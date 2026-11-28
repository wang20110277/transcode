import { promises as fs } from 'node:fs';
import { RPC_ERRORS, RpcError, JsonRpcTransport } from './transport.js';
import { AcpSession, sessionCwd, sessionNewResult, type AcpSessionHost } from './session.js';
import { getSession } from '../sessions/store.js';
import { listProjectSessions } from '../sessions/resume.js';
import { loadConfig } from '../config.js';
import { webSearchConfigWarning } from '../provider/web-search.js';
import { validateModelSpec, fetchSelectableModelsLive } from '../provider/provider.js';
import { invalidRulesNotice, loadPermissionRules } from '../agent/permission-rules.js';
import { AGENT_TOOL_NAMES } from '../agent/tools/index.js';
import { VERSION } from '../version.js';
import type {
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptBlock,
  AcpPromptParams,
  AcpSessionNewParams,
  AcpSessionUpdate,
} from './protocol.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) {
    throw new RpcError(RPC_ERRORS.invalidParams, `Missing or invalid "${key}"`);
  }
  return value;
}

export class AcpServer implements AcpSessionHost {
  private readonly sessions = new Map<string, AcpSession>();

  constructor(private readonly transport: JsonRpcTransport) {
    transport.setHandlers(
      (method, params) => this.handleRequest(method, params),
      (method, params) => this.handleNotification(method, params),
    );
  }

  sendUpdate(sessionId: string, update: AcpSessionUpdate): void {
    this.transport.notify('session/update', { sessionId, update });
  }

  async requestPermission(
    request: AcpPermissionRequest,
    signal?: AbortSignal,
  ): Promise<AcpPermissionResponse> {
    const result = await this.transport.request('session/request_permission', request, {
      timeoutMs: 60_000,
      signal,
    });
    return result as AcpPermissionResponse;
  }

  shutdown(): void {
    for (const session of this.sessions.values()) session.cancel();
    this.sessions.clear();
  }

  private getSession(sessionId: string): AcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RpcError(RPC_ERRORS.sessionNotFound, `Session not found: ${sessionId}`);
    }
    return session;
  }

  private async handleRequest(method: string, rawParams: unknown): Promise<unknown> {
    try {
      return await this.dispatchRequest(method, rawParams);
    } catch (error) {
      // RpcErrors are protocol outcomes (not-found, bad params, probing) —
      // they answer the host and must NOT spam the `error: ` convention.
      // Only operational failures (unexpected exceptions) log + wrap here;
      // provider-level failures log in AcpSession.prompt's catch.
      if (error instanceof RpcError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`error: ${message}\n`);
      throw new RpcError(RPC_ERRORS.internalError, message);
    }
  }

  private async dispatchRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = asRecord(rawParams);

    switch (method) {
      case 'initialize': {
        // ACP has no /permissions: stderr is the only place to say that rules were ignored.
        const notice = invalidRulesNotice(loadPermissionRules(AGENT_TOOL_NAMES));
        if (notice) process.stderr.write(`${notice}\n`);
        return {
          protocolVersion: 1,
          agentInfo: { name: 'transcode', version: VERSION },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: false,
            },
            mcpCapabilities: {
              http: false,
              sse: false,
            },
          },
          authMethods: [],
        };
      }

      case 'authenticate':
        return null;

      // transcode extension: the model catalog without session semantics —
      // hosts can populate pickers with one cheap call, no session/new.
      // Live: what each key-configured channel actually serves, with
      // per-channel fallback; keyless channels never appear.
      case 'agent/models': {
        return { models: await fetchSelectableModelsLive() };
      }

      case 'session/new':
        return await this.createSession(params as AcpSessionNewParams);

      case 'session/load':
      case 'session/resume': {
        const sessionId = requireString(params, 'sessionId');
        const live = this.sessions.get(sessionId);
        if (live) return sessionNewResult(live);
        // Process restarted (or another host process wrote it): rebuild
        // from the disk store. A missing or corrupt record is -32002 —
        // readRecord swallows parse errors as "not found".
        const record = getSession(sessionId);
        if (!record) {
          throw new RpcError(RPC_ERRORS.sessionNotFound, `Session not found: ${sessionId}`);
        }
        const session = AcpSession.fromRecord(this, record);
        this.sessions.set(session.id, session);
        return sessionNewResult(session);
      }

      case 'session/prompt': {
        const sessionId = requireString(params, 'sessionId');
        const prompt = Array.isArray(params.prompt)
          ? (params.prompt as AcpPromptBlock[])
          : [];
        return await this.getSession(sessionId).prompt({
          sessionId,
          prompt,
        } satisfies AcpPromptParams);
      }

      case 'session/set_model': {
        const sessionId = requireString(params, 'sessionId');
        const modelId = requireString(params, 'modelId');
        const models = this.getSession(sessionId).setModel(modelId);
        return { models };
      }

      case 'session/cancel': {
        const sessionId = requireString(params, 'sessionId');
        this.sessions.get(sessionId)?.cancel();
        return null;
      }

      // transcode extension for its own hosts (multica/transonce): the
      // project's disk sessions, newest first.
      case 'session/list': {
        const cwd = sessionCwd(params.cwd);
        const sessions = (await listProjectSessions(cwd)).map((record) => ({
          sessionId: record.id,
          title: record.title,
          updatedAt: record.updatedAt,
        }));
        return { sessions };
      }

      // Closes the live session; the disk record stays loadable. close()
      // also blocks a still-unwinding round's late persist from clobbering
      // whatever a re-loaded session writes next.
      case 'session/close': {
        const sessionId = requireString(params, 'sessionId');
        const session = this.sessions.get(sessionId);
        if (session) {
          session.close();
          this.sessions.delete(sessionId);
        }
        return null;
      }

      // transcode advertises no MCP capability in the MVP; accept the call so a
      // client probing it does not turn a harmless request into a task failure.
      case 'session/set_config_option': {
        return {};
      }

      default:
        throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  private async handleNotification(method: string, rawParams: unknown): Promise<void> {
    if (method !== 'session/cancel' && method !== '$/cancelRequest') return;

    const params = asRecord(rawParams);
    const sessionId = params.sessionId;
    if (typeof sessionId === 'string') {
      this.sessions.get(sessionId)?.cancel();
    }
  }

  private async createSession(params: AcpSessionNewParams): Promise<unknown> {
    const cwd = sessionCwd(params.cwd);

    let stat;
    try {
      stat = await fs.stat(cwd);
    } catch {
      throw new RpcError(RPC_ERRORS.invalidParams, `cwd does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) {
      throw new RpcError(RPC_ERRORS.invalidParams, `cwd is not a directory: ${cwd}`);
    }

    if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
      process.stderr.write(
        `[transcode] ignoring ${params.mcpServers.length} MCP server(s); MCP is not supported in this MVP\n`,
      );
    }

    const model = typeof params.model === 'string' ? params.model : undefined;
    // A host's model picker must be honored exactly: reject unknown specs
    // here instead of silently falling back to the default model (the UI
    // would show A while B runs). Blank = not provided.
    if (model && model.trim()) {
      const problem = validateModelSpec(model);
      if (problem) {
        process.stderr.write(`error: ${problem}\n`);
        throw new RpcError(RPC_ERRORS.invalidParams, problem);
      }
    }
    const session = new AcpSession(this, cwd, model);
    this.sessions.set(session.id, session);
    process.stderr.write(
      `[transcode] session ${session.id} created cwd=${cwd} model=${session.modelState.currentModelId}\n`,
    );
    const webSearchWarning = webSearchConfigWarning(loadConfig().webSearch);
    if (webSearchWarning) {
      process.stderr.write(`[transcode] ${webSearchWarning}\n`);
    }
    return sessionNewResult(session);
  }
}

/** One machine-readable stderr line explaining a signal-driven exit. */
export function shutdownNotice(signal: string): string {
  return `[transcode] ${signal}: shutting down\n`;
}

export async function runAcpServer(): Promise<void> {
  // stdout is the JSON-RPC channel. Any library that calls console.log must not
  // corrupt it, so route console output to stderr for the lifetime of the server.
  for (const method of ['log', 'info', 'debug', 'dir', 'table'] as const) {
    (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (
      ...args: unknown[]
    ) => console.error(...args);
  }

  const transport = new JsonRpcTransport();
  const server = new AcpServer(transport);

  const shutdown = (signal: string) => {
    process.stderr.write(shutdownNotice(signal));
    server.shutdown();
    transport.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  process.stderr.write(`[transcode] ACP server ready (v${VERSION})\n`);

  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });

  server.shutdown();
  transport.close();
}

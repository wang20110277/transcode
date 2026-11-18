import { promises as fs } from 'node:fs';
import { RPC_ERRORS, RpcError, JsonRpcTransport } from './transport.js';
import { AcpSession, sessionCwd, sessionNewResult, type AcpSessionHost } from './session.js';
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
    const params = asRecord(rawParams);

    switch (method) {
      case 'initialize':
        return {
          protocolVersion: 1,
          agentInfo: { name: 'transcode', version: VERSION },
          agentCapabilities: {
            loadSession: false,
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

      case 'authenticate':
        return null;

      case 'session/new':
        return await this.createSession(params as AcpSessionNewParams);

      case 'session/load':
      case 'session/resume': {
        const sessionId = requireString(params, 'sessionId');
        return sessionNewResult(this.getSession(sessionId));
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
    const session = new AcpSession(this, cwd, model);
    this.sessions.set(session.id, session);
    process.stderr.write(
      `[transcode] session ${session.id} created cwd=${cwd} model=${session.modelState.currentModelId}\n`,
    );
    return sessionNewResult(session);
  }
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

  const shutdown = () => {
    server.shutdown();
    transport.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  process.stderr.write(`[transcode] ACP server ready (v${VERSION})\n`);

  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });

  server.shutdown();
  transport.close();
}

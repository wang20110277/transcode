import { createInterface, type Interface } from 'node:readline';
import type { JsonRpcId, JsonRpcResponse } from './protocol.js';

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  sessionNotFound: -32002,
} as const;

type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void | Promise<void>;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Newline-delimited JSON-RPC 2.0 transport over stdio, as required by ACP.
 * stdout is reserved for protocol frames; diagnostics must go to stderr.
 */
export class JsonRpcTransport {
  private readonly reader: Interface;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private requestHandler?: RequestHandler;
  private notificationHandler?: NotificationHandler;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    this.reader = createInterface({ input, crlfDelay: Infinity });
    this.reader.on('line', (line) => {
      void this.handleLine(line);
    });
    this.reader.on('close', () => {
      this.failAll(new Error('ACP connection closed'));
    });
  }

  setHandlers(requestHandler: RequestHandler, notificationHandler?: NotificationHandler): void {
    this.requestHandler = requestHandler;
    this.notificationHandler = notificationHandler;
  }

  async request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed) throw new Error('ACP transport is closed');

    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject };

      if (options.timeoutMs && options.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new RpcError(-32000, `Request timed out: ${method}`));
        }, options.timeoutMs);
        pending.timer.unref?.();
      }

      if (options.signal) {
        const onAbort = () => {
          if (!this.pending.delete(id)) return;
          this.cleanupPending(pending);
          reject(new Error(`Request cancelled: ${method}`));
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
      }

      this.pending.set(id, pending);
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        this.cleanupPending(pending);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result: result ?? null });
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    this.failAll(new Error('ACP transport closed'));
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.abortCleanup?.();
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private write(frame: unknown): void {
    this.output.write(`${JSON.stringify(frame)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.respondError(0, RPC_ERRORS.parseError, 'Invalid JSON');
      return;
    }

    const id = message.id as JsonRpcId | undefined;
    const method = typeof message.method === 'string' ? message.method : undefined;

    if (method && id !== undefined && id !== null) {
      if (!this.requestHandler) {
        this.respondError(id, RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
        return;
      }
      try {
        const result = await this.requestHandler(method, message.params);
        this.respond(id, result);
      } catch (error) {
        if (error instanceof RpcError) {
          this.respondError(id, error.code, error.message, error.data);
        } else {
          this.respondError(
            id,
            RPC_ERRORS.internalError,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return;
    }

    if (method) {
      try {
        await this.notificationHandler?.(method, message.params);
      } catch (error) {
        process.stderr.write(
          `[transcode] notification ${method} failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
      return;
    }

    // Response to a request we sent (for example session/request_permission).
    if (id === undefined || id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    this.cleanupPending(pending);

    const error = message.error as JsonRpcResponse['error'];
    if (error) {
      pending.reject(new RpcError(error.code, error.message, error.data));
    } else {
      pending.resolve(message.result ?? null);
    }
  }
}

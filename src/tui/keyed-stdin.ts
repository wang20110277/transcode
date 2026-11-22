import { EventEmitter } from 'node:events';

/**
 * Ink reads stdin in paused mode ('readable' event + read() loop) and
 * treats each chunk as a single keypress. Burst input (paste, terminal
 * multiplexer send-keys, fast typing coalesced by the runtime) therefore
 * arrives glued — e.g. "help\r" — and keys like Enter/Escape silently
 * stop working. Bun's stdin layer makes this worse by merging even
 * time-separated writes into one chunk.
 *
 * This proxy reads the real stdin in flowing mode, splits every buffer
 * into discrete keystrokes (one escape sequence, or one character per
 * key), and hands them to Ink ONE PER read() call — chunk coalescing is
 * impossible on any runtime.
 *
 * Implements exactly the subset of the stdin API Ink uses:
 * addListener/removeListener('readable'), read(), setEncoding(),
 * setRawMode(), ref(), unref(), isTTY.
 */
/**
 * Split a stdin burst into discrete keys: one escape sequence per key
 * (with any trailing plain characters re-queued — a glued "\x1b[Ax\r"
 * must NOT swallow the x and the Enter), one character otherwise.
 */
export function splitKeys(chunk: string): string[] {
  if (!chunk) return [];
  if (chunk.charCodeAt(0) !== 0x1b) return [...chunk];
  // Escape sequence: lone ESC, ESC+single char, or CSI/SS3 ending at the
  // first letter/~ (parameter bytes 0x30-0x3F, intermediates 0x20-0x2F).
  // Lone ESC, or ESC+char (terminals send Alt-modified keys this way —
  // keep as one key). CSI/SS3 sequences end at the first letter/~.
  let end = 2;
  if (chunk[1] === '[' || chunk[1] === 'O') {
    while (end < chunk.length && !/[a-zA-Z~]/.test(chunk[end]!)) end++;
    end = Math.min(end + 1, chunk.length);
  }
  return [chunk.slice(0, end), ...[...chunk.slice(end)]];
}

class KeyedStdin extends EventEmitter {
  readonly isTTY = true;
  private queue: string[] = [];
  private readonly realStdin: NodeJS.ReadStream & {
    setRawMode(mode: boolean): unknown;
  };

  constructor(realStdin: NodeJS.ReadStream & { setRawMode(mode: boolean): unknown }) {
    super();
    this.realStdin = realStdin;
    realStdin.setEncoding('utf8');
    realStdin.on('data', (chunk: string) => {
      for (const key of splitKeys(chunk)) this.pushKey(key);
    });
  }

  setEncoding(_encoding: string): void {
    // Chunks pushed in the constructor are already strings.
  }

  setRawMode(mode: boolean): void {
    this.realStdin.setRawMode(mode);
  }

  ref(): void {
    // Real stdin stays ref'd for the lifetime of the process.
  }

  /**
   * Ink calls unref() when the last raw-mode consumer unmounts. The
   * flowing-mode listener on the real stdin keeps the event loop alive,
   * so it must be parked here or the process never exits after `exit`.
   */
  unref(): void {
    this.realStdin.pause();
  }

  /** Always returns at most one keystroke — never a merged chunk. */
  read(): string | null {
    return this.queue.shift() ?? null;
  }

  pushKey(key: string): void {
    this.queue.push(key);
    // Emit synchronously — every 'readable' sees exactly one queued key,
    // and there is no scheduling window in which listeners can change.
    this.emit('readable');
  }
}

export function createKeyedStdin(): NodeJS.ReadStream {
  const proxy = new KeyedStdin(
    process.stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): unknown },
  );
  return proxy as unknown as NodeJS.ReadStream;
}

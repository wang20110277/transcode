/**
 * Frame-level throttle for streaming output. Stock Ink re-renders
 * synchronously on every setState — per-delta appends (dozens per second,
 * each rewriting the whole history frame) are what makes the screen
 * flicker. Coalescing deltas into one append per interval window cuts the
 * render rate to frame level without changing output content or order.
 */

export interface ThrottleTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const REAL_TIMERS: ThrottleTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createStreamThrottler(
  append: (text: string) => void,
  intervalMs = 32,
  timers: ThrottleTimers = REAL_TIMERS,
): { push: (chunk: string) => void; flush: () => void } {
  let buffer = '';
  let pending: unknown = null;

  const drain = (): void => {
    if (pending !== null) {
      timers.clearTimer(pending);
      pending = null;
    }
    if (!buffer) return;
    const text = buffer;
    buffer = '';
    append(text);
  };

  return {
    push(chunk) {
      buffer += chunk;
      if (pending === null) {
        pending = timers.setTimer(drain, intervalMs);
      }
    },
    flush: drain,
  };
}

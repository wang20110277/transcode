import { describe, expect, test } from 'bun:test';
import { createStreamThrottler } from './stream-throttle.js';

interface Harness {
  push: (chunk: string) => void;
  flush: () => void;
  appended: string[];
  tick: () => void;
  pendingTimer: () => boolean;
}

function harness(intervalMs = 32): Harness {
  const appended: string[] = [];
  let timer: (() => void) | null = null;
  const throttler = createStreamThrottler((text) => appended.push(text), intervalMs, {
    setTimer: (fn) => {
      timer = fn;
      return 0;
    },
    clearTimer: () => {
      timer = null;
    },
  });
  return {
    ...throttler,
    appended,
    tick: () => {
      const fn = timer;
      timer = null;
      fn?.();
    },
    pendingTimer: () => timer !== null,
  };
}

describe('createStreamThrottler', () => {
  test('窗口内多个 delta 合并为一次追加(内容按序拼接)', () => {
    const h = harness();
    h.push('He');
    h.push('llo ');
    h.push('world');
    expect(h.appended).toEqual([]);
    h.tick();
    expect(h.appended).toEqual(['Hello world']);
  });

  test('定时器窗口外的新 delta 开新窗口', () => {
    const h = harness();
    h.push('a');
    h.tick();
    h.push('b');
    h.push('c');
    h.tick();
    expect(h.appended).toEqual(['a', 'bc']);
  });

  test('flush 立即排水并取消挂起的定时器;空缓冲 flush 无操作', () => {
    const h = harness();
    h.push('x');
    h.push('y');
    h.flush();
    expect(h.appended).toEqual(['xy']);
    expect(h.pendingTimer()).toBe(false);
    h.flush();
    expect(h.appended).toEqual(['xy']);
  });

  test('flush 后再 push 正常开新窗口', () => {
    const h = harness();
    h.push('1');
    h.flush();
    h.push('2');
    h.tick();
    expect(h.appended).toEqual(['1', '2']);
  });
});

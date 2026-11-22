import { describe, expect, test } from 'bun:test';
import { sliceLiveTail } from './live-view.js';

describe('sliceLiveTail', () => {
  test('超窗截尾:visible 为最后 maxLines 行,hidden 为被截行数', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    const { visible, hidden } = sliceLiveTail(text, 5);
    expect(visible).toBe('line-7\nline-8\nline-9\nline-10\nline-11');
    expect(hidden).toBe(7);
  });

  test('未超窗原样返回 hidden=0;空文本同样安全', () => {
    expect(sliceLiveTail('a\nb\nc', 5)).toEqual({ visible: 'a\nb\nc', hidden: 0 });
    expect(sliceLiveTail('', 5)).toEqual({ visible: '', hidden: 0 });
  });

  test('正好等于窗口边界原样返回', () => {
    const text = 'a\nb\nc';
    expect(sliceLiveTail(text, 3)).toEqual({ visible: text, hidden: 0 });
  });
});

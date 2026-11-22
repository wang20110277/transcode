import { describe, expect, test } from 'bun:test';
import { displayWidth, sliceLiveTail } from './live-view.js';

describe('displayWidth', () => {
  test('宽字符(CJK)按 2 列计,ASCII 按 1 列', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中b')).toBe(4);
  });
});

describe('sliceLiveTail (wrapped-row aware)', () => {
  test('超窗截尾:visible 为最后若干逻辑行,hidden 为被截逻辑行数', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    const { visible, hidden } = sliceLiveTail(text, 5, 80);
    expect(visible).toBe('line-7\nline-8\nline-9\nline-10\nline-11');
    expect(hidden).toBe(7);
  });

  test('折行计入预算:尾部装最新行,装不下的大段被截(按屏幕行计)', () => {
    const longCjk = '中'.repeat(200); // 80 列下 ≈ 5 屏幕行(400 列宽)
    const text = `${longCjk}\nshort\nanother`;
    const { visible, hidden } = sliceLiveTail(text, 6, 80);
    // 尾窗保最新:another(1)+short(1)=2 行;longCjk 占 5 行装不下 → 截
    expect(visible).toBe('short\nanother');
    expect(hidden).toBe(1);
  });

  test('未超窗原样返回 hidden=0;空文本安全', () => {
    expect(sliceLiveTail('a\nb\nc', 5, 80)).toEqual({ visible: 'a\nb\nc', hidden: 0 });
    expect(sliceLiveTail('', 5, 80)).toEqual({ visible: '', hidden: 0 });
  });

  test('单逻辑行超预算也至少保留该行(不整行丢弃)', () => {
    const longCjk = '中'.repeat(400); // ≈ 10 屏幕行
    const { visible, hidden } = sliceLiveTail(longCjk, 3, 80);
    expect(visible).toBe(longCjk);
    expect(hidden).toBe(0);
  });

  test('maxLines 钳制下限 1:退化终端不产生空 visible 与虚高 hidden', () => {
    const text = 'a\nb\nc';
    const { visible, hidden } = sliceLiveTail(text, 0, 80);
    expect(visible).toBe('c');
    expect(hidden).toBe(2);
  });
});

import { describe, expect, test } from 'bun:test';
import { splitKeys } from './keyed-stdin.js';

describe('splitKeys', () => {
  test('纯文本逐字符成键,\\r 单独成键(提交不被吞)', () => {
    expect(splitKeys('ab\r')).toEqual(['a', 'b', '\r']);
    expect(splitKeys('你好\r')).toEqual(['你', '好', '\r']);
  });

  test('ESC 序列整体成键,尾部粘连的普通字符与回车不得被吞', () => {
    expect(splitKeys('\x1b[Ax\r')).toEqual(['\x1b[A', 'x', '\r']);
    expect(splitKeys('\x1bOP\r')).toEqual(['\x1bOP', '\r']);
    expect(splitKeys('\x1b[3~q')).toEqual(['\x1b[3~', 'q']);
  });

  test('孤立 ESC 与 ESC+单字符', () => {
    expect(splitKeys('\x1b')).toEqual(['\x1b']);
    expect(splitKeys('\x1ba')).toEqual(['\x1ba']); // Alt+a 语义,整体成键
  });
});

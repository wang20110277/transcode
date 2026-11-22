import { describe, expect, test } from 'bun:test';
import { reduceQueue } from './input-queue.js';

describe('reduceQueue', () => {
  test('enqueue:入队尾部;空白(trim 后空)拒收', () => {
    expect(reduceQueue(['a'], { type: 'enqueue', text: 'b' })).toEqual({
      queue: ['a', 'b'],
    });
    expect(reduceQueue(['a'], { type: 'enqueue', text: '   ' })).toEqual({ queue: ['a'] });
    expect(reduceQueue([], { type: 'enqueue', text: '' })).toEqual({ queue: [] });
  });

  test('turnEnded:shift 首条返回 submit 与剩余;空队列无 submit', () => {
    expect(reduceQueue(['a', 'b'], { type: 'turnEnded' })).toEqual({
      queue: ['b'],
      submit: 'a',
    });
    expect(reduceQueue([], { type: 'turnEnded' })).toEqual({ queue: [] });
  });

  test('submitNext 与 turnEnded 同型', () => {
    expect(reduceQueue(['x'], { type: 'submitNext' })).toEqual({ queue: [], submit: 'x' });
    expect(reduceQueue([], { type: 'submitNext' })).toEqual({ queue: [] });
  });

  test('frozen 原样返回;clear 清空', () => {
    expect(reduceQueue(['a', 'b'], { type: 'frozen' })).toEqual({ queue: ['a', 'b'] });
    expect(reduceQueue(['a'], { type: 'clear' })).toEqual({ queue: [] });
  });
});

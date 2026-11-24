import { describe, expect, test } from 'bun:test';
import { listWindow } from './list-window.js';

describe('listWindow', () => {
  test('a list that fits is drawn whole', () => {
    expect(listWindow(8, 3, 12)).toEqual({ start: 0, end: 8, before: 0, after: 0 });
  });

  test('stays at the top while the cursor is in the first half of the window', () => {
    expect(listWindow(300, 0, 15)).toEqual({ start: 0, end: 15, before: 0, after: 285 });
  });

  test('follows the cursor one row per step once it passes the middle', () => {
    expect(listWindow(300, 7, 15).start).toBe(0);
    expect(listWindow(300, 8, 15).start).toBe(1);
    expect(listWindow(300, 9, 15).start).toBe(2);
  });

  test('stops at the end of the list', () => {
    expect(listWindow(300, 299, 15)).toEqual({ start: 285, end: 300, before: 285, after: 0 });
  });

  test('the highlighted row is inside the window at every cursor position', () => {
    for (let cursor = 0; cursor < 300; cursor++) {
      const { start, end } = listWindow(300, cursor, 15);
      expect(start <= cursor && cursor < end).toBe(true);
    }
  });

  test('an empty list is an empty window; a height below one still shows the highlighted row', () => {
    expect(listWindow(0, 0, 15)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
    expect(listWindow(10, 4, 0)).toEqual({ start: 4, end: 5, before: 4, after: 5 });
  });
});

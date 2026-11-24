import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { rmSync, writeFileSync } from 'node:fs';
import { resetPermissionMode, setPermissionMode } from '../agent/permission.js';
import REPL from './REPL.js';

/**
 * REPL 权限模式角标:输入框底部横线下方、左对齐的一行,常驻显示当前模式。
 * Shift+Tab 与 /mode 两条切换路径都必须让它即时刷新。
 */

const CONFIG_PATH = '/tmp/transcode-mode-indicator-config.json';
const HINT = ' · (shift+tab to cycle) · esc to interrupt';

const mounted: ReturnType<typeof render>[] = [];

/**
 * lastFrame() 是原始帧:开着颜色时(如设了 FORCE_COLOR)模式名与后面的提示分属不同
 * 颜色的片段,中间隔着 SGR 序列,去掉后才能按纯文本比较。
 */
function plain(frame: string): string {
  return frame.replace(/\x1b\[[0-9;]*m/g, '');
}

function mount(): ReturnType<typeof render> {
  const instance = render(
    React.createElement(REPL, {
      ctx: { modelId: 'stub', setModelId: () => {}, clearHistory: () => {} },
      banner: { logo: 'LOGO', model: 'stub', dir: '/tmp' },
    }),
  );
  mounted.push(instance);
  return instance;
}

/** 让 React 的 effect / 重渲染 / dragFlush 定时器跑完。 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50));
}

beforeEach(() => {
  delete process.env.TRANSCODE_PERMISSION_MODE;
  resetPermissionMode();
  process.env.TRANSCODE_CONFIG_PATH = CONFIG_PATH;
  writeFileSync(CONFIG_PATH, '{}');
});

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  rmSync(CONFIG_PATH, { force: true });
  delete process.env.TRANSCODE_CONFIG_PATH;
});

describe('REPL 权限模式角标', () => {
  test('启动时在输入框下方、与输入行左对齐显示当前模式与切换键提示', async () => {
    process.env.TRANSCODE_PERMISSION_MODE = 'readonly';
    resetPermissionMode();
    const instance = mount();
    await settle();
    const lines = plain(instance.lastFrame() ?? '').trimEnd().split('\n');
    const promptRow = lines.findIndex(line => line.includes('▎'));
    const indicatorRow = lines.findIndex(line => line.includes(`mode: readonly${HINT}`));
    // The input box's own bottom rule is the last rule of the startup frame.
    const bottomRuleRow = lines.findLastIndex(line => line.trimStart().startsWith('─'));
    expect(promptRow).toBeGreaterThanOrEqual(0);
    expect(bottomRuleRow).toBeGreaterThan(promptRow);
    expect(indicatorRow).toBeGreaterThan(bottomRuleRow);

    // 与输入行同样的左缩进 = 靠左(不是居中或缩进显示)。
    const indent = (line: string) => line.length - line.trimStart().length;
    expect(indent(lines[indicatorRow]!)).toBe(indent(lines[promptRow]!));
  });

  test('Shift+Tab 切换后角标立即显示新模式', async () => {
    const instance = mount();
    await settle();
    instance.stdin.write('\x1b[Z');
    await settle();
    const frame = plain(instance.lastFrame() ?? '');
    expect(frame).toContain(`mode: auto${HINT}`);
    expect(frame).not.toContain('mode: ask');
  });

  test('/mode <x> 切换后角标立即显示新模式', async () => {
    const instance = mount();
    await settle();
    for (const ch of '/mode readonly') instance.stdin.write(ch);
    instance.stdin.write('\r');
    await settle();
    const frame = plain(instance.lastFrame() ?? '');
    expect(frame).toContain(`mode: readonly${HINT}`);
    expect(frame).not.toContain('mode: ask');
  });

  test('模式在不触发其它重渲染的路径下切换时,角标照样刷新', async () => {
    const instance = mount();
    await settle();
    setPermissionMode('auto');
    await settle();
    const frame = plain(instance.lastFrame() ?? '');
    expect(frame).toContain(`mode: auto${HINT}`);
    expect(frame).not.toContain('mode: ask');
  });
});

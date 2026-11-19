import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { runAgentLoop, type AgentEvent } from '../src/agent/loop.js';
import { createModel } from '../src/provider/provider.js';
import { buildSystemPrompt, loadProjectContext } from '../src/agent/system-prompt.js';
import { createToolSession } from '../src/agent/tools/session.js';
import { lineDiff } from '../src/agent/tools/diff.js';

/**
 * Real-model E2E for the "read the repo docs, then update README" workflow.
 * Runs against a COPY of a real project (never the original) with the
 * user's exact prompt. Requires a configured model key (~/.transcode.json
 * or provider env vars).
 *
 * Usage: bun scripts/readme-e2e.ts [source-repo] [prompt]
 */

const sourceRepo = process.argv[2] ?? '/Users/lindaw/Documents/transonce';
const prompt = process.argv[3] ?? '更新readme';
const spec = process.env.TRANSCODE_MODEL ?? 'deepseek';
const maxTurns = Number(process.env.TRANSCODE_E2E_MAX_TURNS ?? 200);

const provider = createModel(spec);
if (!provider) throw new Error(`No provider for model spec: ${spec}`);

// 1. Copy the repo subset (docs + code, no deps or git state).
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'transcode-readme-e2e-'));
process.stdout.write(`workspace: ${workspace}\n`);
spawnSync(
  'rsync',
  [
    '-a',
    '--exclude', 'node_modules',
    '--exclude', '.git',
    '--exclude', 'dist',
    '--exclude', '.venv',
    '--exclude', '__pycache__',
    `${sourceRepo}/`,
    `${workspace}/`,
  ],
  { stdio: 'inherit' },
);

const readmeBefore = await fs
  .readFile(path.join(workspace, 'README.md'), 'utf8')
  .catch(() => '');

// 2. Run the exact user workflow: read docs → plan → update README.
const events: AgentEvent[] = [];
let callIndex = 0;
const started = Date.now();

const result = await runAgentLoop({
  model: provider.model,
  cwd: workspace,
  messages: [new HumanMessage(prompt)],
  systemPrompt: buildSystemPrompt(await loadProjectContext(workspace), {
    modelName: provider.config.name,
  }),
  toolSession: createToolSession(workspace),
  maxTurns,
  onEvent: (event) => {
    events.push(event);
    if (event.type === 'tool_call') {
      callIndex++;
      process.stdout.write(`  [${String(callIndex).padStart(3)}] ${event.name}: ${event.title.slice(0, 120)}\n`);
    } else if (event.type === 'tool_result') {
      const first = event.output.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 200);
      process.stdout.write(`        ↳ ${event.ok ? '✓' : '✗'} ${first}\n`);
    } else if (event.type === 'max_turns_reached') {
      process.stdout.write(`  ⚠ max turns reached (${event.maxTurns})\n`);
    }
  },
  // Headless run: auto-allow mutations so the script never blocks.
  requestPermission: async () => true,
});

// 3. Report.
const byName = new Map<string, number>();
for (const event of events) {
  if (event.type === 'tool_result') {
    byName.set(event.name, (byName.get(event.name) ?? 0) + 1);
  }
}
const text = events
  .filter((event) => event.type === 'text')
  .map((event) => (event as { text: string }).text)
  .join('');

const readmeAfter = await fs
  .readFile(path.join(workspace, 'README.md'), 'utf8')
  .catch(() => '');
const diff = readmeBefore === readmeAfter ? '' : lineDiff(readmeBefore, readmeAfter);
const diffLines = diff ? diff.split('\n') : [];
const added = diffLines.filter((line) => line.startsWith('+')).length;
const removed = diffLines.filter((line) => line.startsWith('-')).length;

process.stdout.write('\n===== RESULT =====\n');
process.stdout.write(`stopReason: ${result.stopReason}\n`);
process.stdout.write(
  `tool calls: ${[...byName.entries()].map(([name, n]) => `${name}×${n}`).join(' ') || 'none'}\n`,
);
process.stdout.write(`duration: ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
process.stdout.write(`README changed: ${diff ? `yes (+${added} -${removed})` : 'NO'}\n`);
process.stdout.write(
  `final text: ${JSON.stringify(text.trim().slice(0, 500))}\n`,
);
if (diff) {
  process.stdout.write(`--- README diff (first 40 lines) ---\n${diffLines.slice(0, 40).join('\n')}\n`);
}
process.stdout.write(
  diff
    ? '\nE2E PASSED: the workflow completed end-to-end\n'
    : '\nE2E FAILED: README was not modified\n',
);

await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
process.exitCode = diff ? 0 : 1;

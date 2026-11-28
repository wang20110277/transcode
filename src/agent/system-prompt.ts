import { getRouting } from '../provider/provider.js';
import { loadUserMemory, renderMemoryIndex, type UserMemory } from './memory.js';
import { loadConfig } from '../config.js';
import { normalizeWebSearchConfig } from '../provider/web-search.js';
import { loadHierarchyContext } from './context-files.js';

/** Prompt behind /init: agent analyzes the project and writes TRANS.md. */
export const INIT_PROMPT = `Analyze this project and create a TRANS.md file at the workspace root that records the project background and working rules, like CLAUDE.md does for Claude Code.

Explore first with glob, grep and read_file: README, package.json (or other manifest) scripts, the directory layout, entry points, build/test/lint tooling, and any existing contributor docs. Do not guess what you can read.

Then write TRANS.md with these sections (keep the whole file under 60 lines):
- Project overview: what this project is, in 2-3 sentences
- Commands: how to install, build, test, lint/typecheck — exact commands
- Architecture: key directories/modules and how they fit together
- Conventions: naming, code style, commit message style if discoverable

Write TRANS.md only; do not modify any other file. Reply with a one-paragraph summary when done.`;

export interface ProjectContext {
  cwd: string;
  gitBranch?: string;
  projectFiles: { path: string; content: string }[];
  /** User-level memory (global instructions + memories); loaded alongside project files. */
  userMemory?: UserMemory;
}

/**
 * Web tool guidance, gated like the tools themselves: web_search is only
 * advertised when configured (the tool is hidden from the table otherwise);
 * web_fetch is always available.
 */
function webToolLines(): string[] {
  const searchConfigured = normalizeWebSearchConfig(loadConfig().webSearch) !== null;
  return [
    ...(searchConfigured
      ? [
          '- Questions about anything outside this workspace — unfamiliar terms, latest ' +
            'releases, current documentation — search the web with web_search BEFORE answering ' +
            'from memory; read a promising result with web_fetch.',
        ]
      : []),
    '- Use web_fetch to read a specific URL (docs, API responses, raw files) when the user ' +
      'points at one.',
  ];
}

/** Advertises configured role routing so the model knows it can delegate. */
function roleRoutingLines(): string[] {
  const entries = Object.entries(getRouting()).filter(([role]) => role !== 'default');
  if (entries.length === 0) return [];
  const roles = entries.map(([role, profile]) => `${role}→${profile}`).join(', ');
  return [
    `- Sub-task delegation. Configured roles: ${roles}. Three tiers — ` +
      'do it yourself for simple lookups; ask_model({role, prompt}) for one-shot expert ' +
      'questions (analysis, design trade-offs, reviews, image description); ' +
      'dispatch_agent({role, task, tools}) for multi-step research that needs file access — ' +
      'the sub-agent runs its own tool loop and returns a final report (it cannot see this ' +
      'conversation, so the task must be fully self-contained; dispatch asks the user first).',
  ];
}

async function gitBranch(cwd: string): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise<string | undefined>((resolve) => {
      // timeout (#15): a hung git must not hang prompt building.
      execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5_000 }, (error, stdout) => {
        resolve(error ? undefined : stdout.trim() || undefined);
      });
    });
  } catch {
    return undefined;
  }
}

export async function loadProjectContext(cwd: string): Promise<ProjectContext> {
  // Parallel (#13): the hierarchy walk, the git branch probe and user
  // memory are independent — ACP rebuilds this every prompt.
  const [projectFiles, branch, userMemory] = await Promise.all([
    loadHierarchyContext(cwd),
    gitBranch(cwd),
    loadUserMemory(),
  ]);
  return { cwd, gitBranch: branch, projectFiles, userMemory };
}

export function buildSystemPrompt(
  context: ProjectContext,
  options?: { modelName?: string },
): string {
  const poweredBy = options?.modelName ? `, powered by the ${options.modelName} model` : '';
  const sections: string[] = [
    `You are transcode${poweredBy}, a coding agent running as a local CLI agent in a terminal.`,
    'You work directly in the user-provided workspace and can read, search, edit and execute code.',
    ...(options?.modelName
      ? [
          `When asked which model or company you are, answer that you are transcode running on ${options.modelName}. Never claim to be a different model or company.`,
        ]
      : []),
    '',
    '## Environment',
    `- Workspace: ${context.cwd}`,
    `- Platform: ${process.platform}`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    ...(context.gitBranch ? [`- Git branch: ${context.gitBranch}`] : []),
    '',
    '## How to work',
    '- Inspect the repository before changing it. Read the relevant files first.',
    '- Prefer read_file, glob and grep for exploration; use bash for builds, tests and git.',
    '- View file contents with read_file (NOT cat/head/tail/sed); check unknown file sizes with ' +
      'wc -l first and read large files in offset/limit chunks. Do not cat entire files into the conversation.',
    '- read_file returns up to 2000 lines in ONE call. Never paginate a file through repeated ' +
      'grep/sed window commands — that wastes dozens of turns; read the file once instead.',
    '- For synthesis tasks (update docs/README): explore briefly (aim for ~15 tool calls), ' +
      'then state a short plan and write the result. Exploration is not the deliverable.',
    '- Multi-step tasks (3+ steps): create the list with todo_write first, keep exactly one ' +
      'step in_progress, and mark steps completed as you finish them.',
    ...webToolLines(),
    ...roleRoutingLines(),
    '- Reporting counts (tests, checks, matches): grep -c counts matching LINES, including ' +
      'definitions like `def check(` — read the actual item list instead of trusting a raw count.',
    '- The bash working directory persists across calls; you do not need to cd again each time.',
    '- Never repeat an identical tool call; refine it or switch tools.',
    '- Use edit_file for targeted changes and write_file for new files.',
    '- Keep changes focused on the task. Do not undo unrelated user work.',
    '- After changing code, run the cheapest relevant check (typecheck, targeted test) when available.',
    '- Never claim a command succeeded unless you actually ran it and saw the result.',
    '- When the task is complete, reply with a short summary of what changed and any verification performed.',
    '- If a tool fails, read the error and adapt instead of repeating the same call.',
    '- When the user corrects your behavior or states a lasting preference, save it with ' +
      'memory_save; before relying on a possibly stale memory, verify it still holds.',
  ];

  const memory = context.userMemory;
  if (memory && (memory.globalInstructions || memory.entries.length > 0 || memory.omitted.length > 0)) {
    sections.push('', '## User memory');
    if (memory.globalInstructions) {
      sections.push('', '### Global instructions', memory.globalInstructions);
    }
    if (memory.entries.length > 0) {
      sections.push('', '### Memory', renderMemoryIndex(memory.entries).trim());
      for (const entry of memory.entries) {
        sections.push('', `#### ${entry.name}`, entry.content);
      }
    }
    if (memory.omitted.length > 0) {
      sections.push('', `(omitted: ${memory.omitted.join(', ')})`);
    }
  }

  if (context.projectFiles.length > 0) {
    sections.push('', '## Project instructions');
    for (const file of context.projectFiles) {
      sections.push('', `### ${file.path}`, file.content);
    }
  }

  return sections.join('\n');
}

const PLAN_MODE_INSTRUCTION =
  'PLAN MODE: the session is read-only, so do not modify anything. Answer questions directly. ' +
  'When the user asks for work to be done, explore first, then output a numbered implementation ' +
  'plan with exact files and changes, ending with the line PLAN READY. The user will approve it ' +
  'before any changes are made.';

/**
 * The system prompt of a plan-mode turn. Shared by the REPL and the ACP
 * session so both surfaces plan the same way.
 */
export function withPlanMode(systemPrompt: string): string {
  return `${systemPrompt}\n\n${PLAN_MODE_INSTRUCTION}`;
}

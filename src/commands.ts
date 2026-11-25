import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ModelId } from './provider/provider.js';
import { getAvailableModels } from './provider/provider.js';
import { getPermissionMode, PERMISSION_MODES, setPermissionMode } from './agent/permission.js';
import { getRouting, resolveRole, setRouting } from './provider/provider.js';
import {
  deleteMemory,
  globalInstructionsPath,
  loadUserMemory,
  memoryDir,
  renderMemoryIndex,
  saveMemory,
  userMemoryRoot,
} from './agent/memory.js';

export interface CommandContext {
  /** Registry id (deepseek) or provider:model spec (deepseek:deepseek-reasoner). */
  modelId: string;
  setModelId: (id: string) => void;
  clearHistory: () => void;
}

export interface CommandResult {
  output: string;
  exit?: boolean;
}

export interface Command {
  name: string;
  description: string;
  usage?: string;
  execute: (args: string[], ctx: CommandContext) => CommandResult | Promise<CommandResult>;
}

/** /remember slug: ascii words (≤4) kebab-cased; pure non-ascii text falls back to its first 8 chars. */
function slugFromText(text: string): string {
  const ascii = text
    .split(/\s+/)
    .slice(0, 4)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || text.replace(/\s+/g, '').slice(0, 8);
}

/** Appends -2, -3, … until the memory file name is free. */
function uniqueMemoryName(base: string): string {
  let candidate = base;
  let suffix = 2;
  while (existsSync(path.join(memoryDir(), `${candidate}.md`))) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

const commands: Command[] = [
  {
    name: 'help',
    description: 'Show available commands',
    execute: () => ({
      output: commands.map(c => `  /${c.name.padEnd(10)} ${c.description}`).join('\n'),
    }),
  },
  {
    name: 'models',
    description: 'List and switch model',
    execute: (_args, ctx) => {
      const models = getAvailableModels();
      return {
        output: models.map(m => `  ${m.id.padEnd(10)} ${m.name}${m.id === ctx.modelId ? ' (current)' : ''}`).join('\n'),
      };
    },
  },
  {
    name: 'init',
    description: 'Analyze the project and write TRANS.md',
    // Intercepted by the REPL before command dispatch (like /models) so the
    // analysis runs through the full agent loop with tools and permissions.
    execute: () => ({
      output: 'Analyzing the project and writing TRANS.md…',
    }),
  },
  {
    name: 'memory',
    description: 'Show user memories (global instructions + memory index)',
    execute: async () => {
      const memory = await loadUserMemory();
      const lines: string[] = [`Memory root: ${userMemoryRoot()}`];
      lines.push(
        memory.globalInstructions
          ? `Global instructions: ${globalInstructionsPath()} (${memory.globalInstructions.split('\n').length} lines)`
          : `Global instructions: none yet — create ${globalInstructionsPath()}`,
      );
      if (memory.entries.length > 0) {
        lines.push('Memories:', ...renderMemoryIndex(memory.entries).trim().split('\n'));
      } else {
        lines.push('No memories yet. Use /remember <text> to save one.');
      }
      if (memory.omitted.length > 0) {
        lines.push(`(over budget, omitted: ${memory.omitted.join(', ')})`);
      }
      lines.push('Usage: /remember <text> — save a memory; /forget <name> — delete one.');
      return { output: lines.join('\n') };
    },
  },
  {
    name: 'remember',
    description: 'Save a user memory (/remember <text>)',
    execute: async (args) => {
      const text = args.join(' ').trim();
      if (!text) return { output: 'Usage: /remember <text>' };
      const name = uniqueMemoryName(slugFromText(text));
      const entry = await saveMemory({ name, type: 'user', content: text });
      return { output: `Saved memory "${entry.name}".` };
    },
  },
  {
    name: 'search',
    description: 'Configure web search provider + key (tavily|brave)',
    // Intercepted by the REPL before command dispatch (like /models): the
    // setup runs an interactive provider → key → live-test flow.
    execute: () => ({
      output: 'Configuring web search…',
    }),
  },
  {
    name: 'forget',
    description: 'Delete a user memory (/forget <name>)',
    execute: async (args) => {
      const name = args[0]?.trim();
      if (!name) return { output: 'Usage: /forget <name>' };
      const removed = await deleteMemory(name);
      return removed
        ? { output: `Forgot ${name}.` }
        : { output: `No memory named '${name}'.` };
    },
  },
  {
    name: 'mode',
    description: 'Show or switch permission mode (ask | readonly | plan | auto)',
    execute: (args) => {
      const target = args[0]?.toLowerCase();
      if (!target) {
        return {
          output:
            `Current permission mode: ${getPermissionMode()}\n` +
            `Usage: /mode <${PERMISSION_MODES.join('|')}> — ` +
            'ask prompts for mutating tools (read-only commands pass), ' +
            'readonly denies mutating tools, ' +
            'plan stays read-only and ends each task with an implementation plan (PLAN READY), ' +
            'auto allows everything.',
        };
      }
      if (!PERMISSION_MODES.includes(target as never)) {
        return { output: `Unknown mode: ${target}. Valid modes: ${PERMISSION_MODES.join(', ')}` };
      }
      setPermissionMode(target as never);
      // Silent switch: the REPL's mode indicator is the feedback. An empty
      // output lands no transcript entry (same contract as /clear).
      return { output: '' };
    },
  },
  {
    name: 'new',
    description: 'Start a new conversation',
    // Intercepted by the REPL (needs messagesRef/toolSession state).
    execute: () => ({ output: 'Starting a new conversation…' }),
  },
  {
    name: 'sessions',
    description: 'List/search saved conversations (optionally by keyword)',
    // Intercepted by the REPL.
    execute: () => ({ output: 'Listing conversations…' }),
  },
  {
    name: 'resume',
    description: 'Resume a saved conversation (/resume <序号|id|标题片段> [N])',
    // Intercepted by the REPL.
    execute: () => ({ output: 'Resuming…' }),
  },
  {
    name: 'compact',
    description: '无参查看上下文预算;/compact <N> 手动压缩(保留最近 N 轮,默认 1)',
    // Intercepted by the REPL.
    execute: () => ({ output: 'Compacting…' }),
  },
  {
    name: 'route',
    description: 'Show or set role→model routing (analysis/design/vision/…)',
    execute: (args) => {
      if (args.length === 0) {
        const routing = getRouting();
        const lines = Object.entries(routing).map(([role, profile]) => {
          const resolved = resolveRole(role);
          return `  ${role.padEnd(10)} → ${profile}${resolved ? ` (${resolved.model})` : ' ⚠ 未解析'}`;
        });
        return {
          output:
            `Role routing:\n${lines.length ? lines.join('\n') : '  (none)'}\n` +
            'Usage: /route <role> <profile|-> — e.g. /route analysis glmc ; "-" removes the role',
        };
      }
      const [role, profile] = args;
      if (!role || !profile) {
        return { output: 'Usage: /route <role> <profile|->' };
      }
      try {
        setRouting(role, profile);
        return {
          output:
            profile === '-'
              ? `Role "${role}" removed.`
              : `Role "${role}" → ${profile}`,
        };
      } catch (error) {
        return { output: (error as Error).message };
      }
    },
  },
  {
    name: 'clear',
    description: 'Clear screen',
    execute: (_args, ctx) => {
      ctx.clearHistory();
      return { output: '' };
    },
  },
  {
    name: 'exit',
    description: 'Exit Trans Code',
    execute: () => ({ output: 'Goodbye!', exit: true }),
  },
];

/** Dispatch wrapper: a throwing command becomes an error message, never an unhandled rejection. */
export async function executeCommand(
  command: Command,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  try {
    return await command.execute(args, ctx);
  } catch (error) {
    return { output: `Command failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function getCommands(): Command[] {
  return commands;
}

export function findCommand(name: string): Command | undefined {
  return commands.find(c => c.name === name);
}

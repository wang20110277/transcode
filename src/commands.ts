import type { ModelId } from './provider/provider.js';
import { getAvailableModels } from './provider/provider.js';
import { getPermissionMode, PERMISSION_MODES, setPermissionMode } from './agent/permission.js';
import { getRouting, resolveRole, setRouting } from './provider/provider.js';

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
    name: 'mode',
    description: 'Show or switch permission mode (ask | auto | readonly)',
    execute: (args) => {
      const target = args[0]?.toLowerCase();
      if (!target) {
        return {
          output:
            `Current permission mode: ${getPermissionMode()}\n` +
            `Usage: /mode <${PERMISSION_MODES.join('|')}> — ` +
            'ask prompts for mutating tools (read-only commands pass), ' +
            'auto allows everything, readonly denies mutating tools.',
        };
      }
      if (!PERMISSION_MODES.includes(target as never)) {
        return { output: `Unknown mode: ${target}. Valid modes: ${PERMISSION_MODES.join(', ')}` };
      }
      setPermissionMode(target as never);
      return { output: `Permission mode switched to ${target}` };
    },
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

export function getCommands(): Command[] {
  return commands;
}

export function findCommand(name: string): Command | undefined {
  return commands.find(c => c.name === name);
}

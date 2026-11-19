import type { ModelId } from './provider/provider.js';
import { getAvailableModels } from './provider/provider.js';

export interface CommandContext {
  modelId: ModelId;
  setModelId: (id: ModelId) => void;
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

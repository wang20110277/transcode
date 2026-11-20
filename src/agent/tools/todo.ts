import { z } from 'zod';
import type { AgentTool } from './types.js';
import type { TodoItem } from './session.js';

const STATUS_MARK: Record<TodoItem['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

export const todoWriteTool: AgentTool = {
  name: 'todo_write',
  description:
    'Create or replace the task todo list. Use it for any task with 3 or more steps: write the ' +
    'list BEFORE you start, keep exactly one step in_progress at a time, mark steps completed ' +
    'immediately after finishing them, and update the list as plans change. ' +
    'This keeps you on the deliverable instead of endless exploration. ' +
    'Each call replaces the entire list. Do not use it for single-step tasks.',
  kind: 'think',
  isMutating: false,
  schema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().min(1).describe('Short step description'),
          status: z.enum(['pending', 'in_progress', 'completed']).describe('Step status'),
        }),
      )
      .describe('The full todo list (replaces the previous one)'),
  }),
  title: () => 'todos',
  async execute(input, ctx) {
    const todos = (input.todos as TodoItem[]).map((item) => ({
      content: String(item.content),
      status: item.status,
    }));
    ctx.session.todos = todos;

    if (todos.length === 0) return 'Todo list cleared.';

    const lines = todos.map(
      (item, index) => `${STATUS_MARK[item.status]} ${index + 1}. ${item.content}`,
    );
    const allDone = todos.every((item) => item.status === 'completed');
    return `${lines.join('\n')}${allDone ? '\n(all complete)' : ''}`;
  },
};

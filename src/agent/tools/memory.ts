import { z } from 'zod';
import type { AgentTool } from './types.js';
import { deleteMemory, saveMemory, type MemoryType } from '../memory.js';

export const memorySaveTool: AgentTool = {
  name: 'memory_save',
  description:
    'Save or update a user memory — a durable fact that should outlive this conversation: ' +
    'who the user is and their preferences (user), a correction to your own behavior (feedback), ' +
    'a lasting project constraint (project), or a pointer to an external resource (reference). ' +
    'One fact per call. Do NOT save: code structure (read the code instead), git history ' +
    '(git log answers it), temporary task state (use todo_write), or anything TRANS.md already covers.',
  kind: 'edit',
  isMutating: true,
  schema: z.object({
    name: z.string().min(1).describe('Short kebab-case slug identifying the memory'),
    type: z
      .enum(['user', 'feedback', 'project', 'reference'])
      .describe(
        'user=who the user is/preferences; feedback=correction to agent behavior; ' +
          'project=lasting project constraint; reference=external resource pointer',
      ),
    content: z.string().min(1).describe('The fact itself'),
    description: z
      .string()
      .nullable()
      .optional()
      .describe('One-line hook for the index; defaults to the first line of content'),
  }),
  title: (input) => `memory_save ${input.name}`,
  async execute(input) {
    try {
      const entry = await saveMemory({
        name: String(input.name),
        type: input.type as MemoryType,
        content: String(input.content),
        description: input.description ? String(input.description) : undefined,
      });
      return `Saved memory ${entry.name} (type=${entry.type}).`;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const memoryDeleteTool: AgentTool = {
  name: 'memory_delete',
  description:
    'Delete a saved user memory by name — use when the user asks to forget something ' +
    'or a memory turned out to be wrong.',
  kind: 'delete',
  isMutating: true,
  schema: z.object({
    name: z.string().min(1).describe('Name of the memory to delete'),
  }),
  title: (input) => `memory_delete ${input.name}`,
  async execute(input) {
    const name = String(input.name);
    const removed = await deleteMemory(name);
    return removed ? `Deleted memory ${name}.` : `not found: no memory named '${name}'`;
  },
};

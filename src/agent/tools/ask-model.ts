import { z } from 'zod';
import type { AgentTool } from './types.js';

export type AskRoleFn = (
  role: string,
  prompt: string,
  images?: string[],
  ctx?: { cwd: string },
) => Promise<string>;

/** Factory so tests can inject a stub; production wires the provider. */
export function createAskModelTool(askRole: AskRoleFn): AgentTool {
  return {
    name: 'ask_model',
    description:
      'Delegate a sub-task to a specialized model configured under a role ' +
      '(analysis, design, review, vision, …). The sub-model answers in one shot; ' +
      'its answer comes back as text here. Use it for deep analysis, design ' +
      'trade-offs, reviews or describing images instead of doing everything ' +
      'yourself. images (optional) lists workspace file paths for vision roles.',
    kind: 'think',
    isMutating: false,
    schema: z.object({
      role: z.string().describe('Role name configured via /route'),
      prompt: z.string().describe('The sub-task, fully self-contained'),
      images: z
        .array(z.string())
        .nullable()
        .optional()
        .describe('Workspace image paths for vision roles'),
    }),
    title: (input) => `ask ${String(input.role ?? '')}: ${String(input.prompt ?? '').slice(0, 60)}`,
    async execute(input, ctx) {
      const role = String(input.role ?? '').trim();
      const prompt = String(input.prompt ?? '').trim();
      if (!role || !prompt) throw new Error('Both role and prompt are required.');
      const images = Array.isArray(input.images)
        ? (input.images as string[]).map((file) => String(file))
        : undefined;
      const answer = await askRole(role, prompt, images, { cwd: ctx.cwd });
      return answer.length > 20_000 ? `${answer.slice(0, 20_000)}\n… (truncated)` : answer;
    },
  };
}

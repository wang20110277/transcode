import { tool as langChainTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentTool, InvokeResult, ToolContext } from './types.js';
import { bashTool } from './bash.js';
import { editFileTool, readFileTool, writeFileTool } from './files.js';
import { globTool, grepTool } from './search.js';

export const AGENT_TOOLS: AgentTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
];

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((item) => item.name === name);
}

/** Tool definitions bound to the model. Execution happens locally via invokeTool. */
export function bindableTools(tools: AgentTool[] = AGENT_TOOLS): StructuredToolInterface[] {
  return tools.map((item) =>
    langChainTool(async () => '', {
      name: item.name,
      description: item.description,
      schema: item.schema,
    }),
  );
}

export async function invokeTool(
  item: AgentTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<InvokeResult> {
  const parsed = item.schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      output: `Invalid input for ${item.name}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  try {
    const result = await item.execute(parsed.data as Record<string, unknown>, ctx);
    if (typeof result === 'string') {
      return { ok: true, output: result || '(no output)' };
    }
    return { ok: true, output: result.output || '(no output)', diff: result.diff };
  } catch (error) {
    return { ok: false, output: `Error: ${(error as Error).message}` };
  }
}

export * from './types.js';
export * from './session.js';

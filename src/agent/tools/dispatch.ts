import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentLoopOptions, AgentLoopResult } from '../loop.js';
import type { AgentTool } from './types.js';
import { createToolSession } from './session.js';
import { createModel, getRouting } from '../../provider/provider.js';
import { resolveContextTokens } from '../../sessions/compact.js';

export interface DispatchDeps {
  runLoop?: (options: AgentLoopOptions) => Promise<AgentLoopResult>;
  /** Tool pool the whitelist selects from; MUST NOT include dispatch itself. */
  tools?: AgentTool[];
  /** Injected model factory (tests). Default: createModel(profile). */
  model?: BaseChatModel | ((profile: string) => BaseChatModel);
}

const DEFAULT_WHITELIST = ['read_file', 'glob', 'grep'];
const MAX_REPORT_CHARS = 30_000;

const SUBAGENT_SYSTEM_PROMPT =
  'You are a sub-agent. Complete the assigned task using the tools provided, then reply ' +
  'with a final, self-contained report in the same language as the task. The report is the ' +
  'only thing the dispatcher sees — include findings, evidence (file:line) and conclusions; ' +
  'do not ask questions back.';

/**
 * dispatch_agent: the main model delegates an investigation-style sub-task to
 * a routed role's model running its own agent loop with a tool whitelist.
 * Context contract: task text in → final report out (the sub-agent sees
 * nothing of the parent conversation). Dispatch itself is a mutating tool,
 * so the user authorizes each dispatch (y/n) in ask mode.
 */
export function createDispatchAgentTool(deps: DispatchDeps = {}): AgentTool {
  const runLoop = deps.runLoop;
  const pool = deps.tools;
  return {
    name: 'dispatch_agent',
    description:
      'Dispatch a self-contained sub-task to a sub-agent running a routed role model ' +
      '(configured via /route). The sub-agent explores with the whitelisted tools in its ' +
      'own loop and returns one final report; it does NOT see this conversation, so the ' +
      'task must carry all needed context (files, constraints, expected output). ' +
      'tools defaults to the read-only set (read_file, glob, grep). Use for multi-step ' +
      'research/investigation; use ask_model for single-shot expert questions.',
    kind: 'execute',
    isMutating: true,
    schema: z.object({
      role: z.string().describe('Role configured via /route (e.g. research, analysis)'),
      task: z.string().describe('Fully self-contained sub-task description'),
      tools: z
        .array(z.string())
        .nullable()
        .optional()
        .describe('Tool whitelist for the sub-agent (default: read_file, glob, grep)'),
    }),
    title: (input) =>
      `dispatch ${String(input.role ?? '')}: ${String(input.task ?? '').slice(0, 60)}`,
    async execute(input, ctx) {
      const role = String(input.role ?? '').trim();
      const task = String(input.task ?? '').trim();
      if (!role || !task) throw new Error('Both role and task are required.');

      const routing = getRouting();
      const profile = routing[role];
      if (!profile) {
        const names = Object.keys(routing).join(', ');
        throw new Error(
          `Unknown role "${role}". Configured roles: ${names || '(none — set one with /route)'}`,
        );
      }

      const poolTools = pool;
      if (!poolTools) throw new Error('dispatch_agent is not wired with a tool pool.');

      const explicit = Array.isArray(input.tools) && input.tools.length > 0
        ? (input.tools as string[]).map((name) => String(name))
        : undefined;
      let requested: string[];
      if (explicit) {
        const missing = explicit.filter((name) => !poolTools.some((item) => item.name === name));
        if (missing.length > 0) {
          throw new Error(
            `Unknown or forbidden tools: ${missing.join(', ')}. ` +
              `Available: ${poolTools.map((item) => item.name).join(', ')}`,
          );
        }
        requested = explicit;
      } else {
        // Default: the read-only set intersected with the wired pool.
        requested = DEFAULT_WHITELIST.filter((name) =>
          poolTools.some((item) => item.name === name),
        );
      }
      const selected = poolTools.filter((item) => requested.includes(item.name));

      const model =
        typeof deps.model === 'function'
          ? deps.model(profile)
          : deps.model
            ? deps.model
            : createModel(profile).model;

      const envTurns = Number(process.env.TRANSCODE_SUBAGENT_MAX_TURNS);
      const maxTurns = Number.isFinite(envTurns) && envTurns > 0 ? envTurns : 25;

      // The sub-agent may run a DIFFERENT model (role profile) with its own
      // window — resolve its budget, not the parent's (spec ruling #2).
      const budget = resolveContextTokens(profile);
      const result = await runLoop!({
        model,
        cwd: ctx.session.cwd,
        messages: [new HumanMessage(task)],
        systemPrompt: SUBAGENT_SYSTEM_PROMPT,
        tools: selected,
        maxTurns,
        ...(budget.enabled && budget.tokens > 0 ? { contextTokens: budget.tokens } : {}),
        toolSession: createToolSession(ctx.session.cwd),
        onEvent: (event) => {
          // Forward sub-agent tool calls (prefixed) so the parent UI shows
          // live progress; sub-agent text and results stay private.
          if (ctx.emit && event.type === 'tool_call') {
            ctx.emit({
              ...event,
              toolCallId: `sub-${event.toolCallId}`,
              title: `[${role}] ${event.title}`,
            });
          }
        },
        requestPermission: ctx.requestPermission,
        permissionMode: ctx.permissionMode,
      });

      const lastAi = [...result.messages].reverse().find((message) => message.getType() === 'ai');
      const content = lastAi?.content;
      const report =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .map((block) =>
                  block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
                    ? (block as { text: string }).text
                    : '',
                )
                .join('')
            : '';

      if (!report.trim()) {
        throw new Error(`子代理未产出报告（stopReason: ${result.stopReason}）。`);
      }
      return report.length > MAX_REPORT_CHARS
        ? `${report.slice(0, MAX_REPORT_CHARS)}\n… (truncated)`
        : report;
    },
  };
}

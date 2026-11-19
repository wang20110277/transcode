import { Box, Text, useInput, useApp } from 'ink';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import path from 'node:path';
import { findCommand, getCommands, type CommandContext } from '../commands.js';
import { getAvailableModels, createProviderWithKey, createProvider, setPreferredModel, type ModelId } from '../provider/provider.js';
import { runAgentLoop, type PermissionRequest } from '../agent/loop.js';
import { createToolSession } from '../agent/tools/index.js';
import { getPermissionMode } from '../agent/permission.js';
import { walkFiles } from '../agent/tools/fs-utils.js';
import { applyCompletion, filterFiles, mentionQuery } from './file-completion.js';
import { renderDiff } from './diff-render.js';
import { createTurnStats, recordCall, shouldCollapse, summaryLine } from './turn-summary.js';
import { buildSystemPrompt, INIT_PROMPT, loadProjectContext } from '../agent/system-prompt.js';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';

interface HistoryEntry {
  input: string;
  output: string;
}

type PromptPhase = 'idle' | 'model_select' | 'model_apikey' | 'permission';

interface REPLProps {
  ctx: CommandContext;
}

export default function REPL({ ctx }: REPLProps) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  // Multiple keystrokes can be handled in one React batch before a
  // re-render; closures over `input` would see stale values (e.g. the
  // Enter after a fast paste would submit without the last characters).
  // The ref is the source of truth; the state mirrors it for rendering.
  const inputRef = useRef('');
  const commitInput = useCallback((next: string) => {
    inputRef.current = next;
    setInput(next);
  }, []);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState('');
  const [phase, setPhase] = useState<PromptPhase>('idle');
  // Live tool activity while generating; collapsed into a summary at turn end.
  const [liveTool, setLiveTool] = useState<{
    title: string;
    index: number;
    ok: number;
    fail: number;
  } | null>(null);
  const [pendingModel, setPendingModel] = useState<ModelId | null>(null);
  const [modelCursor, setModelCursor] = useState(0);

  const models = getAvailableModels();
  // Bun's scheduler can drop the render flush for updates issued from the
  // stdin event path (updates from timers always flush). Nudge a re-render
  // on a timer so submitted commands are guaranteed to paint.
  const [flushTick, setFlushTick] = useState(0);
  const dragFlush = useCallback(() => {
    setTimeout(() => setFlushTick(t => t + 1), 0);
  }, []);

  const addHistory = useCallback((entry: HistoryEntry) => {
    setHistory(prev => [...prev, entry]);
  }, []);

  // ---- chat state ----
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const messagesRef = useRef<BaseMessage[]>([]);
  // One tool session per process: bash cwd and read-file state persist
  // across prompts, like the ACP session.
  const toolSessionRef = useRef(createToolSession(process.cwd()));

  // @-mention file completion: lazy file list, active query, dismissed flag.
  const [fileList, setFileList] = useState<string[] | null>(null);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mention = phase === 'idle' && !busy ? mentionQuery(input) : null;
  const mentionActive = mention !== null && !mentionDismissed;

  useEffect(() => {
    if (mention === null) setMentionDismissed(false);
  }, [mention]);
  useEffect(() => {
    setMentionCursor(0);
  }, [mention]);
  // Load the workspace file list on first use; refresh on next open after a
  // prompt so files the agent created/removed show up.
  useEffect(() => {
    if (!mentionActive || fileList) return;
    let cancelled = false;
    walkFiles(process.cwd())
      .then((files) => {
        if (cancelled) return;
        setFileList(
          files.map((file) => path.relative(process.cwd(), file).replace(/\\/g, '/')).sort(),
        );
      })
      .catch(() => setFileList([]));
    return () => {
      cancelled = true;
    };
  }, [mentionActive, fileList]);

  const mentionCandidates = useMemo(
    () => (mentionActive && fileList ? filterFiles(fileList, mention ?? '', 8) : []),
    [mentionActive, fileList, mention],
  );
  const pendingPermissionRef = useRef<{
    request: PermissionRequest;
    resolve: (allow: boolean) => void;
  } | null>(null);

  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);

  const appendChatOutput = useCallback((chunk: string) => {
    setHistory(prev => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, output: last.output + chunk };
      return next;
    });
  }, []);

  const askInTerminal = useCallback(
    (request: PermissionRequest, signal: AbortSignal): Promise<boolean> => {
      const mode = getPermissionMode();
      if (mode === 'auto') return Promise.resolve(true);
      if (mode === 'readonly') return Promise.resolve(false);
      return new Promise<boolean>(resolve => {
        const settle = (allow: boolean) => {
          signal.removeEventListener('abort', onAbort);
          pendingPermissionRef.current = null;
          setPhase('idle');
          resolve(allow);
        };
        const onAbort = () => settle(false);
        signal.addEventListener('abort', onAbort);
        pendingPermissionRef.current = { request, resolve: settle };
        setPhase('permission');
      });
    },
    [],
  );

  const runChat = useCallback(
    async (text: string, display?: string) => {
      setBusyBoth(true);
      const controller = new AbortController();
      abortRef.current = controller;
      addHistory({ input: display ?? text, output: '' });

      try {
        const provider =
          process.env.TRANSCODE_MOCK === '1'
            ? undefined
            : createProvider(ctx.modelId);

        const projectContext = await loadProjectContext(process.cwd());
        const systemPrompt = buildSystemPrompt(
          projectContext,
          provider ? { modelName: provider.config.name } : undefined,
        );
        if (messagesRef.current[0]?.getType() === 'system') {
          messagesRef.current[0] = new SystemMessage(systemPrompt);
        } else {
          messagesRef.current.unshift(new SystemMessage(systemPrompt));
        }
        messagesRef.current.push(new HumanMessage(text));

        let lastWasTool = false;
        const stats = createTurnStats();
        const titlesById = new Map<string, string>();
        const bufferedLines: string[] = [];
        let pendingCalls = 0;
        const result = await runAgentLoop({
          model: provider?.model,
          cwd: process.cwd(),
          messages: messagesRef.current,
          systemPrompt,
          signal: controller.signal,
          toolSession: toolSessionRef.current,
          onEvent: event => {
            if (event.type === 'text') {
              appendChatOutput(lastWasTool ? `\n${event.text}` : event.text);
              lastWasTool = false;
            } else if (event.type === 'max_turns_reached') {
              appendChatOutput(
                `\n⚠ 已达轮次上限（${event.maxTurns}），任务未完成。输入"继续"接着做，或调大 TRANSCODE_MAX_TURNS。`,
              );
              lastWasTool = true;
            } else if (event.type === 'tool_call') {
              titlesById.set(event.toolCallId, event.title);
              pendingCalls++;
              setLiveTool({ title: event.title, index: pendingCalls, ok: stats.ok, fail: stats.fail });
              lastWasTool = true;
            } else if (event.type === 'tool_result') {
              const title = titlesById.get(event.toolCallId) ?? event.name;
              const marker = event.skippedPermission ? ' ✓ (read-only)' : event.ok ? ' ✓' : ' ✗';
              recordCall(stats, event.name, event.ok);
              setLiveTool(prev =>
                prev ? { ...prev, ok: stats.ok, fail: stats.fail } : prev,
              );
              if (event.diff) {
                // Edits and writes stay visible immediately — rare and important.
                appendChatOutput(`\n⚙ ${title} ${marker}\n${renderDiff(event.diff)}`);
              } else {
                bufferedLines.push(`\n⚙ ${title} ${marker}`);
              }
              lastWasTool = true;
            }
          },
          requestPermission: request => askInTerminal(request, controller.signal),
        });

        // Collapse long turns into one summary line; short turns stay expanded.
        if (shouldCollapse(stats)) {
          const line = summaryLine(stats);
          if (line) appendChatOutput(`\n${line}`);
        } else {
          for (const line of bufferedLines) appendChatOutput(line);
        }

        messagesRef.current = result.messages;
        if (controller.signal.aborted) appendChatOutput('\n(cancelled)');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendChatOutput(`\n⚠ ${message}`);
        if (/api.?key/i.test(message)) {
          appendChatOutput(`\n(run "models" to switch model + set key, or export its env var)`);
        }
      } finally {
        setBusyBoth(false);
        abortRef.current = undefined;
        setLiveTool(null);
        // The agent may have created/removed files; rebuild @-completion list.
        setFileList(null);
        dragFlush();
      }
    },
    [ctx.modelId, addHistory, appendChatOutput, askInTerminal, setBusyBoth, dragFlush],
  );

  const enterModelSelect = useCallback(() => {
    const currentIdx = models.findIndex(m => m.id === ctx.modelId);
    setModelCursor(currentIdx >= 0 ? currentIdx : 0);
    setPhase('model_select');
  }, [ctx.modelId, models]);

  const handleApiKey = useCallback((value: string) => {
    const apiKey = value.trim();
    const modelId = pendingModel!;

    if (!apiKey) {
      addHistory({ input: '••••••••', output: 'API key cannot be empty.' });
      enterModelSelect();
      return;
    }

    try {
      createProviderWithKey(modelId, apiKey);
      ctx.setModelId(modelId);
      setPreferredModel(modelId);
      const found = models.find(m => m.id === modelId);
      addHistory({ input: '••••••••', output: `Switched to ${found?.name ?? modelId}` });
    } catch {
      addHistory({ input: '••••••••', output: 'Failed to switch model. Invalid API key.' });
    }

    setPendingModel(null);
    setPhase('idle');
  }, [pendingModel, ctx, addHistory, enterModelSelect, models]);

  const handleSubmit = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    if (phase === 'model_apikey') {
      handleApiKey(trimmed);
      commitInput('');
      return;
    }

    const stripped = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    const parts = stripped.split(/\s+/);
    const cmdName = parts[0];
    const args = parts.slice(1);

    if (cmdName === 'models') {
      addHistory({ input: trimmed, output: 'Select a model (↑↓ to navigate, Enter to select):' });
      enterModelSelect();
      commitInput('');
      dragFlush();
      return;
    }

    if (cmdName === 'init') {
      commitInput('');
      setHistoryIndex(-1);
      setSavedInput('');
      await runChat(INIT_PROMPT, trimmed);
      return;
    }

    const cmd = findCommand(cmdName);

    if (cmd) {
      const result = await cmd.execute(args, ctx);

      if (result.exit) {
        exit();
        return;
      }

      if (cmdName === 'clear') {
        ctx.clearHistory();
        setHistory([]);
      } else if (result.output) {
        addHistory({ input: trimmed, output: result.output });
      }
    } else if (trimmed.startsWith('/')) {
      // Explicit slash prefix means the user intended a command.
      addHistory({ input: trimmed, output: `Unknown command: ${cmdName}. Type "help" for available commands.` });
    } else {
      // Free text — converse with the current model.
      commitInput('');
      setHistoryIndex(-1);
      setSavedInput('');
      await runChat(trimmed);
      return;
    }
    dragFlush();

    commitInput('');
    setHistoryIndex(-1);
    setSavedInput('');
  }, [exit, ctx, phase, handleApiKey, addHistory, enterModelSelect, commitInput, dragFlush, runChat]);

  useInput((ch, key) => {
    if (process.env.TRANSCODE_DEBUG_KEYS === '1') {
      // eslint-disable-next-line no-console
      console.error(`CB ${JSON.stringify(ch)} ret=${key.return} esc=${key.escape}`);
    }
    // @-mention popup: Esc dismisses it instead of exiting the app.
    if (key.escape && mentionActive && mentionCandidates.length > 0) {
      setMentionDismissed(true);
      return;
    }
    if (key.escape) {
      // While generating, Esc cancels instead of exiting.
      if (busyRef.current && abortRef.current) {
        abortRef.current.abort();
        return;
      }
      if (phase !== 'idle') {
        setPhase('idle');
        setPendingModel(null);
        commitInput('');
        addHistory({ input: '', output: 'Cancelled.' });
        return;
      }
      exit();
      return;
    }

    if (phase === 'permission') {
      if (ch === 'y' || ch === 'Y' || key.return) {
        pendingPermissionRef.current?.resolve(true);
        return;
      }
      if (ch === 'n' || ch === 'N') {
        pendingPermissionRef.current?.resolve(false);
        return;
      }
      return;
    }

    if (phase === 'model_select') {
      if (key.return) {
        const selected = models[modelCursor];
        setPendingModel(selected.id);
        setPhase('model_apikey');
        commitInput('');
        return;
      }
      if (key.upArrow) {
        setModelCursor(prev => (prev - 1 + models.length) % models.length);
        return;
      }
      if (key.downArrow) {
        setModelCursor(prev => (prev + 1) % models.length);
        return;
      }
      return;
    }

    // @-mention popup navigation and completion (takes precedence over
    // history navigation, tab completion and submission).
    if (phase === 'idle' && mentionActive && mentionCandidates.length > 0) {
      if (key.upArrow) {
        setMentionCursor(prev => (prev - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (key.downArrow) {
        setMentionCursor(prev => (prev + 1) % mentionCandidates.length);
        return;
      }
      if (key.tab || key.return) {
        commitInput(applyCompletion(inputRef.current, mentionCandidates[mentionCursor]));
        return;
      }
    }

    if (key.return) {
      if (busyRef.current) return; // still generating; Esc cancels
      handleSubmit(inputRef.current);
      return;
    }

    if (key.backspace || key.delete) {
      commitInput(inputRef.current.slice(0, -1));
      return;
    }

    if (key.tab && phase === 'idle' && inputRef.current.startsWith('/')) {
      const prefix = inputRef.current.slice(1).toLowerCase();
      const matches = getCommands().filter(c => c.name.startsWith(prefix));
      if (matches.length === 1) {
        commitInput(`/${matches[0].name} `);
      }
      return;
    }

    if (phase === 'idle' && key.upArrow) {
      const inputs = history.map(h => h.input);
      if (inputs.length === 0) return;

      if (historyIndex === -1) {
        setSavedInput(inputRef.current);
      }

      const newIndex = historyIndex === -1
        ? inputs.length - 1
        : Math.max(0, historyIndex - 1);

      setHistoryIndex(newIndex);
      commitInput(inputs[newIndex]);
      return;
    }

    if (phase === 'idle' && key.downArrow) {
      if (historyIndex === -1) return;

      const inputs = history.map(h => h.input);
      const newIndex = historyIndex + 1;

      if (newIndex >= inputs.length) {
        setHistoryIndex(-1);
        commitInput(savedInput);
      } else {
        setHistoryIndex(newIndex);
        commitInput(inputs[newIndex]);
      }
      return;
    }

    if (ch && !key.ctrl && !key.meta) {
      commitInput(inputRef.current + ch);
    }
  });

  const promptLabel = phase === 'model_select'
    ? 'model> '
    : phase === 'model_apikey'
      ? 'apikey> '
      : phase === 'permission'
        ? 'allow?> '
        : '> ';

  return (
    <Box flexDirection="column" paddingX={1}>
      {history.map((entry, i) => (
        <Box key={i} flexDirection="column">
          {entry.input && (
            <Box>
              <Text color="green">&gt; </Text>
              <Text>{entry.input}</Text>
            </Box>
          )}
          {entry.output && (
            <Box marginLeft={2}>
              <Text color="gray">{entry.output}</Text>
            </Box>
          )}
        </Box>
      ))}

      {phase === 'permission' && pendingPermissionRef.current && (
        <Box marginLeft={2}>
          <Text color="yellow">
            ⚙ {pendingPermissionRef.current.request.title} ({pendingPermissionRef.current.request.kind}) — allow? y/n
          </Text>
        </Box>
      )}

      {busy && phase === 'idle' && (
        <Box marginLeft={2} flexDirection="column">
          <Text dimColor>… generating (Esc to cancel)</Text>
          {liveTool && (
            <Text dimColor>
              ⚙{' '}
              {liveTool.title.length > 64 ? `${liveTool.title.slice(0, 64)}…` : liveTool.title}
              {' '}· call {liveTool.index} · {liveTool.ok}✓ {liveTool.fail}✗
            </Text>
          )}
        </Box>
      )}

      {phase === 'model_select' && (
        <Box flexDirection="column" marginLeft={2}>
          {models.map((m, i) => (
            <Box key={m.id}>
              <Text color={i === modelCursor ? 'cyan' : undefined}>
                {i === modelCursor ? '❯ ' : '  '}
                {m.id.padEnd(10)} {m.name}
              </Text>
              {m.id === ctx.modelId && (
                <Text color="yellow"> (current)</Text>
              )}
            </Box>
          ))}
        </Box>
      )}

      {phase !== 'model_select' && (
        <Box>
          <Text color={phase === 'idle' ? 'green' : 'yellow'}>{promptLabel}</Text>
          <Text>{phase === 'model_apikey' ? '*'.repeat(input.length) : input}</Text>
          <Text color="gray">▎</Text>
        </Box>
      )}

      {phase === 'idle' && input.startsWith('/') && (() => {
        const prefix = input.slice(1).toLowerCase();
        const matches = getCommands()
          .filter(c => !prefix || c.name.startsWith(prefix))
          .map(c => `  /${c.name.padEnd(10)} ${c.description}`);
        if (matches.length === 0 || (prefix && matches.length === 1 && matches[0].slice(2, 2 + prefix.length).toLowerCase() === prefix)) return null;
        return (
          <Box marginLeft={2}>
            <Text color="blue" dimColor>{matches.join('\n')}</Text>
          </Box>
        );
      })()}

      {phase === 'idle' && !busy && mentionActive && (
        <Box flexDirection="column" marginLeft={2}>
          {fileList === null ? (
            <Text color="gray" dimColor>… loading files</Text>
          ) : mentionCandidates.length === 0 ? (
            <Text color="gray" dimColor>no files match “{mention}”</Text>
          ) : (
            <>
              {mentionCandidates.map((file, i) => (
                <Box key={file}>
                  <Text color={i === mentionCursor ? 'cyan' : 'gray'}>
                    {i === mentionCursor ? '❯ ' : '  '}
                    {file}
                  </Text>
                </Box>
              ))}
              <Text color="gray" dimColor>↑↓ navigate · tab/enter insert · esc close</Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

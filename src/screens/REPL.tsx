import { Box, Text, useInput, useApp } from 'ink';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import path from 'node:path';
import { findCommand, getCommands, type CommandContext } from '../commands.js';
import {
  getAvailableModels,
  createProvider,
  setPreferredModel,
  registerApiKey,
  lookupApiKey,
  setCustomModel,
  listEndpointModels,
  vendorModelSpec,
  vendorModels,
  verifyModel,
  type ModelId,
} from '../provider/provider.js';
import { loadConfig } from '../config.js';
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

type PromptPhase =
  | 'idle'
  | 'model_select'
  | 'model_pick'
  | 'model_name'
  | 'custom_baseurl'
  | 'model_apikey'
  | 'model_check'
  | 'permission';

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
  const pendingModelRef = useRef<ModelId | null>(null);
  const setVendor = (id: ModelId | null) => {
    pendingModelRef.current = id;
    setPendingModel(id);
  };
  const [modelCursor, setModelCursor] = useState(0);
  // Model selection flow: vendor → model → key (reused if saved) → check.
  const [pickOptions, setPickOptions] = useState<string[]>([]);
  const [pickCursor, setPickCursor] = useState(0);
  const [pickLive, setPickLive] = useState(false);
  const [pickLoading, setPickLoading] = useState(false);
  const vendorModelCache = useRef(new Map<string, string[]>());
  const [pendingSpec, setPendingSpec] = useState<string | null>(null);
  const [pendingDisplayName, setPendingDisplayName] = useState('');
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const [customBaseDraft, setCustomBaseDraft] = useState('');

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
              } else if (event.name === 'todo_write' || event.name === 'dispatch_agent') {
                // Progress state and sub-agent reports: show immediately.
                appendChatOutput(`\n${event.output}`);
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

  const maskKey = (key: string): string =>
    key.length <= 8 ? '…****' : `${key.slice(0, 3)}…${key.slice(-4)}`;

  const beginKeyStep = useCallback(
    (spec: string, displayName: string) => {
      const saved = lookupApiKey(spec);
      setPendingSpec(spec);
      setPendingDisplayName(displayName);
      setKeyHint(saved ? maskKey(saved) : null);
      setPhase('model_apikey');
      commitInput('');
    },
    [commitInput],
  );

  const applyModelSwitch = useCallback(
    (spec: string, displayName: string, apiKey: string, checkMessage: string) => {
      registerApiKey(spec.split(':')[0]!, apiKey);
      ctx.setModelId(spec);
      setPreferredModel(spec);
      addHistory({
        input: '••••••••',
        output: `${checkMessage} — 已切换到 ${displayName}`,
      });
      setPendingSpec(null);
      setPendingDisplayName('');
      setKeyHint(null);
      setVendor(null);
      setPhase('idle');
      dragFlush();
    },
    [ctx, addHistory, dragFlush],
  );

  const handleApiKey = useCallback(
    async (value: string) => {
      const spec = pendingSpec!;
      const savedKey = lookupApiKey(spec);
      const apiKey = value.trim() || savedKey;

      if (!apiKey) {
        addHistory({ input: '••••••••', output: 'API key 不能为空。' });
        return; // stay on the key prompt
      }

      if (process.env.TRANSCODE_SKIP_MODEL_CHECK === '1') {
        applyModelSwitch(spec, pendingDisplayName, apiKey, '已跳过连通性测试');
        return;
      }

      setPhase('model_check');
      const result = await verifyModel(spec, apiKey);
      if (result.ok) {
        applyModelSwitch(spec, pendingDisplayName, apiKey, `✓ ${result.message}`);
        return;
      }
      addHistory({
        input: '••••••••',
        output: `✗ 连通失败：${result.message}\n请重新输入 key（Esc 返回模型列表）`,
      });
      setPhase('model_apikey');
      commitInput('');
      dragFlush();
    },
    [pendingSpec, pendingDisplayName, addHistory, applyModelSwitch, commitInput, dragFlush],
  );

  const handleSubmit = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    if (phase === 'model_apikey' || phase === 'model_check') {
      await handleApiKey(trimmed);
      commitInput('');
      return;
    }

    if (phase === 'custom_baseurl') {
      if (!/^https?:\/\//.test(trimmed)) {
        addHistory({ input: trimmed, output: '地址需以 http:// 或 https:// 开头。' });
        return;
      }
      setCustomBaseDraft(trimmed);
      setPhase('model_name');
      commitInput('');
      return;
    }

    if (phase === 'model_name') {
      if (!trimmed) return;
      if (pendingModel === null) {
        // Custom gateway: base URL collected, now the model name.
        setCustomModel({ baseUrl: customBaseDraft, model: trimmed });
        beginKeyStep('custom', `custom/${trimmed}`);
      } else {
        beginKeyStep(vendorModelSpec(pendingModel, trimmed), `${pendingModel}/${trimmed}`);
      }
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
        setVendor(null);
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
        if (selected.id === 'custom') {
          const saved = loadConfig().custom;
          setVendor(null);
          if (saved?.baseUrl && saved.model) {
            beginKeyStep('custom', `custom/${saved.model}`);
          } else {
            setPhase('custom_baseurl');
            commitInput('');
          }
          return;
        }
        setVendor(selected.id);
        setPickOptions(vendorModels(selected.id));
        setPickCursor(0);
        setPickLive(false);
        setPhase('model_pick');
        commitInput('');

        // Prefer the endpoint's live model list (what it actually serves)
        // over the curated fallback; cache per vendor for this process.
        const vendor = selected.id;
        const cached = vendorModelCache.current.get(vendor);
        if (cached) {
          if (cached.length > 0) {
            setPickOptions(cached);
            setPickLive(true);
          }
        } else {
          setPickLoading(true);
          void listEndpointModels(vendor)
            .then((live) => {
              vendorModelCache.current.set(vendor, live);
              if (live.length > 0 && pendingModelRef.current === vendor) {
                setPickOptions(live);
                setPickCursor(0);
                setPickLive(true);
              }
            })
            .finally(() => setPickLoading(false));
        }
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

    if (phase === 'model_pick') {
      const total = pickOptions.length + 1; // + "自定义模型名…"
      if (key.return) {
        if (pickCursor >= pickOptions.length) {
          setPhase('model_name');
          commitInput('');
          return;
        }
        const modelName = pickOptions[pickCursor]!;
        beginKeyStep(vendorModelSpec(pendingModel!, modelName), `${pendingModel}/${modelName}`);
        commitInput('');
        return;
      }
      if (key.upArrow) {
        setPickCursor(prev => (prev - 1 + total) % total);
        return;
      }
      if (key.downArrow) {
        setPickCursor(prev => (prev + 1) % total);
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
    ? 'vendor> '
    : phase === 'model_pick'
      ? 'model> '
      : phase === 'model_name'
        ? pendingModel === null ? '自定义模型名> ' : '自定义模型名> '
        : phase === 'custom_baseurl'
          ? 'baseurl> '
          : phase === 'model_apikey'
            ? keyHint ? `apikey (回车沿用 ${keyHint})> ` : 'apikey> '
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
          <Text color="gray" dimColor>↑↓ 选择厂商 · Enter 进入模型列表</Text>
        </Box>
      )}

      {phase === 'model_pick' && (
        <Box flexDirection="column" marginLeft={2}>
          {pickOptions.map((name, i) => (
            <Box key={name}>
              <Text color={i === pickCursor ? 'cyan' : undefined}>
                {i === pickCursor ? '❯ ' : '  '}
                {name}
              </Text>
            </Box>
          ))}
          <Box>
            <Text color={pickCursor === pickOptions.length ? 'cyan' : 'gray'}>
              {pickCursor === pickOptions.length ? '❯ ' : '  '}
              自定义模型名…
            </Text>
          </Box>
          {pickLoading && <Text color="gray" dimColor>… 正在从网关获取实时模型列表</Text>}
          {!pickLoading && pickLive && <Text color="gray" dimColor>（网关实时列表）</Text>}
          <Text color="gray" dimColor>↑↓ 选择模型 · Enter 确认</Text>
        </Box>
      )}

      {phase === 'model_check' && (
        <Box marginLeft={2}>
          <Text dimColor>… 测试连通性（{pendingDisplayName}）</Text>
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

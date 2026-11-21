import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import path from 'node:path';
import { findCommand, getCommands, type CommandContext } from '../commands.js';
import {
  getAvailableModels,
  createModel,
  setPreferredModel,
  registerApiKey,
  lookupApiKey,
  setCustomModel,
  listEndpointModels,
  vendorModelSpec,
  vendorModels,
  verifyModel,
  switchNote,
  type ModelId,
} from '../provider/provider.js';
import { loadConfig } from '../config.js';
import { runAgentLoop, type PermissionRequest } from '../agent/loop.js';
import { createToolSession } from '../agent/tools/index.js';
import { getPermissionMode } from '../agent/permission.js';
import {
  buildSessionRecord,
  generateTitle,
  listSessions,
  newSessionId,
  saveSession,
  searchSessions,
  type SessionRecord,
} from '../sessions/store.js';
import { listProjectSessions, resolveResumeTarget, splitResumeArgs } from '../sessions/resume.js';
import { DEFAULT_KEEP_TURNS, compressSession, parseKeepCount, transcriptEntries, splitTurns } from '../sessions/compact.js';
import { walkFiles } from '../agent/tools/fs-utils.js';
import { applyCompletion, filterFiles, mentionQuery } from './file-completion.js';
import {
  applySlashCompletion,
  filterSlashCommands,
  slashQuery,
} from './slash-completion.js';
import { resolveSubmitInput } from './submit.js';
import { historyRule } from './history-rule.js';
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
  | 'vendor_apikey'
  | 'model_apikey'
  | 'model_check'
  | 'permission'
  | 'session_select';

interface REPLProps {
  ctx: CommandContext;
  /** Background auto-update outcome; a non-null message shows as a banner. */
  updateNotice?: Promise<string | null>;
}

export default function REPL({ ctx, updateNotice }: REPLProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
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
  // session_select picker: cursor over the project-scoped session snapshot.
  const [sessionCursor, setSessionCursor] = useState(0);
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
  const [customKeyDraft, setCustomKeyDraft] = useState('');
  // Key typed at the vendor step (first-time setup) before any model pick.
  const [vendorKeyDraft, setVendorKeyDraft] = useState('');

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
  // Conversation persistence: lazily created record + model-generated title.
  const conversationRef = useRef<{ id: string; createdAt: number; titled: boolean } | null>(null);
  const conversationTitleRef = useRef('');
  // Compaction digest of turns older than the kept window (from resume//compact).
  const summaryRef = useRef<string | null>(null);
  const lastSessionsRef = useRef<string[]>([]);
  // Snapshot for the /resume arrow-key picker (set together with the phase).
  const sessionPickerRef = useRef<SessionRecord[]>([]);
  /** Load a record into the live conversation; shared by /resume arg and picker paths. */
  const applyResume = useCallback(
    (record: SessionRecord, inputLine: string) => {
      conversationRef.current = { id: record.id, createdAt: record.createdAt, titled: true };
      conversationTitleRef.current = record.title;
      summaryRef.current = record.summary ?? null;
      messagesRef.current = record.messages;
      toolSessionRef.current = createToolSession(process.cwd());
      addHistory({
        input: inputLine,
        output: `已恢复「${record.title}」（${record.messages.length} 条消息，${record.model}），继续对话。`,
      });
    },
    [addHistory],
  );

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

  // Slash-command popup (mirrors the @-mention popup): candidates for the
  // current input, a cursor, and a dismissed flag reset when the query changes.
  const [slashCursor, setSlashCursor] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashPrefix = phase === 'idle' && !busy ? slashQuery(input) : null;
  const slashCandidates = useMemo(
    () =>
      slashPrefix !== null && !slashDismissed
        ? filterSlashCommands(input, getCommands())
        : [],
    [slashPrefix, slashDismissed, input],
  );
  useEffect(() => {
    setSlashCursor(0);
    if (slashPrefix === null) setSlashDismissed(false);
  }, [slashPrefix]);

  // Background auto-update outcome: surface as a history banner once settled.
  useEffect(() => {
    if (!updateNotice) return;
    let cancelled = false;
    void updateNotice.then(message => {
      if (!cancelled && message) {
        addHistory({ input: '', output: message });
        dragFlush();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [updateNotice, addHistory, dragFlush]);
  const pendingPermissionRef = useRef<{
    request: PermissionRequest;
    resolve: (allow: boolean) => void;
  } | null>(null);

  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);

  /** Shared resume flow: auto-compact over-long sessions, then load + render. */
  const resumeWith = async (record: SessionRecord, inputLine: string, keepTurns = DEFAULT_KEEP_TURNS) => {
    const { turns } = splitTurns(record.messages);
    let finalRecord = record;
    let oldTurns = 0;
    if (turns.length > keepTurns) {
      setBusyBoth(true);
      try {
        if (process.env.TRANSCODE_MOCK !== '1') {
          const outcome = await compressSession(record, createModel(ctx.modelId).model, keepTurns);
          if (outcome.compressed) {
            finalRecord = outcome.record;
            oldTurns = turns.length - keepTurns;
            saveSession(finalRecord);
          } else {
            addHistory({ input: '', output: `⚠ 提炼失败(${outcome.error ?? '未知'}),已恢复完整对话。` });
          }
        }
      } catch {
        addHistory({ input: '', output: '⚠ 提炼失败,已恢复完整对话。' });
      } finally {
        setBusyBoth(false);
      }
    }
    applyResume(finalRecord, inputLine);
    // Restore in the original conversation form: each message becomes a
    // history entry (rule-framed questions, full-length replies).
    for (const entry of transcriptEntries(summaryRef.current, messagesRef.current, oldTurns || undefined)) {
      addHistory(entry);
    }
    dragFlush();
  };

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
    async (text: string, display?: string, options?: { planMode?: boolean }) => {
      setBusyBoth(true);
      const controller = new AbortController();
      abortRef.current = controller;
      addHistory({ input: display ?? text, output: '' });
      if (options?.planMode) {
        appendChatOutput('［plan 模式：只读探索，产出方案，PLAN READY 后可让我执行］\n');
      }

      try {
        const provider =
          process.env.TRANSCODE_MOCK === '1'
            ? undefined
            : createModel(ctx.modelId);

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
        let turnAssistantText = '';
        const stats = createTurnStats();
        const titlesById = new Map<string, string>();
        const bufferedLines: string[] = [];
        let pendingCalls = 0;
        // The digest rides in as a transient system message after the leading
        // system prompt — passed as a copy and stripped from the result so it
        // never lands in messagesRef or the persisted session.
        let loopMessages = messagesRef.current;
        if (summaryRef.current) {
          const copy = [...messagesRef.current];
          let insertAt = 0;
          while (insertAt < copy.length && copy[insertAt]!.getType() === 'system') insertAt++;
          copy.splice(insertAt, 0, new SystemMessage(`【前情提要】\n${summaryRef.current}`));
          loopMessages = copy;
        }
        const result = await runAgentLoop({
          model: provider?.model,
          cwd: process.cwd(),
          messages: loopMessages,
          systemPrompt: options?.planMode
            ? `${systemPrompt}\n\nPLAN MODE: explore read-only, then output a numbered implementation plan with exact files and changes. End with the line PLAN READY. Do not modify anything.`
            : systemPrompt,
          planMode: options?.planMode === true,
          signal: controller.signal,
          toolSession: toolSessionRef.current,
          onEvent: event => {
            if (event.type === 'text') {
              appendChatOutput(lastWasTool ? `\n${event.text}` : event.text);
              turnAssistantText += event.text;
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

        messagesRef.current = result.messages.filter(
          (message) =>
            !(
              message.getType() === 'system' &&
              typeof message.content === 'string' &&
              message.content.startsWith('【前情提要】')
            ),
        );

        // Persist the conversation for /sessions and /resume.
        if (!conversationRef.current) {
          conversationRef.current = {
            id: newSessionId(),
            createdAt: Date.now(),
            titled: false,
          };
          conversationTitleRef.current = text.replace(/\s+/g, ' ').trim().slice(0, 24) || '新对话';
        }
        const conversation = conversationRef.current;
        const persist = () =>
          saveSession(
            buildSessionRecord({
              id: conversation.id,
              title: conversationTitleRef.current,
              createdAt: conversation.createdAt,
              cwd: process.cwd(),
              model: ctx.modelId,
              messages: messagesRef.current,
              summary: summaryRef.current,
            }),
          );
        persist();
        if (!conversation.titled && provider) {
          conversation.titled = true;
          const firstUserText = text;
          void (async () => {
            try {
              conversationTitleRef.current = await generateTitle(
                provider.model,
                firstUserText,
                turnAssistantText,
              );
            } catch {
              // keep the derived fallback title
            }
            persist();
          })();
        }
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
    (spec: string, displayName: string, apiKey: string, checkMessage: string, served?: string) => {
      registerApiKey(spec.split(':')[0]!, apiKey);
      ctx.setModelId(spec);
      setPreferredModel(spec);
      const pickedModel = spec.split(':').pop() ?? displayName;
      addHistory({
        input: '••••••••',
        output: `${checkMessage} — ${switchNote(displayName, pickedModel, served)}`,
      });
      setPendingSpec(null);
      setPendingDisplayName('');
      setKeyHint(null);
      setCustomBaseDraft('');
      setCustomKeyDraft('');
      setVendorKeyDraft('');
      setVendor(null);
      setPhase('idle');
      dragFlush();
    },
    [ctx, addHistory, dragFlush],
  );

  /** Verify a selection and apply it, or surface the error and re-prompt. */
  const finalizeSelection = useCallback(
    async (spec: string, displayName: string, apiKey: string) => {
      if (process.env.TRANSCODE_SKIP_MODEL_CHECK === '1') {
        applyModelSwitch(spec, displayName, apiKey, '已跳过连通性测试');
        return;
      }
      setPhase('model_check');
      const result = await verifyModel(spec, apiKey);
      if (result.ok) {
        applyModelSwitch(spec, displayName, apiKey, `✓ ${result.message}`, result.served);
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
    [applyModelSwitch, addHistory, commitInput, dragFlush],
  );

  const handleApiKey = useCallback(
    async (value: string) => {
      // Key-first vendor setup: the key unlocks the live model list before
      // any model is picked (first-time use — no saved key yet).
      if (phase === 'vendor_apikey') {
        const apiKey = value.trim();
        if (!apiKey) {
          addHistory({ input: '••••••••', output: 'API key 不能为空。' });
          return;
        }
        const vendor = pendingModel!;
        setVendorKeyDraft(apiKey);
        setPhase('model_pick');
        setPickOptions(vendorModels(vendor));
        setPickCursor(0);
        setPickLive(false);
        setPickLoading(true);
        commitInput('');
        const live = await listEndpointModels(vendor, { apiKey });
        if (pendingModelRef.current === vendor) {
          if (live.length > 0) {
            setPickOptions(live);
            setPickCursor(0);
            setPickLive(true);
          }
          setPickLoading(false);
        }
        dragFlush();
        return;
      }

      // Custom-gateway setup: collect the key, then pick the model from the
      // gateway's live list instead of asking for a blind model name.
      if (pendingSpec === null && pendingModel === null && customBaseDraft) {
        const apiKey = value.trim() || lookupApiKey('custom');
        if (!apiKey) {
          addHistory({ input: '••••••••', output: 'API key 不能为空。' });
          return;
        }
        setCustomKeyDraft(apiKey);
        setPickOptions([]);
        setPickCursor(0);
        setPickLive(false);
        setPhase('model_pick');
        commitInput('');
        setPickLoading(true);
        const live = await listEndpointModels('', { baseUrl: customBaseDraft, apiKey });
        setPickOptions(live);
        setPickLive(live.length > 0);
        setPickLoading(false);
        dragFlush();
        return;
      }

      const spec = pendingSpec!;
      const savedKey = lookupApiKey(spec);
      const apiKey = value.trim() || savedKey;

      if (!apiKey) {
        addHistory({ input: '••••••••', output: 'API key 不能为空。' });
        return; // stay on the key prompt
      }

      await finalizeSelection(spec, pendingDisplayName, apiKey);
    },
    [
      phase,
      pendingSpec,
      pendingModel,
      pendingDisplayName,
      customBaseDraft,
      addHistory,
      finalizeSelection,
     commitInput,
      dragFlush,
    ],
  );

  const handleSubmit = useCallback(async (raw: string) => {
    // Bare Enter is a no-op except at the apikey prompt, where it means
    // "reuse the saved key" (the prompt's 回车沿用 hint).
    const trimmed = resolveSubmitInput(phase, raw);
    if (trimmed === null) return;

    if (phase === 'vendor_apikey' || phase === 'model_apikey' || phase === 'model_check') {
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
      setKeyHint(lookupApiKey('custom') ? maskKey(lookupApiKey('custom')!) : null);
      setPendingSpec(null);
      setPhase('model_apikey');
      commitInput('');
      return;
    }

    if (phase === 'model_name') {
      if (!trimmed) return;
      if (pendingModel === null) {
        // Custom gateway, free-text model name (live list was empty/unreachable).
        setCustomModel({ baseUrl: customBaseDraft, model: trimmed });
        await finalizeSelection('custom', `custom/${trimmed}`, customKeyDraft);
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

    if (cmdName === 'new') {
      conversationRef.current = null;
      conversationTitleRef.current = '';
      summaryRef.current = null;
      messagesRef.current = [];
      toolSessionRef.current = createToolSession(process.cwd());
      addHistory({ input: trimmed, output: '已开始新对话。' });
      commitInput('');
      setHistoryIndex(-1);
      setSavedInput('');
      dragFlush();
      return;
    }

    if (cmdName === 'sessions') {
      const keyword = args.join(' ');
      const found = keyword.trim() ? searchSessions(keyword) : listSessions();
      lastSessionsRef.current = found.map((session) => session.id);
      const lines = found
        .slice(0, 20)
        .map(
          (session, index) =>
            `${index + 1}. ${session.title} · ${new Date(session.updatedAt).toLocaleString()} · ` +
            `${session.model} · ${session.messages.length} 条`,
        );
      addHistory({
        input: trimmed,
        output: found.length
          ? `${keyword.trim() ? `匹配“${keyword}”` : ''}${found.length} 个对话：\n${lines.join('\n')}\n/resume <序号|id|标题片段> 恢复`
          : keyword.trim()
            ? `没有匹配“${keyword}”的对话。`
            : '暂无历史对话。',
      });
      commitInput('');
      setHistoryIndex(-1);
      setSavedInput('');
      dragFlush();
      return;
    }

    if (cmdName === 'resume') {
      const { target, keepRaw } = splitResumeArgs(args);
      const { keep, error } = parseKeepCount(keepRaw);
      if (error) addHistory({ input: '', output: `⚠ ${error}` });
      if (!target) {
        // One-step resume: arrow-key picker over this project's sessions.
        const projectSessions = listProjectSessions(process.cwd()).slice(0, 20);
        if (projectSessions.length === 0) {
          addHistory({ input: trimmed, output: '当前项目暂无历史对话。' });
        } else {
          sessionPickerRef.current = projectSessions;
          lastSessionsRef.current = projectSessions.map((session) => session.id);
          setSessionCursor(0);
          setPhase('session_select');
        }
      } else {
        const record = resolveResumeTarget(target, lastSessionsRef.current, listSessions());
        if (!record) {
          addHistory({ input: trimmed, output: `未找到对话“${target}”。先 /sessions 查看列表。` });
        } else {
          await resumeWith(record, trimmed, keep);
        }
      }
      commitInput('');
      setHistoryIndex(-1);
      setSavedInput('');
      dragFlush();
      return;
    }

    if (cmdName === 'compact') {
      const finishCompact = () => {
        commitInput('');
        setHistoryIndex(-1);
        setSavedInput('');
        dragFlush();
      };
      if (!conversationRef.current) {
        addHistory({ input: trimmed, output: '当前没有进行中的会话,先聊几句或 /resume 恢复一个。' });
        finishCompact();
        return;
      }
      const { keep, error } = parseKeepCount(args[0]);
      const keepN = keep ?? DEFAULT_KEEP_TURNS;
      if (error) addHistory({ input: '', output: `⚠ ${error}` });
      const { turns } = splitTurns(messagesRef.current);
      if (turns.length <= keepN) {
        addHistory({ input: trimmed, output: `无需压缩:当前 ${turns.length} 轮 ≤ ${keepN}。` });
        finishCompact();
        return;
      }
      setBusyBoth(true);
      try {
        const record: SessionRecord = buildSessionRecord({
          id: conversationRef.current.id,
          title: conversationTitleRef.current,
          createdAt: conversationRef.current.createdAt,
          cwd: process.cwd(),
          model: ctx.modelId,
          messages: messagesRef.current,
          summary: summaryRef.current,
        });
        const outcome = process.env.TRANSCODE_MOCK === '1'
          ? { compressed: false as const, record, error: 'mock 模式无模型' }
          : await compressSession(record, createModel(ctx.modelId).model, keepN);
        if (outcome.compressed) {
          summaryRef.current = outcome.record.summary ?? null;
          messagesRef.current = outcome.record.messages;
          saveSession(outcome.record);
          addHistory({
            input: trimmed,
            output: `已压缩:旧 ${turns.length - keepN} 轮提炼为前情提要,保留最近 ${keepN} 轮。`,
          });
          for (const entry of transcriptEntries(summaryRef.current, messagesRef.current)) {
            addHistory(entry);
          }
        } else {
          addHistory({ input: trimmed, output: `⚠ 压缩失败(${outcome.error ?? '未知'}),会话保持原样。` });
        }
      } catch {
        addHistory({ input: trimmed, output: '⚠ 压缩失败,会话保持原样。' });
      } finally {
        setBusyBoth(false);
      }
      finishCompact();
      return;
    }

    if (cmdName === 'plan') {
      const task = stripped.startsWith('/plan') ? stripped.slice(5).trim() : stripped;
      if (!task) {
        addHistory({ input: trimmed, output: '用法：/plan <任务描述> — 只读探索并产出实施方案（PLAN READY），确认后再执行' });
        dragFlush();
        commitInput('');
        return;
      }
      commitInput('');
      setHistoryIndex(-1);
      setSavedInput('');
      await runChat(task, trimmed, { planMode: true });
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
    // Slash-command popup: same — Esc dismisses instead of exiting.
    if (key.escape && slashCandidates.length > 0) {
      setSlashDismissed(true);
      return;
    }
    if (key.escape) {
      // While generating, Esc cancels instead of exiting.
      if (busyRef.current) {
        // Busy covers both a live agent turn (abort it) and async
        // compaction (no controller yet — Esc must not quit the app).
        abortRef.current?.abort();
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
        setVendorKeyDraft('');
        // Key-first: without a saved key the live /models call would 401,
        // so ask for the key up front and fetch the real list with it.
        if (!lookupApiKey(selected.id)) {
          setPhase('vendor_apikey');
          commitInput('');
          return;
        }
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

    if (phase === 'session_select') {
      const picker = sessionPickerRef.current;
      if (picker.length === 0) return;
      if (key.return) {
        const record = picker[sessionCursor];
        if (record) {
          setPhase('idle');
          void resumeWith(record, '/resume');
        }
        return;
      }
      if (key.upArrow) {
        setSessionCursor(prev => (prev - 1 + picker.length) % picker.length);
        return;
      }
      if (key.downArrow) {
        setSessionCursor(prev => (prev + 1) % picker.length);
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
        if (pendingModel === null && customBaseDraft) {
          // Custom gateway: model chosen from the live list.
          setCustomModel({ baseUrl: customBaseDraft, model: modelName });
          void finalizeSelection('custom', `custom/${modelName}`, customKeyDraft);
        } else if (vendorKeyDraft) {
          // Key-first flow: the key was just typed — verify without
          // re-asking for it (applyModelSwitch persists it on success).
          void finalizeSelection(
            vendorModelSpec(pendingModel!, modelName),
            `${pendingModel}/${modelName}`,
            vendorKeyDraft,
          );
        } else {
          beginKeyStep(vendorModelSpec(pendingModel!, modelName), `${pendingModel}/${modelName}`);
        }
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

    // Slash-command popup: ↑↓ navigate, Tab/Enter complete (takes precedence
    // over history navigation and submission).
    if (phase === 'idle' && slashCandidates.length > 0) {
      if (key.upArrow) {
        setSlashCursor(prev => (prev - 1 + slashCandidates.length) % slashCandidates.length);
        return;
      }
      if (key.downArrow) {
        setSlashCursor(prev => (prev + 1) % slashCandidates.length);
        return;
      }
      if (key.tab || key.return) {
        commitInput(applySlashCompletion(inputRef.current, slashCandidates[slashCursor]!.name));
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
            : phase === 'vendor_apikey'
              ? 'apikey> '
            : phase === 'permission'
              ? 'allow?> '
              : '> ';

  return (
    <Box flexDirection="column" paddingX={1}>
      {history.map((entry, i) => (
        <Box key={i} flexDirection="column">
          {entry.input && (
            <Box flexDirection="column">
              <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
              <Box>
                <Text color="green" bold>&gt; </Text>
                <Text color="cyan" bold>{entry.input}</Text>
              </Box>
              <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
            </Box>
          )}
          {entry.output && (
            <Box marginLeft={2}>
              <Text>{entry.output}</Text>
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

      {phase === 'session_select' && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color="gray" dimColor>恢复对话 (↑↓ 选择 · Enter 恢复 · Esc 取消)</Text>
          {sessionPickerRef.current.map((session, i) => (
            <Box key={session.id}>
              <Text color={i === sessionCursor ? 'cyan' : undefined}>
                {i === sessionCursor ? '❯ ' : '  '}
                {i + 1}. {session.title} · {new Date(session.updatedAt).toLocaleString()} ·{' '}
                {session.model} · {session.messages.length} 条
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {phase === 'model_pick' && (
        <Box flexDirection="column" marginLeft={2}>
          {pendingModel === null && customBaseDraft && (
            <Text color="gray" dimColor>自定义网关 {customBaseDraft} 的模型：</Text>
          )}
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
          {!pickLoading && !pickLive && (
            <Text color="gray" dimColor>（本地列表 · 保存 key 后显示线上实时列表）</Text>
          )}
          <Text color="gray" dimColor>↑↓ 选择模型 · Enter 确认</Text>
        </Box>
      )}

      {phase === 'model_check' && (
        <Box marginLeft={2}>
          <Text dimColor>… 测试连通性（{pendingDisplayName}）</Text>
        </Box>
      )}

      {phase !== 'model_select' && phase !== 'session_select' && (
        <Box flexDirection="column">
          <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
          <Box>
            <Text color={phase === 'idle' ? 'green' : 'yellow'}>{promptLabel}</Text>
            <Text>{phase === 'model_apikey' ? '*'.repeat(input.length) : input}</Text>
            <Text color="gray">▎</Text>
          </Box>
          <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
        </Box>
      )}

      {phase === 'idle' && slashCandidates.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {slashCandidates.map((cmd, i) => (
            <Box key={cmd.name}>
              <Text color={i === slashCursor ? 'cyan' : 'gray'}>
                {i === slashCursor ? '❯ ' : '  '}
                /{cmd.name.padEnd(10)} {cmd.description}
              </Text>
            </Box>
          ))}
          <Text color="gray" dimColor>↑↓ navigate · tab/enter complete · esc close</Text>
        </Box>
      )}

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

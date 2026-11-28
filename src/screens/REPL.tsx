import { Box, Static, Text, useInput, useApp, useStdout } from 'ink';
import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import path from 'node:path';
import { executeCommand, findCommand, getCommands, type CommandContext } from '../commands.js';
import {
  getAvailableModels,
  createModel,
  getRouting,
  setPreferredModel,
  registerApiKey,
  lookupApiKey,
  saveCustomProfile,
  listEndpointModels,
  resolveGatewayBaseUrl,
  resolveModel,
  isCustomModelSpec,
  listCustomGateways,
  customProfileName,
  modelLabel,
  contextSuffix,
  vendorModelSpec,
  vendorModels,
  verifyModel,
  switchNote,
  deleteCustomGateway,
  deletedGatewayNote,
  type CustomGatewayEntry,
  type ModelId,
} from '../provider/provider.js';
import { CONTEXT_BUDGET_CHOICES, loadConfig, normalizeAutoCompact, writeContextTokens } from '../config.js';
import {
  checkWebSearch,
  normalizeWebSearchConfig,
  saveWebSearchConfig,
  webSearchConfigWarning,
  type WebSearchConfig,
} from '../provider/web-search.js';
import { VERSION } from '../version.js';
import { runAgentLoop, type PermissionRequest } from '../agent/loop.js';
import { withPlanMode } from '../agent/system-prompt.js';
import { AGENT_TOOL_NAMES, createToolSession } from '../agent/tools/index.js';
import { getPermissionMode, nextPermissionMode, setPermissionMode, subscribePermissionMode, type PermissionMode } from '../agent/permission.js';
import { invalidRulesWarning, loadPermissionRules, rememberAlways } from '../agent/permission-rules.js';
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
import { DEFAULT_KEEP_TURNS, compressSession, parseKeepCount, resolveContextTokens, shouldAutoCompact, transcriptEntries, splitTurns } from '../sessions/compact.js';
import { walkFiles } from '../agent/tools/fs-utils.js';
import { applyCompletion, filterFiles, mentionQuery } from './file-completion.js';
import {
  applySlashCompletion,
  filterSlashCommands,
  slashQuery,
} from './slash-completion.js';
import { resolveSubmitInput } from './submit.js';
import { submitSearchApiKey } from './search-setup.js';
import { reduceQueue, shouldResumeQueue, type QueueAction } from './input-queue.js';
import { createStreamThrottler } from './stream-throttle.js';
import { historyRule } from './history-rule.js';
import { listWindow } from './list-window.js';
import { fuzzyFilter } from './fuzzy-filter.js';
import { BRAND_GREEN } from './banner.js';
import { quietLibraryNoise } from '../provider/library-noise.js';
import { renderDiff } from './diff-render.js';
import { createTurnStats, recordCall, renderCollapsed, shouldCollapse, summaryLine } from './turn-summary.js';
import { sliceLiveTail } from './live-view.js';
import { clearScreen } from './clear-screen.js';
import { expansionTitle, latestFoldedIndex, NOTHING_FOLDED, stepFoldedIndex, windowedDetail } from './expansion.js';
import { buildSystemPrompt, INIT_PROMPT, loadProjectContext } from '../agent/system-prompt.js';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';

interface BannerData {
  logo: string;
  model: string;
  dir: string;
}

interface HistoryEntry {
  input: string;
  output: string;
  /** Tool-log detail hidden behind the collapse summary (ctrl+o reveals). */
  hiddenLines?: string[];
  /**
   * Header block printed with the entry, under its text: the startup banner
   * (first entry) and the entry that lands a model switch.
   */
  banner?: BannerData;
}

/** Key-input phases echo asterisks, never the typed secret (#4). */
export function inputEcho(phase: PromptPhase, input: string): string {
  const secret =
    phase === 'model_apikey' || phase === 'vendor_apikey' || phase === 'search_apikey';
  return secret ? '*'.repeat(input.length) : input;
}

type PromptPhase =
  | 'idle'
  | 'model_select'
  | 'custom_list'
  | 'model_pick'
  | 'model_name'
  | 'custom_baseurl'
  | 'vendor_apikey'
  | 'model_apikey'
  | 'model_check'
  | 'permission'
  | 'session_select'
  | 'search_provider'
  | 'search_apikey'
  | 'search_check'
  | 'model_context'
  | 'model_context_custom';

/** Providers offered by the /search setup flow (mirrors normalizeWebSearchConfig). */
const SEARCH_PROVIDERS: WebSearchConfig['provider'][] = ['tavily', 'brave'];

/**
 * Mode indicator (bottom-left, under the input box): color of the mode name —
 * green prompts before mutating tools, red prompts for nothing, blue denies them.
 */
const MODE_COLOR: Record<PermissionMode, string> = { ask: 'green', readonly: 'blue', plan: 'magenta', auto: 'red' };

interface REPLProps {
  ctx: CommandContext;
  /** Startup banner data; printed once as the first Static entry. */
  banner?: BannerData;
  /** Background auto-update outcome; a non-null message shows as a banner. */
  updateNotice?: Promise<string | null>;
}

export default function REPL({ ctx, banner, updateNotice }: REPLProps) {
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
  // Single commit for history + live stream: the legacy reconciler paints
  // per commit, so landing a turn and clearing the live region in two
  // commits flashes one duplicated tail frame (spec ruling #6).
  interface ChatView {
    history: HistoryEntry[];
    /**
     * Changes exactly when the history is replaced wholesale (/clear). It is
     * the key of <Static>, which then mounts afresh and prints its items
     * again — so it has to change in the same update as the history.
     */
    generation: number;
    liveOutput: string;
    /** Input echo shown at the top of the live region while a turn runs. */
    turnInput: string;
  }
  // The banner for the model in use right now. /clear prints it again, so it
  // must be read from the current prop, never from a copy kept at mount: the
  // model may have been switched since.
  const bannerEntry = banner
    ? { input: '', output: '', banner }
    : null;
  const [chat, setChat] = useState<ChatView>(() => ({
    // Banner prints once as the first static item (spec ruling #3).
    history: bannerEntry ? [bannerEntry] : [],
    generation: 0,
    liveOutput: '',
    turnInput: '',
  }));
  const liveOutputRef = useRef('');
  const turnDisplayRef = useRef('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState('');
  const [phase, setPhaseState] = useState<PromptPhase>('idle');
  // Synchronous mirror: queued-command chaining must read the CURRENT
  // phase right after a command opened a picker — React state alone lags
  // a render, and chaining into a picker would submit into it.
  const phaseRef = useRef<PromptPhase>('idle');
  const setPhase = useCallback((next: PromptPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
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
  // /models "custom" vendor: the saved custom gateways (each with its
  // address) followed by "+ 新建自定义模型…".
  const [customEntries, setCustomEntries] = useState<CustomGatewayEntry[]>([]);
  const [customCursor, setCustomCursor] = useState(0);
  // The saved entry waiting for the delete confirmation (y confirms).
  const [deleteTarget, setDeleteTarget] = useState<CustomGatewayEntry | null>(null);
  // Why the entry under the cursor cannot be deleted, shown under the list.
  const [customNotice, setCustomNotice] = useState<string | null>(null);
  // /models budget step: cursor over CONTEXT_BUDGET_CHOICES; the verified
  // switch args wait here while the user picks a context budget.
  const [modelContextCursor, setModelContextCursor] = useState(0);
  const pendingSwitchRef = useRef<{
    spec: string;
    /** Id the switch ends on (the new gateway's own name when it creates one). */
    target: string;
    displayName: string;
    apiKey: string;
    message: string;
    served?: string;
    /** A custom gateway set up in this flow: saved as its own entry once the switch applies. */
    newCustom?: { baseUrl: string; model: string };
  } | null>(null);

  // /search setup flow: cursor over SEARCH_PROVIDERS, ref carries the pick.
  const [searchCursor, setSearchCursor] = useState(0);
  const searchProviderRef = useRef<WebSearchConfig['provider']>('tavily');
  // Generation guard: bumping invalidates an in-flight connectivity check,
  // so a cancelled /search never writes config or yanks the phase back.
  const searchRunIdRef = useRef(0);
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

  // Permission mode lives in the agent/permission.ts module store: subscribing
  // keeps the mode indicator current for every switch path (Shift+Tab, /mode).
  const permMode = useSyncExternalStore(subscribePermissionMode, getPermissionMode);

  const addHistory = useCallback((entry: HistoryEntry) => {
    setChat(prev => ({ ...prev, history: [...prev.history, entry] }));
  }, []);

  /** Turn-time streaming target: the live region (never mutates history). */
  const appendLive = useCallback((chunk: string) => {
    liveOutputRef.current += chunk;
    setChat(prev => ({ ...prev, liveOutput: prev.liveOutput + chunk }));
  }, []);

  // Busy-input queue: prompts typed while the agent works. Natural turn end
  // auto-continues the head; cancel/error freezes (manual Enter resumes);
  // Esc at idle clears. Ref mirror avoids stale closures in runChat's finally.
  const [inputQueue, setInputQueue] = useState<string[]>([]);
  const inputQueueRef = useRef<string[]>([]);
  const applyQueue = useCallback((action: QueueAction) => {
    const next = reduceQueue(inputQueueRef.current, action);
    inputQueueRef.current = next.queue;
    setInputQueue(next.queue);
    return next;
  }, []);
  const handleSubmitRef = useRef<(raw: string, fromQueue?: boolean) => Promise<void>>(async () => {});

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
  // Auto-compact breaker state: consecutive failures + warned-once flag.
  const autoCompactFailuresRef = useRef(0);
  const autoCompactWarnedRef = useRef(false);
  const lastSessionsRef = useRef<string[]>([]);
  // Snapshot for the /resume arrow-key picker (set together with the phase).
  const sessionPickerRef = useRef<SessionRecord[]>([]);
  /** Load a record into the live conversation; shared by /resume arg and picker paths. */
  const applyResume = useCallback(
    (record: SessionRecord, _inputLine: string) => {
      conversationRef.current = { id: record.id, createdAt: record.createdAt, titled: true };
      conversationTitleRef.current = record.title;
      summaryRef.current = record.summary ?? null;
      messagesRef.current = record.messages;
      toolSessionRef.current = createToolSession(process.cwd());
      // The confirmation line now lands WITH the streamed digest in
      // resumeWith (live region hosts the digest while compacting).
    },
    [],
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
  // ctrl+o panel: the folded turn whose detail is shown above the input
  // box, NOTHING_FOLDED while it says there is none, null while it is closed.
  const [expansion, setExpansion] = useState<number | null>(null);
  // The panel shows finished turns; while the agent works, its own tool
  // calls are on show.
  useEffect(() => {
    if (busy) setExpansion(null);
  }, [busy]);
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

  // Model picker search: what is typed in the picker narrows the list
  // (gateways list 300+ models).
  const pickMatches = useMemo(
    () => fuzzyFilter(pickOptions, input, name => name),
    [pickOptions, input],
  );

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
  // Web search misconfiguration: one line on startup; a simply-absent
  // section stays silent (never nags unconfigured users).
  useEffect(() => {
    const warning = webSearchConfigWarning(loadConfig().webSearch);
    if (warning) {
      addHistory({ input: '', output: warning });
      dragFlush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Miswritten permission rules are ignored; say so once on startup.
  useEffect(() => {
    const warning = invalidRulesWarning(loadPermissionRules(AGENT_TOOL_NAMES));
    if (warning) {
      addHistory({ input: '', output: warning });
      dragFlush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The terminal is ours while the REPL is mounted. Ink has taken
  // console.* over by the time this effect runs; wrap what is in place so
  // LangChain's per-chunk merge warnings cannot flood the screen.
  useEffect(() => quietLibraryNoise(), []);
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
    applyResume(record, inputLine);
    const confirm = `已恢复「${record.title}」（${record.messages.length} 条消息，${record.model}），继续对话。`;
    let oldTurns = 0;
    if (turns.length > keepTurns && process.env.TRANSCODE_MOCK !== '1') {
      setBusyBoth(true);
      try {
        const outcome = await runCompaction(record, keepTurns);
        if (outcome.compressed) {
          oldTurns = turns.length - keepTurns;
          summaryRef.current = outcome.record.summary ?? null;
          messagesRef.current = outcome.record.messages;
          saveSession(outcome.record);
          // Manual success heals the auto-compact breaker too.
          autoCompactFailuresRef.current = 0;
          autoCompactWarnedRef.current = false;
          landLive({ input: inputLine, prefix: confirm });
        } else {
          // Failure: partial digest + warning merged as ONE entry (ruling #5).
          landLive({
            input: inputLine,
            prefix: confirm,
            suffix: `\n⚠ 提炼失败(${outcome.error ?? '未知'}),已恢复完整对话。`,
          });
        }
      } catch {
        landLive({
          input: inputLine,
          prefix: confirm,
          suffix: '\n⚠ 提炼失败,已恢复完整对话。',
        });
      } finally {
        setBusyBoth(false);
      }
    } else {
      addHistory({ input: inputLine, output: confirm });
    }
    // Restore in the original conversation form: each message becomes a
    // history entry (rule-framed questions, full-length replies).
    for (const entry of transcriptEntries(summaryRef.current, messagesRef.current, oldTurns || undefined)) {
      addHistory(entry);
    }
    dragFlush();
  };

  /**
   * Frame-level coalescing for streaming output. Stock Ink re-renders
   * synchronously per setState, so per-delta appends rewrite the whole
   * history frame dozens of times per second — that is the flicker.
   * Everything within a turn flows through here and is flushed at turn
   * end (order preserved; ≤32ms latency, invisible).
   */
  const streamAppendRef = useRef<ReturnType<typeof createStreamThrottler> | null>(null);
  if (streamAppendRef.current === null) {
    streamAppendRef.current = createStreamThrottler(appendLive, 32);
  }
  const streamAppend = (chunk: string): void => {
    streamAppendRef.current?.push(chunk);
  };

  /** Show the input echo at the top of the live region while a turn runs. */
  const beginTurnLive = useCallback((display: string) => {
    turnDisplayRef.current = display;
    setChat(prev => ({ ...prev, turnInput: display }));
  }, []);

  /**
   * Land the streamed live output as one static history entry and clear the
   * live region in a single commit. Flushes the throttler first and builds
   * output = prefix + live + suffix AFTER the flush — never pre-capture the
   * live text at the call site (the tail may sit in the throttler). Ruling #6.
   */
  const landLive = useCallback(
    (entry: {
      input: string;
      prefix?: string;
      suffix?: string;
      hiddenLines?: string[];
    }) => {
      streamAppendRef.current?.flush();
      const output = `${entry.prefix ?? ''}${liveOutputRef.current}${entry.suffix ?? ''}`;
      // TRANSCODE_DEBUG_FRAME=1: the tail-window budget is the one seam no
      // unit test can see (it depends on the real terminal's rows).
      if (process.env.TRANSCODE_DEBUG_FRAME) {
        process.stderr.write(
          `[frame] outputChars=${output.length} rows=${stdout?.rows ?? '?'}\n`,
        );
      }
      liveOutputRef.current = '';
      setChat(prev => ({
        ...prev,
        history: [...prev.history, { input: entry.input, output, hiddenLines: entry.hiddenLines }],
        liveOutput: '',
        turnInput: '',
      }));
    },
    [],
  );

  /**
   * One shared compaction run for /resume and /compact: fast-model routing
   * (routing.compact → fallback current model) with the digest streamed
   * live into the chat area.
   */
  const runCompaction = async (
    record: SessionRecord,
    keepTurns: number,
  ): Promise<{ compressed: boolean; record: SessionRecord; error?: string }> => {
    streamAppend('\n正在提炼前情提要…\n');
    try {
      const outcome = await compressSession(
        record,
        createModel(getRouting().compact ?? ctx.modelId).model,
        keepTurns,
        (delta) => streamAppend(delta),
      );
      streamAppend('\n\n');
      return outcome;
    } catch (error) {
      streamAppend('\n\n');
      return {
        compressed: false,
        record,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

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

  // Auto-compact (Claude Code style proactive): threshold check before each
  // turn, same runCompaction as /compact and resume. Circuit breaker stops
  // after 3 consecutive failures; auto failures warn once per session.
  const autoCompactIfNeeded = async (): Promise<void> => {
    if (!conversationRef.current) return;
    if (process.env.TRANSCODE_MOCK === '1') return;
    if (autoCompactFailuresRef.current >= 3) return;
    const budget = resolveContextTokens(ctx.modelId);
    if (!budget.enabled || budget.tokens <= 0) return;
    if (!shouldAutoCompact(messagesRef.current, { contextTokens: budget.tokens })) return;
    const cfg = normalizeAutoCompact(loadConfig().autoCompact);
    try {
      // Digest streams into the live region; it lands as its own entry here
      // (before the turn's echo) and never mixes into the turn entry.
      const record = buildSessionRecord({
        id: conversationRef.current.id,
        title: conversationTitleRef.current,
        createdAt: conversationRef.current.createdAt,
        cwd: process.cwd(),
        model: ctx.modelId,
        messages: messagesRef.current,
        summary: summaryRef.current,
      });
      const outcome = await runCompaction(record, cfg.keepTurns);
      if (!outcome.compressed) {
        // Without an error it is a no-op (≤ keepTurns turns — e.g. one giant
        // turn over threshold): nothing compressible, skip without touching
        // the breaker. The streamed banner still lands as a stub entry.
        if (outcome.error) throw new Error(outcome.error);
        landLive({ input: '' });
        return;
      }
      summaryRef.current = outcome.record.summary ?? null;
      messagesRef.current = outcome.record.messages;
      saveSession(outcome.record);
      autoCompactFailuresRef.current = 0;
      autoCompactWarnedRef.current = false;
      landLive({ input: '' });
      for (const entry of transcriptEntries(summaryRef.current, messagesRef.current)) {
        addHistory(entry);
      }
    } catch (error) {
      autoCompactFailuresRef.current += 1;
      const reason = error instanceof Error ? error.message : String(error);
      if (autoCompactFailuresRef.current >= 3) {
        landLive({
          input: '',
          suffix: `\n⚠ 自动压缩已暂停(连续 3 次失败,最后原因:${reason})。可 /compact 手动压缩或检查 routing.compact 配置。`,
        });
      } else if (!autoCompactWarnedRef.current) {
        autoCompactWarnedRef.current = true;
        landLive({ input: '', suffix: `\n⚠ 自动压缩失败(${reason}),本轮继续。` });
      } else {
        landLive({ input: '' });
      }
    }
  };

  const runChat = useCallback(
    async (text: string, display?: string) => {
      // Concurrency guard (#9): the queue continuation and a user Enter can
      // both reach here across an await boundary; this is the single choke
      // point, so re-queue instead of running a second concurrent turn.
      if (busyRef.current) {
        applyQueue({ type: 'enqueue', text });
        return;
      }
      setBusyBoth(true);
      const controller = new AbortController();
      abortRef.current = controller;

      let endedNaturally = false;
      let turnHiddenLines: string[] | undefined;
      try {
        // Inside the try (#10): a throw in the pre-turn段 (auto-compaction,
        // live-region setup) must still clear busy in the finally below.
        await autoCompactIfNeeded();
        // No host entry: the input echo lives in the live region and the whole
        // turn lands in <Static> as one immutable entry when it ends.
        beginTurnLive(display ?? text);
        // Fixed for the turn: the mode may be switched while the agent runs.
        const planMode = getPermissionMode() === 'plan';

        const provider =
          process.env.TRANSCODE_MOCK === '1'
            ? undefined
            : createModel(ctx.modelId);

        const projectContext = await loadProjectContext(process.cwd());
        const basePrompt = buildSystemPrompt(
          projectContext,
          provider ? { modelName: provider.config.name } : undefined,
        );
        // The loop keeps whatever system message leads the history, so the
        // turn's variant (plan mode appends its instruction) must be the one
        // placed here. It is rebuilt every turn, so it follows mode switches.
        const systemPrompt = planMode ? withPlanMode(basePrompt) : basePrompt;
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
        const turnBudget = resolveContextTokens(ctx.modelId);
        const result = await runAgentLoop({
          model: provider?.model,
          cwd: process.cwd(),
          messages: loopMessages,
          systemPrompt,
          planMode,
          permissionMode: getPermissionMode(),
          ...(turnBudget.enabled && turnBudget.tokens > 0
            ? { contextTokens: turnBudget.tokens }
            : {}),
          signal: controller.signal,
          toolSession: toolSessionRef.current,
          onEvent: event => {
            if (event.type === 'text') {
              streamAppend(lastWasTool ? `\n${event.text}` : event.text);
              turnAssistantText += event.text;
              lastWasTool = false;
            } else if (event.type === 'max_turns_reached') {
              streamAppend(
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
              const marker = event.skippedPermission
                ? ' ✓ (read-only)'
                : event.allowedBy
                  ? ` ✓ (allowed: ${event.allowedBy})`
                  : event.ok
                    ? ' ✓'
                    : ' ✗';
              recordCall(stats, event.name, event.ok);
              setLiveTool(prev =>
                prev ? { ...prev, ok: stats.ok, fail: stats.fail } : prev,
              );
              if (event.diff) {
                // Edits and writes stay visible immediately — rare and important.
                streamAppend(`\n⚙ ${title} ${marker}\n${renderDiff(event.diff)}`);
              } else if (event.name === 'todo_write' || event.name === 'dispatch_agent') {
                // Progress state and sub-agent reports: show immediately.
                streamAppend(`\n${event.output}`);
              } else {
                bufferedLines.push(`\n⚙ ${title} ${marker}`);
              }
              lastWasTool = true;
            }
          },
          requestPermission: request => askInTerminal(request, controller.signal),
        });

        // A finished plan is only useful once the session can act again: in
        // plan mode the next shift+tab lands on auto, /mode ask keeps prompts.
        if (planMode && turnAssistantText.includes('PLAN READY')) {
          streamAppend('\n（方案已就绪：shift+tab 切到 auto 或输入 /mode ask，然后回复“执行”）');
        }

        // Collapse long turns into one summary line; short turns stay expanded.
        // Collapsed detail is kept (hiddenLines) so ctrl+o can reveal it.
        if (shouldCollapse(stats)) {
          const line = summaryLine(stats);
          if (line) streamAppend(`\n${renderCollapsed(line, bufferedLines)}`);
          turnHiddenLines = bufferedLines;
        } else {
          for (const line of bufferedLines) streamAppend(line);
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
        if (controller.signal.aborted) {
          streamAppend('\n(cancelled)');
        } else {
          endedNaturally = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        streamAppend(`\n⚠ ${message}`);
        if (/api.?key/i.test(message)) {
          streamAppend(`\n(run "models" to switch model + set key, or export its env var)`);
        }
      } finally {
        // Land the whole turn as one immutable static entry and clear the
        // live region in a single commit, then let the queue continue.
        landLive({
          input: turnDisplayRef.current,
          hiddenLines: turnHiddenLines,
        });
        setBusyBoth(false);
        abortRef.current = undefined;
        setLiveTool(null);
        // The agent may have created/removed files; rebuild @-completion list.
        setFileList(null);
        dragFlush();
        // Queue continuation: only a naturally-ended turn auto-submits the
        // next queued prompt; cancel and error freeze it (Enter resumes).
        const queued = applyQueue(endedNaturally ? { type: 'turnEnded' } : { type: 'frozen' });
        if (endedNaturally && queued.submit) {
          void handleSubmitRef.current(queued.submit, true);
        }
      }
    },
    [ctx.modelId, addHistory, askInTerminal, setBusyBoth, dragFlush, applyQueue, beginTurnLive, landLive],
  );

  const enterModelSelect = useCallback(() => {
    // Start on the current model; a saved custom gateway counts as "custom".
    const currentIdx = models.findIndex(
      m => m.id === ctx.modelId || (m.id === 'custom' && isCustomModelSpec(ctx.modelId)),
    );
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
    (
      spec: string,
      displayName: string,
      apiKey: string,
      checkMessage: string,
      served?: string,
      /** A custom gateway set up in this flow: saved as its own entry, then switched to. */
      newCustom?: { baseUrl: string; model: string },
    ) => {
      let target = spec;
      let label = displayName;
      if (newCustom) {
        target = saveCustomProfile(newCustom);
        label = target;
      }
      registerApiKey(target.split(':')[0]!, apiKey);
      ctx.setModelId(target);
      setPreferredModel(target);
      // What was actually requested (a custom entry's name may be a
      // sanitised form of its model id): the note is only for a gateway
      // that really maps the name onto another model.
      const pickedModel = resolveModel(target).model || target.split(':').pop() || label;
      addHistory({
        input: '••••••••',
        output: `${checkMessage} — ${switchNote(label, pickedModel, served)}`,
        // A printed header cannot change in place (Static prints each entry
        // once), so the switch prints it again for the model now in use.
        banner: banner ? { ...banner, model: `${modelLabel(target)}${contextSuffix(target)}` } : undefined,
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
    [ctx, addHistory, dragFlush, banner],
  );

  /**
   * Verify a selection and apply it, or surface the error and re-prompt.
   * `staged` is a custom gateway still being set up: it is checked against
   * the typed address and only saved (as its own entry) once it passes.
   */
  const finalizeSelection = useCallback(
    async (
      spec: string,
      displayName: string,
      apiKey: string,
      staged?: { baseUrl: string; model: string },
    ) => {
      if (process.env.TRANSCODE_SKIP_MODEL_CHECK === '1') {
        applyModelSwitch(spec, displayName, apiKey, '已跳过连通性测试', undefined, staged);
        return;
      }
      setPhase('model_check');
      const result = await verifyModel(spec, apiKey, staged);
      if (result.ok) {
        // Budget picker sits between verification and applying the switch.
        const newCustom = staged
          ? { baseUrl: result.baseUrl ?? staged.baseUrl, model: staged.model }
          : undefined;
        pendingSwitchRef.current = {
          spec,
          // The budget picked next is recorded under the id the switch ends
          // on: a new custom gateway's own name, not the staging spec.
          target: newCustom ? customProfileName(newCustom.model, newCustom.baseUrl) : spec,
          displayName,
          apiKey,
          message: `✓ ${result.message}`,
          served: result.served,
          newCustom,
        };
        setModelContextCursor(0);
        setPhase('model_context');
        commitInput('');
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

  // /search key step: orchestration lives in search-setup.ts (tested there).
  const handleSearchApiKey = useCallback(
    async (value: string) => {
      const runId = ++searchRunIdRef.current;
      const provider = searchProviderRef.current;
      setPhase('search_check');
      await submitSearchApiKey(value, provider, {
        savedConfig: () => normalizeWebSearchConfig(loadConfig().webSearch),
        check: (cfg) => checkWebSearch(cfg),
        save: saveWebSearchConfig,
        notify: (output) => addHistory({ input: '••••••••', output }),
        onOutcome: (phase) => setPhase(phase),
        isStale: () => searchRunIdRef.current !== runId,
      });
      dragFlush();
    },
    [addHistory, dragFlush],
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
        // The address may be typed Claude-Code-style (the gateway root, as in
        // ANTHROPIC_BASE_URL): resolve the path the gateway actually serves
        // and keep it — it is what gets saved for this gateway.
        const effective = await resolveGatewayBaseUrl(customBaseDraft, apiKey);
        setCustomBaseDraft(effective);
        setCustomKeyDraft(apiKey);
        setPickOptions([]);
        setPickCursor(0);
        setPickLive(false);
        setPhase('model_pick');
        commitInput('');
        setPickLoading(true);
        const live = await listEndpointModels('', { baseUrl: effective, apiKey });
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

  /** Forgets the conversation in progress: what the model is handed next starts empty. */
  const startNewConversation = useCallback(() => {
    conversationRef.current = null;
    conversationTitleRef.current = '';
    summaryRef.current = null;
    messagesRef.current = [];
    toolSessionRef.current = createToolSession(process.cwd());
  }, []);

  const handleSubmit = useCallback(async (raw: string, fromQueue = false) => {
    // Bare Enter is a no-op except at the apikey prompt, where it means
    // "reuse the saved key" (the prompt's 回车沿用 hint).
    const trimmed = resolveSubmitInput(phase, raw);
    if (trimmed === null) return;

    if (phase === 'vendor_apikey' || phase === 'model_apikey' || phase === 'model_check') {
      await handleApiKey(trimmed);
      commitInput('');
      return;
    }

    if (phase === 'model_context_custom') {
      const tokens = Number(trimmed);
      if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
        addHistory({ input: trimmed, output: '请输入正整数 token 数(例如 1000000),或 Esc 取消。' });
        return;
      }
      const pending = pendingSwitchRef.current!;
      pendingSwitchRef.current = null;
      writeContextTokens(pending.target, tokens);
      setPhase('idle');
      applyModelSwitch(pending.spec, pending.displayName, pending.apiKey, pending.message, pending.served, pending.newCustom);
      commitInput('');
      return;
    }

    if (phase === 'search_apikey') {
      await handleSearchApiKey(trimmed);
      commitInput('');
      return;
    }

    if (phase === 'search_check') {
      // #7: previously a silent swallow — the typed text hung in the box
      // while Enter did nothing. Clear it with a notice instead.
      if (trimmed) {
        addHistory({ input: trimmed, output: '搜索配置校验中,请稍候…' });
        commitInput('');
      }
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
        await finalizeSelection('custom', `custom/${trimmed}`, customKeyDraft, {
          baseUrl: customBaseDraft,
          model: trimmed,
        });
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

    if (cmdName === 'search') {
      addHistory({ input: trimmed, output: 'Select a search provider (↑↓ to navigate, Enter to select):' });
      setSearchCursor(0);
      setPhase('search_provider');
      commitInput('');
      dragFlush();
      return;
    }

    if (cmdName === 'new') {
      startNewConversation();
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
      // No args: show the effective context-budget config instead of running.
      // (Before the conversation guard — viewing config needs no session.)
      if (args.length === 0 || !args[0]?.trim()) {
        const budget = resolveContextTokens(ctx.modelId);
        const sourceLabel =
          budget.source === 'byModel' ? '按模型(byModel)' :
          budget.source === 'env' ? '环境变量' :
          budget.source === 'global' ? '全局配置' : '默认';
        const approxChars = budget.tokens * 4; // 英文口径;中文约 ×1.5
        addHistory({
          input: trimmed,
          output:
            `上下文预算 — 模型 ${ctx.modelId}\n` +
            `生效: ${budget.tokens.toLocaleString()} tokens(约 ${approxChars.toLocaleString()} 字符)· 来源:${sourceLabel}\n` +
            `自动压缩:${budget.enabled ? '开' : '关'} · keepTurns:${normalizeAutoCompact(loadConfig().autoCompact).keepTurns}\n` +
            `配置:autoCompact.byModel / contextTokens(~/.transcode.json),/models 流程可交互设置`,
        });
        finishCompact();
        return;
      }
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
          : await runCompaction(record, keepN);
        if (outcome.compressed) {
          summaryRef.current = outcome.record.summary ?? null;
          messagesRef.current = outcome.record.messages;
          saveSession(outcome.record);
          // Manual success heals the auto-compact breaker too.
          autoCompactFailuresRef.current = 0;
          autoCompactWarnedRef.current = false;
          landLive({
            input: trimmed,
            suffix: `已压缩:旧 ${turns.length - keepN} 轮提炼为前情提要,保留最近 ${keepN} 轮。`,
          });
          for (const entry of transcriptEntries(summaryRef.current, messagesRef.current)) {
            addHistory(entry);
          }
        } else {
          landLive({
            input: trimmed,
            suffix: `\n⚠ 压缩失败(${outcome.error ?? '未知'}),会话保持原样。`,
          });
        }
      } catch {
        landLive({ input: trimmed, suffix: '\n⚠ 压缩失败,会话保持原样。' });
      } finally {
        setBusyBoth(false);
      }
      finishCompact();
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
      const result = await executeCommand(cmd, args, ctx);

      if (result.exit) {
        exit();
        return;
      }

      if (cmdName === 'clear') {
        // A clean screen with the banner back at the top. Only the screen is
        // cleared: the conversation itself goes on (that is /new's job).
        // The screen is scrolled into the terminal's scrollback first, so the
        // earlier turns can still be read by scrolling up.
        setExpansion(null);
        // Written before the repaint below, so the cursor is at the top of
        // an empty screen when Ink prints into it.
        stdout?.write(clearScreen(stdout?.rows ?? 24));
        // Printed history is append-only: nothing in it can be taken back.
        // /clear replaces it and mounts <Static> afresh in the SAME update,
        // so the fresh mount prints the banner again, from the top. In a
        // render of its own, the new mount would first print the old transcript.
        setChat(prev => ({
          ...prev,
          generation: prev.generation + 1,
          history: bannerEntry ? [bannerEntry] : [],
        }));
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
    // Queued slash chain (#9): a command never runs the agent loop, so a
    // queued prompt behind it would freeze forever. Only a submission that
    // CAME from the queue chains on, and only when the command left the
    // prompt idle — pickers consume the next input themselves.
    if (fromQueue && phaseRef.current === 'idle') {
      const next = applyQueue({ type: 'submitNext' });
      if (next.submit) void handleSubmitRef.current(next.submit, true);
    }
    dragFlush();

    commitInput('');
    setHistoryIndex(-1);
    setSavedInput('');
  }, [exit, ctx, phase, handleApiKey, addHistory, enterModelSelect, commitInput, dragFlush, runChat, startNewConversation, bannerEntry]);
  // Late-bound so runChat's finally can auto-continue queued prompts.
  // Written during RENDER, not in an effect: the finally may fire in the
  // same commit's aftermath, and an effect-run assignment would leave a
  // stale no-op handler for that window (a queued prompt would vanish).
  handleSubmitRef.current = handleSubmit;

  // Ink binds the key handler in an effect, which React runs only after the
  // frame is drawn — and late, when the machine is busy. A key that arrives
  // in between (a fast hand, a paste) reached the handler of the state
  // BEFORE a prompt or picker appeared, and was taken as plain input. So the
  // listener Ink binds never changes: it calls the newest handler, which is
  // stored as the component renders and is therefore in step with the frame.
  type KeyHandler = Parameters<typeof useInput>[0];
  const keyHandlerRef = useRef<KeyHandler>(() => {});
  keyHandlerRef.current = (ch, key) => {
    if (process.env.TRANSCODE_DEBUG_KEYS === '1') {
      // eslint-disable-next-line no-console
      console.error(`CB ${JSON.stringify(ch)} ret=${key.return} esc=${key.escape}`);
    }
    // ctrl+o toggles the panel with the detail of folded turns (expansion.ts).
    // Printed entries never change, so the detail is shown in the live region
    // instead of being printed under its turn. While the agent works, its
    // own tool calls are on show and the key does nothing.
    if (key.ctrl && (ch === 'o' || ch === 'O')) {
      if (!busyRef.current) {
        setExpansion(current => (current === null ? latestFoldedIndex(chat.history) : null));
        dragFlush();
      }
      return;
    }
    // "Nothing is folded" goes away on the next key, which keeps its meaning.
    if (expansionIndex === NOTHING_FOLDED) {
      setExpansion(null);
      dragFlush();
    }
    // Esc closes the panel first; only with it closed does Esc mean the rest.
    if (key.escape && expansionIndex !== null) {
      setExpansion(null);
      dragFlush();
      return;
    }
    // Detail panel open: the arrows move between folded turns, not through
    // the input history — unless a file mention popup is open on top.
    if (
      expansionIndex !== null &&
      expansionIndex >= 0 &&
      (key.upArrow || key.downArrow) &&
      !(mentionActive && mentionCandidates.length > 0)
    ) {
      const next = stepFoldedIndex(chat.history, expansionIndex, key.upArrow ? -1 : 1);
      if (next !== expansionIndex) {
        setExpansion(next);
        dragFlush();
      }
      return;
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
    // Model picker: Esc clears the search before it leaves the picker.
    if (key.escape && phase === 'model_pick' && input) {
      commitInput('');
      setPickCursor(0);
      return;
    }
    if (key.escape) {
      // Budget menu / custom input: Esc = SKIP (keep current budget) and
      // still apply the verified model switch — the generic phase cancel
      // below must never discard a completed model selection.
      if (
        (phase === 'model_context' || phase === 'model_context_custom') &&
        pendingSwitchRef.current
      ) {
        const pending = pendingSwitchRef.current;
        pendingSwitchRef.current = null;
        setPhase('idle');
        commitInput('');
        applyModelSwitch(pending.spec, pending.displayName, pending.apiKey, pending.message, pending.served, pending.newCustom);
        return;
      }
      // While generating, Esc cancels instead of exiting.
      if (busyRef.current) {
        // Busy covers both a live agent turn (abort it) and async
        // compaction (no controller yet — Esc must not quit the app).
        abortRef.current?.abort();
        return;
      }
      // The custom gateway list is a sub-menu of the vendor list: back one level.
      if (phase === 'custom_list') {
        // A pending delete question is dismissed first; the next Esc goes back.
        if (deleteTarget !== null) setDeleteTarget(null);
        else setPhase('model_select');
        return;
      }
      if (phase !== 'idle') {
        // Invalidate any in-flight /search connectivity check: its late
        // result must not write config or pull the user back into the flow.
        searchRunIdRef.current++;
        setPhase('idle');
        setVendor(null);
        commitInput('');
        addHistory({ input: '', output: 'Cancelled.' });
        return;
      }
      if (inputQueueRef.current.length > 0) {
        applyQueue({ type: 'clear' });
        addHistory({ input: '', output: '(队列已清空)' });
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
      if (ch === 'a' || ch === 'A') {
        // Offered only when the mode caused the question: a remembered rule
        // ranks below a configured `ask` rule, so "always" would do nothing there.
        const pending = pendingPermissionRef.current;
        if (pending?.request.alwaysRule) {
          rememberAlways({ name: pending.request.name, input: pending.request.input }, process.cwd(), 'allow');
          pending.resolve(true);
        }
        return;
      }
      if (ch === 'n' || ch === 'N') {
        pendingPermissionRef.current?.resolve(false);
        return;
      }
      return;
    }

    if (phase === 'model_context') {
      if (key.upArrow) {
        setModelContextCursor((c) => (c - 1 + CONTEXT_BUDGET_CHOICES.length) % CONTEXT_BUDGET_CHOICES.length);
        return;
      }
      if (key.downArrow) {
        setModelContextCursor((c) => (c + 1) % CONTEXT_BUDGET_CHOICES.length);
        return;
      }
      if (key.escape) {
        const pending = pendingSwitchRef.current;
        pendingSwitchRef.current = null;
        setPhase('idle');
        if (pending) applyModelSwitch(pending.spec, pending.displayName, pending.apiKey, pending.message, pending.served, pending.newCustom);
        return;
      }
      if (key.return) {
        const choice = CONTEXT_BUDGET_CHOICES[modelContextCursor]!;
        const pending = pendingSwitchRef.current!;
        if (choice.custom) {
          setPhase('model_context_custom');
          commitInput('');
          return;
        }
        pendingSwitchRef.current = null;
        writeContextTokens(pending.target, choice.tokens);
        setPhase('idle');
        commitInput('');
        applyModelSwitch(pending.spec, pending.displayName, pending.apiKey, pending.message, pending.served, pending.newCustom);
        return;
      }
      return;
    }

    if (phase === 'search_provider') {
      if (key.upArrow) {
        setSearchCursor((c) => (c - 1 + SEARCH_PROVIDERS.length) % SEARCH_PROVIDERS.length);
        return;
      }
      if (key.downArrow) {
        setSearchCursor((c) => (c + 1) % SEARCH_PROVIDERS.length);
        return;
      }
      if (key.return) {
        const provider = SEARCH_PROVIDERS[searchCursor];
        searchProviderRef.current = provider;
        const saved = normalizeWebSearchConfig(loadConfig().webSearch);
        const hint = saved?.provider === provider ? '(Enter 沿用已存 key)' : '';
        addHistory({ input: '', output: `搜索商:${provider}。输入 API key ${hint}:` });
        setPhase('search_apikey');
        commitInput('');
        return;
      }
      return;
    }

    if (phase === 'model_select') {
      if (key.return) {
        const selected = models[modelCursor];
        if (selected.id === 'custom') {
          // Never straight to the key prompt: the saved gateways are listed
          // with their addresses, and a new one can be added next to them.
          setVendor(null);
          setCustomEntries(listCustomGateways());
          setCustomCursor(0);
          setCustomNotice(null);
          setPhase('custom_list');
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

    if (phase === 'custom_list') {
      const rows = customEntries.length + 1; // + "新建自定义模型…"
      if (deleteTarget !== null) {
        if (ch === 'y' || ch === 'Y') {
          const target = deleteTarget;
          setDeleteTarget(null);
          const removed = deleteCustomGateway(target.spec);
          if (removed) {
            addHistory({ input: '', output: deletedGatewayNote(removed) });
            setCustomEntries(listCustomGateways());
            dragFlush();
          }
        } else {
          setDeleteTarget(null); // any other key only dismisses the question
        }
        return;
      }
      // Plain d only: ctrl+d (the usual exit key) must not ask to delete.
      if (ch === 'd' && !key.ctrl && !key.meta) {
        const entry = customEntries[customCursor];
        if (entry) {
          // Deleting the model the session runs on would swap it mid-conversation.
          // The legacy slot also backs every "custom:MODEL" spec.
          const inUse =
            ctx.modelId === entry.spec || (entry.spec === 'custom' && ctx.modelId.startsWith('custom:'));
          if (inUse) {
            setCustomNotice(`${entry.model} 正在使用中，不能删除，请先切换到其它模型`);
          } else {
            setDeleteTarget(entry);
          }
        }
        return;
      }
      if (key.return) {
        const entry = customEntries[customCursor];
        if (entry) {
          // Saved gateway: its key prompt (Enter reuses the saved key), as before.
          beginKeyStep(entry.spec, entry.spec === 'custom' ? `custom/${entry.model}` : entry.spec);
        } else {
          setPhase('custom_baseurl');
          commitInput('');
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        setCustomCursor(prev => (prev + (key.upArrow ? -1 : 1) + rows) % rows);
        setCustomNotice(null); // the hint was about the entry just left
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
      const total = pickMatches.length + 1; // matches of the search + "自定义模型名…"
      const pickRow = Math.min(pickCursor, pickMatches.length); // the list may have shrunk under the cursor
      if (key.return) {
        if (pickRow >= pickMatches.length) {
          // "自定义模型名…": what was typed carries over as the name draft.
          setPhase('model_name');
          return;
        }
        const modelName = pickMatches[pickRow]!;
        if (pendingModel === null && customBaseDraft) {
          // Custom gateway: model chosen from the live list.
          void finalizeSelection('custom', `custom/${modelName}`, customKeyDraft, {
            baseUrl: customBaseDraft,
            model: modelName,
          });
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
        setPickCursor((pickRow - 1 + total) % total);
        return;
      }
      if (key.downArrow) {
        setPickCursor((pickRow + 1) % total);
        return;
      }
      // Anything else (search characters, Backspace) falls through to the
      // shared input handling below: what is typed filters this list.
    }

    // Shift+Tab cycles permission modes (ask → readonly → plan → auto). Runs FIRST:
    // ink reports shift+tab as a bare {tab} key (raw input '[Z'), so every
    // later tab branch (popup completion, slash completion) would misfire.
    if (key.tab && (ch === '[Z' || key.shift) && phase === 'idle') {
      const next = nextPermissionMode(getPermissionMode());
      // Silent: the mode indicator (subscribed to the permission store) is
      // the only feedback. Nothing lands in history here, so nudge the
      // paint on a timer the same way command submission does.
      setPermissionMode(next);
      dragFlush();
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
      if (busyRef.current) {
        // Still generating: queue the prompt; it submits when the turn ends
        // naturally (cancel/error freeze it — idle empty-Enter resumes).
        const trimmed = inputRef.current.trim();
        if (trimmed) {
          applyQueue({ type: 'enqueue', text: trimmed });
          commitInput('');
        }
        return;
      }
      if (shouldResumeQueue(phase, inputRef.current, inputQueueRef.current.length)) {
        const next = applyQueue({ type: 'submitNext' });
        if (next.submit) void handleSubmit(next.submit, true);
        return;
      }
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
      const inputs = chat.history.map(h => h.input);
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

      const inputs = chat.history.map(h => h.input);
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
  };
  const forwardKey = useCallback<KeyHandler>((ch, key) => keyHandlerRef.current(ch, key), []);
  useInput(forwardKey, {});

  // Live-region tail window: keep the interactive frame shorter than the
  // terminal or Ink falls back to clearing + repainting everything.
  // Wrapped-row budget (review finding: Ink counts folded screen rows, so
  // logical-line budgets blow on long CJK/diff lines): rows-15 with wide
  // chars measured at 2 columns, columns-2 for paddingX. The 15 counts the
  // fixed rows around the tail (turn echo, the three-line permission
  // question, input box + mode indicator, …).
  const liveTail = sliceLiveTail(
    chat.liveOutput,
    (stdout?.rows ?? 24) - 15,
    (stdout?.columns ?? 80) - 2,
  );

  // Model picker: gateways list 300+ models. Draw a window around the cursor
  // so the highlighted row is always on screen and the frame fits the
  // terminal (rows - 12 leaves room for the header, the search line, the two
  // "… 还有 N 项" lines, the list note, the hint and the input box). The
  // list may have shrunk under the cursor while a search was typed.
  const pickRow = Math.min(pickCursor, pickMatches.length);
  const pickView = listWindow(pickMatches.length + 1, pickRow, Math.max(5, (stdout?.rows ?? 24) - 12));

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
            : phase === 'model_context_custom'
              ? 'context tokens> '
            : phase === 'search_apikey'
              ? 'search apikey> '
            : phase === 'permission'
              ? 'allow?> '
              : '> ';

  // ctrl+o panel. An index counts only while it still points at a folded
  // entry, so a history that was replaced underneath it leaves it closed.
  const expansionIndex =
    expansion === NOTHING_FOLDED
      ? NOTHING_FOLDED
      : expansion !== null && (chat.history[expansion]?.hiddenLines?.length ?? 0) > 0
        ? expansion
        : null;
  const expansionView =
    expansionIndex !== null && expansionIndex >= 0
      ? {
          title: expansionTitle(chat.history, expansionIndex),
          // Windowed like the live tail: the panel shares the frame with the
          // input box (6 rows) and its own "… +N lines" line.
          detail: windowedDetail(
            chat.history[expansionIndex]!.hiddenLines!,
            (stdout?.rows ?? 24) - 8,
            (stdout?.columns ?? 80) - 4,
          ),
        }
      : undefined;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Static key={chat.generation} items={chat.history}>
        {(entry, i) => (
          <Box key={i} flexDirection="column">
            {entry.input && (
              <Box flexDirection="column">
                <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
                <Box>
                  <Text color="green" bold>&gt; </Text>
                  <Text color={BRAND_GREEN} bold>{entry.input}</Text>
                </Box>
                <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
              </Box>
            )}
            {entry.output && (
              <Box marginLeft={2}>
                <Text>{entry.output}</Text>
              </Box>
            )}
            {entry.banner ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text color={BRAND_GREEN} bold>{entry.banner.logo}</Text>
                <Box marginTop={1}>
                  <Text color="green" bold>Trans Code</Text>
                  <Text> v{VERSION}</Text>
                </Box>
                <Box>
                  <Text color="yellow">Model: </Text>
                  <Text>{entry.banner.model}</Text>
                </Box>
                <Box>
                  <Text color="red">Dir: </Text>
                  <Text>{entry.banner.dir}</Text>
                </Box>
                <Box marginTop={1}>
                  <Text dimColor>Type "help" for available commands, "exit" to quit.</Text>
                </Box>
              </Box>
            ) : null}
          </Box>
        )}
      </Static>

      {busy && chat.turnInput && (
        <Box flexDirection="column">
          <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
          <Box>
            <Text color="green" bold>&gt; </Text>
            <Text color={BRAND_GREEN} bold>{chat.turnInput}</Text>
          </Box>
          <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
        </Box>
      )}
      {liveTail.hidden > 0 && (
        <Box marginLeft={2}>
          <Text color="gray" dimColor>… +{liveTail.hidden} lines</Text>
        </Box>
      )}
      {liveTail.visible && (
        <Box marginLeft={2}>
          <Text>{liveTail.visible}</Text>
        </Box>
      )}

      {expansionIndex === NOTHING_FOLDED && (
        <Box marginLeft={2} flexDirection="column">
          <Text color="yellow">没有折叠的回合。</Text>
          <Text color="gray" dimColor>任意键关闭</Text>
        </Box>
      )}
      {expansionView && (
        <Box marginLeft={2} flexDirection="column">
          <Text color="cyan" bold>{expansionView.title}</Text>
          <Text color="gray" dimColor>ctrl+o 收起 · ↑↓ 切换回合</Text>
          {expansionView.detail.hidden > 0 && (
            <Text color="gray" dimColor>… +{expansionView.detail.hidden} lines</Text>
          )}
          {expansionView.detail.visible && <Text>{expansionView.detail.visible}</Text>}
        </Box>
      )}

      {phase === 'permission' && pendingPermissionRef.current && (
        <Box marginLeft={2} flexDirection="column">
          <Text color="yellow">
            ⚙ {pendingPermissionRef.current.request.title} ({pendingPermissionRef.current.request.kind}) — allow?
          </Text>
          <Text color="yellow">  y  允许这一次</Text>
          {pendingPermissionRef.current.request.alwaysRule && (
            <Text color="yellow">  a  本会话总是允许  {pendingPermissionRef.current.request.alwaysRule}</Text>
          )}
          <Text color="yellow">  n  拒绝</Text>
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
              {(m.id === ctx.modelId || (m.id === 'custom' && isCustomModelSpec(ctx.modelId))) && (
                <Text color="yellow"> (current)</Text>
              )}
            </Box>
          ))}
          <Text color="gray" dimColor>↑↓ 选择厂商 · Enter 进入模型列表</Text>
        </Box>
      )}

      {phase === 'custom_list' && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color="gray" dimColor>自定义模型 (↑↓ 选择 · Enter 使用 · d 删除 · Esc 返回)</Text>
          {customEntries.map((entry, i) => (
            <Box key={entry.spec}>
              <Text color={i === customCursor ? 'cyan' : undefined}>
                {i === customCursor ? '❯ ' : '  '}{entry.model}
              </Text>
              <Text color="gray" dimColor>  {entry.baseUrl}</Text>
            </Box>
          ))}
          <Text color={customCursor === customEntries.length ? 'cyan' : 'green'}>
            {customCursor === customEntries.length ? '❯ ' : '  '}+ 新建自定义模型…
          </Text>
          {deleteTarget && (
            <Text color="yellow">删除 {deleteTarget.model}（{deleteTarget.baseUrl}）？y 确认 · 其它键取消</Text>
          )}
          {customNotice && <Text color="yellow">{customNotice}</Text>}
        </Box>
      )}

      {phase === 'model_context' && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color="gray" dimColor>上下文预算(↑↓ 选择 · Enter 确认 · Esc 跳过)</Text>
          {CONTEXT_BUDGET_CHOICES.map((choice, i) => (
            <Box key={choice.label}>
              <Text color={i === modelContextCursor ? 'cyan' : undefined}>
                {i === modelContextCursor ? '❯ ' : '  '}{choice.label}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {phase === 'search_provider' && (
        <Box flexDirection="column" marginLeft={2}>
          {SEARCH_PROVIDERS.map((p, i) => (
            <Box key={p}>
              <Text color={i === searchCursor ? 'cyan' : undefined}>
                {i === searchCursor ? '❯ ' : '  '}{p}
              </Text>
            </Box>
          ))}
          <Text color="gray" dimColor>↑↓ 选择搜索商 · Enter 下一步 · Esc 取消</Text>
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
          {input && (
            <Text color="gray" dimColor>
              {pickMatches.length > 0
                ? `搜索「${input}」：${pickMatches.length} / ${pickOptions.length} 个模型`
                : `搜索「${input}」：没有匹配的模型 — 回车将输入内容作为模型名`}
            </Text>
          )}
          {pickView.before > 0 && (
            <Text color="gray" dimColor>… 还有 {pickView.before} 项（↑ 向上）</Text>
          )}
          {pickMatches.slice(pickView.start, pickView.end).map((name, offset) => {
            const i = pickView.start + offset;
            return (
              <Box key={name}>
                <Text color={i === pickRow ? 'cyan' : undefined}>
                  {i === pickRow ? '❯ ' : '  '}
                  {name}
                </Text>
              </Box>
            );
          })}
          {pickView.end > pickMatches.length && (
            <Box>
              <Text color={pickRow === pickMatches.length ? 'cyan' : 'gray'}>
                {pickRow === pickMatches.length ? '❯ ' : '  '}
                自定义模型名…
              </Text>
            </Box>
          )}
          {pickView.after > 0 && (
            <Text color="gray" dimColor>… 还有 {pickView.after} 项（↓ 向下）</Text>
          )}
          {pickLoading && <Text color="gray" dimColor>… 正在从网关获取实时模型列表</Text>}
          {!pickLoading && pickLive && <Text color="gray" dimColor>（网关实时列表）</Text>}
          {!pickLoading && !pickLive && (
            <Text color="gray" dimColor>（本地列表 · 保存 key 后显示线上实时列表）</Text>
          )}
          <Text color="gray" dimColor>↑↓ 选择模型 · Enter 确认 · 直接输入可筛选</Text>
        </Box>
      )}

      {phase === 'model_check' && (
        <Box marginLeft={2}>
          <Text dimColor>… 测试连通性（{pendingDisplayName}）</Text>
        </Box>
      )}

      {phase !== 'model_select' && phase !== 'session_select' && phase !== 'custom_list' && (
        <Box flexDirection="column">
          {inputQueue.length > 0 && (
            <Box flexDirection="column" marginLeft={2}>
              {inputQueue.map((text, i) => (
                <Text key={i} color="gray" dimColor>⏎ {text}</Text>
              ))}
              {!busy && phase === 'idle' && (
                <Text color="gray" dimColor>(queued {inputQueue.length} — Enter 续发,Esc 清空)</Text>
              )}
            </Box>
          )}
          <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
          <Box>
            <Text color={phase === 'idle' ? 'green' : 'yellow'}>{promptLabel}</Text>
            <Text>{inputEcho(phase, input)}</Text>
            <Text color="gray">▎</Text>
          </Box>
          <Text color="gray" dimColor>{historyRule(stdout?.columns ?? 80)}</Text>
          {/* Mode indicator: its own line, bottom-left of the input box. */}
          <Box>
            <Text color="gray" dimColor>mode: </Text>
            <Text color={MODE_COLOR[permMode]} bold>{permMode}</Text>
            <Text color="gray" dimColor> · (shift+tab to cycle) · esc to cancel</Text>
          </Box>
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

import { Box, Text, useInput, useApp } from 'ink';
import { useState, useCallback, useRef } from 'react';
import { findCommand, getCommands, type CommandContext } from '../commands.js';
import { getAvailableModels, createProviderWithKey, type ModelId } from '../provider/provider.js';

interface HistoryEntry {
  input: string;
  output: string;
}

type PromptPhase = 'idle' | 'model_select' | 'model_apikey';

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
    } else {
      addHistory({ input: trimmed, output: `Unknown command: ${cmdName}. Type "help" for available commands.` });
    }
    dragFlush();

    commitInput('');
    setHistoryIndex(-1);
    setSavedInput('');
  }, [exit, ctx, phase, handleApiKey, addHistory, enterModelSelect, commitInput, dragFlush]);

  useInput((ch, key) => {
    if (process.env.TRANSCODE_DEBUG_KEYS === '1') {
      // eslint-disable-next-line no-console
      console.error(`CB ${JSON.stringify(ch)} ret=${key.return} esc=${key.escape}`);
    }
    if (key.escape) {
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

    if (key.return) {
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
    </Box>
  );
}

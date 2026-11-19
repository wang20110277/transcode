import { render, Box, Text } from 'ink';
import { useState } from 'react';
import { envModelLabel, getAvailableModels, type ModelId } from './provider/provider.js';
import { type CommandContext } from './commands.js';
import REPL from './screens/REPL.js';
import { createKeyedStdin } from './tui/keyed-stdin.js';
import { VERSION } from './version.js';
const DEFAULT_MODEL: ModelId = 'opus';

function Banner({ modelId, cwd, envLabel }: { modelId: ModelId; cwd: string; envLabel?: string }) {
  const models = getAvailableModels();
  const current = models.find(m => m.id === modelId);

  const logo = `
  ┌──────────────────────────────────────────────┐
  │  T R A N S C O D E  ·  Multi-model Agent      │
  └──────────────────────────────────────────────┘`

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>{logo}</Text>
      <Box marginTop={1}>
        <Text color="green" bold>Trans Code</Text>
        <Text> v{VERSION}</Text>
      </Box>
      <Box>
        <Text color="yellow">Model: </Text>
        <Text>{envLabel ?? current?.name ?? modelId}</Text>
      </Box>
      <Box>
        <Text color="blue">Dir: </Text>
        <Text>{cwd}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Type "help" for available commands, "exit" to quit.</Text>
      </Box>
    </Box>
  );
}

function App() {
  const [modelId, setModelId] = useState<ModelId>(DEFAULT_MODEL);
  const cwd = process.cwd();

  const ctx: CommandContext = {
    modelId,
    setModelId,
    clearHistory: () => {},
  };

  return (
    <Box flexDirection="column">
      <Banner modelId={modelId} cwd={cwd} envLabel={envModelLabel()} />
      <REPL ctx={ctx} />
    </Box>
  );
}

// KeyedStdin splits burst keystrokes into individual keys — Ink (5 and 8)
// treats a whole chunk as a single keypress, so pasted/burst input breaks
// otherwise. Required on every runtime.
render(<App />, { stdin: createKeyedStdin() });

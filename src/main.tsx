import { render, Box, Text } from 'ink';
import { useState } from 'react';
import { getAvailableModels, type ModelId } from './provider/provider.js';
import { type CommandContext } from './commands.js';
import REPL from './screens/REPL.js';

const VERSION = '0.1.0';
const DEFAULT_MODEL: ModelId = 'opus';

function Banner({ modelId, cwd }: { modelId: ModelId; cwd: string }) {
  const models = getAvailableModels();
  const current = models.find(m => m.id === modelId);

  const logo = `
  ┌─────────────────────────────────────────────┐
  │  T R A N S C O D E  ·  Media & VoIP Engine  │
  └─────────────────────────────────────────────┘`

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>{logo}</Text>
      <Box marginTop={1}>
        <Text color="green" bold>Trans Code</Text>
        <Text> v{VERSION}</Text>
      </Box>
      <Box>
        <Text color="yellow">Model: </Text>
        <Text>{current?.name ?? modelId}</Text>
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
      <Banner modelId={modelId} cwd={cwd} />
      <REPL ctx={ctx} />
    </Box>
  );
}

render(<App />);

import { render, Box, Text } from 'ink';
import { useState } from 'react';
import { envModelLabel, getAvailableModels, preferredModelId } from './provider/provider.js';
import { type CommandContext } from './commands.js';
import REPL from './screens/REPL.js';
import { bannerLines } from './screens/banner.js';
import { createKeyedStdin } from './tui/keyed-stdin.js';
import { autoUpdateNotice } from './upgrade.js';
import { VERSION } from './version.js';
const DEFAULT_MODEL: string = preferredModelId() ?? 'opus';

/** Startup banner as plain text: printed once as the first Static entry. */
function bannerText(modelId: string, cwd: string, envLabel?: string): string {
  const models = getAvailableModels();
  const current = models.find(m => m.id === modelId);
  return [
    bannerLines('T R A N S C O D E  ·  Multi-Model Agent'),
    '',
    `Trans Code v${VERSION}`,
    `Model: ${envLabel ?? current?.name ?? modelId}`,
    `Dir: ${cwd}`,
    '',
    'Type "help" for available commands, "exit" to quit.',
  ].join('\n');
}

function App() {
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL);
  const cwd = process.cwd();

  const ctx: CommandContext = {
    modelId,
    setModelId,
    clearHistory: () => {},
  };

  return (
    <Box flexDirection="column">
      {/* A saved model choice (from the models flow) wins over the env label */}

      <REPL
        banner={bannerText(modelId, cwd, preferredModelId() ? undefined : envModelLabel())} ctx={ctx} updateNotice={autoUpdateNotice()} />
    </Box>
  );
}

// KeyedStdin splits burst keystrokes into individual keys — Ink (5 and 8)
// treats a whole chunk as a single keypress, so pasted/burst input breaks
// otherwise. Required on every runtime.
render(<App />, { stdin: createKeyedStdin() });

import { quietLibraryNoise } from './provider/library-noise.js';
import { VERSION } from './version.js';

const USAGE = `transcode v${VERSION}

Usage:
  transcode                 Start the interactive REPL
  transcode models          Print the model catalog as one-line JSON
  transcode acp             Start the ACP stdio server (for transonce, multica and other ACP clients)
  transcode upgrade [version] Upgrade the npm global install to the latest or a specific version
  transcode --version       Print the version
  transcode --help          Show this help

Environment:
  TRANSCODE_MODEL           Default model (registry id or provider:model)
  TRANSCODE_DEFAULT_PROVIDER Provider for bare model names (default: openai)
  TRANSCODE_PERMISSION_MODE  ask | readonly | plan | auto (default: ask in ACP mode;
                            switch at runtime in the REPL with /mode or shift+tab)
  TRANSCODE_MAX_TURNS        Agent tool-call turn cap (default: 200)
  TRANSCODE_SHELL            Override the shell used by the bash tool
                            (Windows: Git Bash is auto-detected)
  ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY / ... provider keys

Examples:
  TRANSCODE_MODEL=deepseek transcode acp
  TRANSCODE_MODEL=openai:gpt-4o transcode acp
`;

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'models') {
    // One-line JSON for hosts and scripts (opencode-style catalog call):
    // no banner, no session semantics, exit 0. Live per-channel listing,
    // same rules as the ACP agent/models method.
    const { fetchSelectableModelsLive } = await import('./provider/provider.js');
    process.stdout.write(`${JSON.stringify(await fetchSelectableModelsLive())}\n`);
    return;
  }

  if (command === 'acp') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write('Usage: transcode acp\n\nStarts an ACP v1 server over stdin/stdout.\n');
      return;
    }
    const { runAcpServer } = await import('./acp/server.js');
    // No Ink here to own the console: keep LangChain's per-chunk merge
    // warnings out of the host's stderr ourselves.
    quietLibraryNoise();
    await runAcpServer();
    return;
  }

  if (command === 'upgrade' || command === 'update') {
    const target = rest.find(arg => !arg.startsWith('-'));
    const { runUpgrade } = await import('./upgrade.js');
    await runUpgrade(target);
    return;
  }

  if (command && !command.startsWith('-')) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // Default: interactive Ink REPL. The auto-update runs in the background;
  // its notice reaches the REPL through autoUpdateNotice() once settled.
  const { startAutoUpdate } = await import('./upgrade.js');
  startAutoUpdate();
  await import('./main.js');
}

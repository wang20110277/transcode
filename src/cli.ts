import { VERSION } from './version.js';

const USAGE = `transcode v${VERSION}

Usage:
  transcode                 Start the interactive REPL
  transcode acp             Start the ACP stdio server (for multica and other ACP clients)
  transcode --version       Print the version
  transcode --help          Show this help

Environment:
  TRANSCODE_MODEL           Default model (registry id or provider:model)
  TRANSCODE_DEFAULT_PROVIDER Provider for bare model names (default: openai)
  TRANSCODE_PERMISSION_MODE  ask | auto | readonly (default: ask in ACP mode)
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

  if (command === 'acp') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write('Usage: transcode acp\n\nStarts an ACP v1 server over stdin/stdout.\n');
      return;
    }
    const { runAcpServer } = await import('./acp/server.js');
    await runAcpServer();
    return;
  }

  if (command && !command.startsWith('-')) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // Default: interactive Ink REPL.
  await import('./main.js');
}

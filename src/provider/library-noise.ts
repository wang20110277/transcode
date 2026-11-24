/**
 * Library chatter that must not reach the terminal.
 *
 * Some OpenAI-compatible gateways (SiliconFlow, for one) report usage on
 * EVERY streamed chunk, with running totals. @langchain/openai keeps each
 * one in the chunk's response_metadata.usage, and @langchain/core — which
 * accumulates the stream internally — cannot merge numbers that differ, so
 * it warns once per field per chunk: three lines per streamed token. The
 * reply itself is fine and transcode never reads these numbers, so exactly
 * that warning is dropped and everything else still goes through.
 */

const CHUNK_MERGE_NOISE = 'already exists in this message chunk and value has unsupported type';
const QUIET = Symbol('quietLibraryNoise');

type Warn = ((...args: unknown[]) => void) & { [QUIET]?: true };

/**
 * Wraps `target.warn` so LangChain's chunk-merge warnings are dropped.
 *
 * It wraps whatever is in place at call time, so install it AFTER anything
 * that takes console.warn over: Ink replaces it while the REPL is mounted.
 * Returns a function that restores the previous implementation.
 */
export function quietLibraryNoise(target: { warn: (...args: unknown[]) => void } = console): () => void {
  const previous = target.warn as Warn;
  if (previous[QUIET]) return () => {}; // already installed on this function
  const quiet: Warn = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string' && args[0].includes(CHUNK_MERGE_NOISE)) return;
    previous.apply(target, args);
  };
  quiet[QUIET] = true;
  target.warn = quiet;
  return () => {
    // Undo only our own layer: someone may have wrapped it since.
    if (target.warn === quiet) target.warn = previous;
  };
}

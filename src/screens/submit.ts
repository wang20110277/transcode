/**
 * Prompt phases where submitting an empty line is meaningful. At the apikey
 * prompt the hint reads "apikey (回车沿用 sk-…xxxx)> " — a bare Enter means
 * "reuse the saved key", and handleApiKey falls back to it for empty input.
 */
const EMPTY_SUBMIT_PHASES = new Set(['model_apikey']);

/**
 * Decide whether a submitted line should be dispatched. Returns the trimmed
 * value, or null when the line is empty and the phase gives it no meaning —
 * so a bare Enter is a no-op everywhere except the apikey prompt.
 */
export function resolveSubmitInput(phase: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed && !EMPTY_SUBMIT_PHASES.has(phase)) return null;
  return trimmed;
}

/**
 * Pure helpers for the REPL slash-command popup. Rendering/keys live in
 * REPL.tsx (mirroring the @-mention popup); these are the testable parts.
 */

export interface SlashCommand {
  name: string;
  description: string;
}

/** Returns the command prefix after a leading '/', or null if input has none. */
export function slashQuery(input: string): string | null {
  if (!input.startsWith('/')) return null;
  return input.slice(1);
}

/**
 * Commands visible in the popup for the current input: prefix matches,
 * case-insensitive. A lone exact match suppresses the popup so Enter
 * submits the typed command instead of completing it. Non-slash input,
 * or input with arguments (no matching prefix), yields an empty list.
 */
export function filterSlashCommands(
  input: string,
  commands: SlashCommand[],
): SlashCommand[] {
  const query = slashQuery(input);
  if (query === null) return [];
  const prefix = query.toLowerCase();
  const matches = commands.filter((cmd) => cmd.name.startsWith(prefix));
  if (matches.length === 1 && prefix !== '' && matches[0]!.name === prefix) {
    return [];
  }
  return matches;
}

/** Replaces the slash token with the selected command (plus a space for args). */
export function applySlashCompletion(input: string, name: string): string {
  if (slashQuery(input) === null) return input;
  return `/${name} `;
}

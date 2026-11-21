/** Minimum rule length so narrow terminals still show a visible divider. */
const MIN_RULE = 10;
/** Right margin so the rule never wraps onto the next line. */
const MARGIN = 2;

/**
 * The horizontal rule drawn around a user question in the chat history.
 * Box-drawing dash repeated to the terminal width minus a small margin.
 */
export function historyRule(columns: number): string {
  return '─'.repeat(Math.max(MIN_RULE, columns - MARGIN));
}

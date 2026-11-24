/**
 * Fuzzy filtering for the model picker: gateways list 300+ models, so what
 * is typed in the picker narrows the list down.
 *
 * A query matches when each of its words (split on whitespace) is found in
 * the item's key in order, ignoring case — the characters need not be
 * adjacent, so "qwen27b" finds "Qwen/Qwen3.8-27B". Tighter matches rank
 * first; equally good matches keep the list's own order.
 */

const WORD_SEPARATORS = new Set(['-', '_', '.', '/', ':', ' ']);

/** How well one query word fits a lower-cased key; null when it is not found in order. */
function matchWord(key: string, word: string): { score: number; firstAt: number } | null {
  let from = 0;
  let previous = -2;
  let score = 0;
  let firstAt = -1;
  for (const char of word) {
    const at = key.indexOf(char, from);
    if (at < 0) return null;
    if (firstAt < 0) firstAt = at;
    score += 1;
    if (at === previous + 1) score += 4; // continues a run
    if (at === 0 || WORD_SEPARATORS.has(key[at - 1]!)) score += 2; // starts a word
    from = at + 1;
    previous = at;
  }
  return { score, firstAt };
}

/**
 * The items matching `query`: best matches first, then the ones where the
 * query starts earliest; equally good matches keep the list's own order.
 */
export function fuzzyFilter<T>(items: T[], query: string, keyOf: (item: T) => string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;

  const ranked: Array<{ item: T; index: number; score: number; firstAt: number }> = [];
  items.forEach((item, index) => {
    const key = keyOf(item).toLowerCase();
    let score = 0;
    let firstAt = Number.MAX_SAFE_INTEGER;
    for (const word of words) {
      const match = matchWord(key, word);
      if (match === null) return; // every word must be found
      score += match.score;
      firstAt = Math.min(firstAt, match.firstAt);
    }
    ranked.push({ item, index, score, firstAt });
  });
  ranked.sort((a, b) => b.score - a.score || a.firstAt - b.firstAt || a.index - b.index);
  return ranked.map(entry => entry.item);
}

/**
 * Minimal unified-diff generator for TUI display. No dependencies.
 *
 * Strategy: trim the common prefix/suffix lines (edits are localized), run an
 * LCS DP over the remaining middle, and fall back to a whole-block replace
 * when the middle is huge so pathological rewrites stay fast.
 *
 * Limitation: a trailing-newline-only difference is not detected (the last
 * line compares equal either way). Acceptable for display purposes.
 */

type Op = { t: 0 | 1 | 2; line: string }; // 0 = context, 1 = delete, 2 = add

const FALLBACK_MIDDLE_LIMIT = 4000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

function editScript(midA: string[], midB: string[]): Op[] {
  const ops: Op[] = [];
  if (midA.length + midB.length > FALLBACK_MIDDLE_LIMIT) {
    for (const line of midA) ops.push({ t: 1, line });
    for (const line of midB) ops.push({ t: 2, line });
    return ops;
  }

  // dp[i * (m + 1) + j] = LCS length of midA[i:] and midB[j:]
  const n = midA.length;
  const m = midB.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        midA[i] === midB[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ t: 0, line: midA[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      ops.push({ t: 1, line: midA[i] });
      i++;
    } else {
      ops.push({ t: 2, line: midB[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: 1, line: midA[i++] });
  while (j < m) ops.push({ t: 2, line: midB[j++] });
  return ops;
}

/** Generates a unified diff (hunks only, no ---/+++ headers). '' when equal. */
export function lineDiff(a: string, b: string, context = 3): string {
  const linesA = splitLines(a);
  const linesB = splitLines(b);

  let prefix = 0;
  while (prefix < linesA.length && prefix < linesB.length && linesA[prefix] === linesB[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < linesA.length - prefix &&
    suffix < linesB.length - prefix &&
    linesA[linesA.length - 1 - suffix] === linesB[linesB.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = linesA.slice(prefix, linesA.length - suffix);
  const midB = linesB.slice(prefix, linesB.length - suffix);

  const ops: Op[] = [];
  for (let k = 0; k < prefix; k++) ops.push({ t: 0, line: linesA[k] });
  ops.push(...editScript(midA, midB));
  for (let k = linesA.length - suffix; k < linesA.length; k++) ops.push({ t: 0, line: linesA[k] });

  // Group change ops into hunks; merge when the context gap between changes
  // is small enough that the windows would touch.
  const changeIndices: number[] = [];
  for (let index = 0; index < ops.length; index++) {
    if (ops[index].t !== 0) changeIndices.push(index);
  }
  if (changeIndices.length === 0) return '';

  // a/b line counters before each op index (ctx consumes both sides).
  const aBefore: number[] = new Array(ops.length + 1);
  const bBefore: number[] = new Array(ops.length + 1);
  aBefore[0] = 0;
  bBefore[0] = 0;
  for (let index = 0; index < ops.length; index++) {
    aBefore[index + 1] = aBefore[index] + (ops[index].t === 2 ? 0 : 1);
    bBefore[index + 1] = bBefore[index] + (ops[index].t === 1 ? 0 : 1);
  }

  const mergeDistance = 2 * context + 1;
  const hunks: Array<{ start: number; end: number }> = []; // op window [start, end)
  let groupFirst = changeIndices[0];
  let groupLast = changeIndices[0];
  for (let index = 1; index <= changeIndices.length; index++) {
    const next = changeIndices[index];
    if (next !== undefined && next - groupLast - 1 <= mergeDistance) {
      groupLast = next;
      continue;
    }
    hunks.push({
      start: Math.max(0, groupFirst - context),
      end: Math.min(ops.length, groupLast + context + 1),
    });
    if (next !== undefined) {
      groupFirst = next;
      groupLast = next;
    }
  }

  const parts: string[] = [];
  for (const hunk of hunks) {
    let oldCount = 0;
    let newCount = 0;
    for (let index = hunk.start; index < hunk.end; index++) {
      if (ops[index].t !== 2) oldCount++;
      if (ops[index].t !== 1) newCount++;
    }
    // Zero-count ranges point at the line before the window.
    const oldStart = oldCount === 0 ? aBefore[hunk.start] : aBefore[hunk.start] + 1;
    const newStart = newCount === 0 ? bBefore[hunk.start] : bBefore[hunk.start] + 1;
    parts.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let index = hunk.start; index < hunk.end; index++) {
      const op = ops[index];
      parts.push(`${op.t === 0 ? ' ' : op.t === 1 ? '-' : '+'}${op.line}`);
    }
  }

  return parts.join('\n');
}

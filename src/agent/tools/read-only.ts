/**
 * Pragmatic read-only bash command analyzer. A command is considered
 * read-only when every segment (split on ; | && || & and newlines, outside
 * quotes) starts with a whitelisted command AND carries no risky flags, and
 * the raw command contains no unquoted redirection/substitution/heredoc.
 *
 * Conservative by design: anything unparsed or unusual fails closed (asks
 * for permission). Inspired by Claude Code's readOnlyValidation.
 */

const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'pwd', 'echo', 'printf', 'wc', 'file', 'which',
  'whoami', 'date', 'uname', 'hostname', 'basename', 'dirname', 'realpath',
  'stat', 'du', 'df', 'tree', 'grep', 'rg', 'fgrep', 'egrep', 'awk', 'sort',
  'uniq', 'cut', 'tr', 'diff', 'cmp', 'jq', 'printenv', 'type', 'command',
  'help', 'man', 'true', 'false', 'cd', 'md5sum', 'shasum', 'sha256sum',
]);

const GIT_READONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame',
  'describe', 'shortlog', 'reflog', 'grep', 'whatchanged',
]);

const FIND_UNSAFE_FLAGS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprintf',
  '-fprint', '-fprint0',
]);

interface Segment {
  tokens: string[];
}

/**
 * Splits a command line into segments on unquoted separators, tracking
 * whether any unquoted disqualifying metacharacter appears. Backslash
 * escapes and single/double quotes are respected.
 */
function parseSegments(command: string): { segments: Segment[]; unsafe: boolean } {
  const segments: Segment[] = [];
  let current: Segment = { tokens: [] };
  let token = '';
  let hasToken = false;
  let unsafe = false;

  const endToken = () => {
    if (hasToken) {
      current.tokens.push(token);
      token = '';
      hasToken = false;
    }
  };
  const endSegment = () => {
    endToken();
    if (current.tokens.length > 0) segments.push(current);
    current = { tokens: [] };
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (char === "'") {
      // Single quotes: everything literal until the closing quote.
      const close = command.indexOf("'", i + 1);
      if (close === -1) return { segments, unsafe: true }; // unterminated quote
      token += command.slice(i + 1, close);
      hasToken = true;
      i = close;
      continue;
    }

    if (char === '"') {
      const close = command.indexOf('"', i + 1);
      if (close === -1) return { segments, unsafe: true };
      for (let j = i + 1; j < close; j++) {
        if (command[j] === '\\' && j + 1 < close) {
          token += command[j + 1]!;
          j++;
        } else {
          token += command[j]!;
        }
      }
      hasToken = true;
      i = close;
      continue;
    }

    if (char === '\\') {
      if (i + 1 >= command.length) return { segments, unsafe: true };
      token += command[i + 1]!;
      hasToken = true;
      i++;
      continue;
    }

    if (char === ';' || char === '\n') {
      endSegment();
      continue;
    }

    if (char === '|' || char === '&') {
      if (command[i + 1] === char) i++; // || or &&
      endSegment();
      continue;
    }

    if (char === '>' || char === '<' || char === '`') {
      unsafe = true; // redirection, heredoc, backtick substitution
      continue;
    }

    if (char === '$' && command[i + 1] === '(') {
      unsafe = true; // command substitution
      continue;
    }

    if (char === '#' && !hasToken) {
      // Comment: ignore the rest of the line.
      const nl = command.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }

    if (/\s/.test(char)) {
      endToken();
      continue;
    }

    token += char;
    hasToken = true;
  }
  endSegment();

  return { segments, unsafe };
}

function segmentIsReadOnly(tokens: string[]): boolean {
  // Strip leading VAR=value assignments (FOO=1 ls …).
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) {
    start++;
  }
  const rest = tokens.slice(start);
  if (rest.length === 0) return true; // pure assignments are side-effect free
  const base = rest[0]!;

  if (base === 'git') {
    const sub = rest[1];
    if (!sub) return false;
    if (sub === 'branch') {
      // `git branch -vv` lists; `git branch name` creates. Safe only when
      // every argument is a flag.
      return rest.slice(2).every((arg) => arg.startsWith('-'));
    }
    return GIT_READONLY.has(sub);
  }

  if (base === 'find') {
    return !rest.some((arg) => FIND_UNSAFE_FLAGS.has(arg));
  }

  if (base === 'sed') {
    // Unsafe when any short-flag cluster contains `i` (in-place) or a long
    // --in-place style flag is present.
    return !rest.some((arg) => {
      if (arg.startsWith('--')) return arg === '--in-place' || arg.startsWith('--in-place=');
      if (arg.startsWith('-') && arg.length > 1) return arg.includes('i');
      return false;
    });
  }

  return SAFE_COMMANDS.has(base);
}

/** True when the command can run without a permission prompt. */
export function isReadOnlyCommand(command: string): boolean {
  const { segments, unsafe } = parseSegments(command);
  if (unsafe) return false;
  if (segments.length === 0) return false;
  return segments.every((segment) => segmentIsReadOnly(segment.tokens));
}

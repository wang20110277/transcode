import { describe, expect, test } from 'bun:test';
import { isReadOnlyCommand } from './read-only.js';

describe('isReadOnlyCommand', () => {
  test('simple read-only commands pass', () => {
    expect(isReadOnlyCommand('ls')).toBe(true);
    expect(isReadOnlyCommand('ls -la /tmp')).toBe(true);
    expect(isReadOnlyCommand('git status')).toBe(true);
    expect(isReadOnlyCommand('git log --oneline -3')).toBe(true);
    expect(isReadOnlyCommand('grep -n foo bar.txt')).toBe(true);
    expect(isReadOnlyCommand('sed -n "348,420p" tests/smoke.py')).toBe(true);
    expect(isReadOnlyCommand('pwd')).toBe(true);
    expect(isReadOnlyCommand('cd trans-once && pwd')).toBe(true);
  });

  test('pipelines and chains pass when every segment is read-only', () => {
    expect(isReadOnlyCommand('cat x | grep y')).toBe(true);
    expect(isReadOnlyCommand('git log --oneline -3; echo "---"; git diff --stat')).toBe(true);
    expect(isReadOnlyCommand('ls && echo done || echo failed')).toBe(true);
    expect(isReadOnlyCommand('git branch -vv && git log --oneline -15')).toBe(true);
  });

  test('mutating commands fail', () => {
    expect(isReadOnlyCommand('npm install')).toBe(false);
    expect(isReadOnlyCommand('git push origin main')).toBe(false);
    expect(isReadOnlyCommand('git commit -m x')).toBe(false);
    expect(isReadOnlyCommand('node check.ts')).toBe(false);
    expect(isReadOnlyCommand('rm -rf /tmp/x')).toBe(false);
    expect(isReadOnlyCommand('curl https://example.com')).toBe(false);
    expect(isReadOnlyCommand('mkdir newdir')).toBe(false);
  });

  test('mixed chains fail when any segment mutates', () => {
    expect(isReadOnlyCommand('ls && npm install')).toBe(false);
    expect(isReadOnlyCommand('git status; git push')).toBe(false);
  });

  test('output redirection disqualifies', () => {
    expect(isReadOnlyCommand('grep foo bar > out.txt')).toBe(false);
    expect(isReadOnlyCommand('echo hi >> log.txt')).toBe(false);
    expect(isReadOnlyCommand('ls >out')).toBe(false);
  });

  test('command substitution and heredocs disqualify', () => {
    expect(isReadOnlyCommand('echo $(rm -rf x)')).toBe(false);
    expect(isReadOnlyCommand('echo `rm -rf x`')).toBe(false);
    expect(isReadOnlyCommand('cat <<EOF\nhi\nEOF')).toBe(false);
  });

  test('risky flags disqualify find and sed', () => {
    expect(isReadOnlyCommand('find . -name "*.tmp" -delete')).toBe(false);
    expect(isReadOnlyCommand('find . -exec rm {} \\;')).toBe(false);
    expect(isReadOnlyCommand('sed -i s/a/b file.txt')).toBe(false);
    expect(isReadOnlyCommand('sed -in s/a/b file.txt')).toBe(false);
    expect(isReadOnlyCommand('sed --in-place s/a/b file.txt')).toBe(false);
  });

  test('git subcommands outside the read-only set fail', () => {
    expect(isReadOnlyCommand('git branch feature')).toBe(false);
    expect(isReadOnlyCommand('git config user.name x')).toBe(false);
    expect(isReadOnlyCommand('git checkout main')).toBe(false);
  });

  test('quoted separators and metacharacters are not treated as operators', () => {
    expect(isReadOnlyCommand('echo "a;b | c && d"')).toBe(true);
    expect(isReadOnlyCommand('grep "a > b" file.txt')).toBe(true);
  });

  test('env assignment prefixes are tolerated', () => {
    expect(isReadOnlyCommand('LC_ALL=C sort big.txt')).toBe(true);
    expect(isReadOnlyCommand('FOO=1 ls')).toBe(true);
  });

  test('empty or whitespace command is not read-only', () => {
    expect(isReadOnlyCommand('')).toBe(false);
    expect(isReadOnlyCommand('   ')).toBe(false);
  });
});

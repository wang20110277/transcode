import { describe, expect, test } from 'bun:test';
import {
  buildWrappedCommand,
  detectShellWith,
  isPowerShell,
  psQuote,
  shellSpawnArgs,
} from './bash.js';
import { isReadOnlyCommand } from './read-only.js';

describe('PowerShell support', () => {
  test('isPowerShell detects pwsh and powershell paths', () => {
    expect(isPowerShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
    expect(isPowerShell('powershell.exe')).toBe(true);
    expect(isPowerShell('/bin/bash')).toBe(false);
    expect(isPowerShell('/usr/bin/zsh')).toBe(false);
  });

  test('psQuote escapes single quotes the PowerShell way', () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(psQuote('plain')).toBe("'plain'");
  });

  test('detectShellWith prefers Git Bash but falls back to PowerShell on win32', () => {
    expect(detectShellWith('win32', () => false, {})).toBe('powershell.exe');
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(detectShellWith('win32', (p) => p === gitBash, {})).toBe(gitBash);
  });

  test('spawn args use NoProfile -Command for PowerShell', () => {
    expect(shellSpawnArgs('powershell.exe', undefined, 'echo hi')).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'echo hi',
    ]);
    expect(shellSpawnArgs('/bin/bash', undefined, 'echo hi')).toEqual(['-l', '-c', 'echo hi']);
  });

  test('the PowerShell wrapper captures cwd and exit code without POSIX syntax', () => {
    const wrapped = buildWrappedCommand(
      'Get-Location',
      'powershell.exe',
      undefined,
      'C:\\tmp\\cwd-file',
    );
    expect(wrapped).toContain("Get-Location");
    expect(wrapped).toContain('Out-File');
    expect(wrapped).not.toContain('eval ');
    expect(wrapped).not.toContain('pwd -P');
  });

  test('read-only analysis fails closed for PowerShell cmdlets, open for a safe few', () => {
    expect(isReadOnlyCommand('Get-ChildItem')).toBe(true);
    expect(isReadOnlyCommand('Get-Content file.txt')).toBe(true);
    expect(isReadOnlyCommand('Select-String -Pattern x file.txt')).toBe(true);
    expect(isReadOnlyCommand('Remove-Item -Recurse stuff')).toBe(false);
    expect(isReadOnlyCommand('npm install')).toBe(false);
  });
});

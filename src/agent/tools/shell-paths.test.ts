import { describe, expect, test } from 'bun:test';
import { fromPosixPath, toPosixPath } from './shell-paths.js';
import { detectShellWith, killTreeCommand } from './bash.js';

describe('path conversion', () => {
  test('windows → posix drive paths', () => {
    expect(toPosixPath('C:\\Users\\lindaw\\AppData\\Local\\Temp')).toBe(
      '/c/Users/lindaw/AppData/Local/Temp',
    );
    expect(toPosixPath('D:/data/x')).toBe('/d/data/x');
  });

  test('posix paths pass through untouched', () => {
    expect(toPosixPath('/var/folders/abc')).toBe('/var/folders/abc');
    expect(toPosixPath('/tmp')).toBe('/tmp');
  });

  test('posix → windows drive paths (normalized uppercase)', () => {
    expect(fromPosixPath('/c/Users/lindaw')).toBe('C:\\Users\\lindaw');
    expect(fromPosixPath('/d/data/x')).toBe('D:\\data\\x');
  });

  test('non-drive posix paths pass through', () => {
    expect(fromPosixPath('/var/folders/abc')).toBe('/var/folders/abc');
    expect(fromPosixPath('/usr/bin/env')).toBe('/usr/bin/env');
  });

  test('roundtrips', () => {
    const win = 'C:\\repo\\trans-once';
    expect(fromPosixPath(toPosixPath(win))).toBe(win);
  });
});

describe('detectShellWith', () => {
  test('TRANSCODE_SHELL override wins everywhere', () => {
    expect(
      detectShellWith('win32', () => false, { TRANSCODE_SHELL: 'C:\\sh\\pwsh.exe' }),
    ).toBe('C:\\sh\\pwsh.exe');
  });

  test('SHELL env is used when it is bash/zsh', () => {
    expect(detectShellWith('linux', () => false, { SHELL: '/usr/bin/zsh' })).toBe('/usr/bin/zsh');
  });

  test('win32 probes Git Bash locations before falling back', () => {
    expect(detectShellWith('win32', (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe', {})).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    expect(detectShellWith('win32', () => false, {})).toBe('/bin/bash');
  });
});

describe('killTreeCommand', () => {
  test('win32 uses taskkill /T /F', () => {
    const command = killTreeCommand(4242, 'win32');
    expect(command?.file).toBe('taskkill');
    expect(command?.args).toEqual(['/pid', '4242', '/T', '/F']);
  });

  test('posix uses the process-group kill path (no command)', () => {
    expect(killTreeCommand(4242, 'darwin')).toBeNull();
    expect(killTreeCommand(4242, 'linux')).toBeNull();
  });
});

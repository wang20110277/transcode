/**
 * Windows ↔ Git-Bash (MSYS) path conversion. Git Bash accepts both forms
 * for arguments, but `pwd -P` outputs POSIX paths while Node APIs need
 * native Windows ones — every boundary converts explicitly.
 */

/** C:\a\b or C:/a/b → /c/a/b ; already-POSIX paths pass through. */
export function toPosixPath(input: string): string {
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(input);
  if (!drive) return input;
  return `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`;
}

/** /c/a/b → C:\a\b (drive letter uppercased) ; non-drive paths pass through. */
export function fromPosixPath(input: string): string {
  const drive = /^\/([a-zA-Z])\/(.*)$/.exec(input);
  if (!drive) return input;
  return `${drive[1]!.toUpperCase()}:\\${drive[2]!.replace(/\//g, '\\')}`;
}

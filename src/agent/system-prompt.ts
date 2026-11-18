import { promises as fs } from 'node:fs';
import path from 'node:path';

const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md', 'TRANSCODE.md', '.transcode/AGENTS.md'];
const MAX_CONTEXT_CHARS = 40_000;

export interface ProjectContext {
  cwd: string;
  gitBranch?: string;
  projectFiles: { path: string; content: string }[];
}

async function readOptional(file: string): Promise<string | null> {
  try {
    const content = await fs.readFile(file, 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function gitBranch(cwd: string): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise<string | undefined>((resolve) => {
      execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }, (error, stdout) => {
        resolve(error ? undefined : stdout.trim() || undefined);
      });
    });
  } catch {
    return undefined;
  }
}

export async function loadProjectContext(cwd: string): Promise<ProjectContext> {
  const projectFiles: ProjectContext['projectFiles'] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (const relative of CONTEXT_FILES) {
    if (budget <= 0) break;
    const absolute = path.join(cwd, relative);
    const content = await readOptional(absolute);
    if (!content) continue;

    const clipped =
      content.length > budget
        ? `${content.slice(0, budget)}\n... (project instructions truncated)`
        : content;
    projectFiles.push({ path: relative, content: clipped });
    budget -= clipped.length;
  }

  return { cwd, gitBranch: await gitBranch(cwd), projectFiles };
}

export function buildSystemPrompt(context: ProjectContext): string {
  const sections: string[] = [
    'You are transcode, a coding agent running as a local CLI agent in a terminal.',
    'You work directly in the user-provided workspace and can read, search, edit and execute code.',
    '',
    '## Environment',
    `- Workspace: ${context.cwd}`,
    `- Platform: ${process.platform}`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    ...(context.gitBranch ? [`- Git branch: ${context.gitBranch}`] : []),
    '',
    '## How to work',
    '- Inspect the repository before changing it. Read the relevant files first.',
    '- Prefer read_file, glob and grep for exploration; use bash for builds, tests and git.',
    '- Use edit_file for targeted changes and write_file for new files.',
    '- Keep changes focused on the task. Do not undo unrelated user work.',
    '- After changing code, run the cheapest relevant check (typecheck, targeted test) when available.',
    '- Never claim a command succeeded unless you actually ran it and saw the result.',
    '- When the task is complete, reply with a short summary of what changed and any verification performed.',
    '- If a tool fails, read the error and adapt instead of repeating the same call.',
  ];

  if (context.projectFiles.length > 0) {
    sections.push('', '## Project instructions');
    for (const file of context.projectFiles) {
      sections.push('', `### ${file.path}`, file.content);
    }
  }

  return sections.join('\n');
}

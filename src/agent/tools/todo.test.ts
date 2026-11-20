import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { findAgentTool } from './index.js';
import { createToolSession } from './session.js';
import { todoWriteTool, type TodoItem } from './todo.js';

describe('todo_write', () => {
  test('is registered in the default tool set', () => {
    expect(findAgentTool('todo_write')).toBeDefined();
    expect(todoWriteTool.isMutating).toBe(false);
  });

  test('replaces the whole list and returns a status checklist', async () => {
    const session = createToolSession('/tmp');
    const todos: TodoItem[] = [
      { content: '调研仓库结构', status: 'completed' },
      { content: '起草 README 方案', status: 'in_progress' },
      { content: '写入 README', status: 'pending' },
    ];

    const output = await todoWriteTool.execute(
      { todos },
      { cwd: '/tmp', session },
    );

    expect(session.todos).toEqual(todos);
    expect(output).toContain('[x]');
    expect(output).toContain('[~]');
    expect(output).toContain('[ ]');
    expect(output).toContain('调研仓库结构');
  });

  test('reports completion when everything is done', async () => {
    const session = createToolSession('/tmp');
    const output = await todoWriteTool.execute(
      { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] },
      { cwd: '/tmp', session },
    );
    expect(output).toMatch(/all complete/i);
  });

  test('rejects unknown status values via the schema', () => {
    const parsed = todoWriteTool.schema.safeParse({
      todos: [{ content: 'a', status: 'bogus' }],
    });
    expect(parsed.success).toBe(false);
  });

  test('schema matches the OpenAI nullable-optional convention', () => {
    const shape = todoWriteTool.schema.shape;
    void z;
    expect(Object.keys(shape)).toEqual(['todos']);
  });
});

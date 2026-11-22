import { describe, expect, test } from 'bun:test';
import { serializeToolCallArgsInBody } from './openai-compat.js';

describe('serializeToolCallArgsInBody', () => {
  test('对象 arguments 序列化为字符串(glm 1210 修复)', () => {
    const body = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'assistant', content: 'hi', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'glob', arguments: { pattern: '**/*' } } },
        ] },
      ],
    });
    const fixed = JSON.parse(serializeToolCallArgsInBody(body));
    expect(fixed.messages[0].tool_calls[0].function.arguments).toBe('{"pattern":"**/*"}');
  });

  test('字符串 arguments 原样保留(合规网关零影响)', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'assistant', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"a"}' } },
        ] },
      ],
    });
    expect(JSON.parse(serializeToolCallArgsInBody(body))).toEqual(JSON.parse(body));
  });

  test('非 assistant 消息与其他字段不动;坏 JSON 原样返回', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: { foo: { bar: 1 } } },
        { role: 'assistant', content: '', tool_calls: [] },
      ],
      tools: [{ type: 'function', function: { name: 'x', parameters: { a: 1 } } }],
    });
    expect(JSON.parse(serializeToolCallArgsInBody(body))).toEqual(JSON.parse(body));
    expect(serializeToolCallArgsInBody('not json')).toBe('not json');
  });
});

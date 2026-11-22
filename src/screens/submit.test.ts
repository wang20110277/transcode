import { describe, expect, test } from 'bun:test';
import { resolveSubmitInput } from './submit.js';

describe('resolveSubmitInput', () => {
  test('empty Enter at the apikey prompt submits (reuses the saved key)', () => {
    // The prompt advertises "apikey (回车沿用 sk-…xxxx)> " — a bare Enter
    // must reach handleApiKey, which falls back to the saved key.
    expect(resolveSubmitInput('model_apikey', '')).toBe('');
  });

  test('empty Enter in every other phase is a no-op', () => {
    expect(resolveSubmitInput('idle', '')).toBeNull();
    expect(resolveSubmitInput('model_name', '')).toBeNull();
    expect(resolveSubmitInput('custom_baseurl', '')).toBeNull();
    expect(resolveSubmitInput('model_select', '')).toBeNull();
    expect(resolveSubmitInput('model_pick', '')).toBeNull();
  });

  test('non-empty input is trimmed and passed through', () => {
    expect(resolveSubmitInput('model_apikey', '  sk-abc  ')).toBe('sk-abc');
    expect(resolveSubmitInput('idle', 'hello')).toBe('hello');
  });
});

describe('search_apikey empty submit', () => {
  test('empty Enter at the search_apikey prompt submits (reuses the saved key)', () => {
    // The /search prompt advertises "(Enter 沿用已存 key)" — a bare Enter
    // must reach the search key handler, which falls back to the saved key.
    expect(resolveSubmitInput('search_apikey', '')).toBe('');
  });
});

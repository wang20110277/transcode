import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearRegisteredApiKeys,
  createModel,
  getAvailableModels,
  lookupApiKey,
  registerApiKey,
  resolveModel,
  setCustomModel,
  vendorModelSpec,
  vendorModels,
  verifyModel,
  switchNote,
  deletedGatewayNote,
  modelLabel,
} from './provider.js';

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-provider-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  clearRegisteredApiKeys();
});
afterEach(() => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  delete process.env.TRANSCODE_MODEL;
  rmSync(configDir, { recursive: true, force: true });
});

describe('GLM Coding Plan preset', () => {
  test('resolves the glmc registry id to the coding endpoint', () => {
    const resolved = resolveModel('glmc');
    expect(resolved.id).toBe('glmc');
    expect(resolved.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(resolved.envKey).toBe('GLM_API_KEY');
  });

  test('the glmc:MODEL spec overrides the model name but keeps the coding endpoint', () => {
    const resolved = resolveModel('glmc:glm-4.5');
    expect(resolved.model).toBe('glm-4.5');
    expect(resolved.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
  });

  test('createModel wires the coding base URL into the client config', () => {
    registerApiKey('glmc', 'test-key');
    const provider = createModel('glmc');
    expect(provider.config.baseUrl).toContain('/api/coding/');
    expect(provider.config.model).toBe('glm-5.3');
  });

  test('appears in the model list for /models', () => {
    const entry = getAvailableModels().find((model) => model.id === 'glmc');
    expect(entry?.name).toContain('Coding');
  });
});

describe('vendor model lists', () => {
  test('every vendor exposes at least one curated model', () => {
    for (const model of getAvailableModels()) {
      if (model.id === 'custom') continue; // empty until the gateway is set up
      expect(vendorModels(model.id).length).toBeGreaterThan(0);
    }
  });

  test('glm lists the current model line', () => {
    const glm = vendorModels('glm');
    // The glm-5.x generation is what the endpoints actually serve now;
    // glm-4.6/4.5 live on as server-side aliases. glm-4-flash is retired.
    expect(glm).toContain('glm-5.3');
    expect(glm).toContain('glm-5.3-flash');
    expect(glm).toContain('glm-4.6');
    expect(glm).not.toContain('glm-4-flash');
  });

  test('glmc lists the current model line of the coding endpoint', () => {
    const glmc = vendorModels('glmc');
    expect(glmc).toContain('glm-5.3');
    expect(glmc).toContain('glm-5.3-flash');
    expect(glmc).toContain('glm-4.6');
  });

  test('registry defaults resolve to models the endpoints actually serve', () => {
    expect(resolveModel('glm').model).toBe('glm-5.3');
    expect(resolveModel('glmc').model).toBe('glm-5.3');
  });

  test('deepseek lists the current model line', () => {
    const deepseek = vendorModels('deepseek');
    expect(deepseek).toContain('deepseek-v4-pro');
    expect(deepseek).toContain('deepseek-flash');
  });

  test('spec mapping routes registry ids to provider prefixes', () => {
    expect(vendorModelSpec('deepseek', 'deepseek-reasoner')).toBe('deepseek:deepseek-reasoner');
    expect(vendorModelSpec('opus', 'claude-sonnet-4')).toBe('anthropic:claude-sonnet-4');
    expect(vendorModelSpec('gpt', 'gpt-4o-mini')).toBe('openai:gpt-4o-mini');
    expect(vendorModelSpec('glmc', 'glm-4.5')).toBe('glmc:glm-4.5');
  });
});

describe('key reuse', () => {
  test('a spec inherits the key registered for its vendor prefix', () => {
    registerApiKey('deepseek', 'vendor-key');
    expect(lookupApiKey('deepseek:deepseek-reasoner')).toBe('vendor-key');
  });

  test('glmc reuses the key saved for glm (same credential family)', () => {
    registerApiKey('glm', 'glm-key');
    expect(lookupApiKey('glmc')).toBe('glm-key');
    expect(lookupApiKey('glmc:glm-4.5')).toBe('glm-key');
  });
});

describe('custom gateway', () => {
  test('persists and resolves base URL and model', () => {
    setCustomModel({ baseUrl: 'https://gw.example.com/v1', model: 'my-model' });

    const resolved = resolveModel('custom');
    expect(resolved.model).toBe('my-model');
    expect(resolved.baseUrl).toBe('https://gw.example.com/v1');
    expect(resolved.provider).toBe('openai');

    const overridden = resolveModel('custom:other-model');
    expect(overridden.model).toBe('other-model');
    expect(overridden.baseUrl).toBe('https://gw.example.com/v1');
  });

  test('appears in the model list', () => {
    expect(getAvailableModels().some((model) => model.id === 'custom')).toBe(true);
  });
});

describe('verifyModel', () => {
  test('fails fast with a readable message when no key is available', async () => {
    const result = await verifyModel('deepseek:deepseek-chat', '');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/key/i);
  });
});

describe('switchNote', () => {
  test('plain switch line when the endpoint serves the picked name', () => {
    expect(switchNote('glmc/glm-5.3', 'glm-5.3', 'glm-5.3')).toBe('已切换到 glmc/glm-5.3');
    expect(switchNote('glmc/glm-5.3', 'glm-5.3', undefined)).toBe('已切换到 glmc/glm-5.3');
  });

  test('appends the effectively served model when it differs from the pick', () => {
    expect(switchNote('glmc/glm-4.6', 'glm-4.6', 'glm-5.3-flash')).toBe(
      '已切换到 glmc/glm-4.6（实际生效 glm-5.3-flash）',
    );
  });
});

describe('modelLabel', () => {
  test('a registry id reads as its name', () => {
    expect(modelLabel('deepseek')).toBe('DeepSeek');
  });

  test('a vendor:model spec is shown as is', () => {
    expect(modelLabel('glmc:glm-5.4')).toBe('glmc:glm-5.4');
  });

  test('a saved gateway is shown under its own name', () => {
    expect(modelLabel('alpha')).toBe('alpha');
  });
});

describe('deletedGatewayNote', () => {
  test('names the removed entry', () => {
    expect(deletedGatewayNote({ model: 'qwen', baseUrl: 'https://a.example/v1', roles: [] })).toBe(
      '已删除自定义模型 qwen（https://a.example/v1）',
    );
  });

  test('lists the roles the removal unassigned', () => {
    expect(deletedGatewayNote({ model: 'qwen', baseUrl: 'https://a.example/v1', roles: ['analysis', 'compact'] })).toBe(
      '已删除自定义模型 qwen（https://a.example/v1） · 已解除角色路由: analysis, compact',
    );
  });
});

describe('validateModelSpec', () => {
  test('合法拼法:注册表 id、前缀 spec、空白视为未提供', async () => {
    const { validateModelSpec } = await import('./provider.js');
    expect(validateModelSpec('glmc')).toBeNull();
    expect(validateModelSpec('glmc:glm-5.3-flash')).toBeNull();
    expect(validateModelSpec('opus')).toBeNull();
    expect(validateModelSpec('openai:gpt-4o')).toBeNull();
    expect(validateModelSpec('  ')).toBeNull();
  });

  test('非法拼法返回含 invalid model 的消息', async () => {
    const { validateModelSpec } = await import('./provider.js');
    expect(validateModelSpec('glmz:x')).toContain('invalid model');
    expect(validateModelSpec('nope')).toContain('invalid model');
  });

  test('用户 profile 名合法', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ profiles: { mygw: { baseUrl: 'http://x', model: 'm' } } }),
    );
    const { validateModelSpec } = await import('./provider.js');
    expect(validateModelSpec('mygw')).toBeNull();
  });
});

describe('validateModelSpec 补充', () => {
  test('冒号后模型段为空 → 拒绝', async () => {
    const { validateModelSpec } = await import('./provider.js');
    expect(validateModelSpec('glmc:')).toContain('invalid model');
    expect(validateModelSpec('openai:   ')).toContain('invalid model');
  });

  test('与注册表同名的 profile 优先且通过校验(计划承诺的回归测试)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        profiles: { glmc: { baseUrl: 'http://my-gw', model: 'my-model' } },
      }),
    );
    const { validateModelSpec, resolveModel } = await import('./provider.js');
    expect(validateModelSpec('glmc')).toBeNull();
    expect(resolveModel('glmc').model).toBe('my-model');
  });
});

describe('getSelectableModels', () => {
  test('展开厂商模型,不含厂商裸 id,同名模型带厂商名可区分', async () => {
    const { getSelectableModels } = await import('./provider.js');
    const catalog = getSelectableModels();
    expect(catalog.length).toBeGreaterThan(0);
    const flash = catalog.find((m) => m.modelId === 'glmc:glm-5.3-flash');
    expect(flash?.name).toContain('GLM Coding Plan');
    expect(flash?.name).toContain('glm-5.3-flash');
    expect(catalog.some((m) => m.modelId === 'glmc')).toBe(false);
    const names = new Map(catalog.map((m) => [m.modelId, m.name]));
    expect(names.get('glm:glm-5.3')).toContain('GLM');
    expect(names.get('glmc:glm-5.3')).toContain('GLM Coding Plan');
  });

  test('自定义网关多条全出现(custom 槽 + 两个 profile)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        custom: { baseUrl: 'http://legacy/v1', model: 'legacy-model' },
        profiles: {
          gw1: { baseUrl: 'http://a/v1', model: 'ma' },
          gw2: { baseUrl: 'http://b/v1', model: 'mb' },
        },
      }),
    );
    const { getSelectableModels } = await import('./provider.js');
    const ids = getSelectableModels().map((m) => m.modelId);
    expect(ids).toContain('custom');
    expect(ids).toContain('gw1');
    expect(ids).toContain('gw2');
  });

  test('全量条目过校验器(任一 modelId 可直接用于 session/new)', async () => {
    const { getSelectableModels, validateModelSpec } = await import('./provider.js');
    for (const model of getSelectableModels()) {
      expect(validateModelSpec(model.modelId)).toBeNull();
    }
  });
});

describe('profile:MODEL spec 形态', () => {
  test('profile名:MODEL 路由到该网关;裸 profile 名语义不变', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        profiles: { gw1: { baseUrl: 'http://gw1/v1', model: 'mb' } },
      }),
    );
    const { resolveModel, validateModelSpec } = await import('./provider.js');
    const routed = resolveModel('gw1:model-a');
    expect(routed.model).toBe('model-a');
    expect(routed.baseUrl).toBe('http://gw1/v1');
    expect(resolveModel('gw1').model).toBe('mb');
    expect(validateModelSpec('gw1:anything')).toBeNull();
  });

  test('不完整 profile 作前缀不劫持厂商分支', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        profiles: { half: { baseUrl: 'http://half/v1' } }, // 缺 model
      }),
    );
    const { resolveModel, validateModelSpec } = await import('./provider.js');
    // half:x 不是 profile 路由(不完整),也不是厂商前缀 → 校验拒绝
    expect(validateModelSpec('half:x')).toContain('invalid model');
    expect(resolveModel('half:x').model).not.toBe('x');
  });
});

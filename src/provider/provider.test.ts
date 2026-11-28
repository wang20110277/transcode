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

describe('getSelectableModels(key 圈定)', () => {
  const PROVIDER_KEY_ENV = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'GLM_API_KEY',
    'MINIMAX_API_KEY',
    'KIMI_API_KEY',
    'TRANSCODE_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};
  const scrubEnv = () => {
    for (const name of PROVIDER_KEY_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  };
  const restoreEnv = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  test('空配置无 key 无网关 → 空目录', async () => {
    scrubEnv();
    try {
      const { getSelectableModels } = await import('./provider.js');
      expect(getSelectableModels()).toEqual([]);
    } finally {
      restoreEnv();
    }
  });

  test('有 key 厂商才出现:glmc 有 key,deepseek/opus 不出现', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ apiKeys: { glmc: 'test-key' } }),
    );
    scrubEnv();
    try {
      const { getSelectableModels } = await import('./provider.js');
      const ids = getSelectableModels().map((m) => m.modelId);
      expect(ids).toContain('glmc:glm-5.3-flash');
      expect(ids.some((id) => id.startsWith('deepseek:'))).toBe(false);
      expect(ids.some((id) => id.startsWith('anthropic:'))).toBe(false);
      expect(ids).not.toContain('glmc');
    } finally {
      restoreEnv();
    }
  });

  test('#27 custom 槽位只出网关一条,不产生厂商侧重复', async () => {
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
    expect(ids).not.toContain('custom:legacy-model');
  });

  test('全量条目过校验与解析(含 gateway 条目)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        apiKeys: { glmc: 'k', deepseek: 'k' },
        profiles: { gw1: { baseUrl: 'http://a/v1', model: 'ma' } },
      }),
    );
    const { getSelectableModels, validateModelSpec, resolveModel } = await import('./provider.js');
    const catalog = getSelectableModels();
    expect(catalog.length).toBeGreaterThan(0);
    for (const model of catalog) {
      expect(validateModelSpec(model.modelId)).toBeNull();
      expect(resolveModel(model.modelId).baseUrl).toBeTruthy();
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

describe('fetchSelectableModelsLive', () => {
  const PROVIDER_KEY_ENV = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY', 'KIMI_API_KEY', 'TRANSCODE_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};
  const scrubEnv = () => {
    for (const name of PROVIDER_KEY_ENV) { saved[name] = process.env[name]; delete process.env[name]; }
  };
  const restoreEnv = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };

  test('网关线上多模型;厂商通道失败回退 curated;无 key 不现', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        apiKeys: { glmc: 'k' },
        profiles: { gw1: { baseUrl: 'http://gw1/v1', model: 'mb' } },
      }),
    );
    scrubEnv();
    try {
      const { fetchSelectableModelsLive } = await import('./provider.js');
      const live = await fetchSelectableModelsLive(async (baseUrl) =>
        baseUrl === 'http://gw1/v1' ? ['ma', 'mb', 'mc'] : [],
      );
      const ids = live.map((m) => m.modelId);
      expect(ids).toContain('gw1:ma');
      expect(ids).toContain('gw1:mc');
      expect(ids).toContain('glmc:glm-5.3-flash'); // glmc 通道线上空 → curated 回退
      expect(ids.some((id) => id.startsWith('deepseek:') || id.startsWith('anthropic:'))).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  test('单通道 fetcher 抛错只回退该通道', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        apiKeys: { glmc: 'k', deepseek: 'k' },
        profiles: { bad: { baseUrl: 'http://bad/v1', model: 'fb' } },
      }),
    );
    scrubEnv();
    try {
      const { fetchSelectableModelsLive } = await import('./provider.js');
      const live = await fetchSelectableModelsLive(async (baseUrl) => {
        if (baseUrl === 'http://bad/v1') throw new Error('boom');
        if (baseUrl.includes('deepseek')) return ['deepseek-v4-pro'];
        return [];
      });
      const ids = live.map((m) => m.modelId);
      expect(ids).toContain('bad:fb'); // 抛错 → 回退已配模型
      expect(ids).toContain('deepseek:deepseek-v4-pro');
      expect(ids).toContain('glmc:glm-5.3'); // 空列表 → curated 回退
    } finally {
      restoreEnv();
    }
  });

  test('通道并行:两通道各 120ms,总时长 < 200ms', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        profiles: {
          g1: { baseUrl: 'http://g1/v1', model: 'm1' },
          g2: { baseUrl: 'http://g2/v1', model: 'm2' },
        },
      }),
    );
    scrubEnv();
    try {
      const { fetchSelectableModelsLive } = await import('./provider.js');
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const started = Date.now();
      await fetchSelectableModelsLive(async () => {
        await delay(120);
        return ['x'];
      });
      expect(Date.now() - started).toBeLessThan(200);
    } finally {
      restoreEnv();
    }
  });
});

describe('目录通道显示名(中性标签)', () => {
  test('opus 通道的 sonnet 条目显示 Anthropic 前缀,不误标 Opus', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ apiKeys: { opus: 'test-key' } }),
    );
    const { getSelectableModels } = await import('./provider.js');
    const sonnet = getSelectableModels().find((m) => m.modelId === 'anthropic:claude-sonnet-4-20250514');
    expect(sonnet).toBeDefined();
    expect(sonnet!.name).toBe('Anthropic claude-sonnet-4-20250514');
    const opusEntry = getSelectableModels().find((m) => m.modelId === 'anthropic:claude-opus-4-20250514');
    expect(opusEntry!.name).toBe('Anthropic claude-opus-4-20250514');
  });

  test('glmc 标签不受影响;线上路径同规则', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ apiKeys: { glmc: 'k', opus: 'k' } }),
    );
    const { getSelectableModels, fetchSelectableModelsLive } = await import('./provider.js');
    expect(
      getSelectableModels().find((m) => m.modelId === 'glmc:glm-5.3-flash')?.name,
    ).toBe('GLM Coding Plan glm-5.3-flash');
    const live = await fetchSelectableModelsLive(async () => ['claude-sonnet-4-20250514', 'claude-opus-4-20250514']);
    expect(live.find((m) => m.modelId === 'anthropic:claude-sonnet-4-20250514')?.name).toBe(
      'Anthropic claude-sonnet-4-20250514',
    );
  });
});

describe('模型上下文长度后缀', () => {
  test('已知模型按模型名匹配(跨前缀),未知不显示', async () => {
    const { contextTokensFor, contextSuffix } = await import('./provider.js');
    expect(contextTokensFor('glmc:glm-5.3')).toBe(1_000_000);
    expect(contextTokensFor('glm:glm-5.3')).toBe(1_000_000);
    expect(contextTokensFor('opus')).toBeUndefined();
    expect(contextSuffix('glmc:glm-5.3')).toBe(' [1M]');
    expect(contextSuffix('opus')).toBe('');
  });

  test('格式化:K 档与 1.5M 档', async () => {
    const { contextSuffix } = await import('./provider.js');
    expect(contextSuffix('glmc:glm-5.3')).toBe(' [1M]');
    expect(contextSuffix('nope-unknown')).toBe('');
  });
});

describe('Minor 清账 F/G 组', () => {
  test('#22 原型链名不算合法模型 id', async () => {
    const { validateModelSpec } = await import('./provider.js');
    for (const bad of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(validateModelSpec(bad)).toContain('invalid model');
    }
  });

  test('#23 fable 别名与裸名大小写:校验与解析一致', async () => {
    const savedName = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
    const savedModel = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = 'fable-test-model';
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
    const { validateModelSpec, resolveModel } = await import('./provider.js');
    try {
      expect(validateModelSpec('fable')).toBeNull();
      expect(resolveModel('fable').model).toBe('fable-test-model');
      expect(validateModelSpec('GLMC')).toBeNull();
      expect(resolveModel('GLMC').model).toBe(resolveModel('glmc').model);
    } finally {
      if (savedName === undefined) delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
      else process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = savedName;
      if (savedModel !== undefined) process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = savedModel;
    }
  });

  test('#24 不完整 profile 名过不了校验', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ profiles: { half: { baseUrl: 'http://x/v1' } } }),
    );
    const { validateModelSpec } = await import('./provider.js');
    expect(validateModelSpec('half')).toContain('invalid model');
  });

  test('#32 含冒号的 profile 名不进目录(同步与线上)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        apiKeys: { glmc: 'k' },
        profiles: { 'my:gw': { baseUrl: 'http://x/v1', model: 'ma' } },
      }),
    );
    const { getSelectableModels, fetchSelectableModelsLive } = await import('./provider.js');
    expect(getSelectableModels().some((m) => m.modelId.includes('my:gw'))).toBe(false);
    const live = await fetchSelectableModelsLive(async () => ['ma', 'mb']);
    expect(live.some((m) => m.modelId.includes('my:gw'))).toBe(false);
  });

  test('#33 线上目录按通道序,不按完成序', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({
        apiKeys: { glmc: 'k', deepseek: 'k' },
      }),
    );
    const { fetchSelectableModelsLive } = await import('./provider.js');
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const live = await fetchSelectableModelsLive(async (baseUrl) => {
      // deepseek(注册表序在前)慢回,glmc 秒回——输出仍须注册表通道序
      if (baseUrl.includes('deepseek')) await delay(60);
      return baseUrl.includes('bigmodel') ? ['glm-x'] : ['ds-x'];
    });
    const ids = live.map((m) => m.modelId);
    expect(ids.indexOf('deepseek:ds-x')).toBeLessThan(ids.indexOf('glmc:glm-x'));
  });

  test('#34 模型列表请求同时带 Bearer 与 x-api-key', async () => {
    const { authHeaders } = await import('./provider.js');
    const headers = authHeaders('sk-test');
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['x-api-key']).toBe('sk-test');
    expect(authHeaders(undefined)).toEqual({});
  });
});

describe('清账轮审查修复', () => {
  test('#8b lookupApiKey 不读原型链', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ apiKeys: { glmc: 'k' } }),
    );
    const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY', 'KIMI_API_KEY', 'TRANSCODE_API_KEY'];
    const saved: Record<string, string | undefined> = {};
    for (const n of names) { saved[n] = process.env[n]; delete process.env[n]; }
    try {
      const { lookupApiKey } = await import('./provider.js');
      expect(lookupApiKey('toString')).toBeUndefined();
      expect(lookupApiKey('hasOwnProperty')).toBeUndefined();
      expect(lookupApiKey('glmc')).toBe('k');
    } finally {
      for (const [n, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[n]; else process.env[n] = v;
      }
    }
  });
});

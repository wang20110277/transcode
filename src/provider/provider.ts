import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { loadConfig, saveConfig } from '../config.js';

export type ModelId =
  | 'opus'
  | 'gpt'
  | 'deepseek'
  | 'glm'
  | 'glmc'
  | 'minimax'
  | 'kimi'
  | 'custom';

export type ProviderKind = 'openai' | 'anthropic';

export interface ModelConfig {
  name: string;
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  envKey: string;
}

const MODEL_REGISTRY: Record<ModelId, ModelConfig> = {
  opus: {
    name: 'Claude Opus',
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    envKey: 'ANTHROPIC_API_KEY',
  },
  gpt: {
    name: 'GPT-4o',
    provider: 'openai',
    model: 'gpt-4o',
    envKey: 'OPENAI_API_KEY',
  },
  deepseek: {
    name: 'DeepSeek',
    provider: 'openai',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
  },
  glm: {
    name: 'GLM',
    provider: 'openai',
    model: 'glm-5.3',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'GLM_API_KEY',
  },
  glmc: {
    name: 'GLM Coding Plan',
    provider: 'openai',
    // The GLM Coding Plan subscription only bills against the dedicated
    // coding endpoint; the standard /api/paas/v4 endpoint answers 429
    // "余额不足或无可用资源包" because the plan is not applied there.
    model: 'glm-5.3',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    envKey: 'GLM_API_KEY',
  },
  minimax: {
    name: 'MiniMax',
    provider: 'openai',
    model: 'MiniMax-Text-01',
    baseUrl: 'https://api.minimax.chat/v1',
    envKey: 'MINIMAX_API_KEY',
  },
  kimi: {
    name: 'Kimi',
    provider: 'openai',
    model: 'moonshot-v1-128k',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'KIMI_API_KEY',
  },
  custom: {
    name: 'Custom (OpenAI 兼容网关)',
    provider: 'openai',
    model: '',
    baseUrl: '',
    envKey: 'TRANSCODE_API_KEY',
  },
};

/** Curated model lists behind each vendor in the /models flow. */
const VENDOR_MODELS: Partial<Record<ModelId, string[]>> = {
  opus: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514'],
  gpt: ['gpt-4o', 'gpt-4o-mini'],
  deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
  glm: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-4.6', 'glm-4.5', 'glm-4.5-air'],
  glmc: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-4.6', 'glm-4.5'],
  minimax: ['MiniMax-Text-01'],
  kimi: ['moonshot-v1-128k', 'moonshot-v1-8k'],
};

/** Registry id → spec prefix understood by resolveModel. */
const SPEC_PREFIX: Record<string, string> = {
  opus: 'anthropic',
  gpt: 'openai',
};

export function vendorModels(id: ModelId): string[] {
  if (id === 'custom') return [loadConfig().custom?.model ?? ''].filter(Boolean);
  return VENDOR_MODELS[id] ?? [MODEL_REGISTRY[id]?.model ?? ''].filter(Boolean);
}

export function vendorModelSpec(id: ModelId, modelName: string): string {
  const prefix = SPEC_PREFIX[id] ?? id;
  return `${prefix}:${modelName}`;
}

const PROVIDER_DEFAULTS: Record<
  string,
  { provider: ProviderKind; baseUrl?: string; envKey: string }
> = {
  openai: { provider: 'openai', envKey: 'OPENAI_API_KEY' },
  anthropic: { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
  deepseek: {
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
  },
  glm: {
    provider: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'GLM_API_KEY',
  },
  glmc: {
    provider: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    envKey: 'GLM_API_KEY',
  },
  minimax: {
    provider: 'openai',
    baseUrl: 'https://api.minimax.chat/v1',
    envKey: 'MINIMAX_API_KEY',
  },
  kimi: {
    provider: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'KIMI_API_KEY',
  },
  moonshot: {
    provider: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'KIMI_API_KEY',
  },
  custom: {
    provider: 'openai',
    baseUrl: undefined,
    envKey: 'TRANSCODE_API_KEY',
  },
};

export interface TransProvider {
  modelId: string;
  model: BaseChatModel;
  config: ModelConfig;
}

export interface ResolvedModel {
  /** Stable id shown in the UI / accepted by `session/set_model`. */
  id: string;
  name: string;
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  envKey: string;
}

export function getAvailableModels(): { id: ModelId; name: string }[] {
  return Object.entries(MODEL_REGISTRY).map(([id, cfg]) => ({
    id: id as ModelId,
    name: cfg.name,
  }));
}

export function getModelConfig(id: ModelId): ModelConfig {
  return MODEL_REGISTRY[id];
}

export function isKnownModelId(value: string): value is ModelId {
  return Object.prototype.hasOwnProperty.call(MODEL_REGISTRY, value);
}

function defaultProvider(): string {
  return (process.env.TRANSCODE_DEFAULT_PROVIDER ?? 'openai').toLowerCase();
}

function anthropicAuthToken(): string {
  return (process.env.ANTHROPIC_AUTH_TOKEN ?? '').trim();
}

function anthropicGatewayUrl(): string | undefined {
  return (process.env.ANTHROPIC_BASE_URL ?? '').trim() || undefined;
}

/** Model configured by Claude Code / fable-style Anthropic-compatible setups. */
function fableModelName(): string {
  const value =
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME ??
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    '';
  // Some Fable setups append a context-size marker such as "[1M]".
  return value.replace(/\[[^\]]+\]$/, '').trim();
}

function defaultModelSpec(): string {
  const explicit = process.env.TRANSCODE_MODEL?.trim();
  if (explicit) return explicit;

  // A model saved from the REPL `models` flow (~/.transcode.json) applies
  // everywhere — REPL, ACP (`transcode acp`), and model checks — so an
  // integration host without an explicit model gets the user's choice.
  const preferred = preferredModelId();
  if (preferred) return preferred;

  if (anthropicAuthToken() || anthropicGatewayUrl()) {
    const fable = fableModelName();
    if (fable) return `anthropic:${fable}`;
  }

  const anthropicModel = process.env.ANTHROPIC_MODEL?.trim();
  if (anthropicModel) return `anthropic:${anthropicModel}`;

  return 'opus';
}

function apiKeyFor(envKey: string): string {
  const direct = process.env[envKey]?.trim();
  if (direct) return direct;

  if (envKey === 'ANTHROPIC_API_KEY') {
    const token = anthropicAuthToken();
    if (token) return token;
  }

  return (process.env.TRANSCODE_API_KEY ?? '').trim();
}

function maxTokens(): number {
  const raw = Number(process.env.TRANSCODE_MAX_TOKENS ?? '');
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 8192;
}

/**
 * Resolve a model spec into a concrete model configuration.
 *
 * Accepted forms:
 *   - a registry id (opus, gpt, deepseek, glm, minimax, kimi)
 *   - provider:model (openai:gpt-4o, anthropic:claude-sonnet-4, deepseek:deepseek-chat, ...)
 *   - a bare model name, routed by its name / TRANSCODE_DEFAULT_PROVIDER
 *   - an empty string, falling back to TRANSCODE_MODEL, the Fable/Anthropic
 *     gateway settings, then "opus"
 */
export function resolveModel(spec?: string): ResolvedModel {
  const raw = (spec?.trim() || defaultModelSpec()).trim();

  if (!raw) return resolveModel('opus');

  // User profiles win over built-in registry ids (same name = override).
  const profile = raw.includes(':') ? undefined : loadConfig().profiles?.[raw];
  if (profile?.baseUrl && profile.model) {
    return {
      id: raw,
      name: `${raw} · ${profile.model}`,
      provider: 'openai',
      model: profile.model,
      baseUrl: profile.baseUrl,
      envKey: profile.envKey ?? keyIdToEnvKey(profile.keyId) ?? 'TRANSCODE_API_KEY',
      // Carried internally for key resolution; harmless extra field.
      ...({ keyId: profile.keyId } as object),
    } as ResolvedModel;
  }

  if (raw.toLowerCase() === 'fable') {
    const fable = fableModelName();
    if (fable) {
      return {
        id: 'fable',
        name: fable,
        provider: 'anthropic',
        model: fable,
        baseUrl: anthropicGatewayUrl(),
        envKey: 'ANTHROPIC_API_KEY',
      };
    }
  }

  if (isKnownModelId(raw)) {
    const cfg = MODEL_REGISTRY[raw];
    if (raw === 'custom') {
      const saved = loadConfig().custom;
      return {
        id: raw,
        name: saved?.model ? `${cfg.name} · ${saved.model}` : cfg.name,
        provider: cfg.provider,
        model: saved?.model ?? '',
        baseUrl: saved?.baseUrl ?? '',
        envKey: cfg.envKey,
      };
    }
    return {
      id: raw,
      name: cfg.name,
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      envKey: cfg.envKey,
    };
  }

  const colon = raw.indexOf(':');
  if (colon > 0) {
    const prefix = raw.slice(0, colon).toLowerCase();
    const model = raw.slice(colon + 1);
    const defaults = PROVIDER_DEFAULTS[prefix];
    if (defaults && model) {
      const custom = prefix === 'custom' ? loadConfig().custom : undefined;
      return {
        id: raw,
        name: `${prefix}/${model}`,
        provider: defaults.provider,
        model,
        baseUrl:
          custom?.baseUrl ??
          (defaults.provider === 'anthropic' ? anthropicGatewayUrl() : defaults.baseUrl),
        envKey: defaults.envKey,
      };
    }
  }

  // Bare unknown model name: route through a provider guessed from the name,
  // then fall back to TRANSCODE_DEFAULT_PROVIDER. This lets transonce/multica
  // users type a model id without remembering the provider:model syntax.
  const lower = raw.toLowerCase();
  let fallback = PROVIDER_DEFAULTS[defaultProvider()] ?? PROVIDER_DEFAULTS.openai;
  if (lower.startsWith('claude')) fallback = PROVIDER_DEFAULTS.anthropic;
  else if (lower.startsWith('deepseek')) fallback = PROVIDER_DEFAULTS.deepseek;
  else if (lower.startsWith('glm')) fallback = PROVIDER_DEFAULTS.glm;
  else if (lower.startsWith('moonshot') || lower.startsWith('kimi')) {
    fallback = PROVIDER_DEFAULTS.kimi;
  } else if (lower.startsWith('minimax')) fallback = PROVIDER_DEFAULTS.minimax;

  // An Anthropic-compatible gateway can host arbitrary model names. Prefer it
  // when the guessed provider has no credentials of its own.
  if (fallback.provider !== 'anthropic' && anthropicGatewayUrl()) {
    const guessedKey = process.env[fallback.envKey]?.trim();
    if (!guessedKey) {
      return {
        id: raw,
        name: raw,
        provider: 'anthropic',
        model: raw,
        baseUrl: anthropicGatewayUrl(),
        envKey: 'ANTHROPIC_API_KEY',
      };
    }
  }

  return {
    id: raw,
    name: raw,
    provider: fallback.provider,
    model: raw,
    baseUrl: fallback.baseUrl,
    envKey: fallback.envKey,
  };
}

function baseUrlFor(resolved: ResolvedModel): string | undefined {
  if (process.env.TRANSCODE_BASE_URL) return process.env.TRANSCODE_BASE_URL;
  if (resolved.provider === 'anthropic') {
    return resolved.baseUrl ?? anthropicGatewayUrl();
  }
  return (
    resolved.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    process.env.OPENAI_API_BASE
  );
}

/** Display name for the model selected by the environment, if it is not a registry id. */
export function envModelLabel(): string | undefined {
  const resolved = resolveModel();
  return isKnownModelId(resolved.id) ? undefined : resolved.model;
}

export function createModel(spec?: string): TransProvider {
  const resolved = resolveModel(spec);
  // Keys entered in the REPL (`models` flow) take precedence over the
  // environment, so switching models in the session actually works.
  const apiKey = lookupApiKey(resolved.id);

  if (!apiKey) {
    throw new Error(
      `Missing API key for ${resolved.name} (${resolved.id}). ` +
        `Set ${resolved.envKey} in the environment.`,
    );
  }

  const baseUrl = baseUrlFor(resolved);
  const model = buildChatModel(resolved, apiKey, baseUrl, maxTokens());

  return {
    modelId: resolved.id,
    model,
    config: {
      name: resolved.name,
      provider: resolved.provider,
      model: resolved.model,
      baseUrl,
      envKey: resolved.envKey,
    },
  };
}

function buildChatModel(
  resolved: ResolvedModel,
  apiKey: string,
  baseUrl: string | undefined,
  tokens: number,
): BaseChatModel {
  if (resolved.provider === 'anthropic') {
    // Only use bearer auth when there is no explicit ANTHROPIC_API_KEY, so a
    // real Anthropic endpoint never receives both x-api-key and Authorization.
    const authToken = process.env.ANTHROPIC_API_KEY?.trim() ? '' : anthropicAuthToken();
    return new ChatAnthropic({
      modelName: resolved.model,
      anthropicApiKey: apiKey,
      ...(baseUrl ? { anthropicApiUrl: baseUrl } : {}),
      ...(authToken ? { clientOptions: { authToken } } : {}),
      temperature: 0,
      maxTokens: tokens,
      // @langchain/anthropic defaults top_k/top_p to -1 and forwards them on
      // every request. Strict Anthropic-compatible gateways reject that
      // ("top_p is in (0, 1.0]"), so drop both keys unless explicitly set.
      invocationKwargs: { top_k: undefined, top_p: undefined },
      maxRetries: 1,
    });
  }
  if (!baseUrl && /custom/.test(resolved.id)) {
    throw new Error('Custom gateway is not configured yet — set a base URL and model first.');
  }
  return new ChatOpenAI({
    modelName: resolved.model,
    openAIApiKey: apiKey,
    temperature: 0,
    maxTokens: tokens,
    maxRetries: 1,
    configuration: baseUrl ? { baseURL: baseUrl } : undefined,
  });
}

/**
 * Connectivity check used by the /models flow: one minimal completion with a
 * short timeout. Returns a readable message for the UI either way.
 */
export async function verifyModel(
  spec: string,
  apiKeyOverride?: string,
): Promise<{ ok: boolean; message: string; served?: string }> {
  const resolved = resolveModel(spec);
  const apiKey = apiKeyOverride?.trim() || lookupApiKey(resolved.id);
  if (!apiKey) {
    return { ok: false, message: `缺少 API key（${resolved.envKey}），请先输入。` };
  }

  try {
    const model = buildChatModel(resolved, apiKey, baseUrlFor(resolved), 16);
    const response = (await Promise.race([
      model.invoke('ping'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('连接超时（10s）')), 10_000).unref?.(),
      ),
    ])) as { response_metadata?: { model_name?: string } };

    const served = response?.response_metadata?.model_name;
    return {
      ok: true,
      served,
      message: `连通正常${served ? `（实际模型 ${served}）` : ''}`,
    };
  } catch (error) {
    const raw = (error as Error).message ?? String(error);
    return { ok: false, message: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw };
  }
}

/**
 * Switch-line copy for applyModelSwitch: appends the effectively served
 * model when the gateway maps the picked name onto a different one
 * (e.g. glm-4.6 → glm-5.3-flash).
 */
export function switchNote(displayName: string, pickedModel: string, served?: string): string {
  if (served && served !== pickedModel) {
    return `已切换到 ${displayName}（实际生效 ${served}）`;
  }
  return `已切换到 ${displayName}`;
}

// ---- REPL key/model persistence (~/.transcode.json) ----

const keyStore = new Map<string, string>(
  Object.entries(loadConfig().apiKeys ?? {}),
);

/** Register an API key for a registry model and persist it to disk. */
export function registerApiKey(id: string, apiKey: string): void {
  keyStore.set(id, apiKey);
  const cfg = loadConfig();
  cfg.apiKeys = { ...(cfg.apiKeys ?? {}), [id]: apiKey };
  saveConfig(cfg);
}

/** Key registered via the REPL, if any (env vars are the fallback). */
export function registeredApiKey(id: string): string | undefined {
  return keyStore.get(id);
}

/** Test helper: forget all REPL-registered keys. */
export function clearRegisteredApiKeys(): void {
  keyStore.clear();
}

/**
 * Resolves the API key for a spec or registry id: exact match first, then
 * the vendor prefix ("deepseek:deepseek-reasoner" → "deepseek"), then any
 * vendor sharing the same env credential family (glmc reuses the glm key),
 * then the environment.
 */
export function lookupApiKey(specOrId: string): string | undefined {
  const trimmed = specOrId.trim();
  const prefix = trimmed.split(':')[0]!;
  const candidates = [trimmed, prefix];
  const resolved = resolveModel(trimmed);
  for (const [id, config] of Object.entries(MODEL_REGISTRY)) {
    if (config.envKey === resolved.envKey) candidates.push(id);
  }
  for (const candidate of candidates) {
    const key = keyStore.get(candidate) ?? loadConfig().apiKeys?.[candidate];
    if (key) return key;
  }
  return apiKeyFor(resolved.envKey) || undefined;
}

/** Persist the custom gateway chosen in the /models flow. */
export function setCustomModel(custom: { baseUrl: string; model: string }): void {
  const cfg = loadConfig();
  cfg.custom = { baseUrl: custom.baseUrl, model: custom.model };
  saveConfig(cfg);
}

/** Maps a key store id onto a sensible env var name (glm → GLM_API_KEY). */
function keyIdToEnvKey(keyId: string | undefined): string | undefined {
  if (!keyId) return undefined;
  const registry = MODEL_REGISTRY[keyId as ModelId];
  if (registry) return registry.envKey;
  return `${keyId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/** Role → profile routing table. */
export function getRouting(): Record<string, string> {
  return { ...(loadConfig().routing ?? {}) };
}

/**
 * Newest-generation-first ordering for a live model list: numeric runs
 * compare pairwise, descending ('glm-5.3' > 'glm-4.6' > 'glm-4.5-air');
 * on a version tie the shorter base name leads ('glm-5.3' before
 * 'glm-5.3-flashx'), then alphabetical.
 */
function newestFirst(a: string, b: string): number {
  const digits = (s: string): number[] => (s.match(/\d+/g) ?? []).map(Number);
  const na = digits(a);
  const nb = digits(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const da = na[i] ?? -1;
    const db = nb[i] ?? -1;
    if (da !== db) return db - da;
  }
  if (a.length !== b.length) return a.length - b.length;
  return a.localeCompare(b);
}

/**
 * Live model list from an endpoint's OpenAI-compatible GET /models, so the
 * /models picker shows what the gateway actually serves (Zhipu's coding
 * endpoint, for one, maps old names to newer generations). Empty list on
 * any failure — callers fall back to the curated list. The override form
 * queries an in-progress custom gateway before it is saved.
 */
export async function listEndpointModels(
  specOrId: string,
  override?: { baseUrl?: string; apiKey?: string },
): Promise<string[]> {
  try {
    const baseUrl = (override?.baseUrl ?? baseUrlFor(resolveModel(specOrId)))?.replace(/\/$/, '');
    if (!baseUrl) return [];
    const apiKey = override?.apiKey ?? lookupApiKey(resolveModel(specOrId).id);
    const response = await Promise.race([
      fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      }),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ]);
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].sort(newestFirst);
  } catch {
    return [];
  }
}

/** Set (or clear with "-") a role's profile. */
export function setRouting(role: string, profile: string): void {
  if (!role.trim()) throw new Error('Role name cannot be empty.');
  const cfg = loadConfig();
  cfg.routing = { ...(cfg.routing ?? {}) };
  if (profile.trim() === '-') delete cfg.routing[role];
  else cfg.routing[role] = profile.trim();
  saveConfig(cfg);
}

/** Resolve a role name to its routed model, if configured. */
export function resolveRole(role: string): ResolvedModel | undefined {
  const profile = getRouting()[role];
  if (!profile) return undefined;
  return resolveModel(profile);
}

/**
 * One-shot delegation to a routed role (used by the ask_model tool): sends
 * the prompt — optionally with base64 images for vision roles — to the
 * role's model and returns its text answer.
 */
export async function askRole(
  role: string,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
): Promise<string> {
  const routing = getRouting();
  const profile = routing[role];
  if (!profile) {
    const names = Object.keys(routing).join(', ');
    throw new Error(`Unknown role "${role}". Configured roles: ${names || '(none — set one with /route)'}`);
  }

  const provider = createModel(profile);
  const content = images?.length
    ? ([
        { type: 'text', text: prompt },
        ...images.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${image.mediaType};base64,${image.data}` },
        })),
      ] as unknown as string)
    : prompt;

  const response = (await Promise.race([
    provider.model.invoke(content),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('角色模型超时（180s）')), 180_000),
    ),
  ])) as { content: unknown };

  if (typeof response.content === 'string') return response.content;
  if (Array.isArray(response.content)) {
    return response.content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

/** Model chosen in the REPL on a previous run, if any. */
export function preferredModelId(): string | undefined {
  const saved = loadConfig().model;
  return saved?.trim() || undefined;
}

/** Persist the REPL's model choice (registry id or provider:model spec). */
export function setPreferredModel(id: string): void {
  const cfg = loadConfig();
  cfg.model = id;
  saveConfig(cfg);
}

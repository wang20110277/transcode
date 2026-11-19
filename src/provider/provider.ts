import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { loadConfig, saveConfig } from '../config.js';

export type ModelId = 'opus' | 'gpt' | 'deepseek' | 'glm' | 'minimax' | 'kimi';

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
    name: 'GLM-4',
    provider: 'openai',
    model: 'glm-4',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
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
};

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
      return {
        id: raw,
        name: `${prefix}/${model}`,
        provider: defaults.provider,
        model,
        baseUrl:
          defaults.provider === 'anthropic' ? anthropicGatewayUrl() : defaults.baseUrl,
        envKey: defaults.envKey,
      };
    }
  }

  // Bare unknown model name: route through a provider guessed from the name,
  // then fall back to TRANSCODE_DEFAULT_PROVIDER. This lets multica users type
  // a model id without remembering the provider:model syntax.
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
  const apiKey = registeredApiKey(resolved.id) ?? apiKeyFor(resolved.envKey);

  if (!apiKey) {
    throw new Error(
      `Missing API key for ${resolved.name} (${resolved.id}). ` +
        `Set ${resolved.envKey} in the environment.`,
    );
  }

  let model: BaseChatModel;
  const baseUrl = baseUrlFor(resolved);

  if (resolved.provider === 'anthropic') {
    // Only use bearer auth when there is no explicit ANTHROPIC_API_KEY, so a
    // real Anthropic endpoint never receives both x-api-key and Authorization.
    const authToken = process.env.ANTHROPIC_API_KEY?.trim() ? '' : anthropicAuthToken();
    model = new ChatAnthropic({
      modelName: resolved.model,
      anthropicApiKey: apiKey,
      ...(baseUrl ? { anthropicApiUrl: baseUrl } : {}),
      ...(authToken ? { clientOptions: { authToken } } : {}),
      temperature: 0,
      maxTokens: maxTokens(),
      // @langchain/anthropic defaults top_k/top_p to -1 and forwards them on
      // every request. Strict Anthropic-compatible gateways reject that
      // ("top_p is in (0, 1.0]"), so drop both keys unless explicitly set.
      invocationKwargs: { top_k: undefined, top_p: undefined },
      maxRetries: 1,
    });
  } else {
    model = new ChatOpenAI({
      modelName: resolved.model,
      openAIApiKey: apiKey,
      temperature: 0,
      maxTokens: maxTokens(),
      maxRetries: 1,
      configuration: baseUrl ? { baseURL: baseUrl } : undefined,
    });
  }

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

/** @deprecated Use createModel instead. Kept for the existing REPL. */
export function createProviderWithKey(id: ModelId, apiKey: string): TransProvider {
  const config = MODEL_REGISTRY[id];
  if (!config) throw new Error(`Unknown model: ${id}`);

  registerApiKey(id, apiKey);

  const model =
    config.provider === 'anthropic'
      ? new ChatAnthropic({
          modelName: config.model,
          anthropicApiKey: apiKey,
        })
      : new ChatOpenAI({
          modelName: config.model,
          openAIApiKey: apiKey,
          configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
        });

  return { modelId: id, model, config };
}

/** @deprecated Use createModel instead. Kept for the existing REPL. */
export function createProvider(id: ModelId): TransProvider {
  return createModel(id);
}

// ---- REPL key/model persistence (~/.transcode.json) ----

const keyStore = new Map<string, string>(
  Object.entries(loadConfig().apiKeys ?? {}),
);

/** Register an API key for a registry model and persist it to disk. */
export function registerApiKey(id: ModelId, apiKey: string): void {
  keyStore.set(id, apiKey);
  const cfg = loadConfig();
  cfg.apiKeys = { ...(cfg.apiKeys ?? {}), [id]: apiKey };
  saveConfig(cfg);
}

/** Key registered via the REPL, if any (env vars are the fallback). */
export function registeredApiKey(id: string): string | undefined {
  return keyStore.get(id);
}

/** Model chosen in the REPL on a previous run, if any. */
export function preferredModelId(): ModelId | undefined {
  const saved = loadConfig().model;
  return saved && isKnownModelId(saved) ? saved : undefined;
}

/** Persist the REPL's model choice for the next run. */
export function setPreferredModel(id: ModelId): void {
  const cfg = loadConfig();
  cfg.model = id;
  saveConfig(cfg);
}

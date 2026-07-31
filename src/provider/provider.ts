import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type ModelId = 'opus' | 'gpt' | 'deepseek' | 'glm' | 'minimax' | 'kimi';

interface ModelConfig {
  name: string;
  provider: 'openai' | 'anthropic';
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

export interface TransProvider {
  modelId: ModelId;
  model: BaseChatModel;
  config: ModelConfig;
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

export function createProviderWithKey(id: ModelId, apiKey: string): TransProvider {
  const config = MODEL_REGISTRY[id];
  if (!config) throw new Error(`Unknown model: ${id}`);

  let model: BaseChatModel;

  if (config.provider === 'anthropic') {
    model = new ChatAnthropic({
      modelName: config.model,
      anthropicApiKey: apiKey,
    });
  } else {
    model = new ChatOpenAI({
      modelName: config.model,
      openAIApiKey: apiKey,
      configuration: config.baseUrl
        ? { baseURL: config.baseUrl }
        : undefined,
    });
  }

  return { modelId: id, model, config };
}

export function createProvider(id: ModelId): TransProvider {
  const config = MODEL_REGISTRY[id];
  if (!config) throw new Error(`Unknown model: ${id}`);

  const apiKey = process.env[config.envKey] ?? '';

  let model: BaseChatModel;

  if (config.provider === 'anthropic') {
    model = new ChatAnthropic({
      modelName: config.model,
      anthropicApiKey: apiKey,
    });
  } else {
    model = new ChatOpenAI({
      modelName: config.model,
      openAIApiKey: apiKey,
      configuration: config.baseUrl
        ? { baseURL: config.baseUrl }
        : undefined,
    });
  }

  return { modelId: id, model, config };
}

# 按 key 圈定的模型目录(修正版)— 设计

日期:2026-11-28 · 状态:设计已确认(修正 0.12.20 的"全厂商 curated 展开"误读;用户明确:没有 key 的不显示)

## 意图

目录只反映 **transcode 实际配置了 key 的通道**及其**真实可用模型**:glmc/deepseek 有 key 就列(线上拉取),没 key 的厂商不出现;自定义网关一个 baseUrl 下多个模型全列。全新无 key 无网关的机器目录为空——期望行为。

## 设计

### 1. 通道集合(key 圈定)

- 注册表厂商:`lookupApiKey(解析后 id)` 有 key 才入选;**无 key 的厂商在任何路径(线上/回退)都不出现**。
- 自定义网关:`listCustomGateways()`(profiles + legacy custom 槽,定义即有 baseUrl)全部入选。

### 2. 线上目录(异步,agent/models 与 `transcode models` 用)

- 每通道并行 `fetchEndpointModels(baseUrl, key)`(现成:GET /models,5 秒超时,失败返回 []);
- 厂商条目 `modelId = '<前缀>:<模型>'`(如 `glmc:glm-5.3-flash`);网关条目 `modelId = '<profile名>:<模型>'` 或 `custom:<模型>`;
- **通道级回退**:线上为空/失败 → 厂商回 curated 表(VENDOR_MODELS),网关回已配模型;无 key 通道仍不出现;
- `name = '<通道显示名> <模型>'`(通道显示名:注册表 name 或 profile 名)。
- 实现带可注入 fetcher 参数(默认 `fetchEndpointModels`),测试用本地假网关。

### 3. 同步快照(session/new 与 set_model 的 availableModels)

零网络:有 key 厂商 → curated 表展开;网关 → 已配模型(legacy custom 网关仍可线上多模型,但快照只展示已配)。`modelCatalog` 的 unshift 当前 id 逻辑保留,补 `modelLabel`。

### 4. 新 spec 形态 `profile名:MODEL`

- `resolveModel` colon 分支:先查 `profiles[prefix]`(baseUrl+model 齐)→ 以该 profile 的 baseUrl/envKey/keyId 路由 MODEL;再查厂商前缀(现行为)。裸 profile 名语义不变(= 已配模型)。
- `validateModelSpec` 同步接受"profile 名:"前缀。
- REPL 建的 profile 名无冒号(已消毒),与厂商前缀不冲突。

### 5. 取代关系

`getSelectableModels()` 重写为 key 圈定的同步快照(替代 0.12.20 的全厂商展开);新增 `fetchSelectableModelsLive()` 供 ACP/CLI。

## 非目标

- 目录结果缓存/TTL(每次 agent/models 现拉;宿主调用频率低)。
- Anthropic 官方端点的 /models 差异适配(失败自然回退 curated)。

## 验收口径

- 无 key 无网关的空配置 → 目录为空数组,不报错。
- 有 glmc key(本地假网关或注入 fetcher)→ 只出现 glmc 通道条目;opus 等不出现。
- 假网关返回多个模型 → 多条;假网关 500 → 回退该通道 curated/已配,其余通道不受影响。
- `gw1:model-a` 形态:`session/new {model: 'gw1:model-a'}` 成功且解析到 gw1 的 baseUrl。

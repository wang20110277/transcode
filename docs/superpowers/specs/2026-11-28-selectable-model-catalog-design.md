# 可选模型目录(ACP/CLI)— 设计

日期:2026-11-28 · 状态:设计已确认(用户反馈:目录只展示厂商层,应展示真实配置的模型;自定义网关可能多模型)

## 意图

`agent/models`、`transcode models`、`session/new`/`set_model` 返回的模型目录当前是 8 个厂商层 id,宿主 picker 选不到具体模型,也看不到自定义网关。目录应与 REPL 选单同宇宙:具体模型规格 + 已存自定义网关(多条)。

## 设计

1. `src/provider/provider.ts` 新增 `export function getSelectableModels(): { modelId: string; name: string }[]`:
   - 厂商侧按 `MODEL_REGISTRY` 顺序展开 `VENDOR_MODELS[id]`,`modelId = vendorModelSpec(id, 模型)`,`name = '<注册表名> <模型>'`(带厂商名以区分 `glm`/`glmc` 同名模型);
   - 追加 `listCustomGateways()`:`modelId = entry.spec`(profile 名或 legacy `custom`),`name = '<spec> · <model>'`;
   - 无 curated 表的厂商自然不产生条目(custom 槽位由网关部分覆盖);
   - 按 modelId 去重,先到先得(厂商条目在前,网关在后;同名 profile 覆盖注册表 id 的场景以注册表规格串为准,二者 modelId 不同不冲突)。
2. 三个消费点统一切换:`agent/models`、CLI `transcode models`、`modelCatalog()`(session/new 与 set_model 的 `availableModels`;当前项不在目录时仍 unshift 当前 id,维持现状)。
3. 所有列出的 `modelId` 必须能被 `validateModelSpec` 接受并能被 `resolveModel` 解析(规格构造即保证)。
4. 现有目录形状断言(`'glmc'` 等)随行为更新为具体规格。

## 非目标

- curated 表的在线刷新(与 REPL 同源,已知过期问题,另行处理)。
- 目录分组/分页(条目 ~25 个)。

## 验收口径

- `agent/models` 含 `glmc:glm-5.3-flash`,不含裸 `glmc`;含每个已存网关的 profile 名。
- 目录中任取一个 modelId 传 `session/new` 均成功。
- `transcode models` 与 ACP 目录内容一致。

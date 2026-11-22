# Web 工具(WebFetch + WebSearch)— 设计

## 意图

给 agent 补上联网能力:抓网页(WebFetch)与搜网(WebSearch)。多模型架构下必须厂商无关——搜索不走任何模型提供商的服务端工具,transcode 只提供实现,搜索商与 key 由用户自己配置,配好全局生效。对齐 CCB 的 WebFetch/WebSearch 能力面,但不搬其 Anthropic 专属实现。

## 设计

### WebFetch(零配置,开箱即用)

- **工具 `web_fetch { url, prompt? }`**:原生 `fetch`(Bun 内建,零新依赖),跟随重定向,15s 超时(AbortSignal.timeout)
- **User-Agent**:诚实 bot 惯例 `Mozilla/5.0 (compatible; transcode/<version>)`,不伪装浏览器;被站点 403 时错误如实返回模型
- **字符集**:收字节(arrayBuffer)后按 Content-Type 头 / meta 标签嗅探 charset,`TextDecoder` 解码(gbk/gb2312 官方构建均支持),兜底 UTF-8——中文页面不乱码
- **代理**:全局安装路径(bun shebang)的 fetch 原生认 HTTP(S)_PROXY,零代码;Node dist 自建路径 v1 不做显式代理(不引 undici),README 注明
- **响应处理**:大小上限 512KB(超限截断);HTML 走零依赖文本提取——剥 `script`/`style`/`head` 噪声,标签转文本,空行折叠;text/plain、application/json 原样(截断);其余二进制类型返回内容类型与大小提示
- **输出**:页面标题 + 提取文本,字符上限 20k(超限截断并注明);`prompt` 参数仅原样附在输出前作阅读指引,不做小模型二次加工(CCB 用 Haiku 转写,多花一次调用,v1 不值)
- **权限**:`kind: 'fetch'`、`isMutating: false` —— readonly 与 plan 模式放行(对工作区只读)

### WebSearch(用户配置,全局生效)

- **配置**:`~/.transcode.json` 新增 `webSearch: { provider: 'tavily' | 'brave', apiKey: string }`。**无环境变量口子,不内置任何 key**;`loadConfig()` 每次现读,改完下一轮生效(REPL/ACP 全局)。两条配置路径:
  - **手改 JSON**(power-user 兜底):直接编辑 `webSearch` 段
  - **REPL 交互 `/search`**:仿 `/models` 三级流程由 REPL 拦截——选搜索商(tavily/brave)→ 输 key(已存的可回车沿用)→ **发一条真实测试查询验证**(显示命中条数与首条标题,失败亮 API 原始报错可重输)→ `saveConfig` 写入 `webSearch` 段
- **适配器**:每家一个纯函数适配器,统一出入参 `{ query, maxResults } → { title, url, snippet }[]`
  - Tavily:`POST https://api.tavily.com/search`(`{ api_key, query, max_results }`)
  - Brave:`GET https://api.search.brave.com/res/v1/web/search`(头 `X-Subscription-Token`,参数 `q`/`count`)
  - 未知 provider / 缺 apiKey / 请求失败 → 返回可读错误文案
- **工具 `web_search { query, maxResults? }`**(默认 5 条):输出 `title — url\nsnippet` 列表;`kind: 'fetch'`、`isMutating: false`
- **未配置时模型不可见**:工具列表在 `loop.ts:315` 每轮组装,按配置过滤——`webSearch` 段无效时 `web_search` 不进本轮工具表(模型不会浪费轮次撞错误),`web_fetch` 恒可用
- **坏配置感知**:`webSearch` 段**存在但无效**(provider 拼错 / key 空)→ REPL 启动打一行警告并提示 `/search`,ACP 侧 stderr 提示一次;**完全未配置** → 全程静默

### 注册与共享

两工具经 `dispatchPool` 进 `AGENT_TOOLS`,ACP 与子 agent 同享(与 memory 工具同路径)。

## 非目标

- 域名安全预检/企业出口代理(CC 的 claude.ai 预检那套)、LRU 缓存、小模型页面转写
- Node dist 路径的显式代理支持(undici ProxyAgent 依赖)——bun 路径原生认环境代理已覆盖全局安装
- 搜索商生态扩张(先 Tavily + Brave 两家,适配器接口留口)
- 流式抓取、图片/二进制内容的多模态回传

## 备选(已否)

- **Anthropic 服务端 `web_search` 工具(CCB 同款)**:只对 anthropic kind 生效,GLM/DeepSeek 主力网关全用不上 — 已否
- **DuckDuckGo HTML 抓取**:免 key 但脆弱且 ToS 灰色,不做默认路径
- **本周期只发 WebFetch**:搜索是"查最新文档"场景的另一半,适配器成本低,一起做
- **环境变量配 key**:用户明确不要——配置只走 `~/.transcode.json`,单一事实源

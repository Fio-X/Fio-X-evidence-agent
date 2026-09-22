# 可视化与 JSON 工具链修复执行记录

本轮针对审计中暴露的三条断链执行了 P0 修复：工具参数协议、证据/数据到渲染的链路，以及无数据时的安全失败。

## 已执行

1. **JSON 工具协议**
   - OpenAI Chat Completions 改用 `type=function`、`function.parameters` 和 `tool` 回合；不再把 Anthropic 的 `input_schema` 直接发送给 OpenAI。
   - 工具调用参数必须是 JSON 对象；对象字段的数组、字符串、数字、布尔值按工具 schema 校验。错误包含工具名和字段路径，不再静默变成空对象。
   - OpenAI 的 `function.arguments` 解析失败、不是 JSON 对象、缺少调用 ID/函数名时 fail-closed；Rust agent 将工具错误原样以有界长度反馈给下一轮。

2. **数据获取与可视化路由**
   - 包含视觉意图的 `news investigate` / `news continue` 自动启用 `visual` profile，暴露数据发现、下载、DuckDB 和 Lieflat 工具。
   - 视觉提示明确要求：先发现/下载机器可读数据，再用 DuckDB 计算；最终可交付 SVG/PNG 或自包含 HTML。
   - `visual` 与 `visual-story` profile 已同步到运行时注册表，避免“工具存在但 profile 看不到”。

3. **Lieflat Charts 保底**
   - 使用仓库内锁定的 Lieflat Charts bundle 与 upstream commit，新增目录选择器和证据绑定渲染器。
   - 默认按 Lupi Editorial → Lupi Basics → Glance 选图；图表模式输出 SVG + 自包含 HTML，报告模式才输出完整 HTML 报告。
   - 发布模块必须有 verified claim、source、DuckDB computation 和真实模板 ID；模板演示数据、网络地图模板和不支持的模板均 fail-closed。探索性 `newsroom_viz_plan` 可显式使用 `verification_mode=draft`，但产物带 `DRAFT / publishable=false` 标记，不得升级为发布模块。
   - 没有可验证证据时只报告 `EVIDENCE_BLOCKED`，不生成事实性信息图。

## 验收结果

以下检查均已通过：

- `cargo test --quiet`：78 passed，1 ignored
- `cargo clippy --locked --all-targets -- -D warnings`
- `python3 scripts/check_runtime_contract.py`
- `node scripts/test_evidence_gate.mjs`
- `node scripts/test_visual_story_routing.mjs`
- `node scripts/test_visual_story_completion.mjs`
- `node scripts/test_bundled_skills.mjs`
- `node scripts/test_lieflat_catalog.mjs`
- `node scripts/test_lieflat_report.mjs`
- `python3 scripts/test_anthropic_wire_mock.py`
- `python3 scripts/test_openai_wire_mock.py`（本地 provider mock）
- `python3 scripts/test_artifact_completion.py`
- `python3 scripts/test_recompute_protocol.py`
- `node scripts/test_viz.mjs`
- `git diff --check`

## 真实数据 E2E 验收

使用 OWID 官方全球能源 CSV 与 codebook（23,377 行、约 130 个字段）跑通 2000—2023 分析窗口。CLI agent 实际完成数据盘点、11 个 DuckDB 计算、6 个 verified claims、6 节 Story Graph，并暴露了四个真实问题：中文图表任务导致目录打平到 L1、通用渲染器把 `year` 误当指标、失败的 Story Graph 会覆盖 `story.json` 调查元数据、跨语言小数重算不一致。上述问题已分别通过双语目录语义桥、`label_field/value_fields` 数据契约、调查元数据只读保护和统一 half-away-from-zero 六位小数协议修复。

修正版组合报告使用 L3 双序列趋势、L4 区域矩阵、L2 排名、F8 散点、L2 极端对比和 F3 多序列趋势；主产物为隔离 E2E 产物中的 `publications/10bff22c8ba4797a7e28ba103c78bf97d39dbd27743ce5605c8c9cd3e23b3d7a/index.html`。Rust 与 Python `verify --recompute` 均通过，HTML 自包含、桌面/移动 QA PASS、网络请求为 0。

## 后续迭代

真实供应商、多轮 Pi、DuckDB 二进制和浏览器环境仍需在部署环境执行一次端到端 qualification；本地契约测试不会冒充真实网络/模型验收。下一步可补充数据源白名单、自动数据 schema profile 和 PNG 栅格导出（当前 SVG/HTML 已满足离线交付）。

## GIS、网络与组合图形迭代

用户提出“GIS 网络气泡图 + Sankey + 基础图形组合”的要求后，确认现有路由已经覆盖：Plotly `geo_linked` / `sankey`、D3 `sankey` / `chord` / `radial_network`、NetworkX 图分析、Sigma 大图网络、MapLibre/deck.gl GIS 和 Python cartographic flow。新增 `scripts/test_composite_geo_network_sankey.mjs`，用自包含 HTML 实际组合了地理气泡、Sankey 和可选节点网络三个模块；回归产物写入操作系统临时目录，不把本机绝对路径提交到仓库。

本地能力边界也记录如下：Plotly/D3 编译和组合渲染 PASS；Python 环境暂缺 `geopandas`、`shapely`、`networkx`、`plotly`，R 环境缺 `Rscript`，浏览器截图 QA 缺 `playwright`。因此 GIS 专业渲染、NetworkX 布局和真实浏览器 QA 仍标记为待 qualification，不将能力注册表当作生产验收。

页面层新增 `japanese_editorial` 设计系统：以 ma（留白）、非对称网格、书籍式层级、细线分隔、克制暖灰和朱红强调为原则，不复制某一位设计师的作品。该 profile 已接入 HTML publication CSS，并通过 style mapping 回归测试。

隔离运行时还新增了 `config/editorial-style-mappings.json` 的物化和 `NEWSROOM_ARTIFACT_DIR` 优先读取逻辑，确保高级 publication 在独立 artifact 中不会因找不到样式配置而降级或失败。

## 第二轮真实 CLI 与便携组合路径

第二轮真实 CLI 使用同一份 OWID 本地 CSV，明确要求 GIS 气泡、Sankey 和网络三类模块。它暴露了一个实际阻塞：可视化 SQL 可以引用已经落盘的 `computations/<hash>.json`，但 DuckDB 的只读目录白名单只包含 `data/` 与 `sources/`，导致 `newsroom_viz_lint` 在执行查询前退出。运行时查询器、Rust `verify --recompute` 与 Python 独立校验器现已统一允许只读 `computations/`；外部访问仍关闭。

同一轮还发现模型常用的 `claim_spec.relation="correlation"` 与内部 `relationship` 词不一致，造成无意义的 schema 重试。现在接受 `correlation` 并规范化为 `relationship`/`scatter` 语法。

专业 GIS、NetworkX、R 或浏览器未安装时，运行时健康检查不再错误地把内置 Plotly 和 native Canvas 一起判为不可用。新增 `newsroom_portable_publication`：它校验 StoryGraph、verified claims、computation row hash 和 field mapping，生成自包含 `japanese_editorial` HTML，支持 `geo_linked`、Sankey 与确定性示意网络。`node scripts/test_evidence_bound_composite.mjs` 会在系统临时目录生成三模块、`evidence_bound=true` 的回归产物；它是本地真实渲染能力 fixture，浏览器 QA 仍需部署环境执行。

第二轮 CLI 的 Lieflat 结果仍诚实记录为部分成功：Sankey 与关系散点 HTML 通过独立 Rust/Python 重算验证（Rust integrity 163、SQL recompute 23；Python checks 239），但专业 GIS、网络和 japanese_editorial 组合没有被偷偷伪造；该产物不能冒充完整三模块 publication。新的便携路径随后完成真实 CLI 验收。第三轮运行先暴露并修复了三类契约问题：模型把 computation artifact 文件名误填到 `result_hash`（现在安全规范化到行哈希）、`country_field`/`value_field` 没有映射到 Plotly 国家名与颜色通道、StoryGraph 入口仍拒绝 `relationship`。现在三者均有显式兼容路径；相关 claim 可以来自同一模块的直接 computation，也可以来自独立、已验证的 supporting computation，并在 `evidence_binding.claim_computation_refs` 留痕，不会把相关证据伪装成直接数据行。真实 CLI 产物保存在本地验收记录中，不将不可访问的临时路径作为公开文档链接。

最新真实验收产物包含 `geo_linked`（ISO-3，颜色绑定 `value_field`）、Plotly Sankey 和 native Canvas network，`japanese_editorial`、self-contained、无外部请求。此次空白页复现确认是 Plotly `scattergeo` 默认请求 Natural Earth topojson，而 publication CSP 禁止外部请求；现在已内置离线 Natural Earth context + country centroid/coordinate Canvas fallback，并为每个模块隔离异常，地图失败不会再中断 Sankey/network。Rust `verify --recompute`：integrity 122、SQL 17；Python 独立校验：178 checks 均 PASS；生成脚本 `node --check`、离线 DOM/Canvas runtime smoke test 均 PASS。portable fallback 明确未冒充浏览器 QA；部署环境仍应对该 HTML 做正式截图/交互回归。

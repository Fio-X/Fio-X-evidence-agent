# 复杂信息图管线：下一步迭代计划

Date: 2026-09-19
Branch: `feat/complex-infographic-audit`

## 目标

将已完成审计的复杂信息图管线，从“本地验证通过的候选版”推进到“可在 GitHub 审查的变更集”，同时保留证据绑定、离线交付、视觉质量和第三方 skill 许可边界。

当前状态：迭代 1 已在本地完成；迭代 2 的新回归组已在本地通过并接入 CI。首次 Actions 暴露的 skill 哈希漂移已修复；visual-runtimes 的构建上下文、Node runtime 探针和 GraphRAG 依赖冲突正在同一反馈轮中修复。公开提交 Lieflat 非商业许可代码已获得项目方确认，但其子树仍保持独立许可边界。

## 迭代 1：提交卫生

- 执行 Rust 格式化，保持 `cargo fmt --all -- --check` 通过。
- 移除公开文档中指向本机的产物链接。
- 生成 fixture 的测试使用操作系统临时目录。
- 不将生成产物、凭证或本地 `.env` 纳入 Git。
- 保留 Lieflat 上游 `LICENSE`、notices、锁定 commit 和聚合哈希；根目录 MIT 许可不覆盖 `skills/lieflat-charts/**`。

退出门槛：`git diff --check` 通过，未发现敏感信息，无超过 GitHub 100MB 限制的文件，所有新回归测试均已接入 CI。

## 迭代 2：确定性 CI 验证

- 验证 bundled skill 完整性、Lieflat 目录/渲染、visual-story 路由和完成门禁。
- 验证证据绑定的地图/Sankey/网络组合。
- 注入离线 topojson 失败，断言 Canvas 地图回退生效，且 Sankey 与网络继续渲染。
- 通过严格的本地 mock HTTP provider 分别验证 OpenAI 与 Anthropic 的工具协议：OpenAI `arguments` JSON 字符串解码、Anthropic `input` 对象、多工具结果顺序和 provider 专属 schema envelope。
- 断言 provider 回合结束后生成非空 HTML、生成 `report.md`，并在报告中引用实际产物路径。
- 通过独立 mock 验证 artifact completion 行为；测试按 `NEWSROOM_TEST_BINARY`、release、debug 的顺序解析 CLI，兼容本地及 CI 构建。
- 将浏览器专项验证与确定性 renderer 测试分开。

退出门槛：Rust build/test/clippy、schema、runtime contract 与新回归组在 GitHub Actions 全部通过。

## 迭代 3：浏览器与设计验收

- 在 390、768、1024 和 1440 像素宽度下运行锁定版 Chromium。
- 截图并验证交互回放、空画布、溢出、标签冲突和减少动效行为。
- 增加同时包含地理气泡、Sankey、关系网络和编辑注释的设计审查 fixture。
- 使用明确的密度、层级、对比和阅读顺序标准评估，不复制特定设计师作品。

退出门槛：桌面/移动浏览器 QA 通过，外部请求为 0，无空白视觉模块，无严重可访问性问题。

## 迭代 4：交付与发布

- 将变更拆分为 runtime/contracts、bundled skills/licensing 和 regressions/docs 三类可审查提交。
- 推送功能分支，创建包含测试证据、许可说明和产物截图的 PR。
- 仅在必需 CI 和许可审查通过后合并。

退出门槛：PR 可审查，必需检查全绿，并可从验证数据重现 HTML 产物。

## 当前验证证据

- `cargo fmt --all -- --check`、`cargo check --all-targets`、`cargo test --all-targets`、`cargo clippy --all-targets -- -D warnings` 已通过。
- OpenAI 严格 wire mock：2 个请求、无协议违规、生成 1 个 HTML 和 `report.md`。
- Anthropic 严格 wire mock：2 个请求、2 个有序工具结果、生成 2 个非空 HTML，报告引用产物路径。
- bundled skills、Lieflat、visual-story、复杂地图/网络/Sankey、离线地图回退和 artifact completion 回归均已通过。
- 本机未安装 `jsonschema`；schema 回归由 CI 的锁定依赖执行，这不是产品代码阻塞项。

## 下一执行顺序

1. 推送 CI 反馈修复并确认 `ci` 与 `visual-runtimes` 两条工作流；本轮只修确定性配置，不扩展 Linux 专项或新增图形类型。
2. CI 全绿后启动浏览器矩阵截图验收，重点检查空白画布、响应式排版、标签碰撞和离线请求。
3. 把截图、测试摘要与第三方许可说明附到 PR，再进入代码审查。

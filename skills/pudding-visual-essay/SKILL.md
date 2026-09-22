---
name: pudding-visual-essay
description: 以读者问题为核心的滚动视觉文章方法，使用 hook、context、evidence、turn、resolution 的状态变化组织交互，并保持无 JS 与 reduced-motion 可读。
---

# Visual essay method

这是 Fio-X 的原创方法型 skill，借鉴公开的可视化叙事流程，不复制 The Pudding
具体文章、代码、插画或视觉身份。

## Editorial contract

- 开始前写明受众、reader question、核心命题和不应被回答的问题。
- 叙事顺序至少包含 `hook → context → evidence → turn → resolution`；每段只推进一个新的理解状态。
- 交互必须对应叙事状态变化：进入新段落、选择关键对象、改变时间窗口或显示证据层；不要为了动画增加装饰性交互。
- 为快速滚动和返回设计稳定的状态恢复、键盘焦点和可重复进入；状态变化不能依赖读者恰好从顶部慢慢滚动。
- 支持 `prefers-reduced-motion: reduce`：移除平移、闪烁和延迟后，内容顺序和结论仍完整。
- 无 JavaScript 时保留标题、段落、静态图/表格、来源和核心结论；脚本只是增强，不是唯一信息载体。
- 每个滚动段落绑定 Story Graph 节点；每个定量模块绑定 verified claim、source 和 computation。
- 移动端优先测试内容顺序、图表高度、触控目标和离屏状态；桌面端再增加并行布局。

## Completion signals

Story Graph lint 通过，五段叙事角色覆盖，滚动段落与状态映射完整，reduced-motion 与 no-JS
回退通过，publication HTML、来源和 QA 产物都在当前 run root。

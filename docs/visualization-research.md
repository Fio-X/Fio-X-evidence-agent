# 新闻级数据可视化研究：从图表生成器到可视化编辑系统

## 结论

当前 `newsroom_chart` 适合作为确定性回归渲染器，但离新闻编辑室级输出有明显距离。它当前只支持 bar/line、固定 960×540 布局、固定颜色、固定轴与脚注位置，也会旋转长标签。Reuters 的编辑规范明确建议长类别采用横向条形图并避免旋转文本，因此当前实现甚至在基础可读性层面就存在可自动检测的问题。

调研后的核心判断是，优秀新闻图形的技术难点很少来自“拥有多少种图表”。真正决定质量的是五层联动：新闻意图、数据语义、视觉编码、文字叙事、视觉审校。The Economist、Financial Times、Reuters 和 Datawrapper 的共同实践都强调这一点。学术研究也形成了稳定证据链，从 Cleveland 与 McGill 的图形知觉实验，到 Munzner 的任务和数据抽象，再到近年来对标题、注释、语义对齐、自动设计约束与 Agent 自反思的研究。

因此项目下一阶段应把 `newsroom_chart` 拆成一个可迭代的可视化编辑闭环：

`story intent → viz plan → constrained spec → render → deterministic lint → visual critic → revise → publish`

Rust CLI 和 Pi 仍然承担编排与审计。图形设计知识不应全部放进 prompt，而应进入可测试的规则、schema、模板与 benchmark。

## 1. 科研证据：新闻图形首先是“知觉任务”

Cleveland 与 McGill 在 1984 年的经典 JASA 论文中将图形阅读拆成基本知觉任务，并通过实验比较其准确性。其核心工程含义很直接：需要精确比较数量时，应优先让读者比较共同尺度上的位置，其次是长度；角度、面积、体积和色彩强度更适合承担较弱的定量任务。这为条形图、点图往往优于饼图提供了实验基础。[1]

Mackinlay 在 1986 年进一步把这些原则转化为自动图形设计系统 APT 的“expressiveness”和“effectiveness”标准。一个自动可视化系统先判断某种编码能否忠实表达数据，再在所有合法表达中寻找人眼更容易准确解码的形式。这一点与 Agent 系统高度契合，因为图表选择可以被表示为约束搜索问题，而不必让 LLM 每次重新发明设计原则。[2]

Munzner 的 Nested Model 把可视化设计拆成四层：领域问题、数据与任务抽象、视觉编码与交互、算法实现。上游判断一旦错误，下游即使渲染得再漂亮也无法修复。这意味着新闻 Agent 在“画图”之前必须先声明要帮助读者完成什么任务，例如 ranking、change、comparison、distribution、correlation 或 part-to-whole。[3]

Financial Times 的 Visual Vocabulary 把这一思想新闻化。它以 Comparison、Correlation、Ranking、Distribution、Change over time、Part-to-whole、Magnitude、Spatial、Flow 等阅读任务组织图形，而不是以“我会画哪些 chart”组织。这是我们最值得直接借鉴的产品模型。[4]

## 2. 文本、标题和注释属于图形本身

新闻可视化和 BI 图表最大的结构差异之一，是文字参与视觉推理。

Stokes 等人在 IEEE VIS 2023 的实验中让 302 名参与者比较不同文字密度的折线图。重注释图没有遭到惩罚，参与者反而更偏好包含较多文字注释的版本。不同语义层级的文字还会改变读者最后提取出的 takeaway。统计或关系性文字会让读者更多关注统计关系，某些信息适合放在标题，另一些信息更适合贴近数据。[5]

Rahman 等人分析了超过 1,800 张现实世界的静态注释图表，形成 annotation design space。注释承担的任务包括 identify、summarize、compare、present 等，机制则包含文字、箭头、范围、形状、强调等组合。这意味着我们的图形 schema 应把 annotation 当成一等对象，而不是一个可选的 `note` 字符串。[6]

Zhu、Cheng 与 Wu 对 caption 的研究进一步显示，caption 描述哪些视觉特征，会改变读者记忆哪些内容。单线图与多线图对统计性、感知性 caption 的反应还不同。[7]

标题需要单独的安全机制。Kong 等人的实验显示，带倾向性的 visualization title 会改变读者对图形“主要信息”的判断，而且读者不一定意识到标题引入了偏向。这对自动新闻系统非常重要。标题生成必须由 evidence verifier 检查，最好保存 neutral title、editorial title 和支持该标题的 claim id。[8]

Borkin 等人的眼动与记忆研究则发现，标题和支持性文字对注意与回忆尤其重要。2015 年的后续研究认为，标题和 supporting text 应明确传达图形的 message，合理的冗余也有助于信息被记住。[9][10]

因此成熟的新闻可视化输出应该包含至少以下语义层：

1. `takeaway_title`，直接表达可验证的主结论。
2. `dek/subtitle`，补充范围、年份、单位与口径。
3. `annotations[]`，绑定到具体数据点、范围或事件。
4. `source` 和 `methodology note`。
5. `alt text`，面向屏幕阅读器，同时也可作为语义一致性检查对象。

## 3. The Economist 的真正设计模式

The Economist 的官方图表规范覆盖 bar/column、stacked chart、line、thermometer、scatter、table、pie/doughnut、double-scale、timeline 和 panel charts 等形式。重要之处在于每一种形式都配有版式、颜色、轴和组合规则，而不是只定义一套颜色。[11]

2024 年 Economist Education 对其 visual data journalist Elizabeth Lees 的访谈说明了团队的实际思路。他们经常使用很基础的图形。Bubble chart 只在需要表现巨大数值范围时使用，同时用 label 弥补面积比较精度不足。Thermometer chart 用于两个类别或两个时期之间的紧凑比较。团队长期保持有限颜色体系，超过大约六个系列时会考虑用颜色突出主指标，而不是继续增加颜色。[12]

### 案例 A：`Whoof-whoof!`

The Economist 展示的美国都市区“有狗家庭 vs 有未成年子女家庭”图，几何结构其实非常克制。每一行只有两个点和连接线，但它同时解决了长类别标签、双变量比较、全国基准突出、精确位置比较和紧凑纵向排布。它属于 range/thermometer family，而不是两个并排 bar。其高级感来自匹配任务的 visual form、直接比较和文字层级。[12]

这对我们的启示是：当问题是“同一实体的 A 与 B 差多少”，默认候选应包含 dumbbell / range / thermometer，而不是永远回退到 grouped bar。

### 案例 B：Big Mac Index interactive

Big Mac Index 更能体现新闻可视化系统的完整形态。The Economist 数据团队在 2018 年重做 interactive 时，先通过用户调查理解读者如何使用旧版，再重新设计响应式体验。新版由多个协调视图组成，包括国家排序、某一时点的 undervaluation/overvaluation 分布、单国时间序列和解释文字。用户还能切换 base currency、raw index 与 GDP-adjusted index。[13]

团队没有把移动端简单缩小。OpenNews 的幕后文章明确提到，他们根据屏幕高度做了不同版本。这个案例说明“responsive visualization”需要 layout decision，而不仅是 SVG `viewBox`。

The Economist 还公开 Big Mac Index 的数据和计算代码，并记录方法调整。图形、数据与方法的可追溯性本身属于产品体验。[14]

### 案例 C：`Escape artists`

2021 年关于 laboratory-acquired infections 的图形采用横向条形图。社区对该图的复刻显示了大量微小但重要的编辑设计：长标签用横向布局，标题和 subtitle 强层级，直接数值标签，关键类别通过颜色强调，source 与作者信息在固定 footer 区域，顶部品牌线保持统一。几何很简单，编辑密度很高。[15]

这说明“更高级”不等同于“更多 mark”。一个只有十来个 bar 的图，在 typography、annotation、direct labeling、spacing、highlight、source hierarchy 上仍然可以有大量设计决策。

### 案例 D：The Economist 对 double-scale 的自我约束

其 style guide 明确承认双轴图节省空间并能表现相关性，同时也列出误导风险。指南要求避免无理由断轴，涉及正负值时两个零线应对齐，不应通过倒置尺度或不相称的单位强迫视觉相关。如果这些条件做不到，建议拆成 panels 或改为 index。[16]

这对 `viz_critic` 很有价值。很多规则都可以直接成为硬约束，而不是审美提示。

## 4. Reuters、FT、Datawrapper 的共同 newsroom 规范

Reuters Graphics 的 Datawrapper newsroom guide 非常工程化。它要求单位明确，大数一致舍入，颜色用于聚焦而不是装饰，长文本标签避免旋转，尽量使用自然语言变量名。其公开 Dos and Don'ts 还明确偏好 bar 而非 pie 来承担精确比较任务，并用“Remove to improve”概括去除冗余视觉元素的原则。[17]

Reuters 还要求发布前填写 title、通常的 description、source，以及面向屏幕阅读器的 alternative description。数据源应尽可能链接到 raw data。[18]

移动端是独立编辑场景。Reuters 建议可以为 desktop 和 mobile 写不同 annotation。Datawrapper 本身也提供 responsive annotation，把窄屏上拥挤的注释转为编号 key，并支持 annotation width 随图形尺寸调整。[19][20]

FT Visual Vocabulary 则解决 chart selection。它公开了大量可复用模板和 Chart Doctor 样例代码。例如 ranking 可以用 ordered bar、dot strip、slope，distribution 可以用 histogram、boxplot、violin、beeswarm，change over time 可以用 line、column、slope、connected scatter，magnitude 可以使用 bar、lollipop、proportional symbols 等。[4][21]

这意味着我们的 renderer 至少应该覆盖“视觉任务族”，而不是把类型列表扩充到一堆互不关联的 chart names。

## 5. 不确定性和数据新闻诚信

新闻系统还需要处理 uncertainty。Hullman 对 90 位经常制作可视化的作者进行调查并访谈 13 位有影响力的设计师，发现作者普遍承认不确定性重要，却经常在成品中省略它。这种结构性缺口意味着自动系统如果只模仿历史新闻图形，也可能继续复制“不画 uncertainty”的惯例。[22]

Kale、Kay 与 Hullman 的实验表明，误差区间、密度、quantile dotplot、hypothetical outcome plots 等不同形式会改变人对 effect size 和决策的判断。把 mean 强调出来还可能让读者降低对 uncertainty 的关注。[23]

新闻 Agent 应显式检查：

- 数据是完整总体还是样本。
- 是否存在 confidence interval / credible interval。
- 模型预测是否具有区间。
- 排名之间的差异是否小于统计或测量误差。
- 图上是否需要 band、interval、dot distribution 或 scenario fan。

## 6. 自动可视化系统的研究路线

Vega-Lite 的价值在于把视觉编码表示成声明式 grammar。数据字段、mark、encoding、scale、layer、facet 和 interaction 可以独立表达，使 Agent 的输出变成结构化 spec，而不是直接拼 SVG。[24]

Draco 更进一步，把可视化设计知识表示为 hard / soft constraints，并可从 perception experiment 学习 soft constraint 权重。这个模式很适合我们的 `viz_critic`。例如“bar 的定量轴必须包含零”可以是 hard rule，“temporal 通常放 x-axis”可以是 soft preference。[25]

VisuaLint 表明错误检查可以直接绑定在图形元素上，例如 truncated axis 或 inexpressive encoding。我们的 lint 也应输出具体可定位问题，而不是只给一个总分。[26]

Pluto 2025 代表了更接近新闻生产的方向，它同时处理 chart 与 text 的语义对齐，可以根据 description 推荐 title、annotation、highlight 或 data transformation。这比 NL2VIS 更接近“数据新闻可视化编辑器”。[27]

VisText 则说明自动 caption 系统需要同时理解 chart image、backing table 和 scene graph。项目收集了 12,441 组 chart/caption，并强调好的 caption 应描述趋势和认知现象，而不只是列出编码方式或最大值。[28]

最新 Agent 路线也提供了直接可借鉴的结构。Google Research 的 CoDA 把 visualization 拆成 Understanding、Planning、Generation、Self-Reflection 四阶段和八个 Agent，并用 visual evaluator 评估 readability、aesthetics、clarity、accessibility 和 specification adherence，再触发修订。其 ICLR 2026 项目在多个 benchmark 上显著超过此前基线。[29]

MultiVis-Agent 使用 logic rules 约束跨模态可视化生成，并提供 benchmark 与自动质量指标。这里最值得我们借鉴的点，是 LLM critic 之外还要存在显式 rule system。[30]

近期 multi-agent data visualization and narrative generation 研究也强调，将关键逻辑外置为 deterministic components，有助于透明性、可靠性和局部修改。这个观点与我们现在“DuckDB 负责数字真值”的架构完全一致。[31]

## 7. 对当前实现的代码级诊断

当前 `runtime/pi/newsroom.ts` 的 `makeSvg()` 暂时具有以下限制：

- chart type 只有 `bar` 和 `line`。
- 固定尺寸 `960×540`。
- 单一固定色 `#44546a`。
- x label 会旋转 35 度。
- line chart 的 y-domain 被强制包含 0，这会在某些变化型数据上压扁趋势。
- bar 和 line 共用几乎同一套 layout logic。
- 没有 direct labeling。
- 没有 annotation anchor、arrow、range highlight、reference line。
- 没有 small multiples / facet。
- 没有 uncertainty channel。
- 没有 semantic color role。
- 没有 responsive strategy。
- `<desc>` 只描述“某字段对某字段”的 construction，没有新闻 takeaway。
- title / subtitle / note / source 都是固定位置文字，没有自动换行、collision detection 或 mobile layout。

因此当前 SVG helper 适合 regression test，最终竞赛输出应该由新的 newsroom visualization engine 接管。

## 8. 推荐的 v0.4 可视化架构

### 8.1 `viz_plan`

输入应包含 dataset profile、candidate claims、story intent、audience 和 output medium。输出结构化设计意图：

```json
{
  "task": "compare_two_values_per_entity",
  "message": "Dog ownership exceeds households with children in most selected metros",
  "comparison_priority": "within_entity",
  "candidate_forms": ["range_plot", "paired_dot", "grouped_bar"],
  "chosen_form": "range_plot",
  "highlight": ["US average", "largest gap"],
  "annotations": [
    {"target": "largest_gap", "purpose": "explain"}
  ],
  "uncertainty": "none_available",
  "responsive": {
    "desktop": "direct annotations",
    "mobile": "annotation key"
  }
}
```

Agent 必须先声明 task 和 message，再选择 form。

### 8.2 `newsroom_viz_spec`

建立一个独立于 renderer 的声明式 grammar。建议保留以下一级对象：

- `data`
- `transform`
- `mark`
- `encoding`
- `scale`
- `facet`
- `layer`
- `annotations`
- `reference_lines`
- `highlights`
- `title/dek/source/note/byline`
- `accessibility`
- `responsive_variants`
- `provenance`

Renderer 可以先实现 SVG / Vega-Lite，后续增加 Datawrapper adapter。

### 8.3 图形任务族

第一阶段值得支持的形式：

| 阅读任务 | 首选形式 |
|---|---|
| 精确类别比较 | ordered bar, dot plot |
| 两值实体比较 | range / dumbbell / thermometer |
| 两三时点变化 | slope chart |
| 连续时间变化 | line, area band |
| 多实体时间变化 | small multiples, highlighted line |
| 排名变化 | bump chart |
| 分布 | histogram, boxplot, strip/beeswarm |
| 两变量关系 | scatter + trend / annotation |
| 三变量关系 | bubble（有严格用途限制） |
| part-to-whole | stacked bar / 100% stacked bar |
| 矩阵模式 | heatmap |
| 正负贡献 | waterfall / diverging bar |
| 区间或不确定性 | interval, band, quantile dots |

Pie/doughnut 可以保留为低优先候选，而不是删除，因为 The Economist 自身 style guide 仍支持它；但精确比较场景应由 constraint system 降权。

### 8.4 `viz_lint`

硬规则全部确定性执行：

- bar baseline 0。
- percentage 是否超出合理范围。
-单位缺失。
- 时间频率混用。
- 双轴零线未对齐。
- label collision。
- 小字号。
- 低对比度。
- 颜色类别过多。
- 类别标签旋转。
- source 缺失。
- alt text 缺失。
- title claim 无 claim_id 支撑。
- 输出图中的值与 SQL 结果不一致。

### 8.5 `viz_critic`

Vision LLM 只承担无法稳定规则化的判断：

- 信息层级是否清晰。
- takeaway 是否在三到五秒内可见。
- annotation 是否压住数据。
- highlight 是否过多。
- 图形是否在视觉上暗示了错误因果或不合理相关。
- narrative text 与 visual 是否语义一致。

Critic 返回可执行 patch，而不是散文建议。

### 8.6 reference retrieval

CoDA 和 PaperVizAgent 类系统都说明 reference-driven generation 有价值。我们可以建立一个版权安全的 pattern library，只保存结构特征与自制合成示例，不复制 Economist / FT 的品牌素材。

一个 pattern record 可以是：

```json
{
  "pattern": "paired-dot-range",
  "task": "compare-two-values-per-entity",
  "strength": "compact within-entity comparison",
  "failure_modes": ["too many entities", "unclear direction"],
  "annotation_patterns": ["largest-gap", "benchmark-row"],
  "mobile_strategy": "short labels + key"
}
```

## 9. 竞赛展示策略

比赛演示不应该只展示“生成了一张 SVG”。理想录像可以展示一次同数据多方案评审：

1. Agent 发现 story angle。
2. `viz_plan` 判断任务是 within-entity comparison。
3. 系统生成三个候选 spec。
4. Draco-like rules 淘汰弱方案。
5. renderer 生成第一稿。
6. lint 抓到旋转标签或年份不可比。
7. Agent 改成 small multiples / range plot，并添加 annotation。
8. critic 检查视觉层级。
9. 最终输出图、alt text、source、claim provenance。

这个过程能够同时证明自主规划、多工具协同、迭代修正、稳定性与业务价值。

## 10. 最关键的产品原则

The Economist 的经验和科研论文汇合到同一个结论：高级新闻图形很少依赖炫技。它依赖“为一个明确的读者任务选择高效知觉编码，再用标题、注释、布局、色彩和来源把主张锁定到正确的证据”。

因此我们的目标应该从 `chart generator` 升级为 `visual editor agent`。

最终一张图应同时拥有：

- 数据真值
- 新闻主张
- 视觉编码理由
- 重点和注释
- 不确定性说明
- source / methodology
- responsive variants
- accessibility description
- provenance graph
- lint / critic 通过记录

这才是能够和专业 newsroom 作品进行比较的技术边界。

## Sources

1. William S. Cleveland & Robert McGill. “Graphical Perception: Theory, Experimentation, and Application to the Development of Graphical Methods.” Journal of the American Statistical Association, 1984. https://doi.org/10.1080/01621459.1984.10478080
2. Jock D. Mackinlay. “Automating the Design of Graphical Presentations of Relational Information.” ACM Transactions on Graphics, 1986. https://doi.org/10.1145/22949.22950
3. Tamara Munzner. “A Nested Model for Visualization Design and Validation.” IEEE TVCG / InfoVis, 2009. https://www.cs.ubc.ca/labs/imager/tr/2009/NestedModel/
4. Financial Times Visual Journalism Team. “Visual Vocabulary.” https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary
5. Chase Stokes et al. “Striking a Balance: Reader Takeaways and Preferences when Integrating Text and Charts.” IEEE TVCG, 2023. https://vis.csail.mit.edu/pubs/vis-text-balance/
6. Md Dilshadur Rahman et al. “A Qualitative Analysis of Common Practices in Annotations: A Taxonomy and Design Space.” 2023. https://arxiv.org/abs/2306.06043
7. Hanxiu Zhu, Shelly Shiying Cheng, Eugene Wu. “How Do Captions Affect Visualization Reading?” 2022. https://arxiv.org/abs/2205.01263
8. Ha-Kyung Kong et al. “Frames and Slants in Titles of Visualizations.” https://vis.csail.mit.edu/classes/6.859/readings/pdfs/Kong-FramesAndSlantsInTitlesOfVisualizationsOnControversialTopics.pdf
9. Michelle Borkin et al. “What Makes a Visualization Memorable?” IEEE TVCG, 2013. https://vcg.seas.harvard.edu/publications/20130101-what-makes-a-visualization-memorable
10. Michelle Borkin et al. “Beyond Memorability: Visualization Recognition and Recall.” IEEE TVCG, 2015. https://vcg.seas.harvard.edu/publications/20150101-beyond-memorability-visualization-recognition-and-recall
11. The Economist. “Chart Style Guide.” 2017. https://design-system.economist.com/documents/CHARTstyleguide_20170505.pdf
12. Economist Education. “Tips for visualising data like The Economist.” 2024. https://education.economist.com/blog/interviews/tips-for-visualising-data-like-the-economist
13. Martín González et al., The Economist Data Team. “How We Made the New Big Mac Index Interactive.” OpenNews Source, 2018. https://source.opennews.org/articles/how-we-made-new-big-mac-index-interactive/
14. The Economist. “Big Mac Index data and methodology.” https://github.com/TheEconomist/big-mac-data
15. Python Graph Gallery. “Horizontal barplot with Matplotlib”, reproduction of The Economist’s “Escape artists.” https://python-graph-gallery.com/web-horizontal-barplot-with-labels-the-economist/
16. The Economist. “Chart Style Guide, Double-scale charts.” 2017. https://design-system.economist.com/documents/CHARTstyleguide_20170505.pdf
17. Reuters Graphics. “Dos and Don’ts.” https://reuters-graphics.github.io/newsroom-datawrapper-guide/next-steps/dos-and-donts/
18. Reuters Graphics. “Making your first chart.” https://reuters-graphics.github.io/newsroom-datawrapper-guide/getting-started/making-your-first-chart/
19. Reuters Graphics. “Mobile & Desktop Annotations.” https://reuters-graphics.github.io/newsroom-datawrapper-guide/next-steps/mobile-annotations/
20. Datawrapper. “Create better, more responsive text annotations.” https://www.datawrapper.de/blog/better-more-responsive-annotations-in-Datawrapper-data-visualizations
21. Financial Times. `visual-vocabulary-templates`. https://github.com/ft-interactive/visual-vocabulary-templates
22. Jessica Hullman. “Why Authors Don’t Visualize Uncertainty.” 2019. https://arxiv.org/abs/1908.01697
23. Alex Kale, Matthew Kay, Jessica Hullman. “Visual Reasoning Strategies for Effect Size Judgments and Decisions.” IEEE TVCG, 2020. https://mucollective.northwestern.edu/project/2020-vis-effect-size-judgements
24. Arvind Satyanarayan et al. “Vega-Lite: A Grammar of Interactive Graphics.” IEEE TVCG, 2017. https://vis.csail.mit.edu/pubs/vega-lite/
25. Dominik Moritz et al. “Formalizing Visualization Design Knowledge as Constraints: Actionable and Extensible Models in Draco.” IEEE TVCG, 2019. https://idl.cs.washington.edu/files/2019-Draco-InfoVis.pdf
26. Aspen Hopkins, Michael Correll, Arvind Satyanarayan. “VisuaLint: Sketchy In Situ Annotations of Chart Construction Errors.” EuroVis, 2020. https://vis.csail.mit.edu/pubs/visualint/
27. Arjun Srinivasan, Vidya Setlur, Arvind Satyanarayan. “Pluto: Authoring Semantically Aligned Text and Charts for Data-Driven Communication.” ACM IUI, 2025. https://vis.csail.mit.edu/pubs/pluto/
28. Benny J. Tang, Angie Boggust, Arvind Satyanarayan. “VisText: A Benchmark for Semantically Rich Chart Captioning.” ACL, 2023. https://vis.csail.mit.edu/pubs/vistext/
29. Google Research. “CoDA: Agentic Systems for Collaborative Data Visualization.” ICLR 2026. https://github.com/google-research/agentic-visualization
30. Jinwei Lu et al. “MultiVis-Agent: A Multi-Agent Framework with Logic Rules for Reliable and Comprehensive Cross-Modal Data Visualization.” SIGMOD 2026. https://github.com/Jinwei-Lu/MultiVis
31. Anton Wolter et al. “Multi-Agent Data Visualization and Narrative Generation.” 2025. https://arxiv.org/abs/2509.00481

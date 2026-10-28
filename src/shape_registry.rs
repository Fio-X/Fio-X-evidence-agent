//! New-route chart matcher: hard gates, a small integer score table and a fixed tie order pick the relation (and
//! its one template) for one data slice, CompassQL style. Pure: the same shape always gives the same list.
//! A slice above a template's row cap is first cut by shape (latest years, then the top N of the largest other
//! dimension, the rest summed into "other" only when that dimension adds up); every cut is returned so the page
//! caption and the computation record can state it. When cutting would drop more than half the rows, a second
//! view is also offered: time collapsed into each entity's first-to-last change. Roles come from the data side's
//! classify and are read, never changed. No cap here is higher than the one it mirrors; no check is loosened.

use std::cmp::Reverse;

/// Mirrors MAX_CHART_ROWS in runtime/pi/newsroom.ts.
pub const MAX_ROWS: usize = 80;
/// Mirrors the choropleth row in CHART_FORM_SHAPES (runtime/pi/page_skeleton.mjs).
pub const MAP_MAX_ROWS: usize = 60;
/// Colours a categorical palette keeps apart (ColorBrewer qualitative sets are mostly 8); inferred.
pub const MAX_LINES: usize = 8;
/// Stacked segments past this are hard to read (score table research page, section 3 item 1); inferred.
pub const MAX_PARTS: usize = 7;
/// Fewer places leave most of a map empty; a bar reads better; inferred.
pub const MIN_MAP_PLACES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Time,
    Unit,
    Place,
    FlowSource,
    FlowTarget,
    AdditiveCategory,
    Category,
    Pick,
    Unknown,
}

/// One dimension that varies in the slice, as classify describes it.
#[derive(Clone, Debug)]
pub struct VaryingDim {
    pub dim: String,
    pub members: usize,
    pub roles: Vec<Role>,
    pub is_place: bool,
    /// Every member is an ISO 3166-1 country by the data side's evidence (no NUTS level, no aggregate).
    pub iso_countries: bool,
    /// The member classify marks as this dimension's total, when the slice holds its row.
    pub total_member: Option<String>,
}

impl VaryingDim {
    fn has(&self, role: Role) -> bool {
        self.roles.contains(&role)
    }
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub dims: Vec<VaryingDim>,
    pub unit_additive: bool,
    /// (source dim, target dim) when classify found an official flow direction.
    pub official_flow: Option<(String, String)>,
}

/// Fixed order: ties go to the earlier one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Relation {
    Flow,
    Composition,
    Map,
    Change,
    Ranking,
    Distribution,
}

pub const RELATIONS: [Relation; 6] = [
    Relation::Flow,
    Relation::Composition,
    Relation::Map,
    Relation::Change,
    Relation::Ranking,
    Relation::Distribution,
];

impl Relation {
    /// The one template of the relation in the view: a change over the slice is a line; a change collapsed to each entity's
    /// first and last value is a dumbbell, which draws the move rows themselves. The other relations draw the same in either view.
    pub fn template(self, view: View) -> &'static str {
        match (self, view) {
            (Relation::Flow, _) => "sankey",
            (Relation::Composition, _) => "stacked_bar_100",
            (Relation::Map, _) => "choropleth",
            (Relation::Change, View::Slice) => "line",
            (Relation::Change, View::FirstToLast) => "dumbbell",
            (Relation::Ranking, _) => "horizontal_bar",
            (Relation::Distribution, _) => "heatmap",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Relation::Flow => "flow",
            Relation::Composition => "composition",
            Relation::Map => "map",
            Relation::Change => "change",
            Relation::Ranking => "ranking",
            Relation::Distribution => "distribution",
        }
    }

    fn base(self) -> i32 {
        match self {
            Relation::Flow => 3,
            Relation::Composition | Relation::Map | Relation::Change => 2,
            Relation::Ranking => 1,
            Relation::Distribution => 0,
        }
    }

    fn cap(self) -> usize {
        if self == Relation::Map {
            MAP_MAX_ROWS
        } else {
            MAX_ROWS
        }
    }
}

/// What a chart's category axis lists, by the kind of dimension it is; AXIS_WORDS gives the Chinese word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Country,
    Region,
    Time,
    Other,
}

/// The one word list for every template; a dimension of no listed kind reads as Other.
pub const AXIS_WORDS: [(Axis, &str); 4] = [
    (Axis::Country, "国家"),
    (Axis::Region, "地区"),
    (Axis::Time, "年份"),
    (Axis::Other, "类别"),
];

pub fn axis_word(axis: Axis) -> &'static str {
    AXIS_WORDS
        .iter()
        .find(|(a, _)| *a == axis)
        .map(|(_, word)| *word)
        .unwrap_or("类别")
}

impl Shape {
    /// What the relation's chart lists along its category: the time for a change over the slice; otherwise (a dumbbell lists its
    /// entities) the one varying dimension that is neither time nor unit, a country when every member is an ISO country, a region
    /// when it is another place.
    pub fn axis(&self, relation: Relation, view: View) -> Axis {
        if relation == Relation::Change && view == View::Slice {
            return Axis::Time;
        }
        let listed: Vec<&VaryingDim> = self
            .dims
            .iter()
            .filter(|d| !d.has(Role::Time) && !d.has(Role::Unit))
            .collect();
        match listed.as_slice() {
            [one] if one.iso_countries => Axis::Country,
            [one] if one.is_place => Axis::Region,
            _ => Axis::Other,
        }
    }
}

impl Relation {
    /// The template's Chinese chart name, as design_pack.mjs chartName gives it.
    pub fn chart_name(self, view: View) -> &'static str {
        match (self, view) {
            (Relation::Flow, _) => "桑基图",
            (Relation::Composition, _) => "百分比堆积条形图",
            (Relation::Map, _) => "地图",
            (Relation::Change, View::Slice) => "折线图",
            (Relation::Change, View::FirstToLast) => "哑铃图",
            (Relation::Ranking, _) => "条形图",
            (Relation::Distribution, _) => "热力图",
        }
    }

    /// The chart's alt text: what it draws, from its chart name, its axis word and the measure's (checked) name, then how
    /// to read it, so a short measure name still meets the lint's 20 characters (viz.mjs). No number.
    pub fn alt(self, view: View, axis: Axis, measure: &str) -> String {
        let (chart, axis) = (self.chart_name(view), axis_word(axis));
        if (self, view) == (Relation::Change, View::FirstToLast) {
            return format!(
                "{chart}，每个{axis}一行，左右两点是起始和最近时期的{measure}，连线越长，变化越大"
            );
        }
        match self {
            Relation::Ranking => format!("{chart}，按{axis}列出{measure}，自上而下由高到低排列"),
            Relation::Distribution => {
                format!("{chart}，按{axis}列出{measure}，格子颜色越深，数值越高")
            }
            Relation::Map => format!("{chart}，按{axis}着色，色值为{measure}，颜色越深，数值越高"),
            Relation::Change => format!("{chart}，横轴为{axis}，纵轴为{measure}，线向上是增加"),
            Relation::Composition => {
                format!("{chart}，每个{axis}一条，段长为各部分占{measure}的比例")
            }
            Relation::Flow => {
                format!("{chart}，从来源流向去向，线宽为{measure}，带子越宽，流量越大")
            }
        }
    }
}

/// The page wording frames by relation: page title, page dek, chart heading, text module. Chinese, so a page that keeps
/// the drafts reads as written; no number, no number in words, no placeholder; the text module says how to read the
/// chart and over what it holds, never why (a cause is no verified claim). The model rewrites them for the topic.
pub const FRAMES: [(Relation, View, [&str; 4]); 7] = [
    (Relation::Ranking, View::Slice, ["谁领先，谁垫底", "从最高到最低，看各自的位置", "由高到低", "读图：条形越长，数值越高，自上而下由高到低排列；各条是同一口径的数据。"]),
    (Relation::Change, View::Slice, ["走势如何", "历年的变化路径和转折点", "随时间的变化", "读图：横轴是时间，纵轴是数值，线向上是增加、向下是减少；时间范围以图中最早和最近的时期为准。"]),
    (Relation::Composition, View::Slice, ["由哪些部分构成", "各个部分及其占整体的份额", "整体的构成", "读图：每段的长短是该部分占整体的份额，各段合起来是整体；各部分是同一口径的数据。"]),
    (Relation::Flow, View::Slice, ["流向哪里", "从来源到去向，看最大的流量", "从来源到去向", "读图：左侧是来源，右侧是去向，带子越宽流量越大；口径以所用数据表为准。"]),
    (Relation::Map, View::Slice, ["哪里最高", "各地在地图上的对比", "各地对比", "读图：颜色越深，数值越高，灰色是没有数据；各地是同一口径的数据。"]),
    (Relation::Change, View::FirstToLast, ["变化多大", "从起始时期到最近时期，各自变了多少", "从起始到最近", "读图：每行的连线连起该行成员在起始时期和最近时期的数值，图例标明哪端是哪个时期；连线越长，变化越大。"]),
    (Relation::Distribution, View::Slice, ["如何分布", "多数数值落在哪里，哪些偏离", "数值的分布", "读图：每个格子的颜色表示一个数值，颜色越深数值越高；同行、同列之间可以直接比较。"]),
];

/// The chart forms the page renderer draws a card for (next_render Card): the page's title, dek, text and reader fields are
/// drafted from the first chart of one of these forms (next_page lead), so the page never describes a chart it does not draw.
/// A form gets its row when its card's node is in.
pub const CARD_FORMS: [(Relation, View); 1] = [(Relation::Ranking, View::Slice)];

/// The scoped page's wording of each FRAMES and CONCEPTS draft that ranks (holds a next_page SUPERLATIVES word): on a page
/// whose places the program narrowed, "highest" holds only among the kept places, so the draft says the order, not who
/// leads. Same rules as FRAMES; "所选" points at the page's own scope field, never says it.
pub const SCOPED_WORDS: [(&str, &str); 10] = [
    ("谁领先，谁垫底", "同一口径下的高低次序"),
    (
        "从最高到最低，看各自的位置",
        "从高到低排列，看所选各方的位置",
    ),
    ("哪里最高", "各地的高低"),
    (
        "读者想知道在同样的口径下谁领先、谁落后，差距有多大。",
        "读者想知道所选各方在同样的口径下高低次序如何，差距有多大。",
    ),
    (
        "把各方排在同一把尺子上，领先者和落后者清楚可见。",
        "把所选各方排在同一把尺子上，高低次序清楚可见。",
    ),
    (
        "读者想知道从起始时期到最近时期，各方变了多少，谁变得最多。",
        "读者想知道从起始时期到最近时期，所选各方各变了多少，变化大小怎样排列。",
    ),
    (
        "读者想知道整体由哪些部分构成，哪部分占得最多。",
        "读者想知道整体由哪些部分构成，各部分的份额大小如何。",
    ),
    (
        "读者想知道这些数值在地理上怎样分布，哪里最高、哪里最低。",
        "读者想知道这些数值在所选各地之间怎样分布，高低怎样对比。",
    ),
    ("哪里最高？", "哪些地方偏高？"),
    ("哪里最低？", "哪些地方偏低？"),
];

/// One visual concept per relation, for the design pack's judgement half: the design record (English, read by the pack's
/// tournament and asset plan, never put on the page) and the Chinese reader-field drafts the model rewords with the page
/// fields (same rules as FRAMES: no number, no number in words, no placeholder; the three questions differ).
pub struct Concept {
    pub relation: Relation,
    pub view: View,
    pub premise: &'static str,
    pub metaphor: &'static str,
    pub hero_scene: &'static str,
    pub why_memorable: &'static str,
    pub media: &'static [&'static str],
    pub reader_problem: &'static str,
    pub visual_thesis: &'static str,
    pub questions: [&'static str; 3],
}

/// What each template shows of its measure, in the English a chart's draft title adds when two charts on a page share one
/// table title (a ranking and a dumbbell of the same table), so their names differ before the model words them.
pub const VIEW_WORDS: [((Relation, View), &str); 7] = [
    (
        (Relation::Ranking, View::Slice),
        "ranked at the latest time",
    ),
    ((Relation::Change, View::Slice), "over time"),
    (
        (Relation::Change, View::FirstToLast),
        "change from the first to the last time",
    ),
    ((Relation::Composition, View::Slice), "parts of the whole"),
    ((Relation::Flow, View::Slice), "flows between places"),
    ((Relation::Map, View::Slice), "by place on a map"),
    (
        (Relation::Distribution, View::Slice),
        "spread over the categories",
    ),
];

pub const CONCEPTS: [Concept; 7] = [
    Concept {
        relation: Relation::Ranking,
        view: View::Slice,
        premise: "Line every member up on one scale so the leader and the laggard are read at a glance.",
        metaphor: "A ladder of bars where each place stands on its own rung.",
        hero_scene: "The ranked bars run top to bottom, the top and the bottom place called out at their ends.",
        why_memorable: "The reader leaves knowing who leads, who trails and how far apart they stand.",
        media: &["ranked bars", "callouts"],
        reader_problem: "读者想知道在同样的口径下谁领先、谁落后，差距有多大。",
        visual_thesis: "把各方排在同一把尺子上，领先者和落后者清楚可见。",
        questions: ["谁排在最前面？", "谁排在最后面？", "最前和最后相差多少？"],
    },
    Concept {
        relation: Relation::Change,
        view: View::Slice,
        premise: "Follow the series through time so its turns and its overall direction carry the story.",
        metaphor: "A path walked across the years, its turning points marked like milestones.",
        hero_scene: "The line crosses the page from the earliest to the latest period, its largest rise and fall annotated.",
        why_memorable: "The reader remembers the direction of travel and the moment it turned.",
        media: &["line", "annotations", "timeline"],
        reader_problem: "读者想知道这些数值随时间怎样变化，在哪里转折。",
        visual_thesis: "沿着时间看走势，转折点和总的方向就是答案。",
        questions: ["总体是上升还是下降？", "变化最大的是哪段时期？", "最近的时期和最早相比如何？"],
    },
    Concept {
        relation: Relation::Change,
        view: View::FirstToLast,
        premise: "Set each member's first and latest value side by side so the size and direction of its move is read at a glance.",
        metaphor: "Two beads on one string, the string's length the size of the move.",
        hero_scene: "One row per member, a dot at the first and at the latest period joined by a line, the largest rise and fall called out.",
        why_memorable: "The reader leaves knowing who moved most and in which direction.",
        media: &["dumbbell", "callouts"],
        reader_problem: "读者想知道从起始时期到最近时期，各方变了多少，谁变得最多。",
        visual_thesis: "把起点和终点并排放，变化的大小和方向清楚可见。",
        questions: ["谁的变化最大？", "哪些在增加，哪些在减少？", "最近时期和起始时期相比，高低次序有什么不同？"],
    },
    Concept {
        relation: Relation::Composition,
        view: View::Slice,
        premise: "Show the whole and its parts together so each part is read as its share of the total.",
        metaphor: "A bar cut into slices, like a cross-section of the whole.",
        hero_scene: "Full-width bars split into their parts, the largest part labelled inside its slice.",
        why_memorable: "The reader sees at once which part dominates the whole.",
        media: &["stacked bars", "labels"],
        reader_problem: "读者想知道整体由哪些部分构成，哪部分占得最多。",
        visual_thesis: "把整体切开来看，最大的部分决定了整体的样子。",
        questions: ["整体由哪些部分构成？", "哪个部分占比最大？", "各部分的份额差别有多大？"],
    },
    Concept {
        relation: Relation::Flow,
        view: View::Slice,
        premise: "Trace what moves from its sources to its destinations so the widest channels show where most of it goes.",
        metaphor: "Rivers splitting and joining, their width standing for volume.",
        hero_scene: "Sources on the left feed bands that widen or narrow toward their destinations on the right.",
        why_memorable: "The reader remembers the main channel and where it ends.",
        media: &["sankey", "labels", "illustration"],
        reader_problem: "读者想知道这些流量从哪里来、到哪里去，主要走哪条路。",
        visual_thesis: "顺着最宽的流向看，主要的来源和去向就清楚了。",
        questions: ["主要来源是哪里？", "主要去向是哪里？", "最大的流向是哪条？"],
    },
    Concept {
        relation: Relation::Map,
        view: View::Slice,
        premise: "Place every value where it happens so neighbours and regional clusters can be compared.",
        metaphor: "A shaded map where darker ground marks the higher values.",
        hero_scene: "The region shaded by value, the highest and the lowest places labelled on the map.",
        why_memorable: "The reader remembers where on the map the values concentrate.",
        media: &["map", "labels"],
        reader_problem: "读者想知道这些数值在地理上怎样分布，哪里最高、哪里最低。",
        visual_thesis: "放到地图上看，高值和低值聚在哪里清清楚楚。",
        questions: ["哪里最高？", "哪里最低？", "相邻地区之间是否相近？"],
    },
    Concept {
        relation: Relation::Distribution,
        view: View::Slice,
        premise: "Lay every value in a grid so the common range and the outliers stand apart.",
        metaphor: "A tiled wall where the colour of each tile is one value.",
        hero_scene: "A grid of tiles shaded by value, rows and columns ordered so the outliers stand out.",
        why_memorable: "The reader sees where most values sit and which ones break away.",
        media: &["heatmap", "labels"],
        reader_problem: "读者想知道大多数数值落在哪里，哪些明显偏离。",
        visual_thesis: "把所有数值排进格子里，常见的范围和异常值自然分开。",
        questions: ["大多数数值落在哪个范围？", "哪些数值明显偏离？", "行与列之间有什么规律？"],
    },
];

/// The page plan's fixed fields for a chart's relation (newsroom_infographic_plan: story_arc, the editorial grammar it is
/// eligible for in config/editorial-grammar-registry.json by the evidence it names, the scene's cognitive goal, and the
/// intent, which states no number). The page takes them from its first chart; later charts add supporting grammars.
#[derive(Debug)]
pub struct PagePlan {
    pub relation: Relation,
    pub view: View,
    pub story_arc: &'static str,
    pub grammar: &'static str,
    /// The supporting grammars the registry's compatible_supporting allows with this one as primary.
    pub supports: &'static [&'static str],
    /// The module visual_grammar of the chart (infographic.mjs VISUAL_GRAMMAR_FORMS lists the chart type under it).
    pub visual_grammar: &'static str,
    pub evidence: &'static [&'static str],
    pub goal: &'static str,
    pub intent: &'static str,
    /// The template's visual channels (newsroom.ts VISUAL_CHANNEL_NAMES): (channel, "category" or "value" column, role).
    pub channels: &'static [(&'static str, &'static str, &'static str)],
    /// quantitative_encoding's mark_semantics and baseline_policy for the template (bars start at zero).
    pub mark: &'static str,
    pub baseline: &'static str,
}

pub const PAGE_AUDIENCE: &str = "general";
pub const PAGE_RENDERERS: [&str; 1] = ["svg"];
pub const PAGE_SCENE_PATTERN: &str = "hero_with_rail";

pub const PAGE_PLANS: [PagePlan; 7] = [
    PagePlan {
        relation: Relation::Ranking,
        view: View::Slice,
        story_arc: "compare",
        grammar: "SPECIMEN_GRID",
        supports: &[
            "CUTAWAY",
            "SCALE_TRANSLATOR",
            "MECHANISM_FLOW",
            "THEN_NOW",
            "ROUTE_SPINE",
        ],
        visual_grammar: "rank",
        evidence: &["comparable_entities", "quantity"],
        goal: "COMPARE",
        intent: "在同一口径上比较各成员的高低，找出领先和落后的一方。",
        channels: &[
            ("position", "category", "categorical"),
            ("length", "value", "quantitative"),
        ],
        mark: "length",
        baseline: "zero",
    },
    PagePlan {
        relation: Relation::Change,
        view: View::Slice,
        story_arc: "chronology",
        grammar: "THEN_NOW",
        supports: &[
            "CUTAWAY",
            "SCALE_TRANSLATOR",
            "MECHANISM_FLOW",
            "SPECIMEN_GRID",
            "ROUTE_SPINE",
        ],
        visual_grammar: "trend",
        evidence: &["comparable_timepoints", "quantity"],
        goal: "MEASURE",
        intent: "看清这项数值随时间怎样变化，哪里升得最快、哪里降得最多。",
        channels: &[
            ("position", "value", "quantitative"),
            ("connection", "category", "categorical"),
        ],
        mark: "position",
        baseline: "included",
    },
    PagePlan {
        relation: Relation::Change,
        view: View::FirstToLast,
        story_arc: "chronology",
        grammar: "THEN_NOW",
        supports: &[
            "CUTAWAY",
            "SCALE_TRANSLATOR",
            "MECHANISM_FLOW",
            "SPECIMEN_GRID",
            "ROUTE_SPINE",
        ],
        visual_grammar: "change",
        evidence: &["comparable_timepoints", "quantity"],
        goal: "COMPARE",
        intent: "比较各成员在起始时期和最近时期的数值，看谁变得最多、往哪个方向变。",
        // One owner per channel (editorial_validators.mjs visual_channel.single_owner): both dots sit on the one value axis, so the
        // end value, the chart's target measure, owns position; each member's line joining its two dots is the connection.
        channels: &[
            ("position", "end", "quantitative"),
            ("connection", "category", "categorical"),
        ],
        mark: "position",
        baseline: "included",
    },
    PagePlan {
        relation: Relation::Composition,
        view: View::Slice,
        story_arc: "explain",
        grammar: "SPECIMEN_GRID",
        supports: &[
            "CUTAWAY",
            "SCALE_TRANSLATOR",
            "MECHANISM_FLOW",
            "THEN_NOW",
            "ROUTE_SPINE",
        ],
        visual_grammar: "composition",
        evidence: &["comparable_entities", "quantity"],
        goal: "COMPARE",
        intent: "拆开整体，看各部分各占多少、哪一部分最大。",
        channels: &[
            ("length", "value", "quantitative"),
            ("color", "category", "identity"),
        ],
        mark: "length",
        baseline: "zero",
    },
    PagePlan {
        relation: Relation::Flow,
        view: View::Slice,
        story_arc: "system",
        grammar: "FLOW_LEDGER",
        supports: &["SCALE_TRANSLATOR", "SPECIMEN_GRID", "THEN_NOW"],
        visual_grammar: "flow",
        evidence: &["origin_destination_relation", "quantity"],
        goal: "MEASURE",
        intent: "看清从哪里流向哪里、哪条去向最多。",
        channels: &[
            ("connection", "category", "categorical"),
            ("size", "value", "quantitative"),
        ],
        mark: "flow_width",
        baseline: "not_applicable",
    },
    PagePlan {
        relation: Relation::Map,
        view: View::Slice,
        story_arc: "compare",
        grammar: "THEMATIC_MAP",
        supports: &["SCALE_TRANSLATOR", "THEN_NOW", "SPECIMEN_GRID"],
        visual_grammar: "spatial",
        evidence: &["spatial_structure", "quantity"],
        goal: "ORIENT",
        intent: "在地图上看各地的差别，哪里最高、哪里最低。",
        channels: &[
            ("position", "category", "identity"),
            ("color", "value", "quantitative"),
        ],
        mark: "color",
        baseline: "not_applicable",
    },
    PagePlan {
        relation: Relation::Distribution,
        view: View::Slice,
        story_arc: "explain",
        grammar: "SPECIMEN_GRID",
        supports: &[
            "CUTAWAY",
            "SCALE_TRANSLATOR",
            "MECHANISM_FLOW",
            "THEN_NOW",
            "ROUTE_SPINE",
        ],
        visual_grammar: "distribution",
        evidence: &["comparable_entities", "quantity"],
        goal: "COMPARE",
        intent: "看大多数数值落在哪里，哪些明显偏离。",
        channels: &[
            ("position", "category", "categorical"),
            ("color", "value", "quantitative"),
        ],
        mark: "color",
        baseline: "not_applicable",
    },
];

pub fn page_plan(relation: Relation, view: View) -> &'static PagePlan {
    PAGE_PLANS
        .iter()
        .find(|p| (p.relation, p.view) == (relation, view))
        .expect("every relation has a page plan")
}

/// Claim kinds whose number is a row value of their chart: one body sentence each, `{c}` the category column and `{v}` the
/// value column of the chart (claim_candidates.mjs kinds; first/last stand for the top/bottom row, so they read max/min of
/// the rows). Same rules as FRAMES; the row placeholders are the only numbers.
/// The hero caption's Chinese draft per claim kind (claim_candidates.mjs `add`), on the claim's own placeholders: {name} is the
/// claim's category placeholder; the program puts "{first.year}年，" before it when the claim states its year. The big number is
/// the hero's own, so no value is here. A kind with no row is never the hero: no English template reaches a Chinese page.
pub const HERO_LABELS: [(&str, &str); 12] = [
    ("rank_top", "{name}最高"),
    ("rank_bottom", "{name}最低"),
    ("cut_top_share", "{name}占总量的比例"),
    ("share_of_total", "{name}占总量的比例"),
    ("cut_members_share", "排在前面的成员合计所占比例"),
    ("extreme_gap", "最高与最低之差"),
    ("top_to_bottom_ratio", "最高值与最低值之比"),
    ("change_largest_rise", "{name}升幅最大"),
    ("change_largest_fall", "{name}降幅最大或升幅最小"),
    ("change_total", "总量的变化幅度"),
    ("cut_members_largest_change", "排在前面的成员中{name}变化最大"),
    ("cut_total_change", "总量的变化"),
];

pub const BODY_SENTENCES: [(&str, &str); 2] = [
    ("rank_top", "{max.{v}.{c}}最高，为{max.{v}}。"),
    ("rank_bottom", "{min.{v}.{c}}最低，为{min.{v}}。"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum View {
    /// The slice as prepared (after cuts).
    Slice,
    /// Time collapsed into each entity's last-minus-first value (claim_candidates.mjs slice 2).
    FirstToLast,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cut {
    LatestYears {
        dim: String,
        kept: usize,
        of: usize,
    },
    /// Ordered by `by` (at the latest year when `latest`), largest first, ties by code; `other` sums the rest
    /// into one row.
    TopN {
        dim: String,
        kept: usize,
        of: usize,
        other: bool,
        by: RankBy,
        latest: bool,
    },
}

/// The one value each member of the cut dimension is ranked by (score table section 1 step 2, keys b to d).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RankBy {
    /// Nothing else varies besides time: the member's own value.
    Own,
    /// The unit adds up and so do these dimensions: the sum over them.
    SumOf(Vec<String>),
    /// Otherwise: each remaining dimension's total row, as (dimension, total member).
    TotalsOf(Vec<(String, String)>),
}

/// Err when a remaining dimension neither adds up nor has a total row: the program does not pick a value itself.
fn rank_by(shape: &Shape, d: usize) -> Result<RankBy, String> {
    let rest: Vec<&VaryingDim> = shape
        .dims
        .iter()
        .enumerate()
        .filter(|(i, x)| *i != d && !x.has(Role::Time))
        .map(|(_, x)| x)
        .collect();
    if rest.is_empty() {
        return Ok(RankBy::Own);
    }
    if shape.unit_additive && rest.iter().all(|x| x.has(Role::AdditiveCategory)) {
        return Ok(RankBy::SumOf(rest.iter().map(|x| x.dim.clone()).collect()));
    }
    rest.iter()
        .map(|x| match &x.total_member {
            Some(m) => Ok((x.dim.clone(), m.clone())),
            None => Err(format!(
                "cannot rank {} by one value: {} does not add up and has no total row",
                shape.dims[d].dim, x.dim
            )),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(RankBy::TotalsOf)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fitted {
    /// Members per varying dimension after the cuts, in the slice's order (an "other" row counts).
    pub members: Vec<usize>,
    pub cuts: Vec<Cut>,
}

impl Fitted {
    pub fn rows(&self) -> usize {
        self.members.iter().product()
    }
}

/// Cut a slice to at most `cap` rows by shape alone: latest years first (at least 2 kept), then the top N of
/// the largest non-time dimension. Err when it cannot fit (the caller asks to narrow the filter).
pub fn fit(shape: &Shape, cap: usize) -> Result<Fitted, String> {
    let dims = &shape.dims;
    let mut members: Vec<usize> = dims.iter().map(|d| d.members).collect();
    let mut cuts = Vec::new();
    let rows = |m: &[usize]| m.iter().product::<usize>();
    if rows(&members) <= cap {
        return Ok(Fitted { members, cuts });
    }
    let time = dims.iter().position(|d| d.has(Role::Time));
    if let Some(t) = time {
        let other: usize = members
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != t)
            .map(|(_, m)| m)
            .product();
        let years = (cap / other.max(1)).max(2).min(members[t]);
        if years < members[t] {
            cuts.push(Cut::LatestYears {
                dim: dims[t].dim.clone(),
                kept: years,
                of: members[t],
            });
            members[t] = years;
        }
    }
    if rows(&members) > cap {
        let Some(d) = (0..dims.len())
            .filter(|&i| !dims[i].has(Role::Time))
            .max_by_key(|&i| (members[i], Reverse(i)))
        else {
            return Err(format!(
                "{} rows with only time varying; at most {cap}",
                rows(&members)
            ));
        };
        let rest = rows(&members) / members[d];
        let other = dims[d].has(Role::AdditiveCategory);
        let kept = (cap / rest).saturating_sub(usize::from(other));
        if kept < 2 {
            return Err(format!(
                "{} rows; keeping 2 of {} still exceeds {cap}",
                rows(&members),
                dims[d].dim
            ));
        }
        cuts.push(Cut::TopN {
            dim: dims[d].dim.clone(),
            kept,
            of: members[d],
            other,
            by: rank_by(shape, d)?,
            latest: time.is_some(),
        });
        members[d] = kept + usize::from(other);
    }
    Ok(Fitted { members, cuts })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub relation: Relation,
    pub view: View,
    pub score: i32,
    /// Base first, then each adjustment, so a wrong pick points at one row of the table.
    pub breakdown: Vec<(String, i32)>,
    pub fitted: Fitted,
}

impl Candidate {
    pub fn template(&self) -> &'static str {
        self.relation.template(self.view)
    }

    pub fn explain(&self) -> String {
        let view = if self.view == View::FirstToLast {
            " (first-to-last change)"
        } else {
            ""
        };
        let parts: Vec<String> = self
            .breakdown
            .iter()
            .map(|(why, n)| format!("{why} {n:+}"))
            .collect();
        format!(
            "{}{view} {} = {}",
            self.relation.name(),
            self.score,
            parts.join(", ")
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rejected {
    pub relation: Relation,
    pub view: View,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Matched {
    /// Best first; empty means narrow the filter (nothing is drawn, no gate opens).
    pub candidates: Vec<Candidate>,
    pub rejected: Vec<Rejected>,
}

/// Rank every relation for one slice. `registered` lists the templates the caller fills (one it does not fill fails
/// its gate); `used_before` lists the relations earlier panels on the page already picked.
pub fn rank(shape: &Shape, registered: &[&str], used_before: &[Relation]) -> Matched {
    let mut out = Matched {
        candidates: Vec::new(),
        rejected: Vec::new(),
    };
    judge(shape, View::Slice, registered, used_before, &mut out);
    if let Some(derived) = first_to_last(shape) {
        judge(
            &derived,
            View::FirstToLast,
            registered,
            used_before,
            &mut out,
        );
    }
    out.candidates
        .sort_by_key(|c| (Reverse(c.score), c.relation, c.view));
    out
}

/// Rank every relation for the first-to-last view only, whatever the slice's size: for a series that already holds each
/// entity's first and last value (a change claim's move rows). No candidate, with the reason, when time does not vary over
/// 2 or more values or nothing is left once it is collapsed.
pub fn rank_first_to_last(shape: &Shape, registered: &[&str], used_before: &[Relation]) -> Matched {
    let mut out = Matched {
        candidates: Vec::new(),
        rejected: Vec::new(),
    };
    match collapse_time(shape) {
        Some(derived) => judge(
            &derived,
            View::FirstToLast,
            registered,
            used_before,
            &mut out,
        ),
        None => out.rejected.extend(RELATIONS.map(|relation| Rejected {
            relation,
            view: View::FirstToLast,
            reason:
                "no time dimension varies over 2 or more values, or none is left besides it".into(),
        })),
    }
    out.candidates
        .sort_by_key(|c| (Reverse(c.score), c.relation, c.view));
    out
}

/// The first-to-last view: offered when the slice has 3 or more time values and fitting it to MAX_ROWS keeps
/// less than half its rows. A difference keeps the unit's additivity (counts stay counts, shares become points).
fn first_to_last(shape: &Shape) -> Option<Shape> {
    let t = shape.dims.iter().position(|d| d.has(Role::Time))?;
    if shape.dims[t].members < 3 {
        return None;
    }
    let total: usize = shape.dims.iter().map(|d| d.members).product();
    let kept = fit(shape, MAX_ROWS).map(|f| f.rows()).unwrap_or(0);
    if kept * 2 >= total {
        return None;
    }
    collapse_time(shape)
}

/// The slice with its time dimension collapsed to each entity's first and last value; None when time does not vary over 2
/// or more values or no other dimension varies.
fn collapse_time(shape: &Shape) -> Option<Shape> {
    let t = shape.dims.iter().position(|d| d.has(Role::Time))?;
    if shape.dims[t].members < 2 {
        return None;
    }
    let mut dims = shape.dims.clone();
    dims.remove(t);
    if dims.is_empty() {
        return None;
    }
    Some(Shape {
        dims,
        unit_additive: shape.unit_additive,
        official_flow: None,
    })
}

fn judge(
    shape: &Shape,
    view: View,
    registered: &[&str],
    used_before: &[Relation],
    out: &mut Matched,
) {
    for relation in RELATIONS {
        let reject = |reason: String| Rejected {
            relation,
            view,
            reason,
        };
        if !registered.contains(&relation.template(view)) {
            out.rejected.push(reject(format!(
                "template {} is not filled by this flow yet",
                relation.template(view)
            )));
            continue;
        }
        let fitted = match fit(shape, relation.cap()) {
            Ok(f) => f,
            Err(why) => {
                out.rejected.push(reject(why));
                continue;
            }
        };
        match gate(shape, relation, view, &fitted) {
            Err(why) => out.rejected.push(reject(why)),
            Ok(()) => {
                let breakdown = score(shape, relation, &fitted, used_before);
                let score = breakdown.iter().map(|(_, n)| n).sum();
                out.candidates.push(Candidate {
                    relation,
                    view,
                    score,
                    breakdown,
                    fitted,
                });
            }
        }
    }
}

fn time_index(shape: &Shape) -> Option<usize> {
    shape.dims.iter().position(|d| d.has(Role::Time))
}

/// The additive non-time dimension with the fewest members: the stacked parts.
fn parts_index(shape: &Shape, fitted: &Fitted) -> Option<usize> {
    (0..shape.dims.len())
        .filter(|&i| shape.dims[i].has(Role::AdditiveCategory) && !shape.dims[i].has(Role::Time))
        .min_by_key(|&i| (fitted.members[i], i))
}

/// Never drop a varying dimension silently: a template that cannot hold all of V does not pass.
fn gate(shape: &Shape, relation: Relation, view: View, fitted: &Fitted) -> Result<(), String> {
    let v = &shape.dims;
    if (relation, view) == (Relation::Change, View::FirstToLast) {
        // A dumbbell draws one row per entity, its first and its last value: exactly one dimension besides time, and every
        // row of the series (no cut, since the rows come from the series' own SQL, never trimmed here).
        return match v.as_slice() {
            [one]
                if !(one.has(Role::Category)
                    || one.has(Role::AdditiveCategory)
                    || one.has(Role::Place)) =>
            {
                Err(format!("{} is neither a category nor a place", one.dim))
            }
            [_] if !fitted.cuts.is_empty() => Err(format!(
                "{} entities; a dumbbell draws every one, at most {}",
                v[0].members,
                relation.cap()
            )),
            [_] => Ok(()),
            _ => Err(format!(
                "a dumbbell holds 1 dimension besides time, not {}",
                v.len()
            )),
        };
    }
    match relation {
        Relation::Flow => match &shape.official_flow {
            Some((s, t))
                if v.len() == 2
                    && v.iter().any(|d| &d.dim == s)
                    && v.iter().any(|d| &d.dim == t) =>
            {
                Ok(())
            }
            Some(_) if v.len() == 2 => {
                Err("the official flow pair is not the two varying dimensions".into())
            }
            Some(_) => Err(format!(
                "a flow needs exactly 2 varying dimensions, not {}",
                v.len()
            )),
            None => Err("no official flow direction for these dimensions".into()),
        },
        Relation::Composition => {
            if v.len() > 2 {
                Err(format!(
                    "a stacked bar holds at most 2 varying dimensions, not {}",
                    v.len()
                ))
            } else if parts_index(shape, fitted).is_none() {
                Err("no varying dimension adds up (additive_category)".into())
            } else {
                Ok(())
            }
        }
        Relation::Map => {
            if v.len() != 1 {
                Err(format!("a map holds 1 varying dimension, not {}", v.len()))
            } else if !v[0].is_place || !v[0].iso_countries {
                Err(format!("{} is not all ISO countries", v[0].dim))
            } else if shape.unit_additive {
                Err("counts (unit_additive=true); a choropleth needs a ratio".into())
            } else {
                Ok(())
            }
        }
        Relation::Change => {
            let Some(t) = time_index(shape) else {
                return Err("no time dimension varies".into());
            };
            if fitted.members[t] < 2 {
                Err("fewer than 2 time values".into())
            } else if v.len() > 2 {
                Err(format!(
                    "a line chart holds time and 1 more dimension, not {}",
                    v.len() - 1
                ))
            } else if v.len() == 2 && fitted.members[1 - t] > MAX_LINES {
                Err(format!(
                    "{} lines; at most {MAX_LINES}",
                    fitted.members[1 - t]
                ))
            } else {
                Ok(())
            }
        }
        Relation::Ranking => {
            if v.len() != 1 {
                Err(format!(
                    "a bar ranking holds 1 varying dimension, not {}",
                    v.len()
                ))
            } else if v[0].has(Role::Time)
                || !(v[0].has(Role::Category)
                    || v[0].has(Role::AdditiveCategory)
                    || v[0].has(Role::Place))
            {
                Err(format!("{} is neither a category nor a place", v[0].dim))
            } else {
                Ok(())
            }
        }
        Relation::Distribution => {
            if v.len() == 2 {
                Ok(())
            } else {
                Err(format!(
                    "a heatmap holds exactly 2 varying dimensions, not {}",
                    v.len()
                ))
            }
        }
    }
}

fn score(
    shape: &Shape,
    relation: Relation,
    fitted: &Fitted,
    used_before: &[Relation],
) -> Vec<(String, i32)> {
    let mut rows = vec![("base".to_string(), relation.base())];
    match relation {
        Relation::Composition => {
            if let Some(p) = parts_index(shape, fitted) {
                if fitted.members[p] > MAX_PARTS {
                    rows.push((format!("parts {} > {MAX_PARTS}", fitted.members[p]), -3));
                }
            }
        }
        Relation::Map if fitted.members[0] < MIN_MAP_PLACES => {
            rows.push((
                format!("places {} < {MIN_MAP_PLACES}", fitted.members[0]),
                -2,
            ));
        }
        Relation::Change => {
            if let Some(t) = time_index(shape) {
                if fitted.members[t] < 3 {
                    rows.push((format!("time values {} < 3", fitted.members[t]), -2));
                }
            }
        }
        _ => {}
    }
    // Page rule (10-26, kept until the user says otherwise): an earlier panel already drew this relation.
    if used_before.contains(&relation) {
        rows.push(("same relation earlier on the page".to_string(), -2));
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page lint (editorial_validators.mjs visual_channel.single_owner) lets one field own each channel; a template row that
    /// gives a channel two owners would stop every page that draws it.
    #[test]
    fn every_template_has_its_view_words() {
        for plan in &PAGE_PLANS {
            assert!(
                VIEW_WORDS
                    .iter()
                    .any(|(form, _)| *form == (plan.relation, plan.view)),
                "{:?} {:?}",
                plan.relation,
                plan.view
            );
        }
    }

    #[test]
    fn every_template_gives_each_channel_one_owner() {
        for plan in &PAGE_PLANS {
            let mut seen = std::collections::BTreeSet::new();
            for (channel, column, _) in plan.channels {
                assert!(
                    seen.insert(*channel),
                    "{:?} {:?}: channel {channel} has a second owner ({column})",
                    plan.relation,
                    plan.view
                );
            }
            assert!(
                !plan.channels.is_empty(),
                "{:?} {:?}: no channel",
                plan.relation,
                plan.view
            );
        }
    }

    const ALL: [&str; 6] = [
        "sankey",
        "stacked_bar_100",
        "choropleth",
        "line",
        "horizontal_bar",
        "heatmap",
    ];

    fn dim(name: &str, members: usize, roles: &[Role], place: bool, iso: bool) -> VaryingDim {
        VaryingDim {
            dim: name.into(),
            members,
            roles: roles.to_vec(),
            is_place: place,
            iso_countries: iso,
            total_member: None,
        }
    }

    fn time(members: usize) -> VaryingDim {
        dim("time", members, &[Role::Time], false, false)
    }

    fn shape(dims: Vec<VaryingDim>, additive: bool) -> Shape {
        Shape {
            dims,
            unit_additive: additive,
            official_flow: None,
        }
    }

    fn order(m: &Matched) -> Vec<(Relation, View, i32)> {
        m.candidates
            .iter()
            .map(|c| (c.relation, c.view, c.score))
            .collect()
    }

    use Relation::*;
    use Role::*;
    use View::*;

    // Development questions, as the score table v1.3 and first-last v1.1 pages project them.
    fn q1() -> Shape {
        shape(vec![dim("geo", 27, &[Place, Category], true, true)], false)
    }
    fn q2_panel1() -> Shape {
        let mut s = shape(
            vec![
                dim(
                    "siec",
                    5,
                    &[FlowSource, AdditiveCategory, Category],
                    false,
                    false,
                ),
                dim("nrg_bal", 4, &[FlowTarget, Category], false, false),
            ],
            true,
        );
        s.official_flow = Some(("siec".into(), "nrg_bal".into()));
        s
    }
    fn q2_panel2() -> Shape {
        shape(
            vec![dim("nrg_bal", 4, &[FlowTarget, Category], false, false)],
            true,
        )
    }
    fn q3_panel1() -> Shape {
        shape(
            vec![
                dim("geo", 27, &[Place, AdditiveCategory, Category], true, true),
                dim("siec", 7, &[AdditiveCategory, Category], false, false),
            ],
            true,
        )
    }
    fn q3_panel2() -> Shape {
        shape(
            vec![dim("siec", 7, &[AdditiveCategory, Category], false, false)],
            true,
        )
    }
    fn q4() -> Shape {
        shape(
            vec![dim("country", 10, &[Place, Category], true, true), time(11)],
            false,
        )
    }
    fn q5() -> Shape {
        shape(
            vec![
                dim("country", 217, &[Place, Category], true, true),
                time(11),
            ],
            false,
        )
    }
    fn q6_panel1() -> Shape {
        shape(
            vec![dim(
                "citizen",
                200,
                &[Place, AdditiveCategory, Category],
                true,
                true,
            )],
            true,
        )
    }
    fn q6_panel2() -> Shape {
        shape(
            vec![dim("age", 5, &[AdditiveCategory, Category], false, false)],
            true,
        )
    }

    #[test]
    fn development_questions_pick_as_projected() {
        assert_eq!(
            order(&rank(&q1(), &ALL, &[])),
            vec![(Map, Slice, 2), (Ranking, Slice, 1)]
        );
        assert_eq!(
            order(&rank(&q1(), &ALL, &[Map])),
            vec![(Ranking, Slice, 1), (Map, Slice, 0)]
        );
        assert_eq!(
            order(&rank(&q2_panel1(), &ALL, &[])),
            vec![
                (Flow, Slice, 3),
                (Composition, Slice, 2),
                (Distribution, Slice, 0)
            ]
        );
        assert_eq!(
            order(&rank(&q2_panel2(), &ALL, &[Flow])),
            vec![(Ranking, Slice, 1)]
        );
        assert_eq!(
            order(&rank(&q3_panel1(), &ALL, &[])),
            vec![(Composition, Slice, 2), (Distribution, Slice, 0)]
        );
        assert_eq!(
            order(&rank(&q3_panel2(), &ALL, &[Composition])),
            vec![(Ranking, Slice, 1), (Composition, Slice, 0)]
        );
        assert_eq!(
            order(&rank(&q4(), &ALL, &[])),
            vec![(Distribution, Slice, 0)]
        );
        assert_eq!(order(&rank(&q5(), &ALL, &[]))[0], (Map, FirstToLast, 2));
        assert_eq!(
            order(&rank(&q6_panel1(), &ALL, &[])),
            vec![(Ranking, Slice, 1), (Composition, Slice, -1)]
        );
        // Panel 2 is expected to be a map, which age cannot give: a fetch-side miss, recorded, not tuned here.
        assert_eq!(
            order(&rank(&q6_panel2(), &ALL, &[Ranking])),
            vec![(Composition, Slice, 2), (Ranking, Slice, -1)]
        );
    }

    #[test]
    fn q3_and_q6_must_not_be_flows() {
        for s in [q3_panel1(), q6_panel1()] {
            assert!(rank(&s, &ALL, &[])
                .candidates
                .iter()
                .all(|c| c.relation != Flow));
        }
    }

    #[test]
    fn cuts_follow_the_shape() {
        let q3 = fit(&q3_panel1(), MAX_ROWS).unwrap();
        assert_eq!(
            q3.cuts,
            vec![Cut::TopN {
                dim: "geo".into(),
                kept: 10,
                of: 27,
                other: true,
                by: RankBy::SumOf(vec!["siec".into()]),
                latest: false
            }]
        );
        assert_eq!(q3.rows(), 77);
        let q4 = fit(&q4(), MAX_ROWS).unwrap();
        assert_eq!(
            q4.cuts,
            vec![Cut::LatestYears {
                dim: "time".into(),
                kept: 8,
                of: 11
            }]
        );
        assert_eq!(q4.rows(), 80);
        let q5 = fit(&q5(), MAX_ROWS).unwrap();
        assert_eq!(
            q5.cuts,
            vec![
                Cut::LatestYears {
                    dim: "time".into(),
                    kept: 2,
                    of: 11
                },
                Cut::TopN {
                    dim: "country".into(),
                    kept: 40,
                    of: 217,
                    other: false,
                    by: RankBy::Own,
                    latest: true
                }
            ]
        );
        let q6 = fit(&q6_panel1(), MAX_ROWS).unwrap();
        assert_eq!(
            q6.cuts,
            vec![Cut::TopN {
                dim: "citizen".into(),
                kept: 79,
                of: 200,
                other: true,
                by: RankBy::Own,
                latest: false
            }]
        );
        assert_eq!(fit(&q1(), MAX_ROWS).unwrap().cuts, vec![]);
    }

    #[test]
    fn a_ratio_gets_no_other_row() {
        let f = fit(
            &shape(
                vec![dim("country", 100, &[Place, Category], true, true)],
                false,
            ),
            MAX_ROWS,
        )
        .unwrap();
        assert_eq!(
            f.cuts,
            vec![Cut::TopN {
                dim: "country".into(),
                kept: 80,
                of: 100,
                other: false,
                by: RankBy::Own,
                latest: false
            }]
        );
    }

    #[test]
    fn what_cannot_fit_asks_to_narrow() {
        assert!(fit(
            &shape(
                vec![
                    dim("a", 50, &[Category], false, false),
                    dim("b", 50, &[Category], false, false)
                ],
                false
            ),
            MAX_ROWS
        )
        .is_err());
        assert!(fit(
            &shape(
                vec![
                    dim("a", 40, &[Category], false, false),
                    dim("b", 40, &[Category], false, false),
                    time(5)
                ],
                false
            ),
            MAX_ROWS
        )
        .is_err());
        let none = rank(
            &shape(
                vec![
                    dim("a", 3, &[Unknown], false, false),
                    dim("b", 3, &[Unknown], false, false),
                    dim("c", 3, &[Unknown], false, false),
                ],
                false,
            ),
            &ALL,
            &[],
        );
        assert!(none.candidates.is_empty());
        assert_eq!(none.rejected.len(), 6);
    }

    #[test]
    fn map_cap_is_its_own_and_cut_to_it() {
        let m = rank(&q5(), &ALL, &[]);
        let map = &m.candidates[0];
        assert_eq!(
            map.fitted.cuts,
            vec![Cut::TopN {
                dim: "country".into(),
                kept: 60,
                of: 217,
                other: false,
                by: RankBy::Own,
                latest: false
            }]
        );
        assert_eq!(map.explain(), "map (first-to-last change) 2 = base +2");
    }

    #[test]
    fn first_to_last_only_when_less_than_half_fits() {
        assert!(first_to_last(&q4()).is_none(), "q4 keeps 80 of 110");
        assert!(first_to_last(&q5()).is_some(), "q5 keeps 80 of 2387");
        assert!(first_to_last(&shape(
            vec![dim("country", 100, &[Place, Category], true, true), time(2)],
            false
        ))
        .is_none());
    }

    #[test]
    fn counts_stay_off_the_map_in_both_views() {
        let counts = shape(
            vec![
                dim(
                    "country",
                    217,
                    &[Place, AdditiveCategory, Category],
                    true,
                    true,
                ),
                time(11),
            ],
            true,
        );
        let m = rank(&counts, &ALL, &[]);
        assert!(m.candidates.iter().all(|c| c.relation != Map));
        assert!(m.rejected.iter().any(|r| r.relation == Map
            && r.view == FirstToLast
            && r.reason.contains("unit_additive=true")));
    }

    #[test]
    fn q4_turns_on_the_line_cap_and_time_first() {
        let lines = rank(&q4(), &ALL, &[])
            .rejected
            .into_iter()
            .find(|r| r.relation == Change)
            .unwrap();
        assert_eq!(lines.reason, "10 lines; at most 8");
        // Had countries been cut first (7 of 10 over all 11 years), the line chart would win: q4 rests on this order.
        let seven = shape(
            vec![dim("country", 7, &[Place, Category], true, true), time(11)],
            false,
        );
        assert_eq!(rank(&seven, &ALL, &[]).candidates[0].relation, Change);
    }

    #[test]
    fn missing_templates_fail_their_gate() {
        let today = ["horizontal_bar", "dot", "line", "choropleth"];
        let m = rank(&q2_panel1(), &today, &[]);
        assert!(m.candidates.is_empty());
        assert!(m
            .rejected
            .iter()
            .any(|r| r.relation == Flow
                && r.reason == "template sankey is not filled by this flow yet"));
    }

    #[test]
    fn ties_follow_the_fixed_order() {
        // composition 2 (parts 4) and change 2 (4 lines, 5 years) tie; composition comes first in the fixed order.
        let s = shape(
            vec![
                time(5),
                dim("siec", 4, &[AdditiveCategory, Category], false, false),
            ],
            true,
        );
        assert_eq!(
            order(&rank(&s, &ALL, &[])),
            vec![
                (Composition, Slice, 2),
                (Change, Slice, 2),
                (Distribution, Slice, 0)
            ]
        );
    }

    // A ratio by country and sex: 30 x 3 = 90 rows, so countries are cut and need one value each.
    fn by_sex(total: Option<&str>) -> Shape {
        let mut sex = dim("sex", 3, &[Category], false, false);
        sex.total_member = total.map(Into::into);
        shape(
            vec![dim("country", 30, &[Place, Category], true, true), sex],
            false,
        )
    }

    #[test]
    fn a_ratio_with_another_dimension_ranks_by_its_total_row() {
        let f = fit(&by_sex(Some("T")), MAX_ROWS).unwrap();
        assert_eq!(
            f.cuts,
            vec![Cut::TopN {
                dim: "country".into(),
                kept: 26,
                of: 30,
                other: false,
                by: RankBy::TotalsOf(vec![("sex".into(), "T".into())]),
                latest: false
            }]
        );
    }

    #[test]
    fn no_total_row_and_nothing_to_sum_asks_to_narrow() {
        let why = fit(&by_sex(None), MAX_ROWS).unwrap_err();
        assert_eq!(
            why,
            "cannot rank country by one value: sex does not add up and has no total row"
        );
        // Counts do not help when the other dimension hit unchecked_slices (classified category, not additive).
        let mut counts = by_sex(None);
        counts.unit_additive = true;
        assert!(fit(&counts, MAX_ROWS).is_err());
    }

    #[test]
    fn a_dimension_that_hit_unchecked_slices_gets_no_other_row() {
        // Counts, but classify left the dimension a plain category (unchecked_slices hit): no "other" row.
        let f = fit(
            &shape(
                vec![dim("citizen", 200, &[Place, Category], true, true)],
                true,
            ),
            MAX_ROWS,
        )
        .unwrap();
        assert_eq!(
            f.cuts,
            vec![Cut::TopN {
                dim: "citizen".into(),
                kept: 80,
                of: 200,
                other: false,
                by: RankBy::Own,
                latest: false
            }]
        );
    }

    #[test]
    fn explain_names_each_row() {
        let c = rank(&q6_panel1(), &ALL, &[])
            .candidates
            .into_iter()
            .find(|c| c.relation == Composition)
            .unwrap();
        assert_eq!(c.explain(), "composition -1 = base +2, parts 80 > 7 -3");
    }

    #[test]
    fn the_alt_text_names_the_chart_its_axis_and_the_measure() {
        let shape = |dims: Vec<VaryingDim>| Shape {
            dims,
            unit_additive: false,
            official_flow: None,
        };
        let geo = |iso: bool| dim("geo", 27, &[Role::Place], true, iso);
        assert_eq!(
            shape(vec![geo(true), time(1)]).axis(Ranking, View::Slice),
            Axis::Country
        );
        assert_eq!(
            shape(vec![geo(false), time(1)]).axis(Map, View::Slice),
            Axis::Region
        );
        assert_eq!(
            shape(vec![geo(true), time(9)]).axis(Change, View::Slice),
            Axis::Time
        );
        // A dumbbell lists its entities, not the time.
        assert_eq!(
            shape(vec![geo(true), time(9)]).axis(Change, View::FirstToLast),
            Axis::Country
        );
        assert_eq!(
            shape(vec![
                dim("siec", 5, &[Role::Category], false, false),
                geo(true)
            ])
            .axis(Ranking, View::Slice),
            Axis::Other
        );
        assert_eq!(
            Ranking.alt(View::Slice, Axis::Country, "可再生能源占比"),
            "条形图，按国家列出可再生能源占比，自上而下由高到低排列"
        );
        assert_eq!(
            Change.alt(View::Slice, Axis::Time, "发电量"),
            "折线图，横轴为年份，纵轴为发电量，线向上是增加"
        );
        assert_eq!(
            Change.alt(View::FirstToLast, Axis::Country, "发电量"),
            "哑铃图，每个国家一行，左右两点是起始和最近时期的发电量，连线越长，变化越大"
        );
        for (relation, view) in RELATIONS
            .map(|r| (r, View::Slice))
            .into_iter()
            .chain([(Change, View::FirstToLast)])
        {
            let alt = relation.alt(view, Axis::Other, "量");
            assert!(!alt.chars().any(|c| c.is_ascii_digit()), "{relation:?}");
            // viz.mjs counts UTF-16 units; a one-character measure name still passes.
            assert!(alt.encode_utf16().count() >= 20, "{relation:?}: {alt}");
        }
    }

    /// The template list lives in JS only (NEXT_TEMPLATE_CHART_TYPES in runtime/pi/design_pack.mjs); node reads it. No node, or no list, fails.
    fn js_templates() -> Vec<String> {
        let module = concat!(env!("CARGO_MANIFEST_DIR"), "/runtime/pi/design_pack.mjs");
        let script = format!(
            "import({:?}).then((m) => console.log(JSON.stringify(m.NEXT_TEMPLATE_CHART_TYPES)))",
            format!("file://{module}")
        );
        let out = std::process::Command::new("node")
            .args(["--input-type=module", "-e", &script])
            .output()
            .expect("node runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).expect("a JSON list of chart types")
    }

    #[test]
    fn a_move_series_ranks_first_to_last_only_and_draws_a_dumbbell() {
        let dumbbell = ["dumbbell"];
        let m = rank_first_to_last(&q4(), &dumbbell, &[]);
        assert_eq!(order(&m), [(Change, View::FirstToLast, 2)]);
        assert_eq!(m.candidates[0].template(), "dumbbell");
        assert!(m.candidates[0].fitted.cuts.is_empty());
        // Forced: q4 keeps 80 of 110 rows, so the slice rank offers no first-to-last view, but its move rows still draw.
        assert!(first_to_last(&q4()).is_none());
        // Two time values are enough for a first and a last.
        let two = shape(
            vec![dim("country", 10, &[Place, Category], true, true), time(2)],
            false,
        );
        assert_eq!(
            order(&rank_first_to_last(&two, &dumbbell, &[])),
            [(Change, View::FirstToLast, 2)]
        );
        // More entities than the cap: the dumbbell would need a cut, and its rows are never trimmed here.
        let why = |m: &Matched| {
            m.rejected
                .iter()
                .find(|r| r.relation == Change)
                .map(|r| r.reason.clone())
                .unwrap_or_default()
        };
        let q5 = rank_first_to_last(&q5(), &dumbbell, &[]);
        assert!(q5.candidates.is_empty());
        assert!(
            why(&q5).contains("a dumbbell draws every one"),
            "{}",
            why(&q5)
        );
        // One time value, or nothing besides time: no first-to-last view.
        let flat = shape(
            vec![dim("country", 10, &[Place], true, true), time(1)],
            false,
        );
        assert!(rank_first_to_last(&flat, &dumbbell, &[])
            .candidates
            .is_empty());
        assert!(
            rank_first_to_last(&shape(vec![time(9)], false), &dumbbell, &[])
                .candidates
                .is_empty()
        );
        // Two dimensions besides time: refused, not one of them dropped.
        let wide = shape(
            vec![
                dim("country", 5, &[Place], true, true),
                dim("siec", 3, &[Category], false, false),
                time(9),
            ],
            false,
        );
        let wide = rank_first_to_last(&wide, &dumbbell, &[]);
        assert!(wide.candidates.is_empty());
        assert!(
            why(&wide).contains("1 dimension besides time, not 2"),
            "{}",
            why(&wide)
        );
    }

    #[test]
    fn a_slice_rank_gains_no_dumbbell_and_its_verdicts_are_unchanged() {
        // Over the value templates, the first-to-last change is refused as unregistered before its gate, so no shape gains a
        // candidate; the slice verdicts are the line's as before.
        let values = ["horizontal_bar", "line", "choropleth"];
        for s in [q4(), q5()] {
            let m = rank(&s, &values, &[]);
            assert!(m.candidates.iter().all(|c| c.template() != "dumbbell"));
            assert!(m
                .rejected
                .iter()
                .filter(|r| (r.relation, r.view) == (Change, View::FirstToLast))
                .all(|r| r.reason == "template dumbbell is not filled by this flow yet"));
        }
        assert_eq!(Change.template(View::Slice), "line");
        assert_eq!(Change.template(View::FirstToLast), "dumbbell");
        for relation in [Flow, Composition, Map, Ranking, Distribution] {
            assert_eq!(
                relation.template(View::Slice),
                relation.template(View::FirstToLast)
            );
        }
        assert_eq!(
            page_plan(Change, View::FirstToLast).visual_grammar,
            "change"
        );
        assert_eq!(page_plan(Change, View::Slice).visual_grammar, "trend");
    }

    /// The whole-chart template lists are frozen: a new graphic is a node or a composition of nodes, never one more
    /// whole-chart template. Each list is held to its current names.
    const FROZEN: &str =
        "whole-chart templates are frozen: a new graphic adds a node or a composition of nodes, \
         not a template";

    #[test]
    fn the_whole_chart_template_lists_stay_frozen() {
        let js = js_templates();
        assert_eq!(
            js,
            [
                "horizontal_bar",
                "dot",
                "line",
                "choropleth",
                "sankey",
                "stacked_bar_100",
                "dumbbell"
            ],
            "{FROZEN}"
        );
        let mut picked: Vec<&str> = RELATIONS
            .iter()
            .flat_map(|r| [r.template(View::Slice), r.template(View::FirstToLast)])
            .collect();
        picked.sort_unstable();
        picked.dedup();
        assert_eq!(
            picked,
            [
                "choropleth",
                "dumbbell",
                "heatmap",
                "horizontal_bar",
                "line",
                "sankey",
                "stacked_bar_100"
            ],
            "{FROZEN}"
        );
    }

    #[test]
    fn templates_come_from_the_js_list() {
        let js = js_templates();
        let names: Vec<&str> = js.iter().map(String::as_str).collect();
        // Every relation's template is a JS template row, except distribution: no heatmap row yet, so it is refused by its gate.
        for relation in RELATIONS {
            assert_eq!(
                names.contains(&relation.template(View::Slice)),
                relation != Distribution,
                "{}",
                relation.template(View::Slice)
            );
        }
        // The dumbbell, the change in the first-to-last view, is a JS row too.
        assert!(names.contains(&Change.template(View::FirstToLast)));
        assert_eq!(order(&rank(&q2_panel1(), &names, &[]))[0].0, Flow);
        assert_eq!(order(&rank(&q3_panel1(), &names, &[]))[0].0, Composition);
        assert!(rank(&q3_panel1(), &names, &[])
            .rejected
            .iter()
            .any(|r| r.relation == Distribution
                && r.reason == "template heatmap is not filled by this flow yet"));
    }
}

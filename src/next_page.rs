//! Flow side, page step 1 (the fourth model ask): the program drafts every page field from the picked claims and the charts
//! they share (the Chinese frames of shape_registry), the model only rewrites the wording (Ask::Text: same placeholders, no
//! number in words, and no typed number but the time values the page draws, such as the year of a claim's row). Where a
//! number may stand follows the design pack: a chart's takeaway and title are checked as having no rows, so they are never
//! drafted here (the pack keeps the claim's own sentence); a chart module's body carries that chart's row placeholders;
//! the page's one hero_stat is the first picked claim that shows one value of its own (the claim that answers the question),
//! its number by value_from, and a claim with neither a body sentence nor the hero is unplaced. The drafts of page title, dek, chart headings and the text module carry neither placeholder nor number. The
//! design pack's reader fields (reader problem, visual thesis, three candidate questions) are drafted from the lead chart's
//! concept (shape_registry CONCEPTS; the lead is the first chart the page draws a card for, so these and the page title,
//! dek and text never describe a chart left off the page) and reworded in the same ask, under the same rules. Pure.
//!
//! Left for the wiring (not done here): a wording refused REFUSED_ROUNDS times goes back to the draft for the refused field
//! only, the other revised fields kept, and the fallback is written as one program event; with slots, an empty answer
//! fails the names check, so the fallback path fills the names on its own. A hero label is still the claim's English
//! template with its value cut out, so a fallback there would put English on the page. A rank body sentence reads
//! {max.*}/{min.*} of the whole chart: only on a one-period ranking or map; on a chart over years it goes to a hero or
//! unplaced.

use std::collections::BTreeMap;

use crate::next_flow::{
    number_not_allowed, placeholders, worded_number, year_after_period, Ask, Choice,
};
use crate::shape_registry::{
    Concept, Relation, View, BODY_SENTENCES, CARD_FORMS, CONCEPTS, FRAMES, HERO_LABELS,
    SCOPED_WORDS, VIEW_WORDS,
};

/// A picked, verified claim: its candidate sheet kind and its template (placeholders over its own one-row SQL).
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub id: String,
    pub kind: String,
    pub template: String,
}

/// One chart of the sheet: the claims drawn on it and the row columns its template reads. In the first-to-last view `value` is
/// the last value's column (the first value's is next_run's MOVE_FROM).
#[derive(Clone, Debug, PartialEq)]
pub struct Chart {
    pub relation: Relation,
    pub view: View,
    pub claim_ids: Vec<String>,
    pub category: String,
    pub value: String,
}

/// Where a drafted field goes on the page.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Target {
    PageTitle,
    PageDek,
    /// The heading of the module that holds chart i (0-based, sheet order).
    Heading(usize),
    /// The body of the module that holds chart i: placeholders over that chart's rows.
    Body(usize),
    /// A hero_stat's label for a claim; the number is value_from, filled by the program, never typed.
    HeroLabel {
        claim_id: String,
        value_from: String,
    },
    /// The page's one text module (the pack passes it as written, so it holds no placeholder).
    Text,
    /// The design pack's reader fields: discovery.reader_problem, story_graph.visual_thesis, discovery.candidate_questions.
    ReaderProblem,
    VisualThesis,
    Question(usize),
    /// The Chinese name of chart i's measure (its measure_semantics phenomenon, hence the chart title): a Text slot, its
    /// draft the table's catalogue title.
    Measure(usize),
}

/// Columns of a claim's own SQL that are when, not how much (claim_candidates.mjs aliases); never a hero value.
pub const TIME_COLUMNS: [&str; 3] = ["year", "from_year", "to_year"];

fn frames(relation: Relation, view: View) -> [&'static str; 4] {
    FRAMES
        .iter()
        .find(|(r, v, _)| (*r, *v) == (relation, view))
        .expect("every relation has frames")
        .2
}

pub fn concept(relation: Relation, view: View) -> &'static Concept {
    CONCEPTS
        .iter()
        .find(|c| (c.relation, c.view) == (relation, view))
        .expect("every relation has a concept")
}

/// Words that rank: on a page with a chart whose places the program narrowed, "highest" holds only among the kept places,
/// so a field keeps its draft when the model's wording holds one (the draft stands under the page's scope fields).
pub const SUPERLATIVES: [&str; 7] = ["最高", "最低", "领先", "垫底", "第一", "最多", "最少"];

/// How the program chose a chart's places (a World Bank table narrowed by wb-rank-by.json): its own page field (the kicker
/// and the chart's eyebrow), never model text, so the model can neither drop nor change it. `text` names the count of places the
/// narrow record keeps; `record` is that record (data/origins), the field's source.
#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub text: String,
    pub record: String,
}

/// The page fields the program drafted, numbered "1".. in order.
#[derive(Clone, Debug, PartialEq)]
pub struct Drafts {
    pub fields: Vec<(Target, String)>,
    /// The numbers a wording may type; the product's page text lists none (run_page: the pack refuses every typed number).
    pub numbers: Vec<String>,
    /// The page's time values that are not years (with_periods): 年 after a time placeholder is refused.
    pub periods: Vec<String>,
    /// Claims that got no field: no body sentence for the kind and no single value placeholder for a hero (the pack's own
    /// sentence still stands as the chart's takeaway).
    pub unplaced: Vec<String>,
    /// The Text slots: per chart its measure, with the catalogue title the Chinese name is made from.
    pub slots: Vec<(Target, String)>,
    /// Some chart of the page has a Scope: a reworded field that ranks goes back to its draft (Drafts::scoped).
    pub has_scope: bool,
}

/// The one placeholder of a claim template that holds its number: not a time column, not the chart's category column.
fn hero_value(template: &str, category: &str) -> Option<String> {
    let found = placeholders(template).ok()?;
    let mut values = found.into_iter().filter(|p| {
        let column = p.strip_prefix("first.").unwrap_or(p);
        p.starts_with("first.") && !TIME_COLUMNS.contains(&column) && column != category
    });
    let one = values.next()?;
    values.next().is_none().then_some(one)
}

/// The hero caption's draft: the claim kind's HERO_LABELS frame on the claim's own placeholders, after "{first.year}年，" when
/// the claim states its year. None for a kind with no row, or a frame naming the category the claim's template does not hold.
fn hero_label(claim: &Claim, category: &str) -> Option<String> {
    let (_, frame) = HERO_LABELS.iter().find(|(kind, _)| *kind == claim.kind)?;
    let held = placeholders(&claim.template).ok()?;
    let name = format!("first.{category}");
    if frame.contains("{name}") && !held.contains(&name) {
        return None;
    }
    let label = frame.replace("{name}", &format!("{{{name}}}"));
    Some(if held.contains("first.year") {
        format!("{{first.year}}年，{label}")
    } else {
        label
    })
}

/// The chart the page-level fields speak for: the first the page draws a card for (CARD_FORMS), else the first chart.
pub fn lead(charts: &[Chart]) -> Option<(Relation, View)> {
    charts
        .iter()
        .find(|c| CARD_FORMS.contains(&(c.relation, c.view)))
        .or(charts.first())
        .map(|c| (c.relation, c.view))
}

/// Drafts every page field from the picked claims and the sheet's charts. A claim on no chart gets no field.
pub fn draft(claims: &[Claim], charts: &[Chart], numbers: Vec<String>) -> Drafts {
    let lead = lead(charts).unwrap_or((Relation::Ranking, View::Slice));
    let mut fields = vec![
        (Target::PageTitle, frames(lead.0, lead.1)[0].to_string()),
        (Target::PageDek, frames(lead.0, lead.1)[1].to_string()),
    ];
    // The page's one hero: the first picked claim (the one that answers the question) that shows one value of its own.
    let hero = claims.iter().find_map(|claim| {
        let chart = charts.iter().find(|c| c.claim_ids.contains(&claim.id))?;
        let value_from = hero_value(&claim.template, &chart.category)?;
        hero_label(claim, &chart.category).map(|label| (claim, value_from, label))
    });
    let mut heroes = Vec::new();
    let mut unplaced = Vec::new();
    for (i, chart) in charts.iter().enumerate() {
        fields.push((
            Target::Heading(i),
            frames(chart.relation, chart.view)[2].to_string(),
        ));
        let mut body = Vec::new();
        for claim in claims.iter().filter(|c| chart.claim_ids.contains(&c.id)) {
            if let Some((_, value_from, label)) = hero.as_ref().filter(|(h, _, _)| h.id == claim.id)
            {
                heroes.push((
                    Target::HeroLabel {
                        claim_id: claim.id.clone(),
                        value_from: value_from.clone(),
                    },
                    label.clone(),
                ));
            } else if let Some((_, sentence)) =
                BODY_SENTENCES.iter().find(|(kind, _)| *kind == claim.kind)
            {
                body.push(
                    sentence
                        .replace("{v}", &chart.value)
                        .replace("{c}", &chart.category),
                );
            } else {
                unplaced.push(claim.id.clone());
            }
        }
        if !body.is_empty() {
            fields.push((Target::Body(i), body.concat()));
        }
    }
    fields.extend(heroes);
    fields.push((Target::Text, frames(lead.0, lead.1)[3].to_string()));
    let reader = concept(lead.0, lead.1);
    fields.push((Target::ReaderProblem, reader.reader_problem.to_string()));
    fields.push((Target::VisualThesis, reader.visual_thesis.to_string()));
    fields.extend(
        reader
            .questions
            .iter()
            .enumerate()
            .map(|(i, q)| (Target::Question(i), q.to_string())),
    );
    Drafts {
        fields,
        numbers,
        periods: Vec::new(),
        unplaced,
        slots: Vec::new(),
        has_scope: false,
    }
}

impl Drafts {
    fn number(i: usize) -> String {
        (i + 1).to_string()
    }

    /// One slot per chart for its measure's Chinese name, made from the chart's table title (sheet order). A title two charts
    /// share gets each chart's VIEW_WORDS, so the model can tell the charts apart and names each for what it shows.
    pub fn name_measures(mut self, titles: &[String], charts: &[Chart]) -> Self {
        self.slots = titles
            .iter()
            .enumerate()
            .map(|(i, title)| {
                let shared = titles.iter().filter(|t| *t == title).count() > 1;
                let words = charts.get(i).and_then(|c| {
                    VIEW_WORDS
                        .iter()
                        .find(|(form, _)| *form == (c.relation, c.view))
                        .map(|(_, w)| *w)
                });
                let title = match words {
                    Some(words) if shared => format!("{title} ({words})"),
                    _ => title.clone(),
                };
                (Target::Measure(i), title)
            })
            .collect();
        self
    }

    /// The page's chart times that are not years (2026-08, a monthly table's), kept for the Text ask's period rule.
    pub fn with_periods(mut self, times: &[String]) -> Self {
        self.periods = times
            .iter()
            .filter(|t| !t.is_empty() && !t.chars().all(|c| c.is_ascii_digit()))
            .cloned()
            .collect();
        // A time placeholder prints the whole period (2026-08), so the hero draft writes no 年 after it.
        if !self.periods.is_empty() {
            for (target, text) in &mut self.fields {
                if matches!(target, Target::HeroLabel { .. }) {
                    *text = text.replace("{first.year}年，", "{first.year}，");
                }
            }
        }
        self
    }

    /// Whether some chart (sheet order, None for a chart of all its places) has a Scope. A scoped page drafts its frames
    /// and reader fields in their SCOPED_WORDS form, so a field `scoped` puts back holds no SUPERLATIVES word either.
    pub fn with_scopes(mut self, scopes: &[Option<Scope>]) -> Self {
        self.has_scope = scopes.iter().any(Option::is_some);
        if self.has_scope {
            for (_, text) in &mut self.fields {
                if let Some((_, scoped)) = SCOPED_WORDS.iter().find(|(draft, _)| draft == text) {
                    *text = scoped.to_string();
                }
            }
        }
        self
    }

    /// The revised fields, each whose wording differs from its draft and holds a SUPERLATIVES word the draft's again when
    /// the page is scoped; returns the fields that went back. With no scope, the fields as given.
    pub fn scoped(
        &self,
        mut out: BTreeMap<Target, String>,
    ) -> (BTreeMap<Target, String>, Vec<Target>) {
        if !self.has_scope {
            return (out, Vec::new());
        }
        let mut back = Vec::new();
        for (target, draft) in &self.fields {
            if let Some(wording) = out.get_mut(target) {
                if wording != draft && SUPERLATIVES.iter().any(|w| wording.contains(w)) {
                    *wording = draft.clone();
                    back.push(target.clone());
                }
            }
        }
        (out, back)
    }

    /// The slot ids, as the ask and the answer's `names` know them.
    pub fn slot_ids(&self) -> Vec<String> {
        (0..self.slots.len())
            .map(|i| format!("s{}", i + 1))
            .collect()
    }

    /// The fourth ask: every drafted field by number, and the slots still needing a Chinese name.
    pub fn ask(&self, slots: Vec<String>) -> Ask {
        Ask::Text {
            fields: self
                .fields
                .iter()
                .enumerate()
                .map(|(i, (_, text))| (Self::number(i), text.clone()))
                .collect(),
            slots,
            numbers: self.numbers.clone(),
            periods: self.periods.clone(),
        }
    }

    /// The page fields after a checked Text answer: a revised field in place of its draft, the rest as drafted. This step
    /// comes after the data is fetched and the claims verified, so a wording refused REFUSED_ROUNDS times must not stop the
    /// run: the caller answers for the model with no revision (empty `text`), and the program's own drafts go on the page.
    pub fn revised(&self, choice: &Choice) -> Result<BTreeMap<Target, String>, String> {
        let Choice::Text { text, names } = choice else {
            return Err("the page wording needs a text answer".into());
        };
        let out: BTreeMap<Target, String> = self
            .fields
            .iter()
            .enumerate()
            .map(|(i, (target, draft))| {
                (
                    target.clone(),
                    text.get(&Self::number(i)).unwrap_or(draft).clone(),
                )
            })
            .collect();
        // A slot the answer left unnamed stays out: its catalogue title is not a Chinese name.
        let named: Vec<(Target, String)> = self
            .slot_ids()
            .iter()
            .zip(&self.slots)
            .filter_map(|(id, (target, _))| {
                names
                    .get(id)
                    .map(|name| (target.clone(), name.trim().to_string()))
            })
            .collect();
        // Ask::check already holds both rules; a second look here keeps a choice from another ask off the page.
        for (target, wording) in &out {
            let draft = &self
                .fields
                .iter()
                .find(|(t, _)| t == target)
                .expect("drafted")
                .1;
            if placeholders(wording) != placeholders(draft)
                || number_not_allowed(wording, &self.numbers).is_some()
                || worded_number(wording).is_some()
                || (!self.periods.is_empty() && year_after_period(wording).is_some())
            {
                return Err(format!("{target:?}: the wording does not keep the draft's placeholders or types a number not allowed"));
            }
        }
        let mut out = out;
        out.extend(named);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::next_flow::typed_numbers;
    use serde_json::json;

    /// The q1 shape (stand-in run): three verified claims on one series, rows {name, value, year}.
    fn q1() -> (Vec<Claim>, Vec<Chart>) {
        let claim = |id: &str, kind: &str, template: &str| Claim {
            id: id.into(),
            kind: kind.into(),
            template: template.into(),
        };
        (
            vec![
                claim("c1", "rank_top", "{first.name} has the highest OBS VALUE in {first.year}: {first.value}."),
                claim("c2", "rank_bottom", "{first.name} has the lowest OBS VALUE in {first.year}: {first.value}."),
                claim("c3", "extreme_gap", "The gap between the highest and the lowest OBS VALUE in {first.year} is {first.gap}."),
            ],
            vec![Chart {
                relation: Relation::Ranking,
                view: View::Slice,
                claim_ids: vec!["c1".into(), "c2".into(), "c3".into()],
                category: "name".into(),
                value: "value".into(),
            }],
        )
    }

    /// An ask that lists a number a wording may type (the product's page text lists none; see run_page).
    fn q1_numbers() -> Vec<String> {
        vec!["2025".to_string()]
    }

    #[test]
    fn q1_puts_the_first_pick_in_the_hero_and_the_other_row_numbers_in_the_body() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, q1_numbers());
        assert_eq!(drafts.unplaced, ["c3"]);
        let targets: Vec<&Target> = drafts.fields.iter().map(|(t, _)| t).collect();
        assert_eq!(
            targets,
            [
                &Target::PageTitle,
                &Target::PageDek,
                &Target::Heading(0),
                &Target::Body(0),
                &Target::HeroLabel {
                    claim_id: "c1".into(),
                    value_from: "first.value".into()
                },
                &Target::Text,
                &Target::ReaderProblem,
                &Target::VisualThesis,
                &Target::Question(0),
                &Target::Question(1),
                &Target::Question(2),
            ]
        );
        let field = |target: &Target| &drafts.fields.iter().find(|(t, _)| t == target).unwrap().1;
        assert_eq!(
            field(&Target::Body(0)),
            "{min.value.name}最低，为{min.value}。"
        );
        assert_eq!(
            field(&Target::HeroLabel {
                claim_id: "c1".into(),
                value_from: "first.value".into()
            }),
            "{first.year}年，{first.name}最高"
        );
        // No draft holds a typed number; only the body and the hero carry placeholders.
        for (target, text) in &drafts.fields {
            assert!(
                typed_numbers(text).is_empty() && worded_number(text).is_none(),
                "{target:?}"
            );
            let carries = !placeholders(text).unwrap().is_empty();
            assert_eq!(
                carries,
                matches!(target, Target::Body(_) | Target::HeroLabel { .. }),
                "{target:?}"
            );
        }
    }

    #[test]
    fn every_relation_has_number_free_frames() {
        for (relation, view, _) in FRAMES {
            for frame in frames(relation, view) {
                let clean = typed_numbers(frame).is_empty() && worded_number(frame).is_none();
                assert!(clean && placeholders(frame).unwrap().is_empty(), "{frame}");
            }
            // The text module tells how to read the chart, never why.
            assert!(
                !["因为", "由于", "原因", "导致"]
                    .iter()
                    .any(|w| frames(relation, view)[3].contains(w)),
                "{relation:?}"
            );
        }
        // The reader-field drafts too, and a concept's three questions differ.
        for (relation, view) in CONCEPTS.iter().map(|c| (c.relation, c.view)) {
            let reader = concept(relation, view);
            for text in [reader.reader_problem, reader.visual_thesis]
                .iter()
                .chain(reader.questions.iter())
            {
                let clean = typed_numbers(text).is_empty() && worded_number(text).is_none();
                assert!(clean && placeholders(text).unwrap().is_empty(), "{text}");
            }
            let distinct: std::collections::BTreeSet<&str> = reader.questions.into_iter().collect();
            assert_eq!(distinct.len(), 3, "{relation:?}");
        }
        for (kind, sentence) in BODY_SENTENCES {
            let filled = sentence.replace("{v}", "value").replace("{c}", "name");
            assert!(
                typed_numbers(&filled).is_empty() && worded_number(&filled).is_none(),
                "{kind}"
            );
        }
    }

    #[test]
    fn a_first_pick_with_no_single_value_passes_the_hero_on_and_is_left_unplaced() {
        let (mut claims, charts) = q1();
        claims[0] = Claim {
            id: "c1".into(),
            kind: "change_largest_rise".into(),
            template: "{first.name} changed the most upward from {first.from_year} to {first.to_year}: from {first.from_value} to {first.to_value}.".into(),
        };
        let drafts = draft(&claims, &charts, q1_numbers());
        assert_eq!(drafts.unplaced, ["c1", "c3"]);
        let heroes: Vec<&Target> = drafts
            .fields
            .iter()
            .map(|(t, _)| t)
            .filter(|t| matches!(t, Target::HeroLabel { .. }))
            .collect();
        assert_eq!(
            heroes,
            [&Target::HeroLabel {
                claim_id: "c2".into(),
                value_from: "first.value".into()
            }]
        );
    }

    #[test]
    fn more_fewer_or_typed_numbers_are_refused_and_a_kept_set_goes_on_the_page() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, q1_numbers());
        let ask = drafts.ask(vec![]);
        let answer =
            |n: &str, wording: &str| json!({"step": "text", "text": {n: wording}, "names": {}});
        // Field 4 is the body, 5 the hero label.
        for (n, wording, why) in [
            ("4", "{max.value.name}最高，为{max.value}；{min.value.name}最低，为{min.value}；相差{first.gap}", "not in the draft"),
            ("4", "{min.value.name}最低。", "missing: [{min.value}]"),
            ("4", "{min.value.name}最低，为{min.value}，相差50.5。", "typed number"),
            ("5", "{first.name}在{first.year}年最高，约65", "typed number"),
            ("1", "{max.value.name}领先", "not in the draft"),
            ("6", "2030年差距会怎样", "typed number"),
            ("6", "最高约是最低的三倍", "number in words"),
            ("1", "过半国家低于平均", "number in words"),
        ] {
            let refused = ask.check(&answer(n, wording)).unwrap_err();
            assert!(refused.problem.contains(why), "{n} {wording}: {}", refused.problem);
            assert_eq!(refused.allowed["text"]["4"], json!(drafts.fields[3].1));
        }
        let wording = "{min.value.name}最低，为{min.value}。";
        let choice = ask.check(&answer("4", wording)).unwrap();
        let page = drafts.revised(&choice).unwrap();
        assert_eq!(page[&Target::Body(0)], wording);
        assert_eq!(page[&Target::PageTitle], drafts.fields[0].1);
        // A hero's number is never the model's: value_from stays the program's placeholder.
        assert!(page.contains_key(&Target::HeroLabel {
            claim_id: "c1".into(),
            value_from: "first.value".into()
        }));
    }

    /// The product's page text (run_page) lists no number to type, as the design pack's claim-template check: the typed years
    /// of q4's stand-in heading are refused here with the rule and its example.
    #[test]
    fn the_page_text_types_no_year_and_says_so_with_an_example() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, Vec::new());
        let ask = drafts.ask(drafts.slot_ids());
        let field = |wording: &str| {
            ask.check(&json!({"step": "text", "text": {"1": wording}, "names": {}}))
        };
        let years = field("从2016年到2024年").unwrap_err();
        assert!(
            years.problem.contains(crate::next_flow::TYPED_NUMBER_RULE),
            "{}",
            years.problem
        );
        // 二氧化碳 is a chemical name, not a number (q4's name was refused for it in four stand-in runs); a number word
        // stays refused, and so does the word right after a placeholder.
        assert!(field("人均二氧化碳排放由高到低").is_ok());
        let words = field("二千万吨").unwrap_err();
        assert!(
            words.problem.contains(crate::next_flow::NUMBER_WORD_RULE),
            "{}",
            words.problem
        );
        assert!(worded_number("人均二氧化碳").is_none());
        assert!(
            worded_number("{first.value}二氧化碳").is_some()
                && worded_number("十二氧化碳").is_some()
        );
        let named = draft(&claims, &charts, Vec::new())
            .name_measures(&["CO2 per capita".to_string()], &charts);
        assert!(named
            .ask(named.slot_ids())
            .check(&json!({"step": "text", "text": {}, "names": {"s1": "人均二氧化碳排放"}}))
            .is_ok());
        // Each wording the rules suggest passes the check that suggests it, as a field and as a name.
        for suggested in crate::next_flow::RULE_SUGGESTIONS {
            assert!(field(suggested).is_ok(), "{suggested}");
            assert!(
                named
                    .ask(named.slot_ids())
                    .check(&json!({"step": "text", "text": {}, "names": {"s1": suggested}}))
                    .is_ok(),
                "{suggested}"
            );
        }
    }

    #[test]
    fn numbers_no_data_gave_are_refused_and_words_pass() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, q1_numbers());
        let ask = drafts.ask(vec![]);
        let title = |wording: &str| {
            ask.check(&json!({"step": "text", "text": {"1": wording}, "names": {}}))
        };
        // The year the page draws is the data's own: allowed as typed.
        for ok in [
            "2025 年谁领先",
            "欧盟各国，2025 年",
            "第一名与末名",
            "统一口径下谁领先",
        ] {
            assert!(title(ok).is_ok(), "{ok}");
        }
        // Any other number is one no data gave, even a year the table holds but the page does not draw, or the EU's
        // member count: refused, with the allowed list in the reply.
        for typed in [
            "2023 年谁领先",
            "2030 年谁领先",
            "2015 至 2025 年",
            "欧盟 27 国谁领先",
            "第1名与末名",
            "前３名",
            "相差50.5",
        ] {
            let refused = title(typed).unwrap_err();
            assert!(refused.problem.contains("is a typed number"), "{typed}");
            assert_eq!(refused.allowed["numbers"], json!(q1_numbers()));
        }
        // A year that matters is the claim's own placeholder: the hero label keeps {first.year}.
        assert!(ask.check(&json!({"step": "text", "text": {"5": "{first.name}在{first.year}年最高"}, "names": {}})).is_ok());
        // Refused twice, the run goes on with the drafts: an empty revision is a valid answer.
        let kept = drafts
            .revised(
                &ask.check(&json!({"step": "text", "text": {}, "names": {}}))
                    .unwrap(),
            )
            .unwrap();
        assert!(drafts.fields.iter().all(|(t, d)| &kept[t] == d));
    }

    #[test]
    fn revised_refuses_a_choice_that_skipped_the_check() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, q1_numbers());
        let unchecked = Choice::Text {
            text: BTreeMap::from([("1".to_string(), "2030年谁领先".to_string())]),
            names: BTreeMap::new(),
        };
        assert!(drafts.revised(&unchecked).is_err());
        assert!(drafts
            .revised(&Choice::Search { query: "x".into() })
            .is_err());
    }

    /// q4's and q5's hero: a scoped page sends a reworded superlative back to its draft, so the draft is Chinese, on the claim's
    /// own placeholders; a period page drops the 年; a kind with no HERO_LABELS row is not the hero.
    #[test]
    fn the_hero_caption_is_drafted_in_chinese_from_its_claim_kind() {
        let (_, charts) = q1();
        let category = charts[0].category.clone();
        let claim = |kind: &str, template: String| Claim {
            id: "c1".into(),
            kind: kind.into(),
            template,
        };
        let top = claim(
            "rank_top",
            format!("Among the most populous economies, {{first.{category}}} has the highest value in {{first.year}}: {{first.value}}."),
        );
        let label = |claims: &[Claim], times: &[String]| {
            draft(claims, &charts, Vec::new())
                .with_periods(times)
                .fields
                .into_iter()
                .find(|(t, _)| matches!(t, Target::HeroLabel { .. }))
                .map(|(_, l)| l)
        };
        assert_eq!(
            label(std::slice::from_ref(&top), &[]),
            Some(format!("{{first.year}}年，{{first.{category}}}最高"))
        );
        assert_eq!(
            label(std::slice::from_ref(&top), &["2026-08".to_string()]),
            Some(format!("{{first.year}}，{{first.{category}}}最高"))
        );
        let unknown = claim(
            "no_such_kind",
            format!("{{first.{category}}} is {{first.value}}."),
        );
        assert_eq!(label(&[unknown], &[]), None);
    }

    /// Every claim kind the candidate sheet can emit (claim_candidates.mjs `add`) has a hero caption row.
    #[test]
    fn every_claim_kind_has_a_hero_caption() {
        let sheet = include_str!("../runtime/pi/claim_candidates.mjs");
        let kinds: Vec<&str> = sheet
            .match_indices("add(\"")
            .filter_map(|(i, m)| sheet[i + m.len()..].split('"').next())
            .collect();
        assert!(kinds.len() >= 10, "{kinds:?}");
        for kind in kinds {
            assert!(
                HERO_LABELS.iter().any(|(k, _)| *k == kind),
                "{kind}: no HERO_LABELS row"
            );
        }
    }

    /// q1 and q5's stand-in pages: the sheet led with a map (q1) or a dumbbell (q5) the page has no card for, and the page
    /// title, dek and reader fields described it over the one ranking card drawn. They speak for the first carded chart.
    #[test]
    fn the_page_words_describe_a_chart_the_page_draws() {
        let (claims, carded) = q1();
        let page_level = |drafts: &Drafts| -> Vec<(Target, String)> {
            drafts
                .fields
                .iter()
                .filter(|(t, _)| {
                    matches!(
                        t,
                        Target::PageTitle
                            | Target::PageDek
                            | Target::Text
                            | Target::ReaderProblem
                            | Target::VisualThesis
                            | Target::Question(_)
                    )
                })
                .cloned()
                .collect()
        };
        let words_of = |relation, view| {
            let chart = Chart {
                relation,
                view,
                ..carded[0].clone()
            };
            page_level(&draft(&claims, &[chart], Vec::new()))
        };
        let (card_relation, card_view) = CARD_FORMS[0];
        for (relation, view, _) in FRAMES {
            if CARD_FORMS.contains(&(relation, view)) {
                continue;
            }
            let uncarded = Chart {
                relation,
                view,
                claim_ids: Vec::new(),
                ..carded[0].clone()
            };
            let page = [uncarded, carded[0].clone()];
            assert_eq!(
                lead(&page),
                Some((card_relation, card_view)),
                "{relation:?}"
            );
            assert_eq!(
                page_level(&draft(&claims, &page, Vec::new())),
                words_of(card_relation, card_view),
                "{relation:?} {view:?} before a carded chart"
            );
            // With no carded chart the page draws nothing; the words stay the first chart's.
            assert_eq!(
                page_level(&draft(&claims, &page[..1], Vec::new())),
                words_of(relation, view)
            );
        }
        // q1's map title is not on a page whose only card is the ranking.
        let map_title = frames(Relation::Map, View::Slice)[0];
        let q1_page = [
            Chart {
                relation: Relation::Map,
                ..carded[0].clone()
            },
            carded[0].clone(),
        ];
        let drafts = draft(&claims, &q1_page, Vec::new());
        assert!(drafts.fields.iter().all(|(_, text)| text != map_title));
    }

    /// q4's stand-in page: a ranking and a dumbbell of one table got the same draft title, so the two names could not differ.
    #[test]
    fn two_charts_of_one_table_get_draft_titles_that_say_what_each_shows() {
        let (claims, mut charts) = q1();
        let mut second = charts[0].clone();
        second.view = View::FirstToLast;
        second.relation = Relation::Change;
        charts.push(second);
        let title = "Carbon dioxide emissions per capita".to_string();
        let drafts = draft(&claims, &charts, Vec::new())
            .name_measures(&[title.clone(), title.clone()], &charts);
        let names: Vec<&str> = drafts.slots.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(
            names,
            [
                "Carbon dioxide emissions per capita (ranked at the latest time)",
                "Carbon dioxide emissions per capita (change from the first to the last time)"
            ]
        );
        // Titles that already differ are listed as they are.
        let other = draft(&claims, &charts, Vec::new())
            .name_measures(&[title.clone(), "Other".into()], &charts);
        assert_eq!(other.slots[0].1, title);
    }

    #[test]
    fn a_measure_slot_is_named_by_the_answer_or_left_out() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, q1_numbers())
            .name_measures(&["Share of renewable energy".to_string()], &charts);
        assert_eq!(drafts.slot_ids(), ["s1"]);
        let ask = drafts.ask(drafts.slot_ids());
        let named = ask
            .check(&json!({"step": "text", "text": {}, "names": {"s1": " 可再生能源占比 "}}))
            .unwrap();
        assert_eq!(
            drafts
                .revised(&named)
                .unwrap()
                .get(&Target::Measure(0))
                .map(String::as_str),
            Some("可再生能源占比")
        );
        assert!(
            ask.check(&json!({"step": "text", "text": {}, "names": {}}))
                .is_err(),
            "the slot is required"
        );
        let unnamed = Choice::Text {
            text: BTreeMap::new(),
            names: BTreeMap::new(),
        };
        assert!(
            !drafts
                .revised(&unnamed)
                .unwrap()
                .contains_key(&Target::Measure(0)),
            "no catalogue title as the name"
        );
    }

    fn by_population() -> Scope {
        Scope {
            text: "在人口最多的8个经济体中".into(),
            record: "data/origins/n.json".into(),
        }
    }

    #[test]
    fn on_a_scoped_page_a_reworded_field_that_ranks_keeps_its_draft() {
        let (claims, charts) = q1();
        let drafts =
            draft(&claims, &charts, q1_numbers()).with_scopes(&[None, Some(by_population())]);
        assert!(drafts.has_scope);
        let ask = drafts.ask(Vec::new());
        // The model ranks in the title, the body, the hero and a reader field, and rewords the dek and the heading without ranking.
        let answer = ask
            .check(&json!({"step": "text", "names": {}, "text": {
                "1": "日本最低",
                "2": "从高到低看各经济体",
                "3": "按高低排列",
                "4": "{min.value.name}垫底，为{min.value}。",
                "5": "{first.name}在{first.year}年最高。",
                "7": "读者想知道哪个经济体最高"}}))
            .unwrap();
        let (page, back) = drafts.scoped(drafts.revised(&answer).unwrap());
        let field = |target: &Target| &drafts.fields.iter().find(|(t, _)| t == target).unwrap().1;
        let hero = Target::HeroLabel {
            claim_id: "c1".into(),
            value_from: "first.value".into(),
        };
        assert_eq!(page[&Target::PageDek], "从高到低看各经济体");
        assert_eq!(page[&Target::Heading(0)], "按高低排列");
        for target in [
            Target::PageTitle,
            Target::Body(0),
            hero.clone(),
            Target::ReaderProblem,
        ] {
            assert_eq!(&page[&target], field(&target), "{target:?}");
        }
        assert_eq!(back.len(), 4, "{back:?}");
        // No field carries the scope: it is the page's own field, not model text.
        assert!(page.values().all(|w| !w.contains("经济体中")));
        // The draft-only answer goes back nowhere.
        let kept = drafts.scoped(
            drafts
                .revised(
                    &ask.check(&json!({"step": "text", "names": {}, "text": {}}))
                        .unwrap(),
                )
                .unwrap(),
        );
        assert!(kept.1.is_empty());
    }

    #[test]
    fn no_relation_drafts_a_ranking_word_on_a_scoped_page() {
        // Every relation's frames and reader fields as the page's lead chart, unscoped and scoped: on a scoped page no
        // draft the superlative check would put back ranks (the claims' own hero and body sentences are not drafts of a frame).
        let (claims, mut charts) = q1();
        let framed = |t: &Target| {
            matches!(
                t,
                Target::PageTitle
                    | Target::PageDek
                    | Target::Heading(_)
                    | Target::Text
                    | Target::ReaderProblem
                    | Target::VisualThesis
                    | Target::Question(_)
            )
        };
        for (relation, view, _) in FRAMES {
            for chart in &mut charts {
                (chart.relation, chart.view) = (relation, view);
            }
            let plain = draft(&claims, &charts, q1_numbers());
            assert_eq!(plain.clone().with_scopes(&[None]), plain);
            let scoped = plain.clone().with_scopes(&[Some(by_population())]);
            for ((target, before), (_, after)) in plain.fields.iter().zip(&scoped.fields) {
                if !framed(target) {
                    assert_eq!(before, after, "{relation:?} {view:?} {target:?}");
                    continue;
                }
                let ranks = |text: &str| SUPERLATIVES.iter().any(|w| text.contains(w));
                assert!(!ranks(after), "{relation:?} {view:?} {target:?}: {after}");
                // Only a ranking draft changes, and its scoped form keeps the frame rules.
                assert_eq!(
                    before != after,
                    ranks(before),
                    "{relation:?} {view:?} {target:?}"
                );
                let clean = typed_numbers(after).is_empty() && worded_number(after).is_none();
                assert!(clean && placeholders(after).unwrap().is_empty(), "{after}");
            }
            let questions: std::collections::BTreeSet<&String> = scoped
                .fields
                .iter()
                .filter(|(t, _)| matches!(t, Target::Question(_)))
                .map(|(_, q)| q)
                .collect();
            assert_eq!(questions.len(), 3, "{relation:?} {view:?}");
        }
        // Every scoped wording is some draft's.
        let drafts: Vec<&str> = FRAMES
            .iter()
            .flat_map(|(_, _, f)| f.iter().copied())
            .chain(CONCEPTS.iter().flat_map(|c| {
                [c.reader_problem, c.visual_thesis]
                    .into_iter()
                    .chain(c.questions)
            }))
            .collect();
        assert!(SCOPED_WORDS.iter().all(|(d, _)| drafts.contains(d)));
    }

    #[test]
    fn with_no_scope_the_page_is_the_reworded_fields_as_before() {
        let (claims, charts) = q1();
        let plain = draft(&claims, &charts, q1_numbers());
        let unscoped = plain.clone().with_scopes(&[None]);
        assert_eq!(unscoped, plain);
        assert_eq!(plain.clone().with_scopes(&[]), plain);
        let answer = plain
            .ask(Vec::new())
            .check(&json!({"step": "text", "names": {}, "text": {"1": "日本最低", "7": "读者想知道哪个经济体最高"}}))
            .unwrap();
        let revised = plain.revised(&answer).unwrap();
        assert_eq!(plain.scoped(revised.clone()), (revised, Vec::new()));
    }
}

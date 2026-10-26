//! Flow side, page step 1 (the fourth model ask): the program drafts every page field from the picked claims and the charts
//! they share (the Chinese frames of shape_registry), the model only rewrites the wording (Ask::Text: same placeholders, no
//! number in words, and no typed number but the time values the page draws, such as the year of a claim's row). Where a
//! number may stand follows the design pack: a chart's takeaway and title are checked as having no rows, so they are never
//! drafted here (the pack keeps the claim's own sentence); a chart module's body carries that chart's row placeholders;
//! the page's one hero_stat is the first picked claim that shows one value of its own (the claim that answers the question),
//! its number by value_from, and a claim with neither a body sentence nor the hero is unplaced. The drafts of page title, dek, chart headings and the text module carry neither placeholder nor number. The
//! design pack's reader fields (reader problem, visual thesis, three candidate questions) are drafted from the lead chart's
//! concept (shape_registry CONCEPTS) and reworded in the same ask, under the same rules. Pure.
//!
//! Left for the wiring (not done here): a wording refused REFUSED_ROUNDS times goes back to the draft for the refused field
//! only, the other revised fields kept, and the fallback is written as one program event; with slots, an empty answer
//! fails the names check, so the fallback path fills the names on its own. A hero label is still the claim's English
//! template with its value cut out, so a fallback there would put English on the page. A rank body sentence reads
//! {max.*}/{min.*} of the whole chart: only on a one-period ranking or map; on a chart over years it goes to a hero or
//! unplaced.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::next_flow::{number_not_allowed, placeholders, worded_number, Ask, Choice};
use crate::shape_registry::{Concept, Relation, BODY_SENTENCES, CONCEPTS, FRAMES};

/// A picked, verified claim: its candidate sheet kind and its template (placeholders over its own one-row SQL).
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub id: String,
    pub kind: String,
    pub template: String,
}

/// One chart of the sheet: the claims drawn on it and the row columns its template reads.
#[derive(Clone, Debug, PartialEq)]
pub struct Chart {
    pub relation: Relation,
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
    HeroLabel { claim_id: String, value_from: String },
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

fn frames(relation: Relation) -> [&'static str; 4] {
    FRAMES.iter().find(|(r, _)| *r == relation).expect("every relation has frames").1
}

pub fn concept(relation: Relation) -> &'static Concept {
    CONCEPTS.iter().find(|c| c.relation == relation).expect("every relation has a concept")
}

/// The numbers a wording may type: the time values this page draws, that is the TIME_COLUMNS of each picked claim's own
/// row and the time values of the rows on its charts, kept when they are numbers only (a year "2023", not "2023-Q1").
/// No other label and no member count: a year the data does not hold, or "27", stays a number no data gave. Sorted, no
/// repeats.
pub fn allowed_numbers(claim_rows: &[Value], chart_times: &[String]) -> Vec<String> {
    let claim_times = claim_rows.iter().flat_map(|row| {
        TIME_COLUMNS.iter().filter_map(move |column| match &row[*column] {
            Value::String(time) => Some(time.clone()),
            Value::Number(time) => time.as_u64().map(|t| t.to_string()),
            _ => None,
        })
    });
    let mut out: Vec<String> = claim_times
        .chain(chart_times.iter().cloned())
        .filter(|time| !time.is_empty() && time.chars().all(|c| c.is_ascii_digit()))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The page fields the program drafted, numbered "1".. in order.
#[derive(Clone, Debug, PartialEq)]
pub struct Drafts {
    pub fields: Vec<(Target, String)>,
    /// allowed_numbers of the page.
    pub numbers: Vec<String>,
    /// Claims that got no field: no body sentence for the kind and no single value placeholder for a hero (the pack's own
    /// sentence still stands as the chart's takeaway).
    pub unplaced: Vec<String>,
    /// The Text slots: per chart its measure, with the catalogue title the Chinese name is made from.
    pub slots: Vec<(Target, String)>,
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

/// The template with its value placeholder taken out, for the hero label (the model rewrites the wording).
fn hero_label(template: &str, value_from: &str) -> String {
    let cut = template.replace(&format!("{{{value_from}}}"), "");
    let words: Vec<&str> = cut.split_whitespace().collect();
    words.join(" ").replace(" .", ".").replace(" :", ":").replace(" ,", ",").replace(":.", ".")
}

/// Drafts every page field from the picked claims and the sheet's charts. A claim on no chart gets no field.
pub fn draft(claims: &[Claim], charts: &[Chart], numbers: Vec<String>) -> Drafts {
    let lead = charts.first().map_or(Relation::Ranking, |c| c.relation);
    let mut fields = vec![
        (Target::PageTitle, frames(lead)[0].to_string()),
        (Target::PageDek, frames(lead)[1].to_string()),
    ];
    // The page's one hero: the first picked claim (the one that answers the question) that shows one value of its own.
    let hero = claims.iter().find_map(|claim| {
        let chart = charts.iter().find(|c| c.claim_ids.contains(&claim.id))?;
        hero_value(&claim.template, &chart.category).map(|value_from| (claim, value_from))
    });
    let mut heroes = Vec::new();
    let mut unplaced = Vec::new();
    for (i, chart) in charts.iter().enumerate() {
        fields.push((Target::Heading(i), frames(chart.relation)[2].to_string()));
        let mut body = Vec::new();
        for claim in claims.iter().filter(|c| chart.claim_ids.contains(&c.id)) {
            if let Some((_, value_from)) = hero.as_ref().filter(|(h, _)| h.id == claim.id) {
                let label = hero_label(&claim.template, value_from);
                heroes.push((Target::HeroLabel { claim_id: claim.id.clone(), value_from: value_from.clone() }, label));
            } else if let Some((_, sentence)) = BODY_SENTENCES.iter().find(|(kind, _)| *kind == claim.kind) {
                body.push(sentence.replace("{v}", &chart.value).replace("{c}", &chart.category));
            } else {
                unplaced.push(claim.id.clone());
            }
        }
        if !body.is_empty() {
            fields.push((Target::Body(i), body.concat()));
        }
    }
    fields.extend(heroes);
    fields.push((Target::Text, frames(lead)[3].to_string()));
    let reader = concept(lead);
    fields.push((Target::ReaderProblem, reader.reader_problem.to_string()));
    fields.push((Target::VisualThesis, reader.visual_thesis.to_string()));
    fields.extend(reader.questions.iter().enumerate().map(|(i, q)| (Target::Question(i), q.to_string())));
    Drafts { fields, numbers, unplaced, slots: Vec::new() }
}

impl Drafts {
    fn number(i: usize) -> String {
        (i + 1).to_string()
    }

    /// One slot per chart for its measure's Chinese name, made from the chart's table title (sheet order).
    pub fn name_measures(mut self, titles: &[String]) -> Self {
        self.slots = titles.iter().enumerate().map(|(i, title)| (Target::Measure(i), title.clone())).collect();
        self
    }

    /// The slot ids, as the ask and the answer's `names` know them.
    pub fn slot_ids(&self) -> Vec<String> {
        (0..self.slots.len()).map(|i| format!("s{}", i + 1)).collect()
    }

    /// The fourth ask: every drafted field by number, and the slots still needing a Chinese name.
    pub fn ask(&self, slots: Vec<String>) -> Ask {
        Ask::Text {
            fields: self.fields.iter().enumerate().map(|(i, (_, text))| (Self::number(i), text.clone())).collect(),
            slots,
            numbers: self.numbers.clone(),
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
            .map(|(i, (target, draft))| (target.clone(), text.get(&Self::number(i)).unwrap_or(draft).clone()))
            .collect();
        // A slot the answer left unnamed stays out: its catalogue title is not a Chinese name.
        let named: Vec<(Target, String)> = self
            .slot_ids()
            .iter()
            .zip(&self.slots)
            .filter_map(|(id, (target, _))| names.get(id).map(|name| (target.clone(), name.trim().to_string())))
            .collect();
        // Ask::check already holds both rules; a second look here keeps a choice from another ask off the page.
        for (target, wording) in &out {
            let draft = &self.fields.iter().find(|(t, _)| t == target).expect("drafted").1;
            if placeholders(wording) != placeholders(draft)
                || number_not_allowed(wording, &self.numbers).is_some()
                || worded_number(wording).is_some()
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
        let claim = |id: &str, kind: &str, template: &str| Claim { id: id.into(), kind: kind.into(), template: template.into() };
        (
            vec![
                claim("c1", "rank_top", "{first.name} has the highest OBS VALUE in {first.year}: {first.value}."),
                claim("c2", "rank_bottom", "{first.name} has the lowest OBS VALUE in {first.year}: {first.value}."),
                claim("c3", "extreme_gap", "The gap between the highest and the lowest OBS VALUE in {first.year} is {first.gap}."),
            ],
            vec![Chart {
                relation: Relation::Ranking,
                claim_ids: vec!["c1".into(), "c2".into(), "c3".into()],
                category: "name".into(),
                value: "value".into(),
            }],
        )
    }

    /// q1's page: the three claims' rows are 2025, and so is every row of the one-year ranking (the table holds 2015..2025).
    fn q1_numbers() -> Vec<String> {
        let row = json!({"name": "DE", "value": 65.4, "year": "2025"});
        allowed_numbers(&[row.clone(), row, json!({"gap": 50.5, "year": 2025})], &vec!["2025".to_string(); 27])
    }

    #[test]
    fn allowed_numbers_are_the_time_values_the_page_draws() {
        assert_eq!(q1_numbers(), ["2025"]);
        // A change claim's from/to years and a chart over years; a non-number time label and a value column stay out.
        let change = json!({"name": "DE", "from_year": 2015, "to_year": "2025", "from_value": 30, "to_value": 60});
        let times: Vec<String> = ["2015", "2020", "2025", "2025-Q1", ""].map(String::from).to_vec();
        assert_eq!(allowed_numbers(&[change], &times), ["2015", "2020", "2025"]);
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
                &Target::HeroLabel { claim_id: "c1".into(), value_from: "first.value".into() },
                &Target::Text,
                &Target::ReaderProblem,
                &Target::VisualThesis,
                &Target::Question(0),
                &Target::Question(1),
                &Target::Question(2),
            ]
        );
        let field = |target: &Target| &drafts.fields.iter().find(|(t, _)| t == target).unwrap().1;
        assert_eq!(field(&Target::Body(0)), "{min.value.name}最低，为{min.value}。");
        assert_eq!(
            field(&Target::HeroLabel { claim_id: "c1".into(), value_from: "first.value".into() }),
            "{first.name} has the highest OBS VALUE in {first.year}."
        );
        // No draft holds a typed number; only the body and the hero carry placeholders.
        for (target, text) in &drafts.fields {
            assert!(typed_numbers(text).is_empty() && worded_number(text).is_none(), "{target:?}");
            let carries = !placeholders(text).unwrap().is_empty();
            assert_eq!(carries, matches!(target, Target::Body(_) | Target::HeroLabel { .. }), "{target:?}");
        }
    }

    #[test]
    fn every_relation_has_number_free_frames() {
        for relation in crate::shape_registry::RELATIONS {
            for frame in frames(relation) {
                let clean = typed_numbers(frame).is_empty() && worded_number(frame).is_none();
                assert!(clean && placeholders(frame).unwrap().is_empty(), "{frame}");
            }
            // The text module tells how to read the chart, never why.
            assert!(!["因为", "由于", "原因", "导致"].iter().any(|w| frames(relation)[3].contains(w)), "{relation:?}");
        }
        // The reader-field drafts too, and a concept's three questions differ (the pack needs three distinct).
        for relation in crate::shape_registry::RELATIONS {
            let reader = concept(relation);
            for text in [reader.reader_problem, reader.visual_thesis].iter().chain(reader.questions.iter()) {
                let clean = typed_numbers(text).is_empty() && worded_number(text).is_none();
                assert!(clean && placeholders(text).unwrap().is_empty(), "{text}");
            }
            let distinct: std::collections::BTreeSet<&str> = reader.questions.into_iter().collect();
            assert_eq!(distinct.len(), 3, "{relation:?}");
            // The design record is English with no number either.
            for text in [reader.premise, reader.metaphor, reader.hero_scene, reader.why_memorable] {
                assert!(typed_numbers(text).is_empty() && text.is_ascii(), "{text}");
            }
            assert!(!reader.media.is_empty());
        }
        for (kind, sentence) in BODY_SENTENCES {
            let filled = sentence.replace("{v}", "value").replace("{c}", "name");
            assert!(typed_numbers(&filled).is_empty() && worded_number(&filled).is_none(), "{kind}");
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
        let heroes: Vec<&Target> = drafts.fields.iter().map(|(t, _)| t).filter(|t| matches!(t, Target::HeroLabel { .. })).collect();
        assert_eq!(heroes, [&Target::HeroLabel { claim_id: "c2".into(), value_from: "first.value".into() }]);
    }

    #[test]
    fn more_fewer_or_typed_numbers_are_refused_and_a_kept_set_goes_on_the_page() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, q1_numbers());
        let ask = drafts.ask(vec![]);
        let answer = |n: &str, wording: &str| json!({"step": "text", "text": {n: wording}, "names": {}});
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
        assert!(page.contains_key(&Target::HeroLabel { claim_id: "c1".into(), value_from: "first.value".into() }));
    }

    #[test]
    fn numbers_no_data_gave_are_refused_and_words_pass() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, q1_numbers());
        let ask = drafts.ask(vec![]);
        let title = |wording: &str| ask.check(&json!({"step": "text", "text": {"1": wording}, "names": {}}));
        // The year the page draws is the data's own: allowed as typed.
        for ok in ["2025 年谁领先", "欧盟各国，2025 年", "第一名与末名", "统一口径下谁领先"] {
            assert!(title(ok).is_ok(), "{ok}");
        }
        // Any other number is one no data gave, even a year the table holds but the page does not draw, or the EU's
        // member count: refused, with the allowed list in the reply.
        for typed in ["2023 年谁领先", "2030 年谁领先", "2015 至 2025 年", "欧盟 27 国谁领先", "第1名与末名", "前３名", "相差50.5"] {
            let refused = title(typed).unwrap_err();
            assert!(refused.problem.contains("not in the allowed numbers"), "{typed}");
            assert_eq!(refused.allowed["numbers"], json!(q1_numbers()));
        }
        // A year that matters is the claim's own placeholder: the hero label keeps {first.year}.
        assert!(ask.check(&json!({"step": "text", "text": {"5": "{first.name}在{first.year}年最高"}, "names": {}})).is_ok());
        // Refused twice, the run goes on with the drafts: an empty revision is a valid answer.
        let kept = drafts.revised(&ask.check(&json!({"step": "text", "text": {}, "names": {}})).unwrap()).unwrap();
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
        assert!(drafts.revised(&Choice::Search { query: "x".into() }).is_err());
    }

    #[test]
    fn a_measure_slot_is_named_by_the_answer_or_left_out() {
        let (claims, charts) = q1();
        let drafts = draft(&claims, &charts, q1_numbers()).name_measures(&["Share of renewable energy".to_string()]);
        assert_eq!(drafts.slot_ids(), ["s1"]);
        let ask = drafts.ask(drafts.slot_ids());
        let named = ask.check(&json!({"step": "text", "text": {}, "names": {"s1": " 可再生能源占比 "}})).unwrap();
        assert_eq!(drafts.revised(&named).unwrap().get(&Target::Measure(0)).map(String::as_str), Some("可再生能源占比"));
        assert!(ask.check(&json!({"step": "text", "text": {}, "names": {}})).is_err(), "the slot is required");
        let unnamed = Choice::Text { text: BTreeMap::new(), names: BTreeMap::new() };
        assert!(!drafts.revised(&unnamed).unwrap().contains_key(&Target::Measure(0)), "no catalogue title as the name");
    }
}

//! Flow side, page step 1 (the fourth model ask): the program drafts every page field from the picked claims and the charts
//! they share (the Chinese frames of shape_registry), the model only rewrites the wording (Ask::Text: same placeholders, no
//! number in words, and no typed number but the time values the page draws, such as the year of a claim's row). Where a
//! number may stand follows the design pack: a chart's takeaway and title are checked as having no rows, so they are never
//! drafted here (the pack keeps the claim's own sentence); a chart module's body carries that chart's row placeholders;
//! the page's one hero_stat is the first picked claim that shows one value of its own (the claim that answers the question),
//! its number by value_from, and a claim with neither a body sentence nor the hero is unplaced. The drafts of page title, chart
//! headings and the text module carry neither placeholder nor number; the title is a label, and a reworded title that asks
//! is refused (Drafts::titles, next_flow TITLE_RULE). The dek is the frame's until the run gives the page's finding
//! (with_finding: one sentence on the picked recipe's own facts, its numbers and names placeholders the program fills). The
//! design pack's reader fields (reader problem, visual thesis, three candidate questions) are drafted from the lead chart's
//! concept (shape_registry CONCEPTS; the lead is the first chart the page draws a card for, so these and the page title,
//! dek and text never describe a chart left off the page) and reworded in the same ask, under the same rules. A leaf page
//! whose bars draw the change between its two ends gives its own form instead (draft_for, from next_run's pick of the
//! recipe), so its title names a change, and a reworded title that asks a level there is refused (Drafts::change_title). Pure.
//!
//! Left for the wiring (not done here): a wording refused REFUSED_ROUNDS times goes back to the draft for the refused field
//! only, the other revised fields kept, and the fallback is written as one program event; with slots, an empty answer
//! fails the names check, so the fallback path fills the names on its own. A hero label is still the claim's English
//! template with its value cut out, so a fallback there would put English on the page. A rank body sentence reads
//! {max.*}/{min.*} of the whole chart: only on a one-period ranking or map; on a chart over years it goes to a hero or
//! unplaced.

use std::collections::BTreeMap;

use crate::next_flow::{
    change_word, level_question, number_not_allowed, place_count_free, placeholders, question_word, unanswered_word, worded_number,
    year_after_fact_period, year_after_period, Ask, Choice,
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
/// so the text check refuses a reworded field that holds one (next_flow SCOPE_RULE); the draft stands under the scope fields.
pub const SUPERLATIVES: [&str; 7] = ["最高", "最低", "领先", "垫底", "第一", "最多", "最少"];

/// How the program chose a chart's places (a World Bank table narrowed by wb-rank-by.json, a Eurostat table cut to the top
/// codes of its open dimension, estat-narrow.json's words): its own page field (the kicker and the chart's eyebrow), never
/// model text, so the model can neither drop nor change it. `text` names the count of places the narrow record keeps;
/// `record` is that record (data/origins), the field's source.
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
    /// Some chart of the page has a Scope: a reworded field that ranks is refused (Ask::Text scoped, Drafts::scoped).
    pub has_scope: bool,
    /// The words a scoped draft holds its ranking under (with_scope_mark: the finding's set phrase, shape_registry
    /// DEK_FINDINGS scoped "{name}{set}增幅最大"): 最大 and 居首 are no SUPERLATIVES word (the rules suggest them), so a
    /// reworded field whose draft holds the phrase keeps it, or it would say the place leads among all places (next_flow
    /// Ask::Text mark). None on a page with no scope or no finding.
    pub scope_mark: Option<String>,
    /// The page-level fields speak for the first-to-last change (draft_for): a reworded title that asks a level with no
    /// change word is refused (Ask::Text changes, next_flow level_question).
    pub change_title: bool,
    /// The page draws one period's levels (a ranking or a map, draft_for) of a measure that is no change itself
    /// (measures_a_change): a reworded title that names a change (next_flow change_word) is refused (Ask::Text levels).
    pub level_title: bool,
    /// The number of distinct places the page draws (next_run places_drawn: the place codes of its drawn rows): a count of
    /// places of that number (四国) is no typed number on the text step (Ask::Text places). None when the run does not know it.
    pub places_drawn: Option<usize>,
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

/// draft with the page-level fields (title, dek, text, reader fields) drafted for `form`: the form the page's main chart
/// draws when the run knows it (a leaf page whose bars draw the change between its two ends), else the lead chart's; none,
/// the ranking's. A page of the first-to-last change gets its change_title.
pub fn draft_for(
    claims: &[Claim],
    charts: &[Chart],
    numbers: Vec<String>,
    form: Option<(Relation, View)>,
) -> Drafts {
    let lead = form.unwrap_or((Relation::Ranking, View::Slice));
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
        scope_mark: None,
        change_title: lead == (Relation::Change, View::FirstToLast),
        level_title: crate::shape_registry::LEVEL_LEADS.contains(&lead),
        places_drawn: None,
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

    /// The dek drafted as the page's finding (next_run finding_of: the sentence on the picked recipe's own facts, unscoped and
    /// scoped) in place of the frame's, its scoped wording on a scoped page; so it follows with_scopes. None (no recipe
    /// picked, or its facts give no finding) keeps the frame's dek.
    pub fn with_finding(mut self, finding: Option<(String, String)>) -> Self {
        if let Some((plain, scoped)) = finding {
            let dek = if self.has_scope { scoped } else { plain };
            for (target, text) in &mut self.fields {
                if *target == Target::PageDek {
                    *text = dek.clone();
                }
            }
        }
        self
    }

    /// The scope phrase the finding's scoped wording holds (next_run: the fill's finding set, the registry's words with the
    /// count a fact placeholder), on a scoped page only; so it follows with_scopes.
    /// A measure that is itself a change (a growth rate, a change from a base year: the run's measures_a_change) may be
    /// ranked under a change word (增速最高), so its title is no level title.
    pub fn measuring_a_change(mut self, change: bool) -> Self {
        self.level_title &= !change;
        self
    }

    pub fn with_scope_mark(mut self, mark: Option<String>) -> Self {
        self.scope_mark = mark.filter(|m| self.has_scope && !m.is_empty());
        self
    }

    /// The revised fields, each whose wording differs from its draft and holds a SUPERLATIVES word, or drops the scope_mark
    /// its draft holds, the draft's again when the page is scoped; returns the fields that went back. The text check refuses such a wording first (Ask::Text scoped),
    /// so after it this finds none: a guard only, its put-back recorded (SCOPE_FALLBACK_EVENT). With no scope, as given.
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
                let unmarked = self.scope_mark.as_deref().is_some_and(|m| draft.contains(m) && !wording.contains(m));
                let bare = self.scope_mark.as_deref().map_or(wording.clone(), |m| wording.replace(m, ""));
                if wording != draft && (unmarked || SUPERLATIVES.iter().any(|w| bare.contains(w))) {
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
            changes: self.changes(),
            levels: self.levels(),
            scoped: self.scoped_fields(),
            titles: self.titles(),
            mark: self.scope_mark.clone().unwrap_or_default(),
            places: self.places_drawn,
        }
    }

    /// The number of the page title's field, which takes a label or a conclusion, never a question.
    fn titles(&self) -> Vec<String> {
        self.fields
            .iter()
            .position(|(t, _)| *t == Target::PageTitle)
            .map(Self::number)
            .into_iter()
            .collect()
    }

    /// The numbers of the fields a ranking word may not enter reworded: every field on a scoped page, else none.
    fn scoped_fields(&self) -> Vec<String> {
        if self.has_scope {
            (0..self.fields.len()).map(Self::number).collect()
        } else {
            Vec::new()
        }
    }

    /// The numbers of the fields that may not name a change: the title's on a level_title page, else none.
    fn levels(&self) -> Vec<String> {
        self.fields
            .iter()
            .position(|(t, _)| self.level_title && *t == Target::PageTitle)
            .map(Self::number)
            .into_iter()
            .collect()
    }

    /// The numbers of the fields that state a change: the title's on a change_title page, else none.
    fn changes(&self) -> Vec<String> {
        self.fields
            .iter()
            .position(|(t, _)| self.change_title && *t == Target::PageTitle)
            .map(Self::number)
            .into_iter()
            .collect()
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
                // a count of the places the page draws passed the check (place_count_free): the same count passes here
                || worded_number(&place_count_free(wording, self.places_drawn)).is_some()
                || unanswered_word(wording).is_some()
                || (!self.periods.is_empty() && year_after_period(wording).is_some())
                || year_after_fact_period(wording).is_some()
                || (self.change_title
                    && *target == Target::PageTitle
                    && level_question(wording).is_some())
                || (self.level_title && *target == Target::PageTitle && change_word(wording).is_some())
                || (*target == Target::PageTitle && question_word(wording).is_some())
            {
                return Err(format!("{target:?}: the wording does not keep the draft's placeholders, types a number not allowed, asks a level on a change page or titles the page with a question"));
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
    use crate::shape_registry::DEK_FINDINGS;
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
            // the change rule's own examples are offered only on a change page; this one ranks one period
            let offered = !crate::next_flow::CHANGE_TITLE_RULE.contains(suggested);
            assert!(!offered || field(suggested).is_ok(), "{suggested}");
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
            "2025 年北欧领先",
            "欧盟各国，2025 年",
            "第一名与末名",
            "统一口径下北欧领先",
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
        // a count of places the check let through (the page draws that many) is kept by the recheck; any other is refused
        let counted = |n: Option<usize>| {
            let mut d = draft(&claims, &charts, q1_numbers());
            d.places_drawn = n;
            d.revised(&Choice::Text {
                text: BTreeMap::from([("1".to_string(), "四国对比".to_string())]),
                names: BTreeMap::new(),
            })
        };
        assert!(counted(Some(4)).is_ok());
        assert!(counted(Some(3)).is_err());
        assert!(counted(None).is_err());
    }

    /// Plan v4 item 7: a ranking (or a map) of one period's levels drafts a level title, whose reworded title may not name a
    /// change (the ask lists it in `levels`, revised refuses a choice that skipped the check); a ranking of a measure that
    /// is itself a change (measuring_a_change) and a page of the first-to-last change draft none.
    #[test]
    fn a_level_page_refuses_a_change_title_unless_its_measure_is_a_change() {
        let (claims, charts) = q1();
        let level = draft_for(&claims, &charts, Vec::new(), Some((Relation::Ranking, View::Slice)));
        assert!(level.level_title && !level.change_title);
        let Ask::Text { levels, .. } = level.ask(vec![]) else { unreachable!() };
        assert_eq!(levels, ["1"]);
        let revise = |d: &Drafts, t: &str| {
            d.revised(&Choice::Text { text: BTreeMap::from([("1".to_string(), t.to_string())]), names: BTreeMap::new() })
        };
        assert!(revise(&level, "各国排放的水平与变化").is_err());
        assert!(revise(&level, "各国排放量排名").is_ok());
        let growth = level.clone().measuring_a_change(true);
        assert!(!growth.level_title && revise(&growth, "各国经济增速排名").is_ok());
        let change = draft_for(&claims, &charts, Vec::new(), Some((Relation::Change, View::FirstToLast)));
        assert!(!change.level_title);
        assert!(draft_for(&claims, &charts, Vec::new(), Some((Relation::Map, View::Slice))).level_title);
    }

    /// q1's and q6's stand-in pages: the bars drew each place's change between two ends, the title asked who is highest.
    /// Drafted for the first-to-last change, the page-level fields are that frame's and concept's; a reworded title that asks
    /// a level is refused with the allowed values (the drafts and the change words) and the rule's example, one that names
    /// the change as a label or a conclusion passes and one that asks it is refused; revised refuses the level title and the
    /// question title of a choice that skipped the check.
    #[test]
    fn a_change_page_drafts_a_change_title_and_refuses_a_level_reword() {
        let (claims, charts) = q1();
        let drafts = draft_for(
            &claims,
            &charts,
            Vec::new(),
            Some((Relation::Change, View::FirstToLast)),
        );
        let field = |target: &Target| &drafts.fields.iter().find(|(t, _)| t == target).unwrap().1;
        let change = frames(Relation::Change, View::FirstToLast);
        assert_eq!(field(&Target::PageTitle), change[0]);
        assert_eq!(field(&Target::PageDek), change[1]);
        assert_eq!(field(&Target::Text), change[3]);
        let reader = concept(Relation::Change, View::FirstToLast);
        assert_eq!(field(&Target::ReaderProblem), reader.reader_problem);
        assert_eq!(field(&Target::Question(0)), reader.questions[0]);
        // the chart's own heading is still the ranking chart's
        assert_eq!(field(&Target::Heading(0)), frames(Relation::Ranking, View::Slice)[2]);
        assert!(drafts.change_title);
        let ask = drafts.ask(vec![]);
        let title = |wording: &str| {
            ask.check(&json!({"step": "text", "text": {"1": wording}, "names": {}}))
        };
        for level in [
            "欧盟哪国可再生能源占比最高",
            "哪些国籍的人申请庇护最多",
            "谁领先，谁垫底",
        ] {
            let refused = title(level).unwrap_err();
            assert!(refused.problem.contains("asks a level"), "{level}: {}", refused.problem);
            assert!(
                refused.problem.contains(crate::next_flow::CHANGE_TITLE_RULE),
                "{}",
                refused.problem
            );
            assert_eq!(refused.allowed["text"]["1"], json!(change[0]));
            assert_eq!(refused.allowed["changes"]["fields"], json!(["1"]));
            assert_eq!(refused.example["step"], "text");
        }
        for names_a_change in [
            "欧盟各国可再生能源占比的变化",
            "北欧国家可再生能源占比升得最多",
            "从起始到最近，庇护申请增加最多的国籍",
            "庇护申请人数的变化",
        ] {
            assert!(title(names_a_change).is_ok(), "{names_a_change}");
        }
        // the stand-ins' change questions name a change and still ask: refused with the word and the change draft as example
        for (asks, word) in [
            ("欧盟各国可再生能源占比变化多大", "多大"),
            ("哪国可再生能源占比升得最多", "哪"),
            ("从起始到最近，谁的庇护申请增加最多", "谁"),
        ] {
            let refused = title(asks).unwrap_err();
            assert!(refused.problem.starts_with(&format!("field '1': '{word}' makes it a question; ")), "{}", refused.problem);
            assert!(refused.problem.ends_with(&format!(", e.g. '{}'", change[0])), "{}", refused.problem);
            assert_eq!(refused.allowed["titles"]["fields"], json!(["1"]));
        }
        // each wording the rules suggest passes here too, the change rule's examples among them
        for suggested in crate::next_flow::RULE_SUGGESTIONS {
            assert!(title(suggested).is_ok(), "{suggested}");
        }
        // only the title states the change: the dek and the reader questions may still say who is highest
        assert!(ask
            .check(&json!({"step": "text", "text": {"2": "哪国最高"}, "names": {}}))
            .is_ok());
        let unchecked = Choice::Text {
            text: BTreeMap::from([("1".to_string(), "哪国可再生能源占比最高".to_string())]),
            names: BTreeMap::new(),
        };
        assert!(drafts.revised(&unchecked).is_err());
        let asked = Choice::Text {
            text: BTreeMap::from([("1".to_string(), "哪国可再生能源占比升得最多".to_string())]),
            names: BTreeMap::new(),
        };
        assert!(drafts.revised(&asked).is_err());
        let worded = Choice::Text {
            text: BTreeMap::from([("1".to_string(), "北欧国家可再生能源占比升得最多".to_string())]),
            names: BTreeMap::new(),
        };
        assert_eq!(
            drafts.revised(&worded).unwrap()[&Target::PageTitle],
            "北欧国家可再生能源占比升得最多"
        );
    }

    /// A page of one year (the column page) is drafted for its lead ranking as before: the level frame, and a title that
    /// says who is highest passes; one that asks it is refused, as on every page.
    #[test]
    fn a_level_page_keeps_the_level_frame_and_a_title_that_says_who_is_highest() {
        let (claims, charts) = q1();
        for drafts in [
            draft(&claims, &charts, Vec::new()),
            draft_for(&claims, &charts, Vec::new(), lead(&charts)),
        ] {
            assert_eq!(drafts.fields[0], (Target::PageTitle, frames(Relation::Ranking, View::Slice)[0].to_string()));
            assert!(!drafts.change_title);
            let ask = drafts.ask(vec![]);
            assert!(ask
                .check(&json!({"step": "text", "text": {"1": "瑞典可再生能源占比在欧盟最高"}, "names": {}}))
                .is_ok());
            assert!(ask
                .check(&json!({"step": "text", "text": {"1": "欧盟哪国可再生能源占比最高"}, "names": {}}))
                .unwrap_err()
                .problem
                .starts_with("field '1': '哪' makes it a question; "));
            assert!(ask
                .check(&json!({"step": "text", "text": {"1": "2030年谁最高"}, "names": {}}))
                .unwrap_err()
                .allowed
                .get("changes")
                .is_none());
        }
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

    /// Fields where the model ranked (title, body, hero, a reader field), each with the SUPERLATIVES word the refusal names.
    const RANKED: [(&str, &str, &str); 4] = [
        ("1", "日本最低", "最低"),
        ("4", "{min.value.name}垫底，为{min.value}。", "垫底"),
        ("5", "{first.name}在{first.year}年最高。", "最高"),
        ("7", "读者想知道哪个经济体最高", "最高"),
    ];

    #[test]
    fn on_a_scoped_page_a_reworded_field_that_ranks_keeps_its_draft() {
        let (claims, charts) = q1();
        let drafts =
            draft(&claims, &charts, q1_numbers()).with_scopes(&[None, Some(by_population())]);
        assert!(drafts.has_scope);
        let ask = drafts.ask(Vec::new());
        let one = |n: &str, wording: &str| json!({"step": "text", "names": {}, "text": {n: wording}});
        // Refused at the check, so the model words it again: the field, the word, the rule and its example are said.
        for (n, wording, word) in RANKED {
            let refused = ask.check(&one(n, wording)).unwrap_err();
            assert!(
                refused.problem.starts_with(&format!("field '{n}': '{word}' ranks; ")),
                "{n}: {}",
                refused.problem
            );
            assert!(refused.problem.contains(crate::next_flow::SCOPE_RULE), "{}", refused.problem);
            assert!(refused.problem.contains("'各地的高低分布'"), "{}", refused.problem);
        }
        // The rule's example passes on the same page, and so does every field as drafted (the body's draft ranks).
        assert!(ask.check(&one("1", "各地的高低分布")).is_ok());
        for (i, (_, text)) in drafts.fields.iter().enumerate() {
            let n = (i + 1).to_string();
            assert!(ask.check(&one(&n, text)).is_ok(), "{n}: {text}");
        }
        // An accepted answer that rewords without ranking goes on the page whole: the guard puts back nothing.
        let answer = ask
            .check(&json!({"step": "text", "names": {}, "text": {
                "1": "各地的高低分布",
                "2": "从高到低看各经济体",
                "3": "按高低排列"}}))
            .unwrap();
        let (page, back) = drafts.scoped(drafts.revised(&answer).unwrap());
        assert!(back.is_empty(), "{back:?}");
        assert_eq!(page[&Target::PageTitle], "各地的高低分布");
        assert_eq!(page[&Target::PageDek], "从高到低看各经济体");
        assert_eq!(page[&Target::Heading(0)], "按高低排列");
        // No field carries the scope: it is the page's own field, not model text.
        assert!(page.values().all(|w| !w.contains("经济体中")));
        // The guard still holds for a choice that never passed this check: each ranking field goes back to its draft.
        let unchecked = Choice::Text {
            text: RANKED.iter().map(|(n, w, _)| (n.to_string(), w.to_string())).collect(),
            names: BTreeMap::new(),
        };
        let (page, back) = drafts.scoped(drafts.revised(&unchecked).unwrap());
        let field = |target: &Target| &drafts.fields.iter().find(|(t, _)| t == target).unwrap().1;
        let hero = Target::HeroLabel {
            claim_id: "c1".into(),
            value_from: "first.value".into(),
        };
        for target in [Target::PageTitle, Target::Body(0), hero, Target::ReaderProblem] {
            assert_eq!(&page[&target], field(&target), "{target:?}");
        }
        assert_eq!(back.len(), 4, "{back:?}");
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

    /// Our four stand-in pages titled with a question, from title drafts that asked ("谁领先，谁垫底", "变化多大"). Every
    /// relation's title draft, as the page's form, unscoped and scoped: a label with no number and no placeholder that asks
    /// nothing, ranks nothing on a scoped page and names the change on the first-to-last change; as its own reword it passes
    /// the text check of its page.
    #[test]
    fn every_title_draft_is_a_label_that_passes_the_checks_of_its_page() {
        let (claims, charts) = q1();
        for (relation, view, _) in FRAMES {
            let plain = draft_for(&claims, &charts, Vec::new(), Some((relation, view)));
            for drafts in [plain.clone(), plain.with_scopes(&[Some(by_population())])] {
                let (target, title) = &drafts.fields[0];
                assert_eq!(*target, Target::PageTitle);
                let kind = format!("{relation:?} {view:?} scoped {}: {title}", drafts.has_scope);
                assert_eq!(question_word(title), None, "{kind}");
                assert!(typed_numbers(title).is_empty() && worded_number(title).is_none(), "{kind}");
                assert!(placeholders(title).unwrap().is_empty(), "{kind}");
                assert!(!drafts.change_title || level_question(title).is_none(), "{kind}");
                assert!(!drafts.has_scope || crate::next_flow::ranking_word(title).is_none(), "{kind}");
                let ask = drafts.ask(Vec::new());
                assert!(ask.check(&json!({"step": "text", "text": {"1": title}, "names": {}})).is_ok(), "{kind}");
                // the title field is the one the question check holds, on every page
                let asked = ask.check(&json!({"step": "text", "text": {"1": "占比为什么不同"}, "names": {}})).unwrap_err();
                assert!(asked.problem.starts_with("field '1': '为什么' makes it a question; "), "{kind}: {}", asked.problem);
                assert!(asked.problem.ends_with(&format!(", e.g. '{title}'")), "{kind}: {}", asked.problem);
                assert_eq!(asked.allowed["titles"]["fields"], json!(["1"]), "{kind}");
            }
        }
    }

    /// A narrowed page's set phrase as next_tree_gen fills {set}: wb-rank-by.json's SP.POP.TOTL words, {n} the drawn fact.
    const SET: &str = "在人口最多的{drawn}个经济体中";

    /// The dek a run gives a page (next_run finding_of: DEK_FINDINGS on the picked recipe's own facts) as fill drafts it:
    /// {name} a place's name placeholder, {value} and {gap} facts, {y0} and {y1} facts' periods. Each finding replaces the
    /// frame's dek, its scoped wording on a scoped page; the sentence types no number, names its later year (and a change its
    /// earlier) through a placeholder, says no "从起始到最近" and on a scoped page ranks nothing; kept or reworded with its
    /// placeholders it passes, a reword that drops one, writes 年 after a period, or on a scoped page ranks, drops the page's
    /// set phrase (its scope_mark), says another page's set or types the set's count is refused. None
    /// keeps the frame's dek.
    #[test]
    fn a_finding_is_the_dek_of_its_page_and_keeps_its_placeholders() {
        let (claims, charts) = q1();
        let fill = |template: &str| {
            template
                .replace("{name}", "{name.SE}")
                .replace("{other}", "{name.BE}")
                .replace("{value}", "{lead}")
                .replace("{y0}", "{lead0.t}")
                .replace("{y1}", "{lead1.t}")
                .replace("{set}", SET)
        };
        let dek = |drafts: &Drafts| drafts.fields.iter().find(|(t, _)| *t == Target::PageDek).unwrap().1.clone();
        let plain = draft(&claims, &charts, Vec::new());
        assert_eq!(dek(&plain.clone().with_finding(None)), frames(Relation::Ranking, View::Slice)[1]);
        let one = |n: &str, wording: &str| json!({"step": "text", "names": {}, "text": {n: wording}});
        for (finding, unscoped, scoped) in DEK_FINDINGS {
            // only the tokens finding_of fills, the name, the value and the later year in every sentence
            for template in [unscoped, scoped] {
                let tokens = placeholders(template).unwrap();
                assert!(tokens.iter().all(|t| ["name", "other", "value", "gap", "y0", "y1", "set"].contains(&t.as_str())), "{template}");
                assert!(["name", "value", "y1"].iter().all(|t| tokens.contains(*t)), "{template}");
                let mut both = placeholders(unscoped).unwrap();
                both.insert("set".to_string());
                assert_eq!(both, placeholders(scoped).unwrap(), "{finding:?}: the scoped wording fills the same and the set");
            }
            let finding_of = Some((fill(unscoped), fill(scoped)));
            for drafts in [
                plain.clone().with_finding(finding_of.clone()),
                plain.clone().with_scopes(&[Some(by_population())]).with_finding(finding_of.clone()).with_scope_mark(Some(SET.to_string())),
            ] {
                let said = dek(&drafts);
                assert_eq!(said, if drafts.has_scope { fill(scoped) } else { fill(unscoped) }, "{finding:?}");
                assert!(typed_numbers(&said).is_empty() && worded_number(&said).is_none(), "{said}");
                assert!(!said.contains("从起始到最近") && question_word(&said).is_none(), "{said}");
                assert!(!drafts.has_scope || crate::next_flow::ranking_word(&said.replace(SET, "")).is_none(), "{said}");
                // the dek is field 2
                let ask = drafts.ask(Vec::new());
                assert!(ask.check(&one("2", &said)).is_ok(), "{said}");
                let reworded = format!("据数据，{said}");
                let page = drafts.revised(&ask.check(&one("2", &reworded)).unwrap()).unwrap();
                assert_eq!(page[&Target::PageDek], reworded);
                let doubled = said.replace("{lead1.t}", "{lead1.t}年");
                let refused = ask.check(&one("2", &doubled)).unwrap_err();
                assert!(refused.problem.contains(crate::next_flow::FACT_PERIOD_RULE), "{}", refused.problem);
                let dropped = said.replace("{name.SE}", "瑞典");
                assert!(ask.check(&one("2", &dropped)).unwrap_err().problem.contains("missing: [{name.SE}]"), "{dropped}");
                let ranks = format!("{said}，居欧盟最高");
                assert_eq!(ask.check(&one("2", &ranks)).is_err(), drafts.has_scope, "{ranks}");
                // e3: 增幅最大 and 居首 rank with no SUPERLATIVES word, so a scoped reword that drops the scope's words said the
                // place led among all places: refused with the draft as the example, and put back by the guard unchecked
                assert_eq!(said.contains(SET), drafts.has_scope, "{said}");
                let unmarked = said.replace(SET, "");
                let unmarked_refused = ask.check(&one("2", &unmarked));
                assert_eq!(unmarked_refused.is_err(), drafts.has_scope, "{unmarked}");
                if drafts.has_scope {
                    // another page's set (another registry option's words), or the set's count typed: refused too
                    let other = said.replace(SET, "在经济规模最大的{drawn}个经济体中");
                    assert!(ask.check(&one("2", &other)).unwrap_err().problem.contains("drops"), "{other}");
                    let typed = said.replace("{drawn}", "8");
                    assert!(ask.check(&one("2", &typed)).is_err(), "{typed}");
                    let wrong = said.replace(SET, "在人口最多的{lead}个经济体中");
                    assert!(ask.check(&one("2", &wrong)).is_err(), "{wrong}");
                }
                if let Err(refused) = unmarked_refused {
                    assert!(refused.problem.starts_with(&format!("field '2': drops '{SET}'; ")), "{}", refused.problem);
                    assert!(refused.problem.ends_with(&format!(", e.g. '{said}'")), "{}", refused.problem);
                    let unchecked = Choice::Text { text: BTreeMap::from([("2".to_string(), unmarked.clone())]), names: BTreeMap::new() };
                    // the set's count is a placeholder, so a wording without the set fails revised too (the drafted
                    // placeholders) before the guard; the guard still puts back one that keeps them
                    assert!(drafts.revised(&unchecked).is_err(), "{unmarked}");
                    let kept = format!("{unmarked}（{{drawn}}）");
                    let unchecked = Choice::Text { text: BTreeMap::from([("2".to_string(), kept)]), names: BTreeMap::new() };
                    let (page, back) = drafts.scoped(drafts.revised(&unchecked).unwrap());
                    assert_eq!((page[&Target::PageDek].as_str(), back), (said.as_str(), vec![Target::PageDek]));
                }
            }
        }
    }

    /// The page title's headline (shape_registry HEADLINES, next_run finding_of fills it as the dek's finding): only the
    /// tokens finding_of fills, the place's name in each; filled, it types no number, asks nothing and names no year; it
    /// holds a comparison word or a fact placeholder (a number from the ledger) and a verb, so it states a conclusion, not a
    /// label; its scoped wording names the page's set ({set}) and holds no ranking word, as the scoped dek's.
    #[test]
    fn a_headline_states_its_finding_with_no_typed_number() {
        use crate::shape_registry::HEADLINES;
        let fill = |template: &str| {
            template.replace("{name}", "{name.SE}").replace("{other}", "{name.BE}").replace("{value}", "{lead}").replace("{set}", SET)
        };
        const COMPARES: [&str; 4] = ["最", "比", "倍", "居首"];
        const VERBS: [&str; 6] = ["增", "降", "是", "占", "居首", "比"];
        for (finding, unscoped, scoped) in HEADLINES {
            assert!(DEK_FINDINGS.iter().any(|(f, _, _)| *f == finding), "{finding:?}: a headline says a dek's finding");
            for template in [unscoped, scoped] {
                let tokens = placeholders(template).unwrap();
                assert!(tokens.iter().all(|t| ["name", "other", "value", "times", "set"].contains(&t.as_str())), "{template}");
                assert!(tokens.contains("name"), "{template}");
                let mut both = placeholders(unscoped).unwrap();
                both.extend(tokens.contains("set").then(|| "set".to_string()));
                assert_eq!(both, tokens, "{finding:?}: both wordings fill the same, the scoped one and the set");
                let said = fill(template);
                assert!(typed_numbers(&said).is_empty() && worded_number(&said).is_none(), "{said}");
                assert!(question_word(&said).is_none() && !said.contains('年'), "{said}");
                let numbered = said.contains("{lead}") || said.contains("{times}");
                assert!(numbered || COMPARES.iter().any(|w| said.contains(w)), "{said}: no comparison");
                assert!(VERBS.iter().any(|w| said.contains(w)), "{said}: no verb");
            }
            // the set right after the name, or (a composition's part: the name is a place and its part) before it
            assert!(scoped.contains("{name}{set}") || scoped.starts_with("{set}{name}"), "{scoped}: no doubled 中");
            assert!(crate::next_flow::ranking_word(&fill(scoped).replace(SET, "")).is_none(), "{scoped}");
        }
    }

    #[test]
    fn with_no_scope_the_page_is_the_reworded_fields_as_before() {
        let (claims, charts) = q1();
        let plain = draft(&claims, &charts, q1_numbers());
        let unscoped = plain.clone().with_scopes(&[None]);
        assert_eq!(unscoped, plain);
        assert_eq!(plain.clone().with_scopes(&[]), plain);
        let ask = plain.ask(Vec::new());
        let answer = ask
            .check(&json!({"step": "text", "names": {}, "text": {"1": "日本最低", "7": "读者想知道哪个经济体最高"}}))
            .unwrap();
        let revised = plain.revised(&answer).unwrap();
        assert_eq!(plain.scoped(revised.clone()), (revised, Vec::new()));
        // Every wording a scoped page refuses for ranking passes here, and the ask says no scope rule.
        for (n, wording, _) in RANKED {
            let one = json!({"step": "text", "names": {}, "text": {n: wording}});
            assert!(ask.check(&one).is_ok(), "{n}: {wording}");
        }
        let described = ask.schema()["properties"]["text"]["description"].as_str().unwrap().to_string();
        assert!(!described.contains(crate::next_flow::SCOPE_RULE), "{described}");
    }
}

/// Drafts every page field from the picked claims and the sheet's charts, the page-level fields for the lead chart. A claim
/// on no chart gets no field. The run drafts through draft_for, with the form its picked recipe draws.
#[cfg(test)]
pub fn draft(claims: &[Claim], charts: &[Chart], numbers: Vec<String>) -> Drafts {
    draft_for(claims, charts, numbers, lead(charts))
}

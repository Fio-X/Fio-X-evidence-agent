//! The legal targets a story page may run against (I8): numbers a binding EU act sets for the Union as a whole, read from
//! targets.json and never typed on a page. Each entry names the Eurostat slice that measures it and the source it was read
//! from; the program checks the entry against the stored excerpt of the act before it gives out a row, so a quote, a number
//! or a year that the act does not say stops the registry instead of reaching a page.
//!
//! Pure: the registry and the excerpts are compiled in (include_str), no file or network is read at run time. The rows come
//! out in the one format the flow group hands to its shape judgment as a table: `{src "target:<id>", main, table, dims,
//! time, value}`, the value the number as the act prints it (decimal point), so the ledger's recheck reads it back.

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const TARGETS: &str = include_str!("../runtime/pi/assets/targets.json");

/// The stored excerpts of the acts, by the file name an entry's `source.excerpt` gives.
const EXCERPTS: [(&str, &str); 2] = [
    (
        "32023L2413.txt",
        include_str!("../runtime/pi/assets/target-sources/32023L2413.txt"),
    ),
    (
        "32023L1791.txt",
        include_str!("../runtime/pi/assets/target-sources/32023L1791.txt"),
    ),
];

/// Whether a target is a floor or a ceiling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum Kind {
    #[serde(rename = "at_least")]
    AtLeast,
    #[serde(rename = "at_most")]
    AtMost,
}

/// A table whose rows a target is read against, with the dimensions that fix the measure (geo and time excluded).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Slice {
    pub dataset: String,
    pub dims: BTreeMap<String, String>,
}

/// Where a target was read from.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Source {
    pub act: String,
    pub clause: String,
    pub url: String,
    pub fetched_at: String,
    /// The hash of the full act as fetched; the full file is not kept, so this is provenance, not checked here.
    pub document_sha256: String,
    /// The file name of the stored excerpt of the act (target-sources/).
    pub excerpt: String,
    /// The hash of that excerpt; checked.
    pub excerpt_sha256: String,
    /// The sentence of the act that sets the target, as the excerpt has it.
    pub quote: String,
    /// The words of the sentence that carry the number: "at least 42,5 %", "no more than 763 Mtoe".
    pub value_phrase: String,
}

/// One legal target.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Target {
    pub id: String,
    pub title: String,
    pub slices: Vec<Slice>,
    pub geo: String,
    pub year: i32,
    /// The number as the act prints it, with a decimal point.
    pub value: String,
    pub unit: String,
    pub unit_label: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub source: Source,
}

/// The registry, read once and checked: an Err names the first entry that fails and why.
pub fn targets() -> Result<&'static [Target], String> {
    static T: std::sync::OnceLock<Result<Vec<Target>, String>> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        #[derive(Deserialize)]
        struct File {
            targets: Vec<Target>,
        }
        let file: File = serde_json::from_str(TARGETS).map_err(|e| format!("targets.json: {e}"))?;
        check_registry(&file.targets, &|name| {
            EXCERPTS.iter().find(|(n, _)| *n == name).map(|(_, t)| *t)
        })?;
        Ok(file.targets)
    })
    .as_ref()
    .map(|v| v.as_slice())
    .map_err(|e| e.clone())
}

/// The target rows of the registry for `main`, one for each target that has a slice on that table; empty for a main no
/// target is read against. Err when the registry fails its checks (a target is never offered from a registry that does).
pub fn target_rows(main: &str) -> Result<Vec<Value>, String> {
    Ok(rows_of(targets()?, main))
}

fn rows_of(targets: &[Target], main: &str) -> Vec<Value> {
    let mut rows = Vec::new();
    for t in targets {
        for slice in t.slices.iter().filter(|s| s.dataset == main) {
            rows.push(json!({
                "src": format!("target:{}", t.id),
                "main": main,
                "table": format!("target_{}", main),
                // The place only: the flow group matches a target to the main by this place.
                "dims": {"geo": t.geo},
                // The slice of the main the target is set on (review 11-22): a main fixed at any other code of these
                // dimensions, or holding more than one, measures something else and takes no target (has_target).
                "slice": slice.dims,
                "time": t.year.to_string(),
                "value": t.value,
            }));
        }
    }
    rows
}

/// The text with every run of white space one space, so a quote matches across the line breaks of a stored excerpt.
fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first number in `text`, as a decimal-point string: the act's "42,5" and "763" read "42.5" and "763".
fn first_number(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.iter().position(|c| c.is_ascii_digit())?;
    let mut out = String::new();
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() {
            out.push(c);
        } else if (c == ',' || c == '.') && chars.get(i + 1).is_some_and(|n| n.is_ascii_digit()) {
            out.push('.');
        } else {
            break;
        }
        i += 1;
    }
    Some(out)
}

/// Checks one entry against the text of its act: the quote is in the text, the value phrase in the quote, the phrase's words
/// and number are the entry's kind and value, and the quote names the entry's year.
pub fn verify_entry(t: &Target, text: &str) -> Result<(), String> {
    let at = |why: &str| format!("target {}: {why}", t.id);
    let (text, quote, phrase) = (
        squeeze(text),
        squeeze(&t.source.quote),
        squeeze(&t.source.value_phrase),
    );
    if !text.contains(&quote) {
        return Err(at("the quoted sentence is not in the stored excerpt"));
    }
    if !quote.contains(&phrase) {
        return Err(at("the value phrase is not in the quoted sentence"));
    }
    let words_ok = match t.kind {
        Kind::AtLeast => phrase.starts_with("at least "),
        Kind::AtMost => ["no more than ", "at most ", "not more than "]
            .iter()
            .any(|w| phrase.starts_with(w)),
    };
    if !words_ok {
        return Err(at(
            "the words before the number do not say the target's type",
        ));
    }
    let read = first_number(&phrase);
    if read.as_deref() != Some(t.value.as_str()) {
        return Err(at(&format!(
            "the sentence says {:?}, the entry {}",
            read.unwrap_or_default(),
            t.value
        )));
    }
    let year = t.year.to_string();
    if !quote
        .split(|c: char| !c.is_ascii_digit())
        .any(|w| w == year)
    {
        return Err(at("the quoted sentence does not name the target's year"));
    }
    if t.value.parse::<f64>().is_err() {
        return Err(at("the value is not a number"));
    }
    Ok(())
}

/// Checks every entry: unique ids, a place and a slice, the excerpt there and its hash the entry's, and the sentence in it.
pub fn check_registry(
    targets: &[Target],
    excerpt: &dyn Fn(&str) -> Option<&'static str>,
) -> Result<(), String> {
    let mut ids = BTreeSet::new();
    if targets.is_empty() {
        return Err("targets.json holds no target".into());
    }
    for t in targets {
        if !ids.insert(t.id.as_str()) {
            return Err(format!("target {} is listed twice", t.id));
        }
        if t.slices.is_empty()
            || t.slices
                .iter()
                .any(|s| s.dims.contains_key("geo") || s.dims.contains_key("time"))
        {
            return Err(format!(
                "target {}: a slice names a table and its measure, not geo or time",
                t.id
            ));
        }
        let Some(text) = excerpt(&t.source.excerpt) else {
            return Err(format!(
                "target {}: no stored excerpt {}",
                t.id, t.source.excerpt
            ));
        };
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        if hash != t.source.excerpt_sha256 {
            return Err(format!(
                "target {}: the stored excerpt's hash is not the entry's",
                t.id
            ));
        }
        verify_entry(t, text)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixture of an act's text, with a line break inside the sentence as an excerpt may have it.
    const ACT: &str = "Article 3\n1. Member States shall collectively ensure that the share of energy from renewable sources in the Union’s\ngross final consumption of energy in 2030 is at least 42,5 %. Member States shall make efforts to reach 45 %.";

    fn entry() -> Target {
        serde_json::from_value(json!({
            "id": "t", "title": "T",
            "slices": [{"dataset": "nrg_ind_ren", "dims": {"freq": "A", "nrg_bal": "REN", "unit": "PC"}}],
            "geo": "EU27_2020", "year": 2030, "value": "42.5", "unit": "PC", "unit_label": "%", "type": "at_least",
            "source": {
                "act": "A", "clause": "C", "url": "u", "fetched_at": "f", "document_sha256": "d",
                "excerpt": "act.txt", "excerpt_sha256": "h",
                "quote": "Member States shall collectively ensure that the share of energy from renewable sources in the Union’s gross final consumption of energy in 2030 is at least 42,5 %.",
                "value_phrase": "at least 42,5 %"
            }
        }))
        .unwrap()
    }

    fn with(f: impl FnOnce(&mut Target)) -> Target {
        let mut t = entry();
        f(&mut t);
        t
    }

    #[test]
    fn a_sentence_the_act_says_passes_across_a_line_break() {
        assert_eq!(verify_entry(&entry(), ACT), Ok(()));
    }

    #[test]
    fn a_quote_the_act_does_not_say_fails() {
        let t = with(|t| t.source.quote = t.source.quote.replace("42,5", "45"));
        assert!(verify_entry(&t, ACT)
            .unwrap_err()
            .contains("not in the stored excerpt"));
        // The excerpt is another text altogether.
        assert!(verify_entry(&entry(), "Article 3 says something else.").is_err());
    }

    #[test]
    fn a_number_the_sentence_does_not_carry_fails() {
        // The sentence says 42,5; the entry says 45 (the act's other, indicative number).
        let t = with(|t| t.value = "45".into());
        assert!(verify_entry(&t, ACT)
            .unwrap_err()
            .contains("the sentence says"));
        let t = with(|t| t.value = "42.50".into());
        assert!(
            verify_entry(&t, ACT).is_err(),
            "the value is the act's own digits"
        );
    }

    #[test]
    fn a_wrong_year_or_type_fails() {
        let t = with(|t| t.year = 2035);
        assert!(verify_entry(&t, ACT).unwrap_err().contains("year"));
        // "2030" inside a longer digit run is not the year.
        let t = with(|t| t.year = 203);
        assert!(verify_entry(&t, ACT).is_err());
        let t = with(|t| t.kind = Kind::AtMost);
        assert!(verify_entry(&t, ACT).unwrap_err().contains("type"));
    }

    #[test]
    fn a_phrase_outside_the_quote_fails() {
        let t = with(|t| t.source.value_phrase = "at least 45 %".into());
        assert!(verify_entry(&t, ACT).unwrap_err().contains("value phrase"));
    }

    #[test]
    fn a_ceiling_reads_no_more_than() {
        let act = "Article 4 1. Member States shall ensure a reduction of at least 11,7 % in 2030 so that the Union’s final energy consumption amounts to no more than 763 Mtoe.";
        let t = with(|t| {
            t.kind = Kind::AtMost;
            t.value = "763".into();
            t.source.quote = act.replace("Article 4 1. ", "");
            t.source.value_phrase = "no more than 763 Mtoe".into();
        });
        assert_eq!(verify_entry(&t, act), Ok(()));
        // The 11,7 % floor in the same sentence is not the ceiling.
        let t = with(|t| {
            t.kind = Kind::AtLeast;
            t.value = "763".into();
            t.source.quote = act.replace("Article 4 1. ", "");
            t.source.value_phrase = "no more than 763 Mtoe".into();
        });
        assert!(verify_entry(&t, act).is_err());
    }

    #[test]
    fn the_act_s_decimal_comma_reads_as_a_point() {
        assert_eq!(first_number("at least 42,5 %").as_deref(), Some("42.5"));
        assert_eq!(
            first_number("no more than 763 Mtoe").as_deref(),
            Some("763")
        );
        assert_eq!(first_number("992,5 Mtoe in 2030").as_deref(), Some("992.5"));
        assert_eq!(first_number("no number"), None);
    }

    #[test]
    fn registry_checks_hash_ids_and_slices() {
        let text: &'static str = ACT;
        let good =
            with(|t| t.source.excerpt_sha256 = format!("{:x}", Sha256::digest(text.as_bytes())));
        let find = |_: &str| Some(text);
        assert_eq!(check_registry(std::slice::from_ref(&good), &find), Ok(()));
        // The hash of another text.
        assert!(check_registry(&[entry()], &find)
            .unwrap_err()
            .contains("hash"));
        // Two entries with one id.
        assert!(check_registry(&[good.clone(), good.clone()], &find)
            .unwrap_err()
            .contains("twice"));
        // A slice that fixes geo or time.
        let geo = with(|t| {
            t.source.excerpt_sha256 = good.source.excerpt_sha256.clone();
            t.slices[0].dims.insert("geo".into(), "DE".into());
        });
        assert!(check_registry(&[geo], &find).unwrap_err().contains("slice"));
        // No excerpt stored, and no entry at all.
        assert!(check_registry(&[good.clone()], &|_| None)
            .unwrap_err()
            .contains("no stored excerpt"));
        assert!(check_registry(&[], &find).is_err());
    }

    #[test]
    fn rows_come_out_in_the_flow_groups_format_for_the_slice_s_table_only() {
        let t = entry();
        let rows = rows_of(std::slice::from_ref(&t), "nrg_ind_ren");
        assert_eq!(
            rows,
            vec![json!({
                "src": "target:t", "main": "nrg_ind_ren", "table": "target_nrg_ind_ren",
                "dims": {"geo": "EU27_2020"},
                "slice": {"freq": "A", "nrg_bal": "REN", "unit": "PC"},
                "time": "2030", "value": "42.5"
            })]
        );
        // A main with no slice of the target gets nothing; two slices give two rows only for their own table.
        assert!(rows_of(std::slice::from_ref(&t), "nrg_ti_gas").is_empty());
    }

    // ---- The shipped registry ----

    #[test]
    fn the_shipped_registry_passes_its_own_checks() {
        let all = targets().expect("targets.json passes its checks");
        let ids: Vec<&str> = all.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["eu-renewables-2030", "eu-final-energy-2030"]);
        assert!(all.iter().all(
            |t| t.geo == "EU27_2020" && t.source.url.starts_with("https://eur-lex.europa.eu/")
        ));
        assert!(all.iter().all(|t| t.source.document_sha256.len() == 64));
    }

    #[test]
    fn the_shipped_rows_for_the_two_renewable_tables_and_the_efficiency_table() {
        for main in ["nrg_ind_ren", "sdg_07_40"] {
            let rows = target_rows(main).unwrap();
            assert_eq!(rows.len(), 1, "{main}");
            assert_eq!(rows[0]["src"], "target:eu-renewables-2030");
            assert_eq!(rows[0]["value"], "42.5");
            assert_eq!(rows[0]["time"], "2030");
            assert_eq!(rows[0]["dims"], json!({"geo": "EU27_2020"}));
            assert_eq!(rows[0]["table"], format!("target_{main}"));
        }
        let eff = target_rows("nrg_ind_eff").unwrap();
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0]["value"], "763");
        assert_eq!(eff[0]["dims"], json!({"geo": "EU27_2020"}));
        assert!(target_rows("nrg_ti_gas").unwrap().is_empty());
        // A World Bank id is not a main of any target.
        assert!(target_rows("EG.FEC.RNEW.ZS@2").unwrap().is_empty());
    }

    #[test]
    fn the_shipped_slices_are_tables_of_a_measure_family_or_the_efficiency_table() {
        // A slice's table is one the catalogue knows how to ask for: the renewable tables sit in the renewable_share family.
        for t in targets().unwrap() {
            for s in &t.slices {
                if t.id == "eu-renewables-2030" {
                    assert!(
                        crate::l5geo::family_holds("renewable_share", &s.dataset),
                        "{}",
                        s.dataset
                    );
                }
            }
        }
    }
}

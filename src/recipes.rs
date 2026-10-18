//! Opt-in (`NEWSROOM_SPEED_RECIPES=1`) method recipes appended to the first investigation prompt.
//! The program picks at most one recipe from the measured shape of the declared CSV tables, never
//! from the request text and never from the model. A recipe is method and pitfalls only: it is
//! not evidence, a source or a claim, and it changes no check.

use crate::agent_loop::ToolRunner;
use crate::data_profile::{shape_csv, TableShape};
use crate::hash::sha256_bytes;
use crate::tool_host::CallOutcome;
use anyhow::Result;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;

pub const RECIPES_HEADING: &str =
    "\nRecipe for this data shape, chosen by the program from the measured table shape (method and pitfalls only: \
not evidence, not a source, not a claim, and it changes no check; record and verify every number you report as usual):\n";

struct Recipe {
    name: &'static str,
    body: &'static str,
    matches: fn(&TableShape) -> bool,
}

const RECIPES: [Recipe; 3] = [
    Recipe {
        name: "line-over-years",
        body: include_str!("../recipes/line-over-years.md"),
        matches: is_year_value_table,
    },
    Recipe {
        name: "sankey-flow",
        body: include_str!("../recipes/sankey-flow.md"),
        matches: is_edge_table,
    },
    Recipe {
        name: "heatmap-grid",
        body: include_str!("../recipes/heatmap-grid.md"),
        matches: is_entity_year_grid,
    },
];

/// A recipe that needs several tables at once; checked before the single-table recipes and wins over them.
const MULTI_RECIPES: [MultiRecipe; 2] = [
    MultiRecipe {
        name: "flow-with-origin-map",
        body: include_str!("../recipes/flow-with-origin-map.md"),
        matches: is_flow_with_origin,
    },
    // Disjoint from the map recipe: it needs that no table carries country codes.
    MultiRecipe {
        name: "flow-with-grid",
        body: include_str!("../recipes/flow-with-grid.md"),
        matches: is_flow_with_grid,
    },
];

struct MultiRecipe {
    name: &'static str,
    body: &'static str,
    matches: fn(&[TableShape]) -> bool,
}

/// A recipe the program loaded: its name and the sha256 of the exact text appended to the prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub name: &'static str,
    pub text: String,
    pub sha256: String,
}

fn column<'a>(shape: &'a TableShape, name: &str) -> Option<&'a crate::data_profile::ColumnShape> {
    shape
        .columns
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case(name))
}

/// One year column (integers in a calendar range, at least ten distinct), exactly one other
/// numeric column, and at most two text columns (an entity and its code).
fn is_year_value_table(shape: &TableShape) -> bool {
    let years: Vec<_> = shape
        .columns
        .iter()
        .filter(|c| {
            c.name.to_ascii_lowercase().contains("year")
                && c.integer
                && c.distinct >= 10
                && c.min >= 1000.0
                && c.max <= 2200.0
        })
        .collect();
    if years.len() != 1 {
        return false;
    }
    let numeric_others = shape
        .columns
        .iter()
        .filter(|c| c.numeric && c.name != years[0].name)
        .count();
    let text = shape.columns.iter().filter(|c| !c.numeric).count();
    numeric_others == 1 && text <= 2
}

/// Columns named source and target (text) and exactly one numeric column, whatever its name
/// (value, value_ktoe, value_GtC, ...); at least two rows.
fn is_edge_table(shape: &TableShape) -> bool {
    let (Some(source), Some(target)) = (column(shape, "source"), column(shape, "target")) else {
        return false;
    };
    shape.rows >= 2
        && !source.numeric
        && !target.numeric
        && shape.columns.iter().filter(|c| c.numeric).count() == 1
}

/// A partner table: a text column holding ISO country codes (name contains "iso3" or is "iso_code")
/// and at least one numeric column.
fn is_origin_table(shape: &TableShape) -> bool {
    let coded = shape.columns.iter().any(|c| {
        let name = c.name.to_ascii_lowercase();
        !c.numeric && (name.contains("iso3") || name == "iso_code")
    });
    coded && shape.columns.iter().any(|c| c.numeric)
}

/// One edge table and, in another table, country-coded partners with a value: a flow page that also needs a map.
fn is_flow_with_origin(shapes: &[TableShape]) -> bool {
    shapes.iter().enumerate().any(|(i, edges)| {
        is_edge_table(edges)
            && shapes
                .iter()
                .enumerate()
                .any(|(j, other)| i != j && is_origin_table(other))
    })
}

/// A complete names-by-years grid: one year column (three to nine distinct years), exactly one other numeric column,
/// a text name column with five to forty distinct names, rows = names x years, and no country-code column.
/// The year count range is disjoint from the line recipe (ten or more).
fn is_entity_year_grid(shape: &TableShape) -> bool {
    let years: Vec<_> = shape
        .columns
        .iter()
        .filter(|c| {
            c.name.to_ascii_lowercase().contains("year")
                && c.integer
                && (3..=9).contains(&c.distinct)
                && c.min >= 1000.0
                && c.max <= 2200.0
        })
        .collect();
    if years.len() != 1 {
        return false;
    }
    let numeric_others = shape
        .columns
        .iter()
        .filter(|c| c.numeric && c.name != years[0].name)
        .count();
    let coded = shape.columns.iter().any(|c| {
        let name = c.name.to_ascii_lowercase();
        !c.numeric && (name.contains("iso3") || name == "iso_code")
    });
    numeric_others == 1
        && !coded
        && shape.columns.iter().any(|c| {
            !c.numeric
                && (5..=40).contains(&c.distinct)
                && shape.rows == c.distinct * years[0].distinct
        })
}

/// An edge table and a names-by-years grid with no country-coded table anywhere (else the map recipe takes it).
fn is_flow_with_grid(shapes: &[TableShape]) -> bool {
    shapes.iter().any(is_edge_table)
        && shapes.iter().any(is_entity_year_grid)
        && !shapes.iter().any(is_origin_table)
}

/// The one recipe that matches, or `None` when none or more than one does (across all tables).
fn select(shapes: &[TableShape]) -> Option<&'static Recipe> {
    select_from(&RECIPES, shapes)
}

fn select_from<'r>(recipes: &'r [Recipe], shapes: &[TableShape]) -> Option<&'r Recipe> {
    let mut found: Vec<&'r Recipe> = Vec::new();
    for shape in shapes {
        let hits: Vec<&'r Recipe> = recipes.iter().filter(|r| (r.matches)(shape)).collect();
        if hits.len() > 1 {
            return None;
        }
        for hit in hits {
            if !found.iter().any(|f| f.name == hit.name) {
                found.push(hit);
            }
        }
    }
    if found.len() == 1 {
        found.pop()
    } else {
        None
    }
}

/// The multi-table recipe that matches, when exactly one does.
fn select_multi(shapes: &[TableShape]) -> Option<&'static MultiRecipe> {
    let hits: Vec<&'static MultiRecipe> = MULTI_RECIPES
        .iter()
        .filter(|r| (r.matches)(shapes))
        .collect();
    if hits.len() == 1 {
        hits.first().copied()
    } else {
        None
    }
}

/// The two V580 comparison switches (exact "1", default off) change what the concept tool asks for, so a recipe that spells the
/// old requirement out would pull the model back. With both off the body is returned untouched, byte for byte.
fn follow_concept_switches(body: &str, count_three: bool, trim_unread: bool) -> String {
    let mut text = body.to_string();
    if count_three {
        text = text.replace(
            "一次写满八个方案（少于八个会被拒）",
            "按工具要求的个数写方案",
        );
    }
    if trim_unread {
        text = text
            .replace("、risk_flags、reporting_gaps，后四项没有内容就写空数组，risk_flags 和 reporting_gaps 的每一项都是一句字符串", "、risk_flags，后三项没有内容就写空数组，risk_flags 的每一项都是一句字符串");
    }
    text
}

/// The tools NEWSROOM_LEAN_GATES=1 removes. A recipe that walks the model through them (the two flow-with-* recipes, whose rounds three and four are
/// those tools) would send it to tools that do not exist, so with the switch on those recipes are not loaded. Off: every recipe loads as before.
const LEAN_REMOVED_TOOLS: [&str; 3] = [
    "newsroom_visual_concepts",
    "newsroom_semantic_novelty",
    "newsroom_asset_requirements",
];

fn dropped_for_lean_gates(body: &str, lean: bool) -> bool {
    lean && LEAN_REMOVED_TOOLS.iter().any(|tool| body.contains(tool))
}

fn switch_on(name: &str) -> bool {
    std::env::var(name).map(|v| v == "1").unwrap_or(false)
}

/// Recipe text for the declared local files, from their measured shape only.
/// Each pair is the path the model sees and the file to read it from.
pub fn section(files: &[(String, PathBuf)]) -> Option<Loaded> {
    let shapes: Vec<TableShape> = files
        .iter()
        .filter_map(|(_, source)| shape_csv(source))
        .collect();
    let (name, body) = match select_multi(&shapes) {
        Some(multi) => (multi.name, multi.body),
        None => {
            let recipe = select(&shapes)?;
            (recipe.name, recipe.body)
        }
    };
    if dropped_for_lean_gates(body, switch_on("NEWSROOM_LEAN_GATES")) {
        return None;
    }
    let body = follow_concept_switches(
        body,
        switch_on("NEWSROOM_CONCEPT_COUNT_3"),
        switch_on("NEWSROOM_TRIM_UNREAD_FIELDS"),
    );
    let text = format!("{RECIPES_HEADING}{body}");
    Some(Loaded {
        name,
        sha256: sha256_bytes(text.as_bytes()),
        text,
    })
}

/// Wraps the tool runner of the Rust agent. After a successful `download_data` it runs the same selection as the first
/// prompt (`section`) over the tables downloaded so far and, when a recipe matches that is not in the conversation yet,
/// adds its text as one more text block of that tool result. "In the conversation" means: attached earlier in this process,
/// carried by the first prompt (the run's manifest names it), or already present in the run folder's saved session, so a
/// follow-up question (`news continue`, a new process) does not get a recipe again. The block is added after the host has
/// recorded the call, so the call report, the tool log of the host and every evidence record are the host's, unchanged. Text
/// only: the call, its arguments, its details and its error state are the host's, unchanged. Off, or for any other tool,
/// the outcome passes through untouched.
pub struct AfterDownload<R> {
    inner: R,
    run_dir: PathBuf,
    enabled: bool,
    files: Vec<(String, PathBuf)>,
    attached: Vec<String>,
    /// Texts of the saved session that carry a recipe heading (a follow-up process sees what the earlier turns showed the model).
    earlier: Vec<String>,
}

impl<R> AfterDownload<R> {
    pub fn new(inner: R, run_dir: &Path, enabled: bool) -> Self {
        Self {
            inner,
            run_dir: run_dir.to_path_buf(),
            enabled,
            files: Vec::new(),
            attached: first_prompt_recipe(run_dir).into_iter().collect(),
            earlier: if enabled {
                session_recipe_texts(run_dir)
            } else {
                Vec::new()
            },
        }
    }

    fn recipe_text(&mut self, details: Option<&Value>) -> Option<String> {
        let shown = details?.get("filePath")?.as_str()?;
        // The file stays inside the run folder: a relative path with no `..` step.
        let relative = Path::new(shown);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return None;
        }
        // And the file it names resolves (links followed) to a place inside the run folder.
        let joined = self.run_dir.join(relative);
        let (inside, root) = (
            joined.canonicalize().ok()?,
            self.run_dir.canonicalize().ok()?,
        );
        if !inside.starts_with(&root) {
            return None;
        }
        let new_file = (shown.to_string(), joined);
        if !self.files.iter().any(|(seen, _)| *seen == new_file.0) {
            self.files.push(new_file.clone());
        }
        // The tables so far (the only way a recipe that needs several tables can load), then this table alone (two
        // different single-table shapes together match nothing, as in the first prompt, and must not hide this one).
        for loaded in [section(&self.files), section(&[new_file])]
            .into_iter()
            .flatten()
        {
            if self.attached.iter().any(|name| name == loaded.name) {
                continue;
            }
            self.attached.push(loaded.name.to_string());
            if self.earlier.iter().any(|seen| seen.contains(&loaded.text)) {
                continue;
            }
            return Some(loaded.text);
        }
        None
    }
}

/// Every string of the saved session's messages that holds a recipe heading. Read only: nothing is created, repaired or written;
/// no session, or one that cannot be read, gives an empty list.
fn session_recipe_texts(run_dir: &Path) -> Vec<String> {
    fn strings(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) if text.contains(RECIPES_HEADING) => out.push(text.clone()),
            Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
            Value::Object(map) => map.values().for_each(|item| strings(item, out)),
            _ => {}
        }
    }
    let path = run_dir
        .join(crate::session_store::DIR)
        .join(crate::session_store::FILE);
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        if let Ok(record) = serde_json::from_str::<Value>(line) {
            if record["type"] == "message" {
                strings(&record["message"], &mut out);
            }
        }
    }
    out
}

/// The name of the recipe the first prompt carried, from the run's manifest; none when the run has no recipe yet.
fn first_prompt_recipe(run_dir: &Path) -> Option<String> {
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(run_dir.join("story.json")).ok()?).ok()?;
    Some(manifest.get("recipe")?.get("name")?.as_str()?.to_string())
}

#[async_trait::async_trait]
impl<R: ToolRunner + Send> ToolRunner for AfterDownload<R> {
    fn exposes(&self, name: &str) -> bool {
        self.inner.exposes(name)
    }
    async fn run(
        &mut self,
        name: &str,
        args: &Value,
        cancel: &AtomicBool,
        progress: &mut Vec<Value>,
    ) -> Result<CallOutcome> {
        let mut outcome = self.inner.run(name, args, cancel, progress).await?;
        if self.enabled && name == "download_data" {
            if let CallOutcome::Result {
                content,
                details,
                is_error: false,
            } = &mut outcome
            {
                if let Some(text) = self.recipe_text(details.as_ref()) {
                    content.push(json!({"type": "text", "text": text}));
                }
            }
        }
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn write(dir: &Path, name: &str, text: &str) -> (String, PathBuf) {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        (format!("data/{name}"), path)
    }

    fn years() -> String {
        let mut csv = String::from("Entity,Code,Year,Rate\n");
        for y in 1960..1990 {
            csv.push_str(&format!("China,CHN,{y},{}.5\n", y - 1900));
        }
        csv
    }

    const EDGES: &str = "source,target,value\nA,B,3\nA,C,2\nB,D,3\nC,D,2\n";

    #[test]
    fn a_year_by_value_table_loads_the_line_recipe() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = section(&[write(dir.path(), "t.csv", &years())]).unwrap();
        assert_eq!(loaded.name, "line-over-years");
        assert!(loaded.text.starts_with(RECIPES_HEADING));
        assert_eq!(loaded.sha256, sha256_bytes(loaded.text.as_bytes()));
    }

    #[test]
    fn a_source_target_value_edge_table_loads_the_sankey_recipe() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = section(&[write(dir.path(), "e.csv", EDGES)]).unwrap();
        assert_eq!(loaded.name, "sankey-flow");
    }

    #[test]
    fn no_match_loads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        // Two numeric measures beside the year, and a table with no year at all.
        let two = "year,a,b\n".to_string()
            + &(1990..2005)
                .map(|y| format!("{y},1.5,2.5\n"))
                .collect::<String>();
        assert!(section(&[write(dir.path(), "two.csv", &two)]).is_none());
        assert!(section(&[write(dir.path(), "plain.csv", "name,score\nx,1.5\ny,2.5\n")]).is_none());
        // Fewer than ten years.
        let short = "year,rate\n".to_string()
            + &(2000..2005)
                .map(|y| format!("{y},1.5\n"))
                .collect::<String>();
        assert!(section(&[write(dir.path(), "short.csv", &short)]).is_none());
        assert!(section(&[]).is_none());
        let json = dir.path().join("a.json");
        std::fs::write(&json, "{}").unwrap();
        assert!(section(&[("data/a.json".into(), json)]).is_none());
    }

    #[test]
    fn a_table_that_fits_two_recipes_loads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        // The built-in shape rules are disjoint (one needs two numeric columns, the other exactly one);
        // the "more than one match" rule is checked with two recipes that both match.
        let shape = shape_csv(&write(dir.path(), "e.csv", EDGES).1).unwrap();
        let both = [
            Recipe {
                name: "x",
                body: "",
                matches: |_| true,
            },
            Recipe {
                name: "y",
                body: "",
                matches: |_| true,
            },
        ];
        assert!(select_from(&both, std::slice::from_ref(&shape)).is_none());
        assert_eq!(select_from(&both[..1], &[shape]).unwrap().name, "x");
        // Two tables that each match a different recipe: ambiguous, nothing loads.
        let files = [
            write(dir.path(), "t.csv", &years()),
            write(dir.path(), "e.csv", EDGES),
        ];
        assert!(section(&files).is_none());
        // Two tables that match the same recipe: still that one recipe.
        let same = [
            write(dir.path(), "t1.csv", &years()),
            write(dir.path(), "t2.csv", &years()),
        ];
        assert_eq!(section(&same).unwrap().name, "line-over-years");
    }

    #[test]
    fn matching_reads_the_table_only_never_the_file_name_or_text() {
        let dir = tempfile::tempdir().unwrap();
        let (_, path) = write(
            dir.path(),
            "sankey-flow-line-over-years.csv",
            "name,score\nx,1.5\ny,2.5\n",
        );
        assert!(section(&[("data/排名 sankey.csv".into(), path)]).is_none());
    }

    #[test]
    fn recipe_bodies_hold_no_digits_paths_or_ids() {
        let bodies = RECIPES
            .iter()
            .map(|r| (r.name, r.body))
            .chain(MULTI_RECIPES.iter().map(|r| (r.name, r.body)));
        for (name, body) in bodies {
            let recipe = (name, body);
            let all = format!("{RECIPES_HEADING}{}", recipe.1);
            // The code-system name "iso3" is the one allowed digit; any other digit could be copied as a number.
            let without_code_name = all.replace("iso3", "");
            assert!(
                !without_code_name.chars().any(|c| c.is_ascii_digit()),
                "{}: digit in recipe text",
                recipe.0
            );
            for bad in ["/Users", "PJ004", "http", "README", ".md", "SKILL"] {
                assert!(!all.contains(bad), "{}: contains {bad}", recipe.0);
            }
            assert!(!recipe.1.starts_with("---"), "{}: frontmatter", recipe.0);
        }
    }

    // Real headers of the Germany energy and import-partner tables, with a few rows each.
    const ENERGY: &str = "source,target,value_ktoe\nC:renewables,transport,2979.849\nC:renewables,K:difference,15.333\nK:difference,heat,10.5\n";
    const OIL: &str = "partner_geo,partner_iso3,value,unit,share,partner_name\nUS,USA,14189,THS_T,0.18380,United States\nNO,NOR,13713,THS_T,0.17764,Norway\n";

    #[test]
    fn an_edge_table_with_any_name_for_its_one_numeric_column_loads_the_sankey_recipe() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            section(&[write(dir.path(), "e.csv", ENERGY)]).unwrap().name,
            "sankey-flow"
        );
        let gtc = "source,target,value_GtC\nA,B,3.5\nB,C,1.5\n";
        assert_eq!(
            section(&[write(dir.path(), "g.csv", gtc)]).unwrap().name,
            "sankey-flow"
        );
        // Two numeric columns, or a numeric source column: nothing.
        let two = "source,target,value_a,value_b\nA,B,3.5,1.5\nB,C,1.5,2.5\n";
        assert!(section(&[write(dir.path(), "two.csv", two)]).is_none());
        let numeric_source = "source,target,value\n1,B,3.5\n2,C,1.5\n";
        assert!(section(&[write(dir.path(), "n.csv", numeric_source)]).is_none());
    }

    #[test]
    fn edges_plus_a_country_coded_partner_table_load_the_map_recipe_and_it_wins() {
        let dir = tempfile::tempdir().unwrap();
        let files = [
            write(dir.path(), "e.csv", ENERGY),
            write(dir.path(), "oil.csv", OIL),
        ];
        assert_eq!(section(&files).unwrap().name, "flow-with-origin-map");
        let reversed = [files[1].clone(), files[0].clone()];
        assert_eq!(section(&reversed).unwrap().name, "flow-with-origin-map");
        // Edges alone keep the sankey recipe; the partner table alone loads nothing.
        assert_eq!(section(&files[..1]).unwrap().name, "sankey-flow");
        assert!(section(&files[1..]).is_none());
        // A partner table whose code column is numeric, or has no iso name, is not a map source.
        let plain = "country,code,value\nUnited States,US,3.5\nNorway,NO,1.5\n";
        assert_eq!(
            section(&[files[0].clone(), write(dir.path(), "p.csv", plain)])
                .unwrap()
                .name,
            "sankey-flow"
        );
        let iso_code = "name,ISO_CODE,amount\nUnited States,USA,3.5\n";
        assert_eq!(
            section(&[files[0].clone(), write(dir.path(), "q.csv", iso_code)])
                .unwrap()
                .name,
            "flow-with-origin-map"
        );
    }

    // Fifteen names by eight years in one numeric column: the heatmap grid; the line topic is not a grid.
    fn grid_csv(names: usize, years: usize) -> String {
        let mut text = String::from("country,year,co2_per_capita\n");
        for n in 0..names {
            for y in 0..years {
                text.push_str(&format!("Country{n},{},{}.5\n", 1990 + y * 5, n + y));
            }
        }
        text
    }

    #[test]
    fn a_names_by_years_grid_loads_heatmap_grid_and_the_line_topic_stays_line() {
        let dir = tempfile::tempdir().unwrap();
        let grid = write(dir.path(), "grid.csv", &grid_csv(15, 8));
        assert_eq!(section(&[grid]).unwrap().name, "heatmap-grid");
        // Ten years is the line recipe's ground; a ragged grid, too few names or a code column load nothing.
        let line = write(
            dir.path(),
            "line.csv",
            &grid_csv(1, 12).replace("country", "name"),
        );
        assert_eq!(section(&[line]).unwrap().name, "line-over-years");
        let ragged = grid_csv(15, 8)
            .lines()
            .take(100)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert!(section(&[write(dir.path(), "ragged.csv", &ragged)]).is_none());
        assert!(section(&[write(dir.path(), "few.csv", &grid_csv(3, 8))]).is_none());
        let coded = grid_csv(15, 8)
            .replace("country,year", "country,iso3,year")
            .lines()
            .enumerate()
            .map(|(i, l)| {
                if i == 0 {
                    l.to_string()
                } else {
                    l.replacen(",", ",XXX,", 1)
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert!(section(&[write(dir.path(), "coded.csv", &coded)]).is_none());
    }

    #[test]
    fn an_edge_table_plus_a_grid_loads_flow_with_grid_unless_a_code_table_is_present() {
        let dir = tempfile::tempdir().unwrap();
        let edges = write(dir.path(), "e.csv", ENERGY);
        let grid = write(dir.path(), "g.csv", &grid_csv(15, 8));
        assert_eq!(
            section(&[edges.clone(), grid.clone()]).unwrap().name,
            "flow-with-grid"
        );
        assert_eq!(
            section(&[grid.clone(), edges.clone()]).unwrap().name,
            "flow-with-grid"
        );
        // The map recipe keeps winning when a country-coded table exists.
        let oil = write(dir.path(), "oil.csv", OIL);
        assert_eq!(
            section(&[edges.clone(), grid.clone(), oil.clone()])
                .unwrap()
                .name,
            "flow-with-origin-map"
        );
        assert_eq!(section(&[edges, oil]).unwrap().name, "flow-with-origin-map");
        // Case one's Germany tables are unchanged by the new recipes.
    }

    #[test]
    fn lean_gates_drop_only_the_recipes_that_name_a_removed_tool() {
        let mut dropped = Vec::new();
        for recipe in RECIPES
            .iter()
            .map(|r| (r.name, r.body))
            .chain(MULTI_RECIPES.iter().map(|r| (r.name, r.body)))
        {
            assert!(!dropped_for_lean_gates(recipe.1, false), "{}", recipe.0);
            if dropped_for_lean_gates(recipe.1, true) {
                dropped.push(recipe.0);
            }
        }
        dropped.sort();
        assert_eq!(dropped, ["flow-with-grid", "flow-with-origin-map"]);
    }

    #[test]
    fn the_concept_switches_change_only_the_two_sentences_and_nothing_when_off() {
        let bodies: Vec<&str> = RECIPES
            .iter()
            .map(|r| r.body)
            .chain(MULTI_RECIPES.iter().map(|r| r.body))
            .collect();
        for body in &bodies {
            assert_eq!(
                follow_concept_switches(body, false, false),
                *body,
                "off must be byte-identical"
            );
        }
        let map = MULTI_RECIPES
            .iter()
            .find(|r| r.name == "flow-with-origin-map")
            .unwrap()
            .body;
        assert!(map.contains("八个") && map.contains("reporting_gaps"));
        let count = follow_concept_switches(map, true, false);
        assert!(
            !count.contains("八个")
                && count.contains("按工具要求的个数写方案")
                && count.contains("reporting_gaps")
        );
        let trim = follow_concept_switches(map, false, true);
        assert!(
            trim.contains("八个")
                && !trim.contains("reporting_gaps")
                && trim.contains("后三项没有内容就写空数组")
        );
        let both = follow_concept_switches(map, true, true);
        assert!(!both.contains("八个") && !both.contains("reporting_gaps"));
        // Only that one recipe names the count or the field; the other recipes are untouched even with both on.
        for body in bodies.iter().filter(|b| **b != map) {
            assert_eq!(follow_concept_switches(body, true, true), *body);
        }
        // Everything outside the two sentences is the same text.
        assert_eq!(
            count.replace(
                "按工具要求的个数写方案",
                "一次写满八个方案（少于八个会被拒）"
            ),
            map
        );
        assert_eq!(trim.replace("、risk_flags，后三项没有内容就写空数组，risk_flags 的每一项都是一句字符串", "、risk_flags、reporting_gaps，后四项没有内容就写空数组，risk_flags 和 reporting_gaps 的每一项都是一句字符串"), map);
    }

    #[test]
    fn the_global_carbon_tables_load_flow_with_grid_which_names_no_concept_count() {
        // data-complex/14-global-carbon: gcb_2023_flows.csv (source,target,value_GtC) and owid_percap_top15_grid.csv (country,year,co2_per_capita; 15 x 8).
        let dir = tempfile::tempdir().unwrap();
        let flows = write(
            dir.path(),
            "gcb_2023_flows.csv",
            "source,target,value_GtC\n其他,化石排放,0.1160\n化石排放,总排放,10.3968\n",
        );
        let grid = write(dir.path(), "owid_percap_top15_grid.csv", &grid_csv(15, 8));
        let loaded = section(&[flows, grid]).unwrap();
        assert_eq!(loaded.name, "flow-with-grid");
        assert!(
            loaded.text.contains("按工具要求的个数写方案")
                && !loaded.text.contains("写满八个")
                && !loaded.text.contains("reporting_gaps")
        );
    }

    /// Answers each call with the next scripted result; `download_data` details name the file under the run folder.
    struct Scripted(std::collections::VecDeque<CallOutcome>);

    #[async_trait::async_trait]
    impl ToolRunner for Scripted {
        fn exposes(&self, _name: &str) -> bool {
            false
        }
        async fn run(
            &mut self,
            _name: &str,
            _args: &Value,
            _cancel: &AtomicBool,
            _progress: &mut Vec<Value>,
        ) -> Result<CallOutcome> {
            Ok(self.0.pop_front().unwrap())
        }
    }

    fn downloaded(file: &str) -> CallOutcome {
        CallOutcome::Result {
            content: vec![
                json!({"type": "text", "text": format!("Downloaded 10 bytes.\nData file: {file}")}),
            ],
            details: Some(json!({"filePath": file})),
            is_error: false,
        }
    }

    async fn call(runner: &mut impl ToolRunner, name: &str) -> CallOutcome {
        runner
            .run(name, &json!({}), &AtomicBool::new(false), &mut Vec::new())
            .await
            .unwrap()
    }

    fn blocks(outcome: &CallOutcome) -> Vec<String> {
        match outcome {
            CallOutcome::Result { content, .. } => content
                .iter()
                .map(|b| b["text"].as_str().unwrap().to_string())
                .collect(),
            other => panic!("{other:?}"),
        }
    }

    fn run_folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        for (name, text) in files {
            std::fs::write(dir.path().join(name), text).unwrap();
        }
        dir
    }

    #[tokio::test]
    async fn a_downloaded_table_gets_its_recipe_once_as_one_more_text_block() {
        let dir = run_folder(&[("data/a.csv", &years()), ("data/b.csv", &years())]);
        let plain = downloaded("data/a.csv");
        let before = blocks(&plain);
        let mut runner = AfterDownload::new(
            Scripted([plain, downloaded("data/b.csv")].into()),
            dir.path(),
            true,
        );
        let first = call(&mut runner, "download_data").await;
        let sent = blocks(&first);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0], before[0]);
        let expected =
            section(&[("data/a.csv".to_string(), dir.path().join("data/a.csv"))]).unwrap();
        assert_eq!(sent[1], expected.text);
        assert_eq!(sha256_bytes(sent[1].as_bytes()), expected.sha256);
        // A second download of the same shape adds nothing.
        let second = call(&mut runner, "download_data").await;
        assert_eq!(blocks(&second).len(), 1);
    }

    #[tokio::test]
    async fn nothing_changes_when_no_shape_matches_the_switch_is_off_or_the_call_is_not_a_clean_download(
    ) {
        let dir = run_folder(&[
            ("data/p.csv", "name,score\nx,1.5\ny,2.5\n"),
            ("data/a.csv", &years()),
        ]);
        // No shape matches.
        let mut runner = AfterDownload::new(
            Scripted([downloaded("data/p.csv")].into()),
            dir.path(),
            true,
        );
        assert_eq!(
            call(&mut runner, "download_data").await,
            downloaded("data/p.csv")
        );
        // Switch off.
        let mut off = AfterDownload::new(
            Scripted([downloaded("data/a.csv")].into()),
            dir.path(),
            false,
        );
        assert_eq!(
            call(&mut off, "download_data").await,
            downloaded("data/a.csv")
        );
        // Another tool, even with the same details.
        let mut other = AfterDownload::new(
            Scripted([downloaded("data/a.csv")].into()),
            dir.path(),
            true,
        );
        assert_eq!(
            call(&mut other, "duckdb_query").await,
            downloaded("data/a.csv")
        );
        // A failed download.
        let failed = || CallOutcome::Result {
            content: vec![json!({"type": "text", "text": "HTTP 404"})],
            details: Some(json!({"filePath": "data/a.csv"})),
            is_error: true,
        };
        let mut bad = AfterDownload::new(Scripted([failed()].into()), dir.path(), true);
        assert_eq!(call(&mut bad, "download_data").await, failed());
        // A path that leaves the run folder is never read.
        let outside = || CallOutcome::Result {
            content: vec![json!({"type": "text", "text": "ok"})],
            details: Some(json!({"filePath": "../a.csv"})),
            is_error: false,
        };
        let mut escape = AfterDownload::new(Scripted([outside()].into()), dir.path(), true);
        assert_eq!(call(&mut escape, "download_data").await, outside());
        // A link inside the run folder that points outside it is not followed.
        #[cfg(unix)]
        {
            let elsewhere = tempfile::tempdir().unwrap();
            std::fs::write(elsewhere.path().join("t.csv"), years()).unwrap();
            std::os::unix::fs::symlink(
                elsewhere.path().join("t.csv"),
                dir.path().join("data/link.csv"),
            )
            .unwrap();
            let mut linked = AfterDownload::new(
                Scripted([downloaded("data/link.csv")].into()),
                dir.path(),
                true,
            );
            assert_eq!(
                call(&mut linked, "download_data").await,
                downloaded("data/link.csv")
            );
        }
    }

    #[tokio::test]
    async fn the_recipe_the_first_prompt_carried_is_not_attached_again() {
        let dir = run_folder(&[
            ("data/a.csv", &years()),
            (
                "story.json",
                r#"{"recipe":{"name":"line-over-years","sha256":"x"}}"#,
            ),
        ]);
        let mut runner = AfterDownload::new(
            Scripted([downloaded("data/a.csv")].into()),
            dir.path(),
            true,
        );
        assert_eq!(
            call(&mut runner, "download_data").await,
            downloaded("data/a.csv")
        );
    }

    #[tokio::test]
    async fn two_downloaded_tables_can_load_a_multi_table_recipe_after_a_single_table_one() {
        let dir = run_folder(&[
            ("data/e.csv", EDGES),
            ("data/o.csv", "iso3,value\nCHN,1.5\nUSA,2.5\n"),
        ]);
        let mut runner = AfterDownload::new(
            Scripted([downloaded("data/e.csv"), downloaded("data/o.csv")].into()),
            dir.path(),
            true,
        );
        let first = blocks(&call(&mut runner, "download_data").await);
        assert_eq!(first.len(), 2);
        assert!(first[1].contains("Recipe for this data shape"));
        let both = section(&[
            ("data/e.csv".to_string(), dir.path().join("data/e.csv")),
            ("data/o.csv".to_string(), dir.path().join("data/o.csv")),
        ])
        .unwrap();
        assert_eq!(both.name, "flow-with-origin-map");
        let second = blocks(&call(&mut runner, "download_data").await);
        assert_eq!(second.len(), 2);
        assert_eq!(second[1], both.text);
    }

    #[tokio::test]
    async fn a_follow_up_process_does_not_attach_a_recipe_the_conversation_already_holds() {
        let dir = run_folder(&[("data/a.csv", &years()), ("data/e.csv", EDGES)]);
        let line = section(&[("data/a.csv".to_string(), dir.path().join("data/a.csv"))]).unwrap();
        // Turn one: a download whose result carried the line recipe, saved in the session.
        let saved = dir.path().join(crate::session_store::DIR);
        std::fs::create_dir_all(&saved).unwrap();
        let message = json!({"type": "message", "message": {"role": "toolResult", "toolName": "download_data",
            "content": [{"type": "text", "text": "Downloaded."}, {"type": "text", "text": line.text}]}});
        std::fs::write(
            saved.join(crate::session_store::FILE),
            format!("{}\n{}\n", json!({"type": "session"}), message),
        )
        .unwrap();
        // Turn two is a new process: the same shape adds nothing, a new shape still gets its recipe.
        let mut runner = AfterDownload::new(
            Scripted([downloaded("data/a.csv"), downloaded("data/e.csv")].into()),
            dir.path(),
            true,
        );
        assert_eq!(
            call(&mut runner, "download_data").await,
            downloaded("data/a.csv")
        );
        let edges = blocks(&call(&mut runner, "download_data").await);
        assert_eq!(edges.len(), 2);
        assert!(edges[1].contains("Recipe for this data shape"));
        // Without a saved session the same shape is attached.
        let fresh = run_folder(&[("data/a.csv", &years())]);
        let mut first = AfterDownload::new(
            Scripted([downloaded("data/a.csv")].into()),
            fresh.path(),
            true,
        );
        assert_eq!(blocks(&call(&mut first, "download_data").await).len(), 2);
    }

    #[tokio::test]
    async fn a_second_download_of_a_different_shape_still_gets_its_recipe() {
        let dir = run_folder(&[("data/a.csv", &years()), ("data/e.csv", EDGES)]);
        let mut runner = AfterDownload::new(
            Scripted([downloaded("data/a.csv"), downloaded("data/e.csv")].into()),
            dir.path(),
            true,
        );
        let line = blocks(&call(&mut runner, "download_data").await);
        let sankey = blocks(&call(&mut runner, "download_data").await);
        assert_eq!((line.len(), sankey.len()), (2, 2));
        assert_ne!(line[1], sankey[1]);
        let alone = section(&[("data/e.csv".to_string(), dir.path().join("data/e.csv"))]).unwrap();
        assert_eq!(sankey[1], alone.text);
    }
}

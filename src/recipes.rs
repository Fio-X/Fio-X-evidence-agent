//! Opt-in (`NEWSROOM_SPEED_RECIPES=1`) method recipes appended to the first investigation prompt.
//! The program picks at most one recipe from the measured shape of the declared CSV tables, never
//! from the request text and never from the model. A recipe is method and pitfalls only: it is
//! not evidence, a source or a claim, and it changes no check.

use crate::data_profile::{shape_csv, TableShape};
use crate::hash::sha256_bytes;
use std::path::PathBuf;

pub const RECIPES_HEADING: &str =
    "\nRecipe for this data shape, chosen by the program from the measured table shape (method and pitfalls only: \
not evidence, not a source, not a claim, and it changes no check; record and verify every number you report as usual):\n";

struct Recipe {
    name: &'static str,
    body: &'static str,
    matches: fn(&TableShape) -> bool,
}

const RECIPES: [Recipe; 2] = [
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
];

/// A recipe the program loaded: its name and the sha256 of the exact text appended to the prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub name: &'static str,
    pub text: String,
    pub sha256: String,
}

fn column<'a>(shape: &'a TableShape, name: &str) -> Option<&'a crate::data_profile::ColumnShape> {
    shape.columns.iter().find(|c| c.name.eq_ignore_ascii_case(name))
}

/// One year column (integers in a calendar range, at least ten distinct), exactly one other
/// numeric column, and at most two text columns (an entity and its code).
fn is_year_value_table(shape: &TableShape) -> bool {
    let years: Vec<_> = shape
        .columns
        .iter()
        .filter(|c| c.name.to_ascii_lowercase().contains("year") && c.integer && c.distinct >= 10 && c.min >= 1000.0 && c.max <= 2200.0)
        .collect();
    if years.len() != 1 {
        return false;
    }
    let numeric_others = shape.columns.iter().filter(|c| c.numeric && c.name != years[0].name).count();
    let text = shape.columns.iter().filter(|c| !c.numeric).count();
    numeric_others == 1 && text <= 2
}

/// Columns named source, target and value; source and target are text, value is the only numeric column.
fn is_edge_table(shape: &TableShape) -> bool {
    let (Some(source), Some(target), Some(value)) = (column(shape, "source"), column(shape, "target"), column(shape, "value")) else {
        return false;
    };
    shape.rows >= 2 && !source.numeric && !target.numeric && value.numeric && shape.columns.iter().filter(|c| c.numeric).count() == 1
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

/// Recipe text for the declared local files, from their measured shape only.
/// Each pair is the path the model sees and the file to read it from.
pub fn section(files: &[(String, PathBuf)]) -> Option<Loaded> {
    let shapes: Vec<TableShape> = files.iter().filter_map(|(_, source)| shape_csv(source)).collect();
    let recipe = select(&shapes)?;
    let text = format!("{RECIPES_HEADING}{}", recipe.body);
    Some(Loaded {
        name: recipe.name,
        sha256: sha256_bytes(text.as_bytes()),
        text,
    })
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
        let two = "year,a,b\n".to_string() + &(1990..2005).map(|y| format!("{y},1.5,2.5\n")).collect::<String>();
        assert!(section(&[write(dir.path(), "two.csv", &two)]).is_none());
        assert!(section(&[write(dir.path(), "plain.csv", "name,score\nx,1.5\ny,2.5\n")]).is_none());
        // Fewer than ten years.
        let short = "year,rate\n".to_string() + &(2000..2005).map(|y| format!("{y},1.5\n")).collect::<String>();
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
            Recipe { name: "x", body: "", matches: |_| true },
            Recipe { name: "y", body: "", matches: |_| true },
        ];
        assert!(select_from(&both, &[shape.clone()]).is_none());
        assert_eq!(select_from(&both[..1], &[shape]).unwrap().name, "x");
        // Two tables that each match a different recipe: ambiguous, nothing loads.
        let files = [write(dir.path(), "t.csv", &years()), write(dir.path(), "e.csv", EDGES)];
        assert!(section(&files).is_none());
        // Two tables that match the same recipe: still that one recipe.
        let same = [write(dir.path(), "t1.csv", &years()), write(dir.path(), "t2.csv", &years())];
        assert_eq!(section(&same).unwrap().name, "line-over-years");
    }

    #[test]
    fn matching_reads_the_table_only_never_the_file_name_or_text() {
        let dir = tempfile::tempdir().unwrap();
        let (_, path) = write(dir.path(), "sankey-flow-line-over-years.csv", "name,score\nx,1.5\ny,2.5\n");
        assert!(section(&[("data/排名 sankey.csv".into(), path)]).is_none());
    }

    #[test]
    fn recipe_bodies_hold_no_digits_paths_or_ids() {
        for recipe in &RECIPES {
            let all = format!("{RECIPES_HEADING}{}", recipe.body);
            assert!(!all.chars().any(|c| c.is_ascii_digit()), "{}: digit in recipe text", recipe.name);
            for bad in ["/Users", "PJ004", "http", "README", ".md", "SKILL"] {
                assert!(!all.contains(bad), "{}: contains {bad}", recipe.name);
            }
            assert!(!recipe.body.starts_with("---"), "{}: frontmatter", recipe.name);
        }
    }
}

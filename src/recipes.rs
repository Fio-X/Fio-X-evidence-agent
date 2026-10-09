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

/// Columns named source and target (text) and exactly one numeric column, whatever its name
/// (value, value_ktoe, value_GtC, ...); at least two rows.
fn is_edge_table(shape: &TableShape) -> bool {
    let (Some(source), Some(target)) = (column(shape, "source"), column(shape, "target")) else {
        return false;
    };
    shape.rows >= 2 && !source.numeric && !target.numeric && shape.columns.iter().filter(|c| c.numeric).count() == 1
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
        is_edge_table(edges) && shapes.iter().enumerate().any(|(j, other)| i != j && is_origin_table(other))
    })
}

/// A complete names-by-years grid: one year column (three to nine distinct years), exactly one other numeric column,
/// a text name column with five to forty distinct names, rows = names x years, and no country-code column.
/// The year count range is disjoint from the line recipe (ten or more).
fn is_entity_year_grid(shape: &TableShape) -> bool {
    let years: Vec<_> = shape
        .columns
        .iter()
        .filter(|c| c.name.to_ascii_lowercase().contains("year") && c.integer && (3..=9).contains(&c.distinct) && c.min >= 1000.0 && c.max <= 2200.0)
        .collect();
    if years.len() != 1 {
        return false;
    }
    let numeric_others = shape.columns.iter().filter(|c| c.numeric && c.name != years[0].name).count();
    let coded = shape.columns.iter().any(|c| {
        let name = c.name.to_ascii_lowercase();
        !c.numeric && (name.contains("iso3") || name == "iso_code")
    });
    numeric_others == 1
        && !coded
        && shape.columns.iter().any(|c| !c.numeric && (5..=40).contains(&c.distinct) && shape.rows == c.distinct * years[0].distinct)
}

/// An edge table and a names-by-years grid with no country-coded table anywhere (else the map recipe takes it).
fn is_flow_with_grid(shapes: &[TableShape]) -> bool {
    shapes.iter().any(is_edge_table) && shapes.iter().any(is_entity_year_grid) && !shapes.iter().any(is_origin_table)
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
    let hits: Vec<&'static MultiRecipe> = MULTI_RECIPES.iter().filter(|r| (r.matches)(shapes)).collect();
    if hits.len() == 1 {
        hits.first().copied()
    } else {
        None
    }
}

/// Recipe text for the declared local files, from their measured shape only.
/// Each pair is the path the model sees and the file to read it from.
pub fn section(files: &[(String, PathBuf)]) -> Option<Loaded> {
    let shapes: Vec<TableShape> = files.iter().filter_map(|(_, source)| shape_csv(source)).collect();
    let (name, body) = match select_multi(&shapes) {
        Some(multi) => (multi.name, multi.body),
        None => {
            let recipe = select(&shapes)?;
            (recipe.name, recipe.body)
        }
    };
    let text = format!("{RECIPES_HEADING}{body}");
    Some(Loaded {
        name,
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
        let bodies = RECIPES.iter().map(|r| (r.name, r.body)).chain(MULTI_RECIPES.iter().map(|r| (r.name, r.body)));
        for (name, body) in bodies {
            let recipe = (name, body);
            let all = format!("{RECIPES_HEADING}{}", recipe.1);
            // The code-system name "iso3" is the one allowed digit; any other digit could be copied as a number.
            let without_code_name = all.replace("iso3", "");
            assert!(!without_code_name.chars().any(|c| c.is_ascii_digit()), "{}: digit in recipe text", recipe.0);
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
        assert_eq!(section(&[write(dir.path(), "e.csv", ENERGY)]).unwrap().name, "sankey-flow");
        let gtc = "source,target,value_GtC\nA,B,3.5\nB,C,1.5\n";
        assert_eq!(section(&[write(dir.path(), "g.csv", gtc)]).unwrap().name, "sankey-flow");
        // Two numeric columns, or a numeric source column: nothing.
        let two = "source,target,value_a,value_b\nA,B,3.5,1.5\nB,C,1.5,2.5\n";
        assert!(section(&[write(dir.path(), "two.csv", two)]).is_none());
        let numeric_source = "source,target,value\n1,B,3.5\n2,C,1.5\n";
        assert!(section(&[write(dir.path(), "n.csv", numeric_source)]).is_none());
    }

    #[test]
    fn edges_plus_a_country_coded_partner_table_load_the_map_recipe_and_it_wins() {
        let dir = tempfile::tempdir().unwrap();
        let files = [write(dir.path(), "e.csv", ENERGY), write(dir.path(), "oil.csv", OIL)];
        assert_eq!(section(&files).unwrap().name, "flow-with-origin-map");
        let reversed = [files[1].clone(), files[0].clone()];
        assert_eq!(section(&reversed).unwrap().name, "flow-with-origin-map");
        // Edges alone keep the sankey recipe; the partner table alone loads nothing.
        assert_eq!(section(&files[..1]).unwrap().name, "sankey-flow");
        assert!(section(&files[1..]).is_none());
        // A partner table whose code column is numeric, or has no iso name, is not a map source.
        let plain = "country,code,value\nUnited States,US,3.5\nNorway,NO,1.5\n";
        assert_eq!(section(&[files[0].clone(), write(dir.path(), "p.csv", plain)]).unwrap().name, "sankey-flow");
        let iso_code = "name,ISO_CODE,amount\nUnited States,USA,3.5\n";
        assert_eq!(section(&[files[0].clone(), write(dir.path(), "q.csv", iso_code)]).unwrap().name, "flow-with-origin-map");
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
        let line = write(dir.path(), "line.csv", &grid_csv(1, 12).replace("country", "name"));
        assert_eq!(section(&[line]).unwrap().name, "line-over-years");
        let ragged = grid_csv(15, 8).lines().take(100).collect::<Vec<_>>().join("\n") + "\n";
        assert!(section(&[write(dir.path(), "ragged.csv", &ragged)]).is_none());
        assert!(section(&[write(dir.path(), "few.csv", &grid_csv(3, 8))]).is_none());
        let coded = grid_csv(15, 8).replace("country,year", "country,iso3,year").lines().enumerate().map(|(i, l)| if i == 0 { l.to_string() } else { l.replacen(",", ",XXX,", 1) }).collect::<Vec<_>>().join("\n") + "\n";
        assert!(section(&[write(dir.path(), "coded.csv", &coded)]).is_none());
    }

    #[test]
    fn an_edge_table_plus_a_grid_loads_flow_with_grid_unless_a_code_table_is_present() {
        let dir = tempfile::tempdir().unwrap();
        let edges = write(dir.path(), "e.csv", ENERGY);
        let grid = write(dir.path(), "g.csv", &grid_csv(15, 8));
        assert_eq!(section(&[edges.clone(), grid.clone()]).unwrap().name, "flow-with-grid");
        assert_eq!(section(&[grid.clone(), edges.clone()]).unwrap().name, "flow-with-grid");
        // The map recipe keeps winning when a country-coded table exists.
        let oil = write(dir.path(), "oil.csv", OIL);
        assert_eq!(section(&[edges.clone(), grid.clone(), oil.clone()]).unwrap().name, "flow-with-origin-map");
        assert_eq!(section(&[edges, oil]).unwrap().name, "flow-with-origin-map");
        // Case one's Germany tables are unchanged by the new recipes.
    }
}

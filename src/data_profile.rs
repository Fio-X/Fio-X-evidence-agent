//! Opt-in (`NEWSROOM_SPEED_DATA_PROFILE=1`) program-measured profile of local CSV files,
//! added to the investigation prompt so the model need not spend turns on exploratory queries.
//! It is a convenience for the model only: it is never stored as a computation, source or
//! claim, so a number that appears only here cannot be verified.

use std::path::Path;

const MAX_COLUMNS: usize = 12;
const SAMPLE_ROWS: usize = 5;
const MAX_CELL_CHARS: usize = 40;
const MAX_FILE_BYTES: u64 = 8_000_000;

pub const PROFILE_HEADING: &str =
    "\nProgram-measured data profile (not evidence: it is not a recorded query, source or claim; \
compute every number you report with duckdb_query and record it with record_claim as usual):\n";

fn split_csv_line(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cell.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => cells.push(std::mem::take(&mut cell)),
            _ => cell.push(c),
        }
    }
    cells.push(cell);
    cells
}

fn clip(cell: &str) -> String {
    let cell = cell.trim();
    if cell.chars().count() > MAX_CELL_CHARS {
        let mut out: String = cell.chars().take(MAX_CELL_CHARS).collect();
        out.push('…');
        out
    } else {
        cell.to_string()
    }
}

/// Profile text for one CSV file, or `None` when it cannot be read as a plain CSV.
pub fn profile_csv(display_path: &str, path: &Path) -> Option<String> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
        != Some("csv")
    {
        return None;
    }
    if std::fs::metadata(path).ok()?.len() > MAX_FILE_BYTES {
        return Some(format!(
            "- {display_path}: skipped: file too large to profile (over {MAX_FILE_BYTES} bytes)\n"
        ));
    }
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines: Vec<Vec<String>> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| split_csv_line(l.trim_start_matches('\u{feff}')))
        .collect();
    // One title line above the header is skipped only when the two lines after it have the same
    // field count as each other (a stable row width); a ragged header is never mistaken for one.
    let skipped_titles = usize::from(
        lines.len() >= 3 && lines[0].len() != lines[1].len() && lines[1].len() == lines[2].len(),
    );
    lines.drain(..skipped_titles);
    let mut lines = lines.into_iter();
    let header = lines.next()?;
    let rows: Vec<Vec<String>> = lines.collect();
    let shown = header.len().min(MAX_COLUMNS);
    let mut out = format!(
        "- {display_path}: {} rows, {} columns\n",
        rows.len(),
        header.len()
    );
    if skipped_titles > 0 {
        out.push_str(&format!(
            "  (skipped {skipped_titles} leading line(s) whose field count differs from the two lines after it, taken as a title; the header is the next line)\n"
        ));
    }
    for (i, name) in header.iter().take(shown).enumerate() {
        let values: Vec<&str> = rows
            .iter()
            .filter_map(|r| r.get(i))
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .collect();
        let nulls = rows.len() - values.len();
        let numbers: Vec<f64> = values
            .iter()
            .filter_map(|v| v.parse::<f64>().ok())
            .collect();
        let range = if !values.is_empty() && numbers.len() == values.len() {
            let min = numbers.iter().cloned().fold(f64::INFINITY, f64::min);
            let max = numbers.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            format!("numeric, min {min}, max {max}")
        } else {
            let mut distinct: Vec<&str> = values.clone();
            distinct.sort_unstable();
            distinct.dedup();
            format!("text, {} distinct", distinct.len())
        };
        out.push_str(&format!("  - {}: {range}, {nulls} empty\n", clip(name)));
    }
    if header.len() > shown {
        out.push_str(&format!(
            "  - ({} more columns not shown)\n",
            header.len() - shown
        ));
    }
    out.push_str("  first rows:\n");
    for row in rows.iter().take(SAMPLE_ROWS) {
        let cells: Vec<String> = row.iter().take(shown).map(|c| clip(c)).collect();
        out.push_str(&format!("    {}\n", cells.join(" | ")));
    }
    Some(out)
}

/// Profile section for every local file that can be profiled; empty when none can.
/// Each pair is the path the model sees and the file to read it from.
pub fn profile_section(files: &[(String, std::path::PathBuf)]) -> String {
    let body: String = files
        .iter()
        .filter_map(|(shown, source)| profile_csv(shown, source))
        .collect();
    if body.is_empty() {
        String::new()
    } else {
        format!("{PROFILE_HEADING}{body}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub_birth_rate(dir: &Path) -> std::path::PathBuf {
        // Same shape as a one-series yearly table: 3 columns, 65 rows.
        let mut csv = String::from("year,country,birth_rate_per_1000\n");
        for y in 1960..2025 {
            csv.push_str(&format!("{y},China,{}\n", 40.0 - (y - 1960) as f64 * 0.45));
        }
        let path = dir.join("birth.csv");
        std::fs::write(&path, csv).unwrap();
        path
    }

    #[test]
    fn profile_names_columns_ranges_and_sample_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = stub_birth_rate(dir.path());
        let section = profile_section(&[("data/birth.csv".to_string(), path)]);
        assert!(section.contains("65 rows, 3 columns"), "{section}");
        assert!(
            section.contains("year: numeric, min 1960, max 2024"),
            "{section}"
        );
        assert!(section.contains("country: text, 1 distinct"), "{section}");
        assert!(section.contains("not evidence"), "{section}");
        assert_eq!(section.matches("\n    19").count(), SAMPLE_ROWS);
        assert!(
            section.len() < 1500,
            "profile grew to {} bytes",
            section.len()
        );
    }

    #[test]
    fn unreadable_or_non_csv_files_add_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let json = dir.path().join("a.json");
        std::fs::write(&json, "{}").unwrap();
        let missing = dir.path().join("none.csv");
        assert_eq!(
            profile_section(&[
                ("data/a.json".to_string(), json),
                ("data/none.csv".to_string(), missing)
            ]),
            ""
        );
    }

    #[test]
    fn quoted_commas_stay_in_one_cell() {
        assert_eq!(
            split_csv_line("a,\"b,c\",\"d\"\"e\""),
            vec!["a", "b,c", "d\"e"]
        );
    }

    #[test]
    fn title_line_is_skipped_and_said_so() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("titled.csv");
        std::fs::write(
            &path,
            "Births per 1000\nyear,country,rate\n2020,China,8.5\n",
        )
        .unwrap();
        let text = profile_csv("data/titled.csv", &path).unwrap();
        assert!(text.contains("1 rows, 3 columns"), "{text}");
        assert!(text.contains("skipped 1 leading line"), "{text}");
        assert!(text.contains("- year: numeric"), "{text}");
    }

    #[test]
    fn oversized_file_is_reported_as_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.csv");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_FILE_BYTES + 1).unwrap();
        let text = profile_csv("data/big.csv", &path).unwrap();
        assert!(text.contains("skipped: file too large"), "{text}");
    }

    #[test]
    fn a_ragged_header_is_not_mistaken_for_a_title_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ragged.csv");
        std::fs::write(&path, "a,b,c\n1,2\n3,4,5\n6,7,8\n").unwrap();
        let text = profile_csv("data/ragged.csv", &path).unwrap();
        assert!(!text.contains("skipped"), "{text}");
        assert!(
            text.contains("- a: numeric") || text.contains("- a: text"),
            "{text}"
        );
    }
}

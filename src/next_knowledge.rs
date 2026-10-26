//! New route, knowledge group: its one group command. Another group reaches the catalogue only through `call`, with a `Request`
//! and back a `Reply` (both shared types under rule one); the catalogue itself (l5geo.rs) stays this group's. The opened catalogue
//! is a handle the caller keeps for the run (loaded once, about 1.4 seconds): this module holds no state of its own, so two runs
//! (or two tests) in one process may open different directories.

use crate::l5geo::{Catalog, Place, Ranking, TableMeta};
use serde_json::Value;
use std::path::Path;

/// One opened catalogue directory. Its fields are this group's: the caller only passes it back in later requests.
pub struct Opened {
    catalog: Catalog,
}

pub enum Request<'a> {
    /// Reads SOURCE.json first, so a wrong directory stops before the load; then the catalogue's original files.
    OpenCatalogue { dir: &'a Path },
    /// The first five tables for the Chinese question and the English search texts, with the scope and places it judged.
    Top5 {
        catalogue: &'a Opened,
        question: &'a str,
        texts: &'a [String],
    },
    /// English place names in the search texts that the question does not name.
    PlacesOutside {
        catalogue: &'a Opened,
        question: &'a str,
        texts: &'a [String],
    },
    /// The dimensions and codes of one listed table.
    Table { catalogue: &'a Opened, id: &'a str },
    /// The places the Chinese question names.
    Places {
        catalogue: &'a Opened,
        question: &'a str,
    },
}

pub enum Reply {
    /// The handle and SOURCE.json of the directory (the original files and their hashes).
    Opened {
        catalogue: Opened,
        source: Value,
    },
    Ranking(Ranking),
    Names(Vec<String>),
    Table(Option<TableMeta>),
    Places(Vec<Place>),
}

/// The knowledge group's command. Only opening a directory can fail; the reading requests are pure.
pub fn call(request: Request<'_>) -> Result<Reply, String> {
    Ok(match request {
        Request::OpenCatalogue { dir } => {
            let source = std::fs::read_to_string(dir.join("SOURCE.json"))
                .map_err(|e| e.to_string())
                .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
                .map_err(|e| format!("SOURCE.json cannot be read: {e}"))?;
            let catalog =
                Catalog::load(dir).map_err(|e| format!("the catalogue cannot be read: {e:#}"))?;
            Reply::Opened {
                catalogue: Opened { catalog },
                source,
            }
        }
        Request::Top5 {
            catalogue,
            question,
            texts,
        } => Reply::Ranking(catalogue.catalog.top5(question, texts)),
        Request::PlacesOutside {
            catalogue,
            question,
            texts,
        } => Reply::Names(catalogue.catalog.places_outside(question, texts)),
        Request::Table { catalogue, id } => Reply::Table(catalogue.catalog.table(id)),
        Request::Places {
            catalogue,
            question,
        } => Reply::Places(catalogue.catalog.places(question)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_without_source_or_catalogue_files_cannot_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let opened = |dir: &Path| call(Request::OpenCatalogue { dir }).err().unwrap();
        assert!(opened(dir.path()).starts_with("SOURCE.json cannot be read"));
        std::fs::write(dir.path().join("SOURCE.json"), "{}").unwrap();
        assert!(opened(dir.path()).starts_with("the catalogue cannot be read"));
    }
}

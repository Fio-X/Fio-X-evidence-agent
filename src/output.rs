use anyhow::{Context, Result};
use chrono::Utc;
use std::env;
use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

/// Resolve a user supplied output path from the directory in which `news`
/// was started. Keeping an absolute path after argument parsing prevents a
/// child process or a later `chdir` from sending artifacts somewhere else.
pub fn resolve_output_dir(requested: &Path) -> Result<PathBuf> {
    let cwd = env::current_dir().context("failed to determine the CLI working directory")?;
    if requested.is_absolute() {
        Ok(requested.to_path_buf())
    } else {
        Ok(cwd.join(requested))
    }
}

/// Print the effective destination and, when explicitly requested, obtain a
/// human confirmation before the first write. The default remains
/// non-interactive so scripts and qualification runs cannot hang on stdin.
pub fn announce_and_confirm(root: &Path, confirm: bool) -> Result<()> {
    eprintln!("[agent] output_root={}", root.display());
    if !confirm {
        return Ok(());
    }
    if !io::stdin().is_terminal() {
        anyhow::bail!(
            "--confirm-output requires an interactive terminal; pass an explicit --out path or omit confirmation"
        );
    }

    eprint!(
        "Write investigation artifacts to {}? [y/N] ",
        root.display()
    );
    io::stderr()
        .flush()
        .context("failed to flush output confirmation prompt")?;
    let mut answer = String::new();
    io::stdin()
        .lock()
        .read_line(&mut answer)
        .context("failed to read output confirmation")?;
    if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        Ok(())
    } else {
        anyhow::bail!("output cancelled by user")
    }
}

/// Create a deterministic, human-readable run directory below a resolved
/// output root. The timestamp keeps separate invocations independent while
/// the slug makes the folder easy to find from a shell.
pub fn create_run_dir(root: &Path, label: &str) -> Result<PathBuf> {
    fs::create_dir_all(root)
        .with_context(|| format!("failed to create output root: {}", root.display()))?;
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let id = format!("{}-{}", timestamp, slugify(label));
    let dir = root.join(id);
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create output run directory: {}", dir.display()))?;
    Ok(dir)
}

/// Runtime tools use this location when they are called by the ephemeral
/// `investigate-v2` command. A command may set `NEWSROOM_OUTPUT_DIR` to keep
/// every generated HTML/SVG below the same user-visible run directory.
pub fn runtime_output_dir() -> Result<PathBuf> {
    let requested = env::var_os("NEWSROOM_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".newsroom/output"));
    let root = resolve_output_dir(&requested)?;
    fs::create_dir_all(&root).with_context(|| {
        format!(
            "failed to create runtime output directory: {}",
            root.display()
        )
    })?;
    Ok(root)
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 48 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "run".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_output_is_based_on_current_directory() {
        let cwd = env::current_dir().expect("cwd");
        assert_eq!(
            resolve_output_dir(Path::new(".newsroom/artifacts")).unwrap(),
            cwd.join(".newsroom/artifacts")
        );
    }

    #[test]
    fn absolute_output_is_preserved() {
        let requested = PathBuf::from("/tmp/newsroom-output-test");
        assert_eq!(resolve_output_dir(&requested).unwrap(), requested);
    }

    #[test]
    fn non_confirming_path_never_reads_stdin() {
        announce_and_confirm(Path::new("/tmp/newsroom-output-test"), false).unwrap();
    }
}

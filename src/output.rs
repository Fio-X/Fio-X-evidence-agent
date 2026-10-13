use anyhow::{Context, Result};
use std::env;
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

use anyhow::{Context, Result};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// Only newsroom/provider settings are accepted from a project .env. This
// prevents a local file from unexpectedly changing PATH, shell behaviour or
// unrelated child-process settings.
const ALLOWED_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "DRAGONCODE_API_KEY",
    "DRAGONCODE_BASE_URL",
    "NEWSROOM_API_KEY",
    "NEWSROOM_ARTIFACTS_DIR",
    "NEWSROOM_BASE_URL",
    "NEWSROOM_MODEL",
    "NEWSROOM_OUTPUT_DIR",
    "NEWSROOM_PI_BIN",
    "NEWSROOM_PI_MODEL",
    "NEWSROOM_PI_PROVIDER",
    "NEWSROOM_PI_THINKING",
    "NEWSROOM_PROVIDER",
    "NEWSROOM_TOOL_PROFILE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
];

/// Load provider and newsroom settings from a project-local `.env` without
/// replacing values already supplied by the shell. An explicit
/// `NEWSROOM_ENV_FILE` may point at an external/symlinked file; the CLI never
/// copies or rewrites it.
pub fn load_project_env() -> Result<()> {
    let explicit_path = env::var_os("NEWSROOM_ENV_FILE").map(PathBuf::from);
    let candidates = if let Some(path) = explicit_path.as_ref() {
        vec![path.clone()]
    } else {
        let mut paths = vec![PathBuf::from(".env")];
        if let Some(path) = user_config_env_path() {
            if !paths.iter().any(|candidate| candidate == &path) {
                paths.push(path);
            }
        }
        paths
    };
    let Some(path) = candidates.into_iter().find(|candidate| candidate.is_file()) else {
        if let Some(path) = explicit_path {
            anyhow::bail!(
                "NEWSROOM_ENV_FILE does not point to a readable file: {}",
                path.display()
            );
        }
        return Ok(());
    };

    let text = fs::read_to_string(&path)
        .with_context(|| format!("failed to read environment file: {}", path.display()))?;
    let mut applied = 0usize;
    for line in text.lines() {
        let Some((key, value)) = parse_assignment(line) else {
            continue;
        };
        if !ALLOWED_KEYS.contains(&key.as_str()) || env::var_os(&key).is_some() {
            continue;
        }
        env::set_var(&key, value);
        applied += 1;
    }

    eprintln!(
        "[config] loaded {} newsroom setting(s) from {} (existing environment preserved)",
        applied,
        path.display()
    );
    Ok(())
}

/// Allow an installed `news` binary to find the user's existing external
/// config when it is launched from a story directory that has no `.env`.
/// This is only a fallback; a cwd `.env` or explicit `NEWSROOM_ENV_FILE` wins.
fn user_config_env_path() -> Option<PathBuf> {
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(base.join("fio-x").join(".env"))
}

fn parse_assignment(line: &str) -> Option<(String, String)> {
    let mut line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    if let Some(rest) = line.strip_prefix("export ") {
        line = rest.trim_start();
    }
    let (key, raw_value) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return None;
    }
    let value = unquote_value(raw_value.trim());
    Some((key.to_string(), value))
}

fn unquote_value(value: &str) -> String {
    let value = value.trim();
    if let Some(&quote) = value
        .as_bytes()
        .first()
        .filter(|byte| **byte == b'"' || **byte == b'\'')
    {
        if let Some(relative_end) = value.as_bytes()[1..].iter().position(|byte| *byte == quote) {
            let end = relative_end + 1;
            let remainder = value[end + 1..].trim();
            if remainder.is_empty() || remainder.starts_with('#') {
                return value[1..end].to_string();
            }
        }
    }
    value
        .split_once(" #")
        .map(|(head, _)| head.trim_end())
        .unwrap_or(value)
        .to_string()
}

#[allow(dead_code)]
fn is_external_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_export_quotes_and_comments() {
        assert_eq!(
            parse_assignment("export NEWSROOM_PI_MODEL='claude-sonnet-4-6' # pinned"),
            Some((
                "NEWSROOM_PI_MODEL".to_string(),
                "claude-sonnet-4-6".to_string()
            ))
        );
        assert_eq!(parse_assignment("# ignored"), None);
        assert_eq!(parse_assignment("NOT VALID=value"), None);
    }

    #[test]
    fn identifies_external_symlink_without_following_or_writing() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = root.path().join("external.env");
        fs::write(&target, "NEWSROOM_PI_MODEL=test\n").expect("write target");
        let link = root.path().join(".env");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        #[cfg(unix)]
        assert!(is_external_symlink(&link));
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "NEWSROOM_PI_MODEL=test\n"
        );
    }

    #[test]
    fn user_config_path_uses_xdg_directory_when_available() {
        let previous = env::var_os("XDG_CONFIG_HOME");
        env::set_var("XDG_CONFIG_HOME", "/tmp/fio-x-config-test");
        assert_eq!(
            user_config_env_path().unwrap(),
            PathBuf::from("/tmp/fio-x-config-test/fio-x/.env")
        );
        match previous {
            Some(value) => env::set_var("XDG_CONFIG_HOME", value),
            None => env::remove_var("XDG_CONFIG_HOME"),
        }
    }
}

use anyhow::{Context, Result};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// Only newsroom/provider settings are accepted from a project .env. This
// prevents a local file from unexpectedly changing PATH, shell behaviour or
// unrelated child-process settings.
const ALLOWED_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
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
    "NEWSROOM_RELAY_API_KEY",
    "NEWSROOM_RELAY_BASE_URL",
    "NEWSROOM_RELAY_MODEL",
    "NEWSROOM_TOOL_PROFILE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ZAI_API_KEY",
    "ZHIPUAI_API_KEY",
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
        apply_saved_login();
        return Ok(());
    };

    let text = fs::read_to_string(&path)
        .with_context(|| format!("failed to read environment file: {}", path.display()))?;
    let mut applied = 0usize;
    for line in text.lines() {
        let Some((key, value)) = parse_assignment(line) else {
            continue;
        };
        if !key_allowed(&key) || env::var_os(&key).is_some() {
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
    apply_saved_login();
    Ok(())
}

/// The one place that holds the names the relay provider was first saved and exported under: its provider id, its three variables and
/// its public address. legacy alias, kept so existing local setups keep working: each of these still resolves to the relay provider
/// (id `relay`, variables `NEWSROOM_RELAY_*`), and nothing else in the repository spells them.
pub struct LegacyRelay {
    pub provider: &'static str,
    pub key: &'static str,
    pub base_url: &'static str,
    pub model: &'static str,
    pub url: &'static str,
}

pub const LEGACY_RELAY: LegacyRelay = LegacyRelay {
    provider: "dragoncode",
    key: "DRAGONCODE_API_KEY",
    base_url: "DRAGONCODE_BASE_URL",
    model: "DRAGONCODE_MODEL",
    url: "https://dragoncode.codes",
};

/// The provider id of the relay route (an Anthropic Messages-compatible endpoint behind an OpenAI-style key and address).
pub const RELAY_PROVIDER: &str = "relay";
pub const RELAY_KEY: &str = "NEWSROOM_RELAY_API_KEY";
pub const RELAY_BASE_URL: &str = "NEWSROOM_RELAY_BASE_URL";

/// The relay provider's id as the program spells it: the legacy id becomes `relay`, anything else stays as given.
pub fn canonical_provider(provider: &str) -> &str {
    if provider == LEGACY_RELAY.provider {
        RELAY_PROVIDER
    } else {
        provider
    }
}

/// True for the relay's own id and for its legacy alias.
pub fn is_relay_provider(provider: &str) -> bool {
    canonical_provider(provider) == RELAY_PROVIDER
}

/// Every key and address name the relay can arrive under, current names first, then the legacy ones.
pub fn relay_key_names() -> [&'static str; 2] {
    [RELAY_KEY, LEGACY_RELAY.key]
}

pub fn relay_base_url_names() -> [&'static str; 2] {
    [RELAY_BASE_URL, LEGACY_RELAY.base_url]
}

/// Whether a project `.env` may set this name: the allow list above plus the legacy relay variables.
fn key_allowed(key: &str) -> bool {
    ALLOWED_KEYS.contains(&key)
        || [LEGACY_RELAY.key, LEGACY_RELAY.base_url, LEGACY_RELAY.model].contains(&key)
}

const MODEL_KEY_NAMES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "NEWSROOM_API_KEY",
    "NEWSROOM_RELAY_API_KEY",
    "OPENAI_API_KEY",
    "ZAI_API_KEY",
    "ZHIPUAI_API_KEY",
];

/// Every name a model key can arrive under. When any of them is already set (by the shell or a `.env`), the saved login is not read at all.
pub fn model_key_names() -> impl Iterator<Item = &'static str> {
    MODEL_KEY_NAMES.iter().copied().chain([LEGACY_RELAY.key])
}

#[cfg(test)]
pub fn is_model_key_name(name: &str) -> bool {
    model_key_names().any(|known| known == name)
}

/// The providers `news login` can save, with the variable names each one is read under. Only Anthropic Messages routes: the built-in
/// agent speaks nothing else.
pub struct ProviderNames {
    pub provider: &'static str,
    pub key: &'static str,
    pub base_url: &'static str,
}

pub const PROVIDERS: &[ProviderNames] = &[
    ProviderNames {
        provider: "anthropic",
        key: "ANTHROPIC_API_KEY",
        base_url: "ANTHROPIC_BASE_URL",
    },
    ProviderNames {
        provider: RELAY_PROVIDER,
        key: RELAY_KEY,
        base_url: RELAY_BASE_URL,
    },
];

pub fn provider_names(provider: &str) -> Option<&'static ProviderNames> {
    let provider = canonical_provider(provider);
    PROVIDERS.iter().find(|p| p.provider == provider)
}

/// What `news login` saves: one `[default]` profile. The key never shows in `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct SavedLogin {
    pub provider: String,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub api_key: String,
}

impl std::fmt::Debug for SavedLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SavedLogin")
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .field("api_key", &mask_key(&self.api_key))
            .finish()
    }
}

/// The key as `news login --show` prints it: the first 8 and last 4 characters, the middle hidden. A key of 16 characters or fewer shows nothing of itself.
pub fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 16 {
        return "*".repeat(8);
    }
    let head: String = chars[..8].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}{}{tail}", "*".repeat(8))
}

/// `$XDG_CONFIG_HOME/fio-x/credentials`, else `$HOME/.config/fio-x/credentials`.
pub fn credentials_path() -> Option<PathBuf> {
    credentials_path_from(env::var_os("XDG_CONFIG_HOME"), env::var_os("HOME"))
}

fn credentials_path_from(
    xdg_config_home: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    user_config_env_path_from(xdg_config_home, home).map(|p| p.with_file_name("credentials"))
}

static SAVED_LOGIN_IN_USE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// True once this process took its model key from the saved login (no key came from the shell or a `.env`).
pub fn saved_login_in_use() -> bool {
    SAVED_LOGIN_IN_USE.load(std::sync::atomic::Ordering::Relaxed)
}

/// After the `.env` step: when no model key is in the environment, take the saved login (if any) as the configuration, without replacing a
/// provider, model or address the shell already set. The note names the file, provider and model only, never the key or any part of it.
fn apply_saved_login() {
    if model_key_names().any(|name| env::var_os(name).is_some_and(|v| !v.is_empty())) {
        return;
    }
    let Some(path) = credentials_path() else {
        return;
    };
    if !path.exists() {
        return;
    }
    let login = match read_credentials(&path) {
        Ok(Some(login)) => login,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[config] saved login not used: {error:#}");
            return;
        }
    };
    let Some(names) = provider_names(&login.provider) else {
        eprintln!(
            "[config] saved login not used: unknown provider `{}` in {} (run `news login` again)",
            login.provider,
            path.display()
        );
        return;
    };
    let set_if_unset = |name: &str, value: &str| {
        if env::var_os(name).is_none() {
            env::set_var(name, value);
        }
    };
    set_if_unset("NEWSROOM_PI_PROVIDER", names.provider);
    if let Some(model) = &login.model {
        set_if_unset("NEWSROOM_PI_MODEL", model);
    }
    if let Some(base_url) = &login.base_url {
        // the relay's address may already be set under any of its names (the legacy one included): the person's value wins
        let relay_bases = relay_base_url_names();
        let own = [names.base_url];
        let base_names: &[&str] = if is_relay_provider(names.provider) {
            &relay_bases
        } else {
            &own
        };
        if base_names.iter().all(|name| env::var_os(name).is_none()) {
            env::set_var(names.base_url, base_url);
        }
    }
    env::set_var(names.key, &login.api_key);
    SAVED_LOGIN_IN_USE.store(true, std::sync::atomic::Ordering::Relaxed);
    eprintln!(
        "[config] using the saved login from {} (provider {}, model {})",
        path.display(),
        login.provider,
        login.model.as_deref().unwrap_or("default")
    );
}

/// Read the saved login. `Ok(None)`: the file has no `[default]` profile with a key. A file that others can read or write is refused (as ssh
/// refuses a private key with loose permissions); the error says how to fix it and never quotes the file.
pub fn read_credentials(path: &Path) -> Result<Option<SavedLogin>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .with_context(|| format!("cannot read {}", path.display()))?
            .permissions()
            .mode()
            & 0o777;
        if mode & 0o077 != 0 {
            anyhow::bail!(
                "{} has permissions {:o}; it must be readable by you only. Fix it with `chmod 600 {}`, or run `news login` again",
                path.display(),
                mode,
                path.display()
            );
        }
    }
    let text =
        fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    Ok(parse_credentials(&text))
}

/// A small reader for the one table `news login` writes: `[default]` with `key = "string"` lines. Other tables and comments are skipped;
/// a malformed line is skipped too (its text is never echoed, since it may hold a key).
fn parse_credentials(text: &str) -> Option<SavedLogin> {
    let mut in_default = false;
    let mut fields: std::collections::BTreeMap<String, String> = Default::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_default = line.trim_end_matches([' ', '\t']) == "[default]";
            continue;
        }
        if !in_default {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let Some(value) = toml_string(value.trim()) else {
            continue;
        };
        fields.insert(key.trim().to_string(), value);
    }
    let api_key = fields.remove("api_key").filter(|v| !v.is_empty())?;
    Some(SavedLogin {
        provider: fields
            .remove("provider")
            .unwrap_or_else(|| "anthropic".to_string()),
        model: fields.remove("model").filter(|v| !v.is_empty()),
        base_url: fields.remove("base_url").filter(|v| !v.is_empty()),
        api_key,
    })
}

/// One TOML basic string (`"..."` with `\\`, `\"`, `\n`, `\t` escapes) or literal string (`'...'`), with an optional trailing comment.
fn toml_string(raw: &str) -> Option<String> {
    let mut chars = raw.chars();
    match chars.next()? {
        '\'' => {
            let rest = &raw[1..];
            let end = rest.find('\'')?;
            let after = rest[end + 1..].trim();
            (after.is_empty() || after.starts_with('#')).then(|| rest[..end].to_string())
        }
        '"' => {
            let mut out = String::new();
            let mut escaped = false;
            for (index, c) in raw.char_indices().skip(1) {
                if escaped {
                    out.push(match c {
                        'n' => '\n',
                        't' => '\t',
                        '"' => '"',
                        '\\' => '\\',
                        _ => return None,
                    });
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    let after = raw[index + 1..].trim();
                    return (after.is_empty() || after.starts_with('#')).then_some(out);
                } else {
                    out.push(c);
                }
            }
            None
        }
        _ => None,
    }
}

fn toml_quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn render_credentials(login: &SavedLogin) -> String {
    let mut text = String::from(
        "# Written by `news login`. Keep this file private (permissions 600).\n[default]\n",
    );
    text.push_str(&format!("provider = {}\n", toml_quote(&login.provider)));
    if let Some(model) = &login.model {
        text.push_str(&format!("model = {}\n", toml_quote(model)));
    }
    if let Some(base_url) = &login.base_url {
        text.push_str(&format!("base_url = {}\n", toml_quote(base_url)));
    }
    text.push_str(&format!("api_key = {}\n", toml_quote(&login.api_key)));
    text
}

/// Write the saved login with permissions 600 (its folder 700) through the guard's private-file writer, which writes only this file and
/// only while `news login` runs.
pub fn write_credentials(path: &Path, login: &SavedLogin) -> Result<()> {
    crate::group_guard::write_private_file(path, render_credentials(login).as_bytes())
        .with_context(|| format!("cannot write {}", path.display()))
}

/// Allow an installed `news` binary to find the user's existing external
/// config when it is launched from a story directory that has no `.env`.
/// This is only a fallback; a cwd `.env` or explicit `NEWSROOM_ENV_FILE` wins.
fn user_config_env_path() -> Option<PathBuf> {
    user_config_env_path_from(env::var_os("XDG_CONFIG_HOME"), env::var_os("HOME"))
}

/// The pure rule behind `user_config_env_path`, so a test can check it without changing the process environment.
fn user_config_env_path_from(
    xdg_config_home: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    let base = xdg_config_home
        .map(PathBuf::from)
        .or_else(|| home.map(|home| PathBuf::from(home).join(".config")))?;
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

    /// `XDG_CONFIG_HOME` pointed at a fresh folder for one test, so `credentials_path()` (the one file `news login` may write)
    /// is `<folder>/fio-x/credentials`; holds the process-wide environment lock and puts the variable back on drop.
    struct CredentialsHome {
        root: tempfile::TempDir,
        before: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl CredentialsHome {
        fn new() -> Self {
            let lock = crate::pi::ENV_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let root = tempfile::tempdir().expect("tempdir");
            let before = env::var_os("XDG_CONFIG_HOME");
            env::set_var("XDG_CONFIG_HOME", root.path());
            Self {
                root,
                before,
                _lock: lock,
            }
        }

        fn path(&self) -> PathBuf {
            self.root.path().join("fio-x").join("credentials")
        }
    }

    impl Drop for CredentialsHome {
        fn drop(&mut self) {
            match self.before.take() {
                Some(value) => env::set_var("XDG_CONFIG_HOME", value),
                None => env::remove_var("XDG_CONFIG_HOME"),
            }
        }
    }

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
    fn provider_credentials_required_by_supported_routes_are_whitelisted() {
        for key in [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "DEEPSEEK_API_KEY",
            "KIMI_API_KEY",
            "MOONSHOT_API_KEY",
            "ZAI_API_KEY",
            "ZHIPUAI_API_KEY",
            "NEWSROOM_RELAY_API_KEY",
            "OPENAI_BASE_URL",
            "NEWSROOM_RELAY_BASE_URL",
            "NEWSROOM_RELAY_MODEL",
            LEGACY_RELAY.key,
            LEGACY_RELAY.base_url,
            LEGACY_RELAY.model,
        ] {
            assert!(key_allowed(key), "missing .env allowlist key: {key}");
        }
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
        assert_eq!(
            user_config_env_path_from(Some("/tmp/fio-x-config-test".into()), Some("/h".into()))
                .unwrap(),
            PathBuf::from("/tmp/fio-x-config-test/fio-x/.env")
        );
        assert_eq!(
            user_config_env_path_from(None, Some("/h".into())).unwrap(),
            PathBuf::from("/h/.config/fio-x/.env")
        );
        assert!(user_config_env_path_from(None, None).is_none());
    }

    const FAKE: &str = "sk-fake-0123456789abcdefWXYZ";

    fn fake_login() -> SavedLogin {
        SavedLogin {
            provider: "anthropic".into(),
            model: Some("claude-sonnet-4-6".into()),
            base_url: Some("http://127.0.0.1:9".into()),
            api_key: FAKE.into(),
        }
    }

    #[test]
    fn credentials_live_next_to_the_user_env_file() {
        assert_eq!(
            credentials_path_from(None, Some("/h".into())).unwrap(),
            PathBuf::from("/h/.config/fio-x/credentials")
        );
        assert_eq!(
            credentials_path_from(Some("/x".into()), Some("/h".into())).unwrap(),
            PathBuf::from("/x/fio-x/credentials")
        );
    }

    #[test]
    fn a_saved_login_roundtrips_with_mode_600_and_odd_characters() {
        let home = CredentialsHome::new();
        let _login = crate::group_guard::command_for_test("login");
        let path = home.path();
        let mut login = fake_login();
        login.api_key = "sk-\"quoted\\back#hash-0123456789".into();
        write_credentials(&path, &login).unwrap();
        assert_eq!(read_credentials(&path).unwrap(), Some(login.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        // a second save replaces the first and leaves no staging file behind
        login.model = None;
        write_credentials(&path, &login).unwrap();
        assert_eq!(read_credentials(&path).unwrap(), Some(login));
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_others_can_read_is_refused_with_the_fix_and_without_its_text() {
        use std::os::unix::fs::PermissionsExt;
        let home = CredentialsHome::new();
        let _login = crate::group_guard::command_for_test("login");
        let path = home.path();
        write_credentials(&path, &fake_login()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let error = format!("{:#}", read_credentials(&path).unwrap_err());
        assert!(error.contains("chmod 600"), "{error}");
        assert!(
            !error.contains(&FAKE[..8]) && !error.contains(&FAKE[FAKE.len() - 4..]),
            "{error}"
        );
    }

    #[test]
    fn the_reader_takes_only_the_default_table_and_never_needs_a_key_line_echoed() {
        let text = "# c\n[other]\napi_key = \"nope-nope-nope-nope\"\n[default]\nprovider = 'relay' # trailing\napi_key = \"k-0123456789abcdef\"\nbroken line\nmodel = \"m\"\n";
        let login = parse_credentials(text).unwrap();
        assert_eq!(login.provider, "relay");
        assert_eq!(login.api_key, "k-0123456789abcdef");
        assert_eq!(login.model.as_deref(), Some("m"));
        assert_eq!(login.base_url, None);
        assert_eq!(
            parse_credentials("[default]\nprovider = \"anthropic\"\n"),
            None
        );
    }

    #[test]
    fn the_mask_shows_eight_then_four_and_nothing_of_a_short_key() {
        assert_eq!(mask_key(FAKE), "sk-fake-********WXYZ");
        assert_eq!(mask_key("short-key-123456"), "********");
        assert!(!format!("{:?}", fake_login()).contains(FAKE));
    }

    #[test]
    fn every_saved_provider_reads_a_key_name_the_env_file_also_accepts() {
        for names in PROVIDERS {
            assert!(is_model_key_name(names.key), "{}", names.provider);
            assert!(key_allowed(names.key), "{}", names.provider);
        }
    }

    #[test]
    fn a_saved_login_does_not_override_an_address_set_under_the_legacy_name() {
        use std::os::unix::fs::PermissionsExt;
        let home = CredentialsHome::new();
        let names = [
            "NEWSROOM_PI_PROVIDER",
            "NEWSROOM_PI_MODEL",
            RELAY_KEY,
            RELAY_BASE_URL,
            LEGACY_RELAY.base_url,
        ];
        let before: Vec<_> = names
            .iter()
            .chain(model_key_names().collect::<Vec<_>>().iter())
            .map(|n| (*n, env::var_os(n)))
            .collect();
        for (name, _) in &before {
            env::remove_var(name);
        }
        let saved = SavedLogin {
            provider: LEGACY_RELAY.provider.to_string(),
            model: None,
            base_url: Some("https://saved.example.invalid".to_string()),
            api_key: "k-0123456789abcdef".to_string(),
        };
        let path = home.path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, render_credentials(&saved)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        // the address is set only under the legacy name: the saved login leaves it alone and writes no second name
        env::set_var(LEGACY_RELAY.base_url, "https://shell.example.invalid");
        apply_saved_login();
        let resolved = relay_base_url_names()
            .iter()
            .find_map(|name| env::var(name).ok());
        let wrote_new_name = env::var_os(RELAY_BASE_URL).is_some();
        let provider = env::var("NEWSROOM_PI_PROVIDER").ok();
        let key_taken = env::var(RELAY_KEY).ok();

        // nothing set: the saved address is applied under the current name
        env::remove_var(LEGACY_RELAY.base_url);
        env::remove_var(RELAY_KEY);
        env::remove_var("NEWSROOM_PI_PROVIDER");
        apply_saved_login();
        let applied = env::var(RELAY_BASE_URL).ok();

        for (name, value) in before {
            match value {
                Some(v) => env::set_var(name, v),
                None => env::remove_var(name),
            }
        }
        SAVED_LOGIN_IN_USE.store(false, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(resolved.as_deref(), Some("https://shell.example.invalid"));
        assert!(!wrote_new_name);
        assert_eq!(provider.as_deref(), Some(RELAY_PROVIDER));
        assert_eq!(key_taken.as_deref(), Some("k-0123456789abcdef"));
        assert_eq!(applied.as_deref(), Some("https://saved.example.invalid"));
    }

    #[test]
    fn the_legacy_relay_names_still_resolve_to_the_relay_provider() {
        // a login saved under the old provider id is read as the relay provider, with the relay's variables
        let names = provider_names(LEGACY_RELAY.provider).expect("the legacy id resolves");
        assert_eq!(names.provider, RELAY_PROVIDER);
        assert_eq!(names.key, RELAY_KEY);
        assert_eq!(names.base_url, RELAY_BASE_URL);
        assert_eq!(canonical_provider(LEGACY_RELAY.provider), RELAY_PROVIDER);
        assert!(is_relay_provider(LEGACY_RELAY.provider) && is_relay_provider(RELAY_PROVIDER));
        assert!(!is_relay_provider("anthropic"));
        // the old variables are still read from a `.env`, still count as a model key, and the new ones do too
        for name in [LEGACY_RELAY.key, LEGACY_RELAY.base_url, LEGACY_RELAY.model] {
            assert!(key_allowed(name), "{name}");
        }
        assert!(is_model_key_name(LEGACY_RELAY.key));
        assert!(is_model_key_name(RELAY_KEY));
        assert!(relay_key_names().contains(&LEGACY_RELAY.key));
        assert!(relay_base_url_names().contains(&LEGACY_RELAY.base_url));
        // a saved file written under the old id parses and keeps its provider text
        let text = format!(
            "[default]\nprovider = '{}'\napi_key = \"k-0123456789abcdef\"\n",
            LEGACY_RELAY.provider
        );
        let login = parse_credentials(&text).unwrap();
        assert!(provider_names(&login.provider).is_some());
    }

    #[test]
    fn only_news_login_writes_and_only_the_credentials_file() {
        let home = CredentialsHome::new();
        let root = &home.root;
        let elsewhere = tempfile::tempdir().expect("tempdir");
        // the one allowed file is credentials_path() itself, compared whole
        let path = home.path();
        assert_eq!(credentials_path().as_deref(), Some(path.as_path()));
        // no command context: refused, nothing written
        assert!(write_credentials(&path, &fake_login()).is_err());
        assert!(!path.exists());
        let _other = crate::group_guard::command_for_test("doctor");
        assert!(write_credentials(&path, &fake_login()).is_err());
        drop(_other);
        let _login = crate::group_guard::command_for_test("login");
        for wrong in [
            root.path().join("fio-x").join("other"),
            root.path().join("elsewhere").join("credentials"),
            PathBuf::from("fio-x/credentials"),
            root.path()
                .join("fio-x")
                .join("..")
                .join("fio-x")
                .join("credentials"),
            // the right shape in another folder is not the credentials path
            elsewhere.path().join("fio-x").join("credentials"),
        ] {
            assert!(
                write_credentials(&wrong, &fake_login()).is_err(),
                "{}",
                wrong.display()
            );
            assert!(crate::group_guard::remove_private_file(&wrong).is_err());
        }
        assert!(!elsewhere.path().join("fio-x").exists());
        write_credentials(&path, &fake_login()).unwrap();
        crate::group_guard::remove_private_file(&path).unwrap();
        assert!(!path.exists());
    }
}

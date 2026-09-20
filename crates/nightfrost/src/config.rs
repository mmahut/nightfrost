/// Default config file written by `nightfrost init` and picked up
/// automatically by a plain `nightfrost` run.
pub const DEFAULT_PATH: &str = "./nightfrost.toml";

/// Populates NIGHTFROST_* env vars from a simple `key = "value"` config file,
/// one setting per line, skipping any key that's already set in the real
/// environment (real env vars and CLI flags both still take precedence,
/// since clap resolves those after this runs).
pub fn apply_env_defaults(path: &str) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let shown = std::fs::canonicalize(path)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.to_string());
    println!("using config file: {shown}");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let Some(env_key) = env_var_name(key.trim()) else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        if std::env::var_os(env_key).is_none() {
            // SAFETY: single-threaded, before any other code reads the environment.
            unsafe { std::env::set_var(env_key, value) };
        }
    }
}

fn env_var_name(key: &str) -> Option<&'static str> {
    Some(match key {
        "node_url" => "NIGHTFROST_NODE_URL",
        "network_id" => "NIGHTFROST_NETWORK_ID",
        "data_dir" => "NIGHTFROST_DATA_DIR",
        "listen" => "NIGHTFROST_LISTEN",
        "metrics_listen" => "NIGHTFROST_METRICS_LISTEN",
        "submit_cors_origin" => "NIGHTFROST_SUBMIT_CORS_ORIGIN",
        "cursor_secret" => "NIGHTFROST_CURSOR_SECRET",
        _ => return None,
    })
}

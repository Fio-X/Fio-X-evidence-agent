#![allow(dead_code)]
#[path = "../src/audit.rs"]
mod audit;
#[path = "../src/runtime.rs"]
mod runtime;
#[path = "../src/tool_registry.rs"]
mod tool_registry;
use std::{fs, time::Instant};
fn main() -> anyhow::Result<()> {
    let root = std::env::temp_dir().join(format!("news-perf-phases-{}", std::process::id()));
    fs::create_dir_all(&root)?;
    let mut cold = Vec::new();
    let mut warm = Vec::new();
    for i in 0..30 {
        let dir = root.join(i.to_string());
        let t = Instant::now();
        runtime::materialize_extension(&dir)?;
        cold.push(t.elapsed().as_secs_f64() * 1000.);
        let t = Instant::now();
        runtime::materialize_extension(&dir)?;
        warm.push(t.elapsed().as_secs_f64() * 1000.);
    }
    let mut scans = serde_json::Map::new();
    for n in [100, 10000, 100000] {
        let events = root.join("events.jsonl");
        fs::write(&events, "{\"type\":\"message_update\"}\n".repeat(n))?;
        let mut times = Vec::new();
        for _ in 0..10 {
            let t = Instant::now();
            audit::build(&events, &root.join("tools.json"))?;
            times.push(t.elapsed().as_secs_f64() * 1000.);
        }
        scans.insert(n.to_string(), serde_json::json!(times));
    }
    println!(
        "{}",
        serde_json::json!({"runtime_new_ms":cold,"runtime_compare_ms":warm,"audit_scan_ms":scans})
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

//! Opt-in (`NEWSROOM_SPEED_COMPOSE_ANSWER=1`) closing text for a single-chart run, written by the
//! program from artifacts the system already verified instead of by another model turn.
//!
//! Only values from the system-verified claim appear as findings. Anything the model wrote and the
//! system did not verify (the claim's caveat) is printed under its own heading. When the artifacts
//! do not hold together, `compose` returns an error and the model writes the answer as before.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde_json::Value;

/// What a run needs to know to decide whether it may compose its own closing text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComposeSpec {
    pub chinese: bool,
}

/// A chart whose critic passed, as the Pi watcher names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartFiles {
    pub desktop: String,
    pub compact: Option<String>,
    pub mobile: Option<String>,
    pub manifest: String,
}

/// Request words that mean more than one chart is wanted. A run that asks for several keeps
/// the model's closing turn: this version ends the loop only at the first complete chart.
const MULTI_CHART_CUES: [&str; 14] = [
    "两张",
    "两幅",
    "两个图",
    "三张",
    "三幅",
    "多张",
    "多幅",
    "几张",
    "各画",
    "two chart",
    "three chart",
    "charts",
    "multiple",
    "several",
];

/// Whether this request may use a composed closing text at all: a single chart, no page, no
/// requested HTML or PNG (those keep the model's turn and the whole completion chain).
pub fn eligible(topic: &str, complex: bool, requires_html: bool, requires_png: bool) -> bool {
    let lower = topic.to_lowercase();
    !complex
        && !requires_html
        && !requires_png
        && !MULTI_CHART_CUES.iter().any(|cue| lower.contains(cue))
}

fn read_json(root: &Path, relative: &str) -> Result<Value> {
    let path = root.join(relative);
    let text = std::fs::read_to_string(&path).with_context(|| format!("cannot read {relative}"))?;
    serde_json::from_str(&text).with_context(|| format!("{relative} is not JSON"))
}

/// The claim line the system verified, by claim id, or an error.
fn verified_claim(root: &Path, claim_id: &str) -> Result<Value> {
    let text = std::fs::read_to_string(root.join("claims.jsonl")).context("no claims.jsonl")?;
    let mut found = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(claim) = serde_json::from_str::<Value>(line) else {
            bail!("claims.jsonl has a line that is not JSON");
        };
        if claim.get("claim_id").and_then(Value::as_str) == Some(claim_id) {
            // A later line for the same id wins, as the verifier reads the file in order.
            found = Some(claim);
        }
    }
    let claim = found.context("the chart's claim is not recorded")?;
    if !crate::verify::is_system_verified_claim(&claim) {
        bail!("the chart's claim is not system-verified");
    }
    Ok(claim)
}

/// Composes the closing text for a finished chart, or says why it cannot.
pub fn compose(root: &Path, chart: &ChartFiles, spec: &ComposeSpec) -> Result<String> {
    let manifest = read_json(root, &chart.manifest)?;
    if manifest.get("verification_mode").and_then(Value::as_str) != Some("verified") {
        bail!("the chart is not in verified mode");
    }
    if manifest.get("publishable").and_then(Value::as_bool) != Some(true) {
        bail!("the chart is not publishable");
    }
    let claim_id = manifest
        .get("claim_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .context("the chart names no claim")?;
    let claim = verified_claim(root, claim_id)?;
    let statement = claim
        .get("claim")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .context("the verified claim has no text")?;
    // A leftover placeholder or an unfilled brace means the text was never completed.
    if statement.contains('{') || statement.contains('}') {
        bail!("the claim still holds a placeholder");
    }
    let source = manifest
        .get("source_note")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let caveat = claim
        .get("caveat")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");

    let zh = spec.chinese;
    let mut out = String::new();
    out.push_str(if zh {
        "图表已完成。\n\n"
    } else {
        "The chart is complete.\n\n"
    });
    out.push_str(if zh { "文件：\n" } else { "Files:\n" });
    out.push_str(&format!(
        "- {}{}\n",
        if zh {
            "桌面版 SVG："
        } else {
            "Desktop SVG: "
        },
        chart.desktop
    ));
    if let Some(compact) = &chart.compact {
        out.push_str(&format!(
            "- {}{compact}\n",
            if zh {
                "紧凑版 SVG："
            } else {
                "Compact SVG: "
            }
        ));
    }
    if let Some(mobile) = &chart.mobile {
        out.push_str(&format!(
            "- {}{mobile}\n",
            if zh {
                "手机版 SVG："
            } else {
                "Mobile SVG: "
            }
        ));
    }
    // Written before the run's final verification, so it says only what the claim passed when the
    // chart was made and points to verification.json for the run's result.
    out.push_str(&if zh {
        format!(
            "\n结论（{claim_id}，该结论在制图时已通过核验检查；本次运行的最终核验结果见 verification.json）：\n{statement}\n"
        )
    } else {
        format!(
            "\nFinding ({claim_id}, passed its check when the chart was made; the run's final verification result is in verification.json):\n{statement}\n"
        )
    });
    if !source.is_empty() {
        out.push_str(&format!(
            "\n{}{source}\n",
            if zh { "数据来源：" } else { "Source: " }
        ));
    }
    if !caveat.is_empty() {
        out.push_str(&format!(
            "\n{}\n{caveat}\n",
            if zh {
                "说明（未经系统核验，由调查过程记录）："
            } else {
                "Note (not verified by the system; recorded during the investigation):"
            }
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree(verified: bool, mode: &str, claim: &str, caveat: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("visualizations")).unwrap();
        std::fs::write(
            dir.path().join("visualizations/m.json"),
            json!({"verification_mode": mode, "publishable": true, "claim_id": "claim-1", "source_note": "Our World in Data"})
                .to_string(),
        )
        .unwrap();
        let mut record = json!({
            "claim_id": "claim-1", "claim": claim, "status": if verified { "verified" } else { "supported" },
            "verification": {"authority": if verified { "system" } else { "model" },
                "rule_id": "verification.source+extraction+computation+claim.v1",
                "source_resolved": true, "extraction_passed": true, "computation_replayed": true,
                "claim_supported": true, "publishable": true},
        });
        if let Some(caveat) = caveat {
            record["caveat"] = json!(caveat);
        }
        std::fs::write(dir.path().join("claims.jsonl"), format!("{record}\n")).unwrap();
        dir
    }

    fn chart() -> ChartFiles {
        ChartFiles {
            desktop: "visualizations/m.svg".into(),
            compact: Some("visualizations/m.compact.svg".into()),
            mobile: None,
            manifest: "visualizations/m.json".into(),
        }
    }

    #[test]
    fn verified_chart_gets_the_claim_the_source_and_the_unverified_caveat_apart() {
        let dir = tree(
            true,
            "verified",
            "出生率从 40 降到 11.2。",
            Some("2024 年为估算"),
        );
        let text = compose(dir.path(), &chart(), &ComposeSpec { chinese: true }).unwrap();
        assert!(text.contains("出生率从 40 降到 11.2。"), "{text}");
        assert!(
            text.contains("claim-1，该结论在制图时已通过核验检查"),
            "{text}"
        );
        assert!(text.contains("最终核验结果见 verification.json"), "{text}");
        assert!(
            !text.contains("status verified") && !text.contains("系统核验 claim"),
            "{text}"
        );
        assert!(text.contains("数据来源：Our World in Data"), "{text}");
        let finding = text.find("出生率").unwrap();
        let heading = text.find("未经系统核验").unwrap();
        assert!(finding < heading && text.find("2024 年为估算").unwrap() > heading);
        let english = compose(dir.path(), &chart(), &ComposeSpec { chinese: false }).unwrap();
        assert!(
            english.contains("(claim-1, passed its check when the chart was made;")
                && english.contains("verification.json")
                && !english.contains("system-verified claim-1")
                && english.contains("Note (not verified")
        );
    }

    #[test]
    fn nothing_beyond_the_verified_claim_is_stated_as_a_finding() {
        let dir = tree(true, "verified", "The rate fell.", None);
        let text = compose(dir.path(), &chart(), &ComposeSpec { chinese: false }).unwrap();
        assert!(
            !text.contains("Note ("),
            "no caveat heading without a caveat: {text}"
        );
        assert!(!text.chars().any(|c| c.is_ascii_digit() && false));
    }

    #[test]
    fn artifacts_that_do_not_hold_together_fall_back_to_the_model() {
        let spec = ComposeSpec { chinese: false };
        for (label, dir) in [
            ("unverified claim", tree(false, "verified", "x", None)),
            (
                "chart not in verified mode",
                tree(true, "unverified", "x", None),
            ),
            (
                "placeholder left in the claim",
                tree(true, "verified", "The rate was {max.rate}.", None),
            ),
        ] {
            assert!(compose(dir.path(), &chart(), &spec).is_err(), "{label}");
        }
        let empty = tempfile::tempdir().unwrap();
        assert!(compose(empty.path(), &chart(), &spec).is_err());
    }

    fn write_chart(manifest: Value, claims: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("visualizations")).unwrap();
        std::fs::write(
            dir.path().join("visualizations/m.json"),
            manifest.to_string(),
        )
        .unwrap();
        std::fs::write(dir.path().join("claims.jsonl"), claims.join("\n")).unwrap();
        dir
    }

    fn claim_line(verified: bool, claim: &str) -> String {
        json!({
            "claim_id": "claim-1", "claim": claim, "status": if verified { "verified" } else { "supported" },
            "verification": {"authority": if verified { "system" } else { "model" },
                "rule_id": "verification.source+extraction+computation+claim.v1",
                "source_resolved": true, "extraction_passed": true, "computation_replayed": true,
                "claim_supported": true, "publishable": true},
        })
        .to_string()
    }

    #[test]
    fn each_gap_in_the_artifacts_is_refused_on_its_own() {
        let spec = ComposeSpec { chinese: false };
        let good = claim_line(true, "The rate fell.");
        let manifest = |extra: Value| {
            let mut m = json!({"verification_mode": "verified", "publishable": true, "claim_id": "claim-1"});
            for (k, v) in extra.as_object().unwrap() {
                m[k] = v.clone();
            }
            m
        };
        assert!(compose(
            write_chart(manifest(json!({})), &[&good]).path(),
            &chart(),
            &spec
        )
        .is_ok());
        for (label, dir) in [
            (
                "chart not publishable",
                write_chart(manifest(json!({"publishable": false})), &[&good]),
            ),
            (
                "chart without a publishable field",
                write_chart(
                    json!({"verification_mode": "verified", "claim_id": "claim-1"}),
                    &[&good],
                ),
            ),
            (
                "empty claim id",
                write_chart(
                    manifest(json!({"claim_id": ""})),
                    &[&good.replace("claim-1", "")],
                ),
            ),
            (
                "a claims line that is not JSON",
                write_chart(manifest(json!({})), &["not json", &good]),
            ),
            (
                "the later line for the id is not verified",
                write_chart(manifest(json!({})), &[&good, &claim_line(false, "x")]),
            ),
            (
                "claim text only blanks",
                write_chart(manifest(json!({})), &[&claim_line(true, "   ")]),
            ),
            (
                "opening brace only",
                write_chart(manifest(json!({})), &[&claim_line(true, "Rate {x")]),
            ),
            (
                "closing brace only",
                write_chart(manifest(json!({})), &[&claim_line(true, "Rate x}")]),
            ),
        ] {
            assert!(compose(dir.path(), &chart(), &spec).is_err(), "{label}");
        }
        let later_verified = write_chart(manifest(json!({})), &[&claim_line(false, "x"), &good]);
        assert!(compose(later_verified.path(), &chart(), &spec).is_ok());
    }

    #[test]
    fn only_a_plain_single_chart_request_is_eligible() {
        assert!(eligible(
            "Draw a line chart of China birth rate",
            false,
            false,
            false
        ));
        assert!(!eligible("Draw a line chart", true, false, false));
        assert!(!eligible("Draw a line chart", false, true, false));
        assert!(!eligible("Draw a line chart", false, false, true));
        assert!(!eligible("画两张图比较出生率", false, false, false));
        assert!(!eligible("draw several charts", false, false, false));
    }
}

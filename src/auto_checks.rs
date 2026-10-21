//! Auto checks (K932 block 1 part b): after a plan call succeeds, the program itself runs the follow-up lint, render and critic calls
//! and folds their results into the same toolResult, so the model does not spend a turn on each. Selected only by
//! `NEWSROOM_SPEED_AUTO_CHECKS` (on unless the value is exactly "0") and only with atomic artifact writes on.
//!
//! Nothing here sets a verification field: every parameter is a reference taken from a tool result, a missing field stops the sequence,
//! and `vision_critic`, `record_claim`, the plan tools and `asset_requirements` are never in the table. The step rules mirror
//! `runtime/pi/tool_chain.mjs` (lint, render, critic and preview params and pass judgements).

use serde_json::{json, Value};

use crate::anthropic_model::{images_enabled, wire_image, TOOL_RESULT_IMAGES_ENV};

/// On unless the value is exactly "0", and atomic writes on (the lint/render/critic refs are only stable then).
pub fn enabled() -> bool {
    crate::pi::auto_checks_switch_on() && crate::pi::atomic_artifact_on()
}

/// `NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS`: only the exact value "1" turns it on (default off), and atomic artifact writes must be on.
/// After a successful `newsroom_publication_plan` the program itself runs `newsroom_publication_render` and `newsroom_publication_qa`.
pub const AUTO_PUBLISH_ENV: &str = "NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS";

pub fn publish_enabled() -> bool {
    std::env::var(AUTO_PUBLISH_ENV).ok().as_deref() == Some("1") && crate::pi::atomic_artifact_on()
}

/// The image switch, read through the request builder's own function (K929).
pub fn images_on() -> bool {
    images_enabled(std::env::var(TOOL_RESULT_IMAGES_ENV).ok().as_deref())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Chain {
    Viz,
    Infographic,
    Publication,
}

const VIZ_STEPS: [&str; 3] = [
    "newsroom_viz_lint",
    "newsroom_viz_render",
    "newsroom_viz_critic",
];
const INFOGRAPHIC_STEPS: [&str; 4] = [
    "newsroom_infographic_lint",
    "newsroom_infographic_render",
    "newsroom_infographic_critic",
    "newsroom_infographic_preview",
];
const PUBLICATION_STEPS: [&str; 2] = ["newsroom_publication_render", "newsroom_publication_qa"];
pub const PREVIEW_TOOL: &str = "newsroom_infographic_preview";

pub fn steps(chain: Chain) -> &'static [&'static str] {
    match chain {
        Chain::Viz => &VIZ_STEPS,
        Chain::Infographic => &INFOGRAPHIC_STEPS,
        Chain::Publication => &PUBLICATION_STEPS,
    }
}

/// References collected along one sequence.
#[derive(Default, Debug)]
pub struct Refs {
    pub plan: String,
    pub lint: Option<String>,
    pub manifest: Option<String>,
    pub critic: Option<String>,
}

fn text_field(details: &Value, key: &str) -> Option<String> {
    details
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn is_true(details: &Value, key: &str) -> bool {
    details.get(key).and_then(Value::as_bool) == Some(true)
}

/// Which sequence a finished plan call starts, if any. A viz plan needs a non-empty `planRef` and `publishable === true`;
/// an infographic plan needs a non-empty `planRef` and a non-error result; a publication plan the same (the caller applies
/// `publish_enabled` to that chain).
pub fn start(tool: &str, details: Option<&Value>, is_error: bool) -> Option<(Chain, Refs)> {
    if is_error {
        return None;
    }
    let details = details?;
    let plan = text_field(details, "planRef")?;
    let chain = match tool {
        "newsroom_viz_plan" if is_true(details, "publishable") => Chain::Viz,
        "newsroom_infographic_plan" => Chain::Infographic,
        "newsroom_publication_plan" => Chain::Publication,
        _ => return None,
    };
    Some((
        chain,
        Refs {
            plan,
            ..Refs::default()
        },
    ))
}

/// Params of one step from the references so far; None when a reference it needs is missing (the sequence stops).
pub fn args_for(tool: &str, refs: &Refs) -> Option<Value> {
    match tool {
        "newsroom_viz_lint" | "newsroom_infographic_lint" => Some(json!({"plan_ref": refs.plan})),
        "newsroom_viz_render" | "newsroom_infographic_render" => {
            Some(json!({"plan_ref": refs.plan, "lint_ref": refs.lint.as_ref()?}))
        }
        "newsroom_viz_critic" | "newsroom_infographic_critic" => Some(json!({
            "plan_ref": refs.plan,
            "lint_ref": refs.lint.as_ref()?,
            "manifest_ref": refs.manifest.as_ref()?,
        })),
        "newsroom_publication_render" => Some(json!({"plan_ref": refs.plan})),
        "newsroom_publication_qa" => {
            Some(json!({"plan_ref": refs.plan, "manifest_ref": refs.manifest.as_ref()?}))
        }
        PREVIEW_TOOL => Some(
            json!({"manifest_ref": refs.manifest.as_ref()?, "critic_ref": refs.critic.as_ref()?}),
        ),
        _ => None,
    }
}

/// Whether a step's result lets the sequence go on. Reads only the tool's own details; a missing field is a stop, never a pass.
pub fn judge(tool: &str, details: Option<&Value>, has_image: bool, refs: &mut Refs) -> bool {
    let Some(details) = details else {
        return false;
    };
    match tool {
        "newsroom_viz_lint" | "newsroom_infographic_lint" => {
            let lint = text_field(details, "lintRef");
            if !is_true(details, "passed") || lint.is_none() {
                return false;
            }
            if tool == "newsroom_viz_lint" && text_field(details, "computationRef").is_none() {
                return false;
            }
            refs.lint = lint;
            true
        }
        "newsroom_viz_render" | "newsroom_infographic_render" => {
            let manifest = text_field(details, "manifestRef");
            if !is_true(details, "renderQaPassed") || manifest.is_none() {
                return false;
            }
            if tool == "newsroom_viz_render"
                && details.get("publishable").and_then(Value::as_bool) == Some(false)
            {
                return false;
            }
            refs.manifest = manifest;
            true
        }
        // The render tool has no pass field of its own: it throws when it refuses, so a result with a manifest reference is its pass.
        "newsroom_publication_render" => {
            let manifest = text_field(details, "manifestRef");
            if manifest.is_none() {
                return false;
            }
            refs.manifest = manifest;
            true
        }
        // `judged: false` means the browser never ran (nothing was verified): that is a stop, not a pass.
        "newsroom_publication_qa" => is_true(details, "passed") && is_true(details, "judged"),
        "newsroom_viz_critic" => is_true(details, "passed"),
        "newsroom_infographic_critic" => {
            let critic = text_field(details, "criticRef");
            if !is_true(details, "passed") || critic.is_none() {
                return false;
            }
            refs.critic = critic;
            true
        }
        PREVIEW_TOOL => text_field(details, "previewRef").is_some() && has_image,
        _ => false,
    }
}

pub fn text_of(content: &[Value]) -> String {
    content
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

pub fn has_image(content: &[Value]) -> bool {
    content
        .iter()
        .any(|b| b.get("type").and_then(Value::as_str) == Some("image"))
}

/// Why the images of this result would be refused on the wire (None when they all pass). It runs the request builder's own
/// `wire_image` on each image, counting the ones before it in this result. It does not see images already in the history.
pub fn image_refusal(content: &[Value]) -> Option<String> {
    let mut sent = (0usize, 0usize);
    for block in content
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("image"))
    {
        match wire_image(block, sent) {
            Ok(_) => {
                sent.0 += 1;
                sent.1 += block
                    .get("data")
                    .and_then(Value::as_str)
                    .map_or(0, str::len);
            }
            Err(reason) => return Some(reason.to_string()),
        }
    }
    None
}

fn text_block(text: String) -> Value {
    json!({"type": "text", "text": text})
}

/// Blocks appended to the toolResult for a step that passed: a one-line status, then the step's text verbatim (warnings, issues,
/// score and Next hints stay), then its images when they fit, otherwise the program's "not sent" line.
pub fn pass_blocks(tool: &str, content: &[Value]) -> Vec<Value> {
    let mut blocks = vec![text_block(format!("\n{tool} PASS\n{}", text_of(content)))];
    if has_image(content) {
        match image_refusal(content) {
            None => blocks.extend(
                content
                    .iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("image"))
                    .cloned(),
            ),
            Some(reason) => blocks.push(text_block(format!(
                "\nPreview image not sent to the model: {reason}"
            ))),
        }
    }
    blocks
}

/// Blocks for a step that failed or was judged not passing: its own text, then the stop line. Images are passed through
/// when they fit (a failing step's picture can still help), never judged here.
pub fn stop_blocks(tool: &str, content: &[Value]) -> Vec<Value> {
    vec![text_block(format!(
        "\n{}\nStopped at {tool}",
        text_of(content)
    ))]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi::AUTO_CHECKS_ENV;

    fn text(t: &str) -> Vec<Value> {
        vec![json!({"type": "text", "text": t})]
    }

    #[test]
    fn viz_plan_starts_only_when_publishable_with_a_plan_ref() {
        let ok = json!({"planRef": "p1", "publishable": true});
        assert_eq!(
            start("newsroom_viz_plan", Some(&ok), false).unwrap().0,
            Chain::Viz
        );
        for bad in [
            json!({"planRef": "p1", "publishable": false}),
            json!({"planRef": "p1"}),
            json!({"planRef": "", "publishable": true}),
            json!({"publishable": true}),
        ] {
            assert!(
                start("newsroom_viz_plan", Some(&bad), false).is_none(),
                "{bad}"
            );
        }
        assert!(start("newsroom_viz_plan", Some(&ok), true).is_none());
        assert!(start("newsroom_viz_plan", None, false).is_none());
    }

    #[test]
    fn infographic_plan_starts_on_a_plan_ref_and_other_tools_never_start() {
        let d = json!({"planRef": "p2", "modules": 3});
        assert_eq!(
            start("newsroom_infographic_plan", Some(&d), false)
                .unwrap()
                .0,
            Chain::Infographic
        );
        assert!(start("newsroom_infographic_plan", Some(&d), true).is_none());
        for tool in [
            "newsroom_vision_critic",
            "newsroom_record_claim",
            "newsroom_asset_requirements",
            "newsroom_viz_lint",
            "newsroom_infographic_lint",
        ] {
            assert!(
                start(
                    tool,
                    Some(&json!({"planRef": "p", "publishable": true})),
                    false
                )
                .is_none(),
                "{tool}"
            );
        }
    }

    #[test]
    fn the_table_holds_no_plan_or_model_filled_tool() {
        for chain in [Chain::Viz, Chain::Infographic, Chain::Publication] {
            for tool in steps(chain) {
                assert!(!tool.ends_with("_plan"), "{tool}");
                assert!(![
                    "newsroom_vision_critic",
                    "newsroom_record_claim",
                    "newsroom_asset_requirements"
                ]
                .contains(tool));
            }
        }
    }

    #[test]
    fn args_use_references_only_and_stop_when_one_is_missing() {
        let mut refs = Refs {
            plan: "p".into(),
            ..Refs::default()
        };
        assert_eq!(
            args_for("newsroom_viz_lint", &refs).unwrap(),
            json!({"plan_ref": "p"})
        );
        assert!(args_for("newsroom_viz_render", &refs).is_none());
        refs.lint = Some("l".into());
        assert_eq!(
            args_for("newsroom_viz_render", &refs).unwrap(),
            json!({"plan_ref": "p", "lint_ref": "l"})
        );
        assert!(args_for("newsroom_viz_critic", &refs).is_none());
        refs.manifest = Some("m".into());
        assert_eq!(
            args_for("newsroom_viz_critic", &refs).unwrap(),
            json!({"plan_ref": "p", "lint_ref": "l", "manifest_ref": "m"})
        );
        assert!(args_for(PREVIEW_TOOL, &refs).is_none());
        refs.critic = Some("c".into());
        assert_eq!(
            args_for(PREVIEW_TOOL, &refs).unwrap(),
            json!({"manifest_ref": "m", "critic_ref": "c"})
        );
        assert!(args_for("newsroom_vision_critic", &refs).is_none());
    }

    #[test]
    fn every_auto_param_is_a_reference_never_a_model_filled_conclusion() {
        let refs = Refs {
            plan: "p".into(),
            lint: Some("l".into()),
            manifest: Some("m".into()),
            critic: Some("c".into()),
        };
        for chain in [Chain::Viz, Chain::Infographic, Chain::Publication] {
            for tool in steps(chain) {
                let args = args_for(tool, &refs).unwrap();
                for key in args.as_object().unwrap().keys() {
                    assert!(key.ends_with("_ref"), "{tool}: {key}");
                    assert!(!["passed", "score", "confidence", "verdict"].contains(&key.as_str()));
                }
            }
        }
    }

    #[test]
    fn lint_passes_only_on_passed_true_with_its_refs() {
        let mut refs = Refs::default();
        assert!(judge(
            "newsroom_infographic_lint",
            Some(&json!({"passed": true, "lintRef": "l"})),
            false,
            &mut refs
        ));
        assert_eq!(refs.lint.as_deref(), Some("l"));
        let mut refs = Refs::default();
        for bad in [
            json!({"passed": false, "lintRef": "l"}),
            json!({"passed": true}),
            json!({"passed": "true", "lintRef": "l"}),
            json!({"lintRef": "l"}),
        ] {
            assert!(
                !judge("newsroom_infographic_lint", Some(&bad), false, &mut refs),
                "{bad}"
            );
        }
        assert!(!judge("newsroom_infographic_lint", None, false, &mut refs));
        // the viz lint also needs the computation reference
        assert!(!judge(
            "newsroom_viz_lint",
            Some(&json!({"passed": true, "lintRef": "l"})),
            false,
            &mut refs
        ));
        assert!(judge(
            "newsroom_viz_lint",
            Some(&json!({"passed": true, "lintRef": "l", "computationRef": "c"})),
            false,
            &mut refs
        ));
    }

    #[test]
    fn render_passes_only_on_render_qa_passed_and_a_manifest() {
        let mut refs = Refs::default();
        assert!(judge(
            "newsroom_viz_render",
            Some(&json!({"renderQaPassed": true, "manifestRef": "m"})),
            false,
            &mut refs
        ));
        assert_eq!(refs.manifest.as_deref(), Some("m"));
        assert!(!judge(
            "newsroom_viz_render",
            Some(&json!({"renderQaPassed": true, "manifestRef": "m", "publishable": false})),
            false,
            &mut refs
        ));
        assert!(!judge(
            "newsroom_viz_render",
            Some(&json!({"renderQaPassed": false, "manifestRef": "m"})),
            false,
            &mut refs
        ));
        assert!(!judge(
            "newsroom_viz_render",
            Some(&json!({"renderQaPassed": true})),
            false,
            &mut refs
        ));
        assert!(judge(
            "newsroom_infographic_render",
            Some(&json!({"renderQaPassed": true, "manifestRef": "m", "publishable": false})),
            false,
            &mut refs
        ));
    }

    #[test]
    fn publication_plan_starts_the_render_then_qa_sequence() {
        let d = json!({"planRef": "pp", "moduleCount": 4});
        let (chain, refs) = start("newsroom_publication_plan", Some(&d), false).unwrap();
        assert_eq!(chain, Chain::Publication);
        assert_eq!(refs.plan, "pp");
        assert_eq!(
            steps(chain),
            ["newsroom_publication_render", "newsroom_publication_qa"]
        );
        assert!(start("newsroom_publication_plan", Some(&d), true).is_none());
        assert!(start(
            "newsroom_publication_plan",
            Some(&json!({"planRef": ""})),
            false
        )
        .is_none());
        assert!(start("newsroom_publication_plan", None, false).is_none());
        // render and qa never start a sequence themselves
        for tool in ["newsroom_publication_render", "newsroom_publication_qa"] {
            assert!(start(tool, Some(&d), false).is_none(), "{tool}");
        }
    }

    #[test]
    fn publication_args_are_references_and_qa_waits_for_the_manifest() {
        let mut refs = Refs {
            plan: "pp".into(),
            ..Refs::default()
        };
        assert_eq!(
            args_for("newsroom_publication_render", &refs).unwrap(),
            json!({"plan_ref": "pp"})
        );
        assert!(args_for("newsroom_publication_qa", &refs).is_none());
        refs.manifest = Some("publications/k/manifest.json".into());
        assert_eq!(
            args_for("newsroom_publication_qa", &refs).unwrap(),
            json!({"plan_ref": "pp", "manifest_ref": "publications/k/manifest.json"})
        );
    }

    #[test]
    fn publication_render_needs_a_manifest_and_qa_needs_passed_and_judged() {
        let mut refs = Refs::default();
        assert!(!judge(
            "newsroom_publication_render",
            Some(&json!({})),
            false,
            &mut refs
        ));
        assert!(!judge(
            "newsroom_publication_render",
            Some(&json!({"manifestRef": ""})),
            false,
            &mut refs
        ));
        assert!(!judge(
            "newsroom_publication_render",
            None,
            false,
            &mut refs
        ));
        assert!(judge(
            "newsroom_publication_render",
            Some(&json!({"manifestRef": "m"})),
            false,
            &mut refs
        ));
        assert_eq!(refs.manifest.as_deref(), Some("m"));
        for bad in [
            json!({"passed": false, "judged": true}),
            json!({"passed": false, "judged": false}),
            json!({"passed": true, "judged": false}),
            json!({"passed": true}),
            json!({"judged": true}),
            json!({"passed": "true", "judged": true}),
        ] {
            assert!(
                !judge("newsroom_publication_qa", Some(&bad), false, &mut refs),
                "{bad}"
            );
        }
        assert!(!judge("newsroom_publication_qa", None, false, &mut refs));
        assert!(judge(
            "newsroom_publication_qa",
            Some(&json!({"passed": true, "judged": true})),
            false,
            &mut refs
        ));
    }

    #[test]
    fn the_publish_switch_is_on_only_for_exactly_one_and_needs_atomic_writes() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(AUTO_PUBLISH_ENV);
        std::env::remove_var(crate::pi::ATOMIC_ARTIFACT_ENV);
        assert!(!publish_enabled(), "unset is off");
        for not_one in ["", "0", "true", "on", "yes", " 1", "1 ", "11", "2"] {
            std::env::set_var(AUTO_PUBLISH_ENV, not_one);
            assert!(!publish_enabled(), "{not_one:?}");
        }
        std::env::set_var(AUTO_PUBLISH_ENV, "1");
        assert!(publish_enabled());
        // independent of the other auto-check switch
        std::env::set_var(AUTO_CHECKS_ENV, "0");
        assert!(publish_enabled());
        std::env::remove_var(AUTO_CHECKS_ENV);
        std::env::set_var(crate::pi::ATOMIC_ARTIFACT_ENV, "0");
        assert!(!publish_enabled(), "atomic off turns it off");
        std::env::remove_var(AUTO_PUBLISH_ENV);
        std::env::remove_var(crate::pi::ATOMIC_ARTIFACT_ENV);
    }

    #[test]
    fn critic_and_preview_judgements() {
        let mut refs = Refs::default();
        assert!(judge(
            "newsroom_viz_critic",
            Some(&json!({"passed": true})),
            false,
            &mut refs
        ));
        assert!(!judge(
            "newsroom_viz_critic",
            Some(&json!({"passed": false, "score": 90})),
            false,
            &mut refs
        ));
        assert!(!judge(
            "newsroom_infographic_critic",
            Some(&json!({"passed": true})),
            false,
            &mut refs
        ));
        assert!(!judge(
            "newsroom_infographic_critic",
            Some(&json!({"passed": false, "criticRef": "c"})),
            false,
            &mut refs
        ));
        assert!(judge(
            "newsroom_infographic_critic",
            Some(&json!({"passed": true, "criticRef": "c"})),
            false,
            &mut refs
        ));
        assert_eq!(refs.critic.as_deref(), Some("c"));
        assert!(!judge(
            PREVIEW_TOOL,
            Some(&json!({"previewRef": "v"})),
            false,
            &mut refs
        ));
        assert!(!judge(PREVIEW_TOOL, Some(&json!({})), true, &mut refs));
        assert!(judge(
            PREVIEW_TOOL,
            Some(&json!({"previewRef": "v"})),
            true,
            &mut refs
        ));
        assert!(!judge(
            "newsroom_vision_critic",
            Some(&json!({"passed": true})),
            true,
            &mut refs
        ));
    }

    #[test]
    fn a_passing_step_keeps_its_text_verbatim_after_one_status_line() {
        let body = "lint warnings: w1\nNext: call render\n  spaced  ";
        let blocks = pass_blocks("newsroom_viz_lint", &text(body));
        assert_eq!(blocks.len(), 1);
        let t = blocks[0]["text"].as_str().unwrap();
        assert!(t.contains("viz_lint PASS\n"));
        assert!(t.ends_with(body), "text must be appended untrimmed: {t:?}");
    }

    #[test]
    fn a_stopped_step_keeps_its_text_and_names_the_stop() {
        let blocks = stop_blocks("newsroom_viz_render", &text("render refused: overlap"));
        let t = blocks[0]["text"].as_str().unwrap();
        assert!(t.contains("render refused: overlap"));
        assert!(t.ends_with("Stopped at newsroom_viz_render"));
    }

    fn image(bytes: usize) -> Value {
        let data = format!(
            "iVBORw0KGgoA{}",
            "A".repeat((bytes / 3 * 4).saturating_sub(12) / 4 * 4)
        );
        json!({"type": "image", "mimeType": "image/png", "data": data})
    }

    #[test]
    fn images_pass_through_when_they_fit_and_are_replaced_by_a_note_when_not() {
        let mut ok = text("preview ok");
        ok.push(image(1000));
        let blocks = pass_blocks(PREVIEW_TOOL, &ok);
        assert!(has_image(&blocks));
        assert!(!blocks
            .iter()
            .any(|b| b["text"].as_str().is_some_and(|t| t.contains("not sent"))));

        let mut big = text("preview ok");
        big.push(image(3 * 1024 * 1024 + 3000));
        let blocks = pass_blocks(PREVIEW_TOOL, &big);
        assert!(!has_image(&blocks));
        assert!(blocks.iter().any(|b| b["text"].as_str().is_some_and(
            |t| t.contains("Preview image not sent to the model: image is larger than 3 MiB")
        )));

        let many: Vec<Value> = (0..21).map(|_| image(30)).collect();
        assert!(image_refusal(&many).unwrap().contains("limit of 20"));
        let total: Vec<Value> = (0..8).map(|_| image(3 * 1024 * 1024)).collect();
        assert!(image_refusal(&total).unwrap().contains("size limit"));
    }

    #[test]
    fn the_switch_is_on_unless_exactly_zero_and_needs_atomic_writes() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(AUTO_CHECKS_ENV);
        std::env::remove_var(crate::pi::ATOMIC_ARTIFACT_ENV);
        assert!(enabled(), "unset is on");
        // Only an exact "0" turns it off; an empty value, false, off, no and a padded 0 leave it on.
        for not_zero in [
            "", "true", "false", "off", "no", "yes", "1", " 0", "0 ", "00", "2",
        ] {
            std::env::set_var(AUTO_CHECKS_ENV, not_zero);
            assert!(enabled(), "{not_zero:?}");
        }
        std::env::set_var(AUTO_CHECKS_ENV, "0");
        assert!(!enabled(), "exactly 0 turns it off");
        std::env::set_var(AUTO_CHECKS_ENV, "1");
        assert!(enabled());
        std::env::set_var(crate::pi::ATOMIC_ARTIFACT_ENV, "0");
        assert!(!enabled(), "atomic off turns it off");
        std::env::remove_var(AUTO_CHECKS_ENV);
        std::env::remove_var(crate::pi::ATOMIC_ARTIFACT_ENV);
    }

    #[test]
    fn images_are_on_unless_exactly_zero() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(TOOL_RESULT_IMAGES_ENV);
        assert!(images_on(), "unset is on");
        for not_zero in ["", "true", "false", "off", "no", " 0", "00", "2"] {
            std::env::set_var(TOOL_RESULT_IMAGES_ENV, not_zero);
            assert!(images_on(), "{not_zero:?}");
        }
        std::env::set_var(TOOL_RESULT_IMAGES_ENV, "0");
        assert!(!images_on(), "exactly 0 turns it off");
        std::env::set_var(TOOL_RESULT_IMAGES_ENV, "1");
        assert!(images_on());
        std::env::remove_var(TOOL_RESULT_IMAGES_ENV);
    }
}

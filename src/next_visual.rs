//! New route, visual group: its one group command. Another group reaches the chart matcher only through `call`, with a
//! `Request` and back a `Reply` (both shared types under rule one); the matcher itself (shape_registry.rs) stays this group's.
//! It holds no state and writes nothing; its one host tool, the image-aware critic, it only names and hands back to run on the
//! host the caller lends. A page it draws by its recipe (next_render) and checks against the ledger it came back with before
//! handing it out; a page that passes has passed the visual gate only, which says nothing about whether a number is verified.

use crate::next_ledger::check_numbers;
use crate::next_nodes::Style;
use crate::next_render::{render, PageSpec, Rendered};
use crate::shape_registry::{Matched, PagePlan, Relation, Shape, View};
use serde_json::Value;

/// The image-aware critic: the model's verdict on the previewed page, kept as a QA record before publication.
pub const VISION_CRITIC_TOOL: &str = "newsroom_infographic_vision_critic";

pub enum Request<'a> {
    /// Every relation ranked for one data slice: `registered` lists the templates the registry has, `used_before` the
    /// relations earlier panels on the page already picked.
    Rank {
        shape: &'a Shape,
        registered: &'a [&'a str],
        used_before: &'a [Relation],
    },
    /// The same, in the first-to-last view only and whatever the slice's size: for a series of each entity's first and last
    /// value.
    RankFirstToLast {
        shape: &'a Shape,
        registered: &'a [&'a str],
        used_before: &'a [Relation],
    },
    /// The page plan row (PAGE_PLANS) of each chart's relation and view, in chart order.
    PagePlan { forms: &'a [(Relation, View)] },
    /// One run of `VISION_CRITIC_TOOL` on the host the caller lends, with these arguments.
    VisionCritic {
        host: crate::next_flow::HostRun<'a>,
        args: Value,
    },
    /// The page for this spec by the column recipe, its knobs at their defaults.
    #[allow(dead_code)]
    // to be wired: the flow asks for its page here when the recipe opens (a user nod)
    Page { spec: &'a PageSpec },
}

pub enum Reply<'a> {
    /// Best first; no candidate means narrow the filter.
    Matched(Matched),
    /// One row per relation asked, in the same order.
    Plans(Vec<&'static PagePlan>),
    /// The critic's run, which the caller awaits.
    Run(crate::next_flow::ToolFuture<'a>),
    /// The drawn page and its ledger; every digit on it was found printing its ledger entry or naming a table the spec names.
    Page(Rendered),
}

/// The visual group's command. Only a page can fail: Err lists what could not be drawn, or every digit the page check found
/// off the ledger (one per line); no page leaves with one.
pub fn call(request: Request<'_>) -> Result<Reply<'_>, String> {
    Ok(match request {
        Request::Rank {
            shape,
            registered,
            used_before,
        } => Reply::Matched(crate::shape_registry::rank(shape, registered, used_before)),
        Request::RankFirstToLast {
            shape,
            registered,
            used_before,
        } => Reply::Matched(crate::shape_registry::rank_first_to_last(
            shape,
            registered,
            used_before,
        )),
        Request::PagePlan { forms } => Reply::Plans(
            forms
                .iter()
                .map(|(r, v)| crate::shape_registry::page_plan(*r, *v))
                .collect(),
        ),
        Request::VisionCritic { host, args } => Reply::Run(host(VISION_CRITIC_TOOL, args)),
        Request::Page { spec } => {
            let page = render(spec, &Style::default())?;
            let off = check_numbers(&page.html, &page.ledger, &spec.refs);
            if !off.is_empty() {
                return Err(off.join("\n"));
            }
            Reply::Page(page)
        }
    })
}

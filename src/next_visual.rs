//! New route, visual group: its one group command. Another group reaches the chart matcher only through `call`, with a
//! `Request` and back a `Reply` (both shared types under rule one); the matcher itself (shape_registry.rs) stays this group's.
//! It holds no state and writes nothing; its one host tool, the image-aware critic, it only names and hands back to run on the
//! host the caller lends.

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
}

pub enum Reply<'a> {
    /// Best first; no candidate means narrow the filter.
    Matched(Matched),
    /// One row per relation asked, in the same order.
    Plans(Vec<&'static PagePlan>),
    /// The critic's run, which the caller awaits.
    Run(crate::next_flow::ToolFuture<'a>),
}

/// The visual group's command. No request can fail; the Result keeps the shape of every group command.
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
    })
}

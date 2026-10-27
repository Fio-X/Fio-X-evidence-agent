//! New route, visual group: its one group command. Another group reaches the chart matcher only through `call`, with a
//! `Request` and back a `Reply` (both shared types under rule one); the matcher itself (shape_registry.rs) stays this group's.
//! Pure: it holds no state and writes nothing.

use crate::shape_registry::{Matched, PagePlan, Relation, Shape};

pub enum Request<'a> {
    /// Every relation ranked for one data slice: `registered` lists the templates the registry has, `used_before` the
    /// relations earlier panels on the page already picked.
    Rank {
        shape: &'a Shape,
        registered: &'a [&'a str],
        used_before: &'a [Relation],
    },
    /// The page plan row (PAGE_PLANS) of each chart's relation, in chart order.
    PagePlan { relations: &'a [Relation] },
}

pub enum Reply {
    /// Best first; no candidate means narrow the filter.
    Matched(Matched),
    /// One row per relation asked, in the same order.
    Plans(Vec<&'static PagePlan>),
}

/// The visual group's command. Neither request can fail; the Result keeps the shape of every group command.
pub fn call(request: Request<'_>) -> Result<Reply, String> {
    Ok(match request {
        Request::Rank {
            shape,
            registered,
            used_before,
        } => Reply::Matched(crate::shape_registry::rank(shape, registered, used_before)),
        Request::PagePlan { relations } => Reply::Plans(
            relations
                .iter()
                .map(|r| crate::shape_registry::page_plan(*r))
                .collect(),
        ),
    })
}

//! New route, visual group: its one group command. Another group reaches the chart matcher only through `call`, with a
//! `Request` and back a `Reply` (both shared types under rule one); the matcher itself (shape_registry.rs) stays this group's.
//! Pure: it holds no state and writes nothing.

use crate::shape_registry::{Matched, Relation, Shape};

pub enum Request<'a> {
    /// Every relation ranked for one data slice: `registered` lists the templates the registry has, `used_before` the
    /// relations earlier panels on the page already picked.
    Rank {
        shape: &'a Shape,
        registered: &'a [&'a str],
        used_before: &'a [Relation],
    },
}

pub enum Reply {
    /// Best first; no candidate means narrow the filter.
    Matched(Matched),
}

/// The visual group's command. The ranking cannot fail; the Result keeps the shape of every group command.
pub fn call(request: Request<'_>) -> Result<Reply, String> {
    Ok(match request {
        Request::Rank {
            shape,
            registered,
            used_before,
        } => Reply::Matched(crate::shape_registry::rank(shape, registered, used_before)),
    })
}

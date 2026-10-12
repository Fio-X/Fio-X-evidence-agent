// The knowledge group's writer for the shadow-check side files (shadow/, see shadow.mjs). The numbers-in-prose and as-of observations are made by a
// visual-side tool, but they observe the evidence and never become evidence, so shadow/ is its own file kind (observation) owned by the knowledge group.
// With NEWSROOM_GROUP_HANDOFF=1 (exact value, default off) shadow.mjs runs its one write inside this writer instead of under the asking tool. Same path,
// same bytes, same number of writes; only who the boundary report names as the writer does (the asking tool stays listed as requested_by).
import { asHandoffWriter } from "./groups.mjs";
import { handoffEnabled } from "./knowledge_writer.mjs";

export const SHADOW_WRITER = "shadow_writer";

/** Run `write` as the knowledge group's shadow writer when the hand-off is on; otherwise just run it. */
export const asShadowWriter = (write) => (handoffEnabled() ? asHandoffWriter(SHADOW_WRITER, write) : write());

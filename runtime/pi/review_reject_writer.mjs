// The visual group's writer for moving a failed manifest to rejected/ (see rejectCriticizedManifest in newsroom.ts). Review tools (the critics) only
// write review records; with NEWSROOM_REVIEW_SPLIT=1 the move of the draw tool's manifest runs inside this writer instead of under the critic.
// Same path, same bytes; only who the boundary report names as the writer does (the asking critic stays listed as requested_by).
import { asHandoffWriter } from "./groups.mjs";

export const REVIEW_REJECT_WRITER = "review_reject_writer";

/** Run `move` as the visual group's review_reject_writer. The caller decides whether the switch is on. */
export const asReviewRejectWriter = (move) => asHandoffWriter(REVIEW_REJECT_WRITER, move);

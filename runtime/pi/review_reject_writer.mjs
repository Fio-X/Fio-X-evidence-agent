// The visual group's writer for moving a failed manifest or publication to rejected/ (see rejectCriticizedManifest and rejectPublication in newsroom.ts). Review tools
// (the critics and the publication QA) only write review records; the move of the draw tool's manifest or publication runs inside this writer instead of under the reviewer.
// Same path, same bytes; only who the boundary report names as the writer does (the asking critic stays listed as requested_by).
import { asHandoffWriter } from "./groups.mjs";

export const REVIEW_REJECT_WRITER = "review_reject_writer";

/** Run `move` as the visual group's review_reject_writer. */
export const asReviewRejectWriter = (move) => asHandoffWriter(REVIEW_REJECT_WRITER, move);

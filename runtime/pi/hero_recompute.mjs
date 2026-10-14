// NEWSROOM_HERO_RECOMPUTE=1 (exact "1", default off): a hero_stat's big number must equal the value the program recomputes from the
// stored query result of its own claim, after the rounding the page shows. The recomputed value is the number in the computation
// row the claim's binding points at, read from the stored computation; nothing here reads model output or changes a claim's status.
// Pure: the caller reads the computation row and hands the value in.

export function heroRecomputeEnabled() {
  return process.env.NEWSROOM_HERO_RECOMPUTE === "1";
}

const SHOWN_NUMBER = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;

/** The shown text as a number and the number of decimals it shows; null when the text is not a bare number (nothing to recompute). */
export function shownNumber(text) {
  const raw = String(text ?? "").trim();
  if (!SHOWN_NUMBER.test(raw)) return null;
  const dot = raw.indexOf(".");
  return { value: Number(raw.replace(/,/g, "")), decimals: dot === -1 ? 0 : raw.length - dot - 1 };
}

/** The recomputed value as the program writes it: float toFixed(decimals), the same call that makes a bound number's text (formatClaimValue in newsroom.ts), as a number. */
export function roundedTo(value, decimals) {
  return Number(value.toFixed(Math.min(100, decimals)));
}

/**
 * Refusal text, or null when the shown number is the recomputed value as the page rounds it (or the check does not apply: the
 * recomputed cell is not a number, or the shown text is not a bare number). The text carries the recomputed value.
 */
export function heroRecomputeRefusal({ heroId, claimId, placeholder, shownText, recomputed }) {
  const shown = shownNumber(shownText);
  if (!shown) return null;
  const numeric = typeof recomputed === "number" ? recomputed : (typeof recomputed === "string" && recomputed.trim() !== "" ? Number(recomputed) : NaN);
  if (!Number.isFinite(numeric)) return null;
  const expected = roundedTo(numeric, shown.decimals);
  if (Math.abs(expected - shown.value) <= 1e-9 * Math.max(1, Math.abs(expected))) return null;
  return `HERO_VALUE_RECOMPUTE_MISMATCH: hero_stat '${heroId}' claim '${claimId}' shows ${String(shownText).slice(0, 30)} for ${placeholder}, but the program recomputes ${numeric} from the claim's query result (${expected.toFixed(shown.decimals)} at ${shown.decimals} decimal${shown.decimals === 1 ? "" : "s"}); run the query and record the claim again`;
}

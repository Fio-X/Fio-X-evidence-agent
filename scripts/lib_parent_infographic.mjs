// The source of runtime/pi/infographic.mjs at an older commit, for tests that compare today's mobile page byte for byte
// with the layout before their own change. Changes made on purpose after that commit, which are not the change a test
// guards, are carried into the old source here, each by an exact edit that must hit exactly once (a miss throws, so a
// test never silently compares against an unedited source). Everything else stays the old commit's bytes.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp, pointRelativeImportsAt } from "./tmp_helper.mjs";

// e97be1dfea5c (never print VERIFIED in the page footer): the page is rendered before verification runs, so a zh page prints
// no English footer line and an en page prints only the brand; the desktop top-right brand line is gone.
const FOOTER = "AGENTIC DATA NEWSROOM · VERIFIED VISUAL STORY</text>`);";
const LATER_CHANGES = Object.freeze([
  {
    commit: "e97be1dfea5c",
    find: "parts.push(`<text x=\"${layout.width - layout.margin}\" y=\"${pageHeight - 26}\" text-anchor=\"end\" font-family=\"${SANS}\" font-size=\"12\" font-weight=\"700\" letter-spacing=\"1.2\" fill=\"${MUTED}\">" + FOOTER,
    replace:
      "{ const footerLine = pageLang(spec) === \"zh\" ? null : \"AGENTIC DATA NEWSROOM\"; if (footerLine) parts.push(`<text x=\"${layout.width - layout.margin}\" y=\"${pageHeight - 26}\" text-anchor=\"end\" font-family=\"${SANS}\" font-size=\"12\" font-weight=\"700\" letter-spacing=\"1.2\" fill=\"${MUTED}\">${footerLine}</text>`); }",
  },
  {
    commit: "e97be1dfea5c",
    find: "if (!mobile) parts.push(`<text x=\"${width - margin}\" y=\"${h.top}\" text-anchor=\"end\" font-family=\"${SANS}\" font-size=\"12\" font-weight=\"700\" letter-spacing=\"1.5\" fill=\"${MUTED}\">AGENTIC DATA NEWSROOM · 01</text>`);",
    replace: "",
  },
]);

// null only when git cannot show the old commit (a checkout without that history); an edit that misses throws.
export function parentInfographicSource(rev, cwd) {
  let src;
  try {
    src = execFileSync("git", ["show", `${rev}:runtime/pi/infographic.mjs`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  for (const change of LATER_CHANGES) {
    const hits = src.split(change.find).length - 1;
    if (hits !== 1) throw new Error(`parent ${rev}: the edit for ${change.commit} hits ${hits} times, not once`);
    src = src.replace(change.find, () => change.replace);
  }
  return src;
}

// parentInfographicSource(rev) loaded as a module, or null without that history. It is written as `name` into a scratch
// folder, never into runtime/pi/ (a test running beside the caller would see it there, and two callers would share the
// name); its relative imports point at today's runtime/pi/ modules, the same instances the caller loads.
export async function importParentInfographic(rev, name) {
  const src = parentInfographicSource(rev, fileURLToPath(new URL("..", import.meta.url)));
  if (src === null) return null;
  const { source, rewritten } = pointRelativeImportsAt(src, new URL("../runtime/pi/", import.meta.url));
  if (rewritten === 0) throw new Error(`parent ${rev}: no relative import found to point at runtime/pi/`);
  const path = join(makeTestTmp("parent-infographic-"), name);
  writeFileSync(path, source);
  return import(pathToFileURL(path).href);
}

#!/usr/bin/env node
// K807: the published page script is byte-for-byte what the base build produces. The QA-only blocked-reason change (browser_qa.py + the QA tool text)
// must not touch runtime/pi/publication.mjs or runtime/web/publication.mjs, so a page rendered from the same fixture spec by this tree and by a
// checkout of the base (K807_BASE_REF, default ab2f9bf6) is identical, in both copies of the renderer. No browser, no provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = process.env.K807_BASE_REF || "ab2f9bf635015308ff4ce8368927b72e6430654a";
const fixtureLine = readFileSync(join(ROOT, "scripts/test_d3_fail_closed_v19.mjs"), "utf8").split("\n").find((l) => l.startsWith("const spec={"));
assert.ok(fixtureLine, "fixture spec line found");
const makeSpec = () => new Function(`${fixtureLine}\nreturn spec;`)();

const tmp = mkdtempSync(join(tmpdir(), "page-bytes-"));
try {
  const archive = execFileSync("git", ["archive", BASE, "runtime", "config"], { cwd: ROOT, maxBuffer: 1 << 28 });
  execFileSync("tar", ["-x", "-C", tmp], { input: archive });
  for (const copy of ["web", "pi"]) {
    const rel = `runtime/${copy}/publication.mjs`;
    const now = await import(pathToFileURL(join(ROOT, rel)).href);
    const base = await import(pathToFileURL(join(tmp, rel)).href);
    const a = now.renderPublication(makeSpec()).html;
    const b = base.renderPublication(makeSpec()).html;
    assert.ok(a.length > 5000 && a.includes("dataset.blocked='runtime'"), `${copy}: a real page script`);
    assert.equal(a, b, `${copy}: the published page differs from the base build`);
    assert.ok(!a.includes("blockedReason") && !a.includes("drawErrorReason"), `${copy}: no reason helper in the page`);
  }
  console.log("test_publication_page_bytes_unchanged: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

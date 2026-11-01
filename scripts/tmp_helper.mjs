// Test-only helper (not a test: the name does not match scripts/test_*.mjs). Makes scratch directories under
// TMPDIR and removes them when the test process exits, including when it exits on a thrown error.
// NEWSROOM_TEST_KEEP_TMP=1 keeps them and prints each path.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = [];
let hooked = false;

export function makeTestTmp(prefix = "newsroom-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const d of made) {
        if (process.env.NEWSROOM_TEST_KEEP_TMP === "1") {
          console.error(`[test-tmp] kept ${d}`);
          continue;
        }
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    });
  }
  return dir;
}

// A module's source made loadable from a scratch folder: each static relative import ("./x.mjs", "../x.mjs", bare
// `import "./x.mjs"`) is pointed at that file under `dirUrl` (the folder the source belongs in), so the copy loads the
// same module instances as the original would. Throws when a relative import is left (a dynamic import("./x") included).
export function pointRelativeImportsAt(src, dirUrl) {
  let rewritten = 0;
  const source = src.replace(/(\bfrom\s+|\bimport\s+)(["'])(\.\.?\/[^"']+)\2/g, (_, kw, q, rel) => {
    rewritten += 1;
    return `${kw}${q}${new URL(rel, dirUrl).href}${q}`;
  });
  if (/(?:\bfrom\s+|\bimport\s*\(?\s*)["']\.\.?\//.test(source)) throw new Error(`a relative import is left in a module moved to scratch (base ${dirUrl})`);
  return { source, rewritten };
}

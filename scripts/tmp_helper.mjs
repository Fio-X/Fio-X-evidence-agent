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

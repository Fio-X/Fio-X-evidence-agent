"""Test browser check for src/next_visual.rs, runtime/pi/browser_qa.py's arguments and report without a browser: writes
<output>/browser-qa.json for the --html file as its first argument says: pass (PASS, its sha256), fail (FAIL) or other
(PASS for other bytes), or it exits writing nothing (silent)."""
import hashlib, json, sys
from pathlib import Path

mode, args = sys.argv[1], dict(zip(sys.argv[2::2], sys.argv[3::2]))
if mode == "silent":
    sys.exit(0)
spec = json.loads(Path(args["--spec"]).read_text())
assert spec["delivery"]["breakpoints"] == [1440], spec
sha = hashlib.sha256(Path(args["--html"]).read_bytes() + (b"x" if mode == "other" else b"")).hexdigest()
report = {"status": "FAIL" if mode == "fail" else "PASS", "html_sha256": sha,
          "errors": ["overflow:1440", "fonts_not_ready:1440:loading"] if mode == "fail" else []}
(Path(args["--output"]) / "browser-qa.json").write_text(json.dumps(report) + "\n")
sys.exit(0 if report["status"] == "PASS" else 2)

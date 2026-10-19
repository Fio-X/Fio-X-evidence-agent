"""Writes fixtures/audit_expected.txt from a run of an AUDIT SCRIPT (the first argument) on the synthetic pair of test_support.make_audit_pair.

The committed file was made once with the audit script as it was before its rename and text edits (sha256
0017fb490399c09e51588639e2a9c33570a1f768051f3fcf86860915dffd3f66):
    python3 -I make_audit_expected.py <that script>
The tests only read the file; they never regenerate it."""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_support as S  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    saved, replay = S.make_audit_pair(tmp)
    out = subprocess.run([sys.executable, "-I", sys.argv[1], "case", saved, replay], capture_output=True, text=True, check=True).stdout
os.makedirs(os.path.join(HERE, "fixtures"), exist_ok=True)
with open(os.path.join(HERE, "fixtures", "audit_expected.txt"), "w", encoding="utf-8") as handle:
    handle.write(out)

"""Test-only twin of runtime/leaves_py/bars_node.py (src/next_run.rs external_bars_q1): the honest reply, tampered by the mode
given as its argument. wider: the first bar 1 px wider (B3); swap: the first two names' places swapped (B5); late: no reply
within the core's deadline. No registry names this file."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "runtime", "leaves_py"))
import bars_node

req = json.loads(sys.stdin.readline())
out = bars_node.reply(req)
mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode == "wider":
    first = req["marks"][0]["id"]
    out["marks"][first]["w"] += 1
elif mode == "swap":
    a, b = (f"{m['id']}/label" for m in req["marks"][:2])
    out["texts"][a], out["texts"][b] = out["texts"][b], out["texts"][a]
elif mode == "late":
    time.sleep(3)
print(json.dumps(out), flush=True)

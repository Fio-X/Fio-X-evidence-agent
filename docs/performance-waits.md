# Waiting and performance measurements

These controls apply to the Rust Pi RPC wrapper, using environment variables in
milliseconds. Invalid values fail before spawning Pi. No credential value is
accepted by these controls.

| Variable | Default | Meaning |
| --- | ---: | --- |
| NEWSROOM_RPC_STARTUP_MS | 60000 | Prompt acceptance and initial pipe write |
| NEWSROOM_RPC_IDLE_MS | 300000 | Waiting before observable active work |
| NEWSROOM_RPC_FINISH_MS | 30000 | Final text/statistics replies after settled |
| NEWSROOM_RPC_TOTAL_MS | 86400000 | Entire RPC session, including writes; 0 explicitly disables |
| NEWSROOM_RPC_HEARTBEAT_MS | 5000 | Safe phase/elapsed progress on stderr |
| NEWSROOM_BROWSER_QA_TIMEOUT_MS | 120000 | Browser QA controlled subprocess deadline |

RPC controls accept at most 604800000 ms (seven days). Only total permits zero.
Tools, thinking, agent activity and retry events switch the session to active
work; token silence then uses the total deadline, never the idle heuristic.
An active but stalled model cannot reliably be distinguished from legitimate
thinking. Choose an explicit total budget for long tasks. The 24-hour default
exceeds the 43200-second soak; canonical qualification/soak scripts are unchanged.

Ctrl-C terminates the RPC session and returns failure. On Unix, Pi starts in a
new process group; cleanup kills that group and reaps Pi with a bounded wait.
Detached descendants are outside this group. The tool executor also enumerates
and kills descendants on Unix; environments denying process enumeration provide
only parent cleanup. Windows descendant cleanup is not yet implemented.

RPC records are capped at 8 MB. Invalid records, provider errors and extension
errors are not echoed verbatim; Pi stderr is suppressed. Known credential values
from environment variables are redacted in parsed events. This does not provide
semantic detection of secrets encoded or split across separate model records.
Progress never includes tool arguments or prompt text.

Materialized runtimes include both registered basemaps and process.mjs, retaining
complete offline files. Full content comparison and full audit scans remain in
place. Audit evidence gates and independent verification are unchanged.

Reproduce offline measurements sequentially (build first, without concurrent tests):

```sh
cargo build --release --locked
python3 scripts/perf_measure.py target/release/news perf-results/optimized.json
cargo build --release --locked --example perf_phases
target/release/examples/perf_phases > perf-results/phases-optimized.json
python3 scripts/test_rpc_waits.py target/release/news
node scripts/test_process_runner.mjs
python3 scripts/perf_checks.py
python3 scripts/test_pi_route_alias.py
```

The Rust example measures runtime materialization/comparison and synthetic full
audit scans in-process. CLI samples include OS/process startup overhead; the
first sample is retained but is not an OS-cache-purged cold start. Pi loading
uses get_state without a prompt/API call. Real attempts use fixed inputs,
provider/model/thinking and profiles in scripts/perf_live.py, loading the external
.env in memory. All attempts must be retained, including setup failures.
No performance result grants qualification or release readiness. Commit and pin
a new SHA before independently rerunning formal qualification.

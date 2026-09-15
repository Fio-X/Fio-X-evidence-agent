# v1.13 Test Report

Release candidate: `1.13.0-rc1`

## New v1.13 tests and gates

### Tool-surface exactness

`check_runtime_contract.py`: PASS.

- Pi extension registrations: 49.
- Rust allowlist entries: 49.
- Exact set equality: PASS.
- Restored tools: StoryGraph, basemap preparation, network reduction.

### Version consistency

`check_version_consistency.py`: PASS.

Cargo package, four Node runtime package manifests, production-host config, dependency policy and cold-story configs all declare `1.13.0-rc1`. PublicationSpec = 0.3.0; MapSpec = 0.2.0.

### Clean-output PR qualification

`release_check.py --profile pr`: PASS after deleting `outputs/`.

The run covers v1.7 semantics, v1.8 synthesis, v1.9 browser/capability contracts, v1.10 style mapping, v1.12 trusted publication, MapSpec 0.2, network overview, phase-scoped tools, source distribution, v1.13 production qualification contract and release-manifest reproducibility.

A former hidden dependency on `outputs/v19-browser/energy-publication.json` was found and fixed by ordering fixture producers before schema consumers.

### Release-manifest reproducibility

`test_release_manifest_reproducibility_v113.py`: PASS.

Two manifest builds separated by more than one second produce identical `source_tree.sha256` and stable `manifest_sha256`. The manifest file itself is excluded from the source tree.

### Production browser qualification

CPU profile: PASS.

GPU profile: expected FAIL on this host.

Errors:

- `webgl2_unavailable:390`,
- `webgl2_unavailable:1024`.

The CPU lane remains sandboxed and makes zero external requests.

### Cold-story gate

`check_cold_story_ledger.py`: BLOCKED as designed.

Observed:

- 7 cases / required 12,
- 5 news cases / required 6,
- 7 topology families / required 8,
- 0 silent semantic errors / required 0,
- 1 correct abstention / required >=1.

### Dependency-lock gate

`verify_dependency_locks.py`: BLOCKED as designed.

Missing:

- `Cargo.lock`,
- `runtime/web/package-lock.json`,
- `runtime/sigma/package-lock.json`,
- `runtime/map/package-lock.json`,
- `runtime/d3/package-lock.json`.

Offline npm probes confirmed the current host does not have enough registry metadata cached to generate valid locks. No synthetic lockfiles were created.

### Production preflight

`production_preflight.py`: BLOCKED.

Passing host checks:

- Python 3.13,
- Chromium 144,
- sandboxed CPU browser qualification.

Blocking host checks:

- Node version,
- Rust,
- Cargo,
- DuckDB,
- Pi,
- dependency locks,
- GPU browser,
- provider credential.

### RC regression evidence

The monolithic `smoke_visual_compiler.sh` exceeds this interactive host's single-command time budget. Before termination it passed through AI visual compiler. The remaining browser/system sections were run separately.

`v113-rc-segmented.json`: `PASS_SEGMENTED`.

Verified segmented evidence includes:

- v1.7 semantic adversarial and cold-story semantics,
- v1.8 visual synthesis,
- backend router/executor and AI visual compiler,
- v1.9 energy Sankey, network and advanced browser QA,
- v1.9 D3 and WebGL expected fail-closed probes,
- v1.10 Nature map, uncertainty, linked geo and large-network technical browser QA,
- large-network editorial `FAIL_HAIRBALL_SPECIALIST_REQUIRED`,
- v1.13 trusted CPU publication PASS and GPU expected fail-closed.

`PASS_SEGMENTED` is explicitly not accepted by `final_qualification.py` as a substitute for a standard-host RC PASS.

### Final dossier

`final_qualification.py`: `BLOCKED`.

Passing:

- release manifest exists and is hashed.

Blocking:

- production preflight,
- standard-host RC release gate,
- cold-story gate,
- live provider qualification,
- qualified-human review,
- dependency locks.

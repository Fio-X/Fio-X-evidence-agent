# Third-party skills

Fio-X vendors the complete `lieflat-charts` skill at the pinned commit recorded
in [`skills/lieflat-charts/UPSTREAM.json`](skills/lieflat-charts/UPSTREAM.json).

All files under `skills/lieflat-charts/**` remain licensed under the upstream
PolyForm Noncommercial License 1.0.0. The upstream `LICENSE` and
`THIRD_PARTY_NOTICES.md` are included unchanged. The MIT license at the
repository root does not replace or extend the license for that subtree.

The vendored skill is used only for personal, non-commercial work in this
project. Fio-X adapter code lives in `runtime/pi/lieflat.mjs` and does not
modify the upstream source files.

`runtime/pi/visual_skill_bundle.mjs` is a generated, packed copy of the same
`skills/lieflat-charts` content (built by `scripts/build_visual_skill_bundle.py`)
and carries the same PolyForm Noncommercial License 1.0.0, not the root MIT
license.

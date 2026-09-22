import assert from "node:assert/strict";
import { catalogLieflat, templateCoverage, lieflatSkillMetadata } from "../runtime/pi/lieflat.mjs";

const ordinary = catalogLieflat({
  mode: "chart",
  language: "en",
  analytical_job: "rank entities",
  data_shape: "ranking",
  reader_task: "comparison",
  reading_speed: "normal",
  module_count: 1,
  offline_required: true,
});
assert.equal(ordinary.selected_family, "lupi-editorial");
assert.equal(ordinary.selected_id, "L2");
assert.ok(ordinary.candidates.length >= 3);
assert.ok(ordinary.candidates.some((candidate) => candidate.family === "lupi-basics"));
assert.ok(ordinary.rejected.some((candidate) => candidate.id !== ordinary.selected_id));
assert.equal(ordinary.network_required, false);
assert.equal(ordinary.self_contained, true);

const glance = catalogLieflat({
  mode: "chart",
  language: "en",
  analytical_job: "weekly dashboard ranking",
  data_shape: "ranking",
  reader_task: "three-second fast read",
  reading_speed: "glance",
  module_count: 1,
  offline_required: true,
});
assert.equal(glance.selected_family, "glance");
assert.ok(glance.selected_id.startsWith("G"));

for (const language of ["zh", "en"]) {
  const report = catalogLieflat({
    mode: "report",
    language,
    analytical_job: "research report",
    data_shape: "multi-module report",
    reader_task: "context evidence resolution",
    reading_speed: "normal",
    module_count: 5,
    offline_required: true,
  });
  assert.equal(report.candidates.length, 12);
  assert.match(report.selected_file, new RegExp(`\\.${language}\\.html$`));
  for (const id of Array.from({ length: 12 }, (_value, index) => `R${String(index + 1).padStart(2, "0")}`)) {
    assert.equal(report.coverage[id].supported, true, `${id} ${language} must be offline-ready`);
    assert.equal(report.coverage[id].validated, true, `${id} ${language} must be validated`);
  }
}

const map = catalogLieflat({
  mode: "chart",
  language: "zh",
  analytical_job: "map of regional distribution",
  data_shape: "map",
  reader_task: "spatial location",
  reading_speed: "normal",
  module_count: 1,
  offline_required: true,
});
assert.equal(map.selected_id, null);
assert.equal(map.network_required, true);
assert.equal(map.self_contained, false);
assert.ok(map.rejected.length === 2);
assert.equal(templateCoverage("M1").supported, false);
assert.equal(templateCoverage("M1").network_required, true);
assert.equal(lieflatSkillMetadata().upstream_commit, "eace082a317b696c5570c25826a53a7fa113e984");

console.log(JSON.stringify({
  status: "PASS",
  ordinary_selected: ordinary.selected_id,
  glance_selected: glance.selected_id,
  report_candidates: 12,
  map_fail_closed: true,
}, null, 2));

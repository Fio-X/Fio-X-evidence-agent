// D1: page-level subject-set lint. Synthetic data; two subject kinds
// (country-like names and non-country entities such as cities and companies).
import assert from "node:assert/strict";
import { lintInfographicSpec, evaluateSubjectSets, annotateSubjectSets, distinctSubjects, composeInfographicBundle } from "../runtime/pi/infographic.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";
import { renderVizBundle } from "../runtime/pi/viz.mjs";

const claim = "claim-d1";
function chartAsset(rows, extra = {}) {
  const spec = { schema_version: "0.9.0", reader_task: "comparison", title: "T", alt: "A synthetic ranking of named entities by one measure, for lint testing only.", source_note: "synthetic", claim_id: claim, sql: "SELECT 1", chart_type: "horizontal_bar", category_field: "c", value_field: "v", unit: "%", highlight_values: [], annotations: [], language: "en" };
  const { desktop, mobile } = renderVizBundle(spec, rows, { mobilePages: false });
  return { manifest: { chart_type: "horizontal_bar", language: "en", category_field: "c", claim_id: claim, source_note: "synthetic", ...extra }, critic: { passed: true }, desktopSvg: desktop, mobileSvg: mobile ?? desktop, subjects: distinctSubjects(rows, "c") };
}
const rowsOf = (names) => names.map((c, i) => ({ c, v: 10 + i * 7 }));
function page(modules, subject_set) {
  return {
    schema_version: "1.0.0", kicker: "K", title: "A synthetic page for the subject set lint", dek: "Fixture for the page-level subject set check.", alt: "A synthetic page used to test the subject set lint rules.",
    byline: "n", date_label: "d", layout: "feature", complexity_budget: "low", source_note: "synthetic", language: "en",
    ...(subject_set ? { subject_set } : {}),
    modules: modules.map((m, i) => ({ id: `v${i}`, type: "visual", span: "full", label: `Chart ${i}`, manifest_ref: `m${i}`, claim_ids: [claim], ...m })).concat([
      { id: "t1", type: "text", span: "full", label: "Note", heading: "Reading note", body: "A short synthetic note.", claim_ids: [claim] },
      { id: "t2", type: "text", span: "full", label: "Note two", heading: "Second note", body: "Another short synthetic note.", claim_ids: [claim] },
    ]),
  };
}
const lint = (spec, assets, members) => lintInfographicSpec(spec, assets, { verified_claim_ids: [claim], mobile_pages: false, ...(members ? { subject_set_members: members } : {}) });
const subjectBlockers = (report) => report.blockers.filter((b) => b.startsWith("subject_set_"));

const shapes = {
  countries: { members: ["Aland", "Borduria", "Carpania", "Dunmark", "Elbonia"], extra: "Zubrowka", inside: ["Borduria", "Dunmark"], setRows: rowsOf(["Aland", "Borduria", "Carpania", "Dunmark", "Elbonia"]) },
  cities_companies: { members: ["Springfield", "Rivertown", "Harbor City", "Lakeside"], extra: "Acme Holdings", inside: ["Rivertown", "Lakeside"], setRows: rowsOf(["Springfield", "Rivertown", "Harbor City", "Lakeside"]) },
};
for (const [shape, def] of Object.entries(shapes)) {
  const declared = { computation_ref: "computations/set.json", key_field: "c", cutoff_date: "2020-06-30" };
  const members = distinctSubjects(def.setRows, "c");
  assert.deepEqual(new Set(members), new Set(def.members));
  // must-fail 1: out-of-set subject, no caption
  {
    const assets = { m0: chartAsset(rowsOf([...def.inside, def.extra])), m1: chartAsset(rowsOf(def.inside)) };
    const out = subjectBlockers(lint(page([{}, {}], declared), assets, members));
    assert.equal(out.length, 1, `${shape}: ${out}`);
    assert.match(out[0], /subject_set_out_of_set_without_caption: visual 'v0'.*Zubrowka|Acme Holdings/);
  }
  // must-fail 2: a chart that writes a different cutoff date
  {
    const assets = { m0: chartAsset(rowsOf(def.inside), { cutoff_date: "2021-01-01" }) };
    const out = subjectBlockers(lint(page([{}], declared), assets, members));
    assert.equal(out.length, 1, `${shape}: ${out}`);
    assert.match(out[0], /subject_set_cutoff_mismatch/);
  }
  // must-pass 1: caption present (and the same cutoff date written)
  {
    const assets = { m0: chartAsset(rowsOf([...def.inside, def.extra]), { cutoff_date: "2020-06-30" }) };
    const spec = page([{ subject_caption: "Includes one entity outside the page's subject set." }], declared);
    assert.deepEqual(subjectBlockers(lint(spec, assets, members)), [], shape);
    // the runtime restyles it and prints the caption
    annotateSubjectSets(spec, assets, new Set(members));
    assert.deepEqual(assets.m0.out_of_set_subjects, [def.extra]);
    const svg = composeInfographicBundle(spec, assets, { mobilePages: false }).desktop.svg;
    assert.ok(svg.includes('data-role="out-of-set-frame"') && svg.includes('data-role="out-of-set-caption"'), `${shape}: distinguished`);
    assert.ok(svg.includes("outside the page"), `${shape}: caption visible`);
    assert.deepEqual(checkSvgGeometry(svg).failures.filter((f) => /viewbox|overlap/.test(f.rule)).map((f) => f.message), [], `${shape}: restyled page stays geometrically clean`);
  }
  // must-pass 2: subjects are a subset of the set
  {
    const assets = { m0: chartAsset(rowsOf(def.inside)) };
    const spec = page([{}], declared);
    assert.deepEqual(subjectBlockers(lint(spec, assets, members)), [], shape);
    annotateSubjectSets(spec, assets, new Set(members));
    assert.equal(assets.m0.out_of_set_subjects, undefined);
    assert.ok(!composeInfographicBundle(spec, assets, { mobilePages: false }).desktop.svg.includes("out-of-set-frame"));
  }
  // fail-closed: a declared set the runtime could not resolve, or an incomplete declaration
  assert.match(subjectBlockers(lint(page([{}], declared), { m0: chartAsset(rowsOf(def.inside)) }, []))[0], /subject_set_unresolved/);
  assert.match(subjectBlockers(lint(page([{}], { computation_ref: "x" }), { m0: chartAsset(rowsOf(def.inside)) }, members))[0], /subject_set_incomplete/);
  // model-written member lists are ignored: only runtime-supplied members count
  {
    const spec = page([{}], { ...declared, members: [def.extra] });
    const assets = { m0: chartAsset(rowsOf([...def.inside, def.extra])) };
    assert.equal(subjectBlockers(lint(spec, assets, members)).length, 1);
  }
}

// no declared set: no block; two partly overlapping unequal charts -> one warning
{
  const a = { m0: chartAsset(rowsOf(["P", "Q", "R"])), m1: chartAsset(rowsOf(["Q", "R", "S"])) };
  const report = lint(page([{}, {}]), a);
  assert.deepEqual(subjectBlockers(report), []);
  assert.equal(report.warnings.filter((w) => w.startsWith("subject_sets_partially_overlap")).length, 1);
  const same = lint(page([{}, {}]), { m0: chartAsset(rowsOf(["P", "Q"])), m1: chartAsset(rowsOf(["Q", "P"])) });
  assert.equal(same.warnings.filter((w) => w.startsWith("subject_sets_partially_overlap")).length, 0, "equal sets: no warning");
  const disjoint = lint(page([{}, {}]), { m0: chartAsset(rowsOf(["P", "Q"])), m1: chartAsset(rowsOf(["S", "T"])) });
  assert.equal(disjoint.warnings.filter((w) => w.startsWith("subject_sets_partially_overlap")).length, 0, "disjoint: no warning");
  const subset = lint(page([{}, {}]), { m0: chartAsset(rowsOf(["P", "Q", "R"])), m1: chartAsset(rowsOf(["P", "Q"])) });
  assert.equal(subset.warnings.filter((w) => w.startsWith("subject_sets_partially_overlap")).length, 1, "proper subset is unequal and overlapping");
}
console.log("test_subject_set ok");

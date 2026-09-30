#!/usr/bin/env node
import assert from 'node:assert/strict';
import { misleadingQuantitativeValidator } from '../runtime/pi/editorial_validators.mjs';

const quantitative = { quantity_kind: 'count', mark_semantics: 'color', scale_type: 'linear', baseline_policy: 'not_applicable', uncertainty_disclosed: true };

function moduleFor(mark_semantics, extra = {}) {
  return {
    id: 'm', type: 'visual', manifest_ref: 'visualizations/m.json',
    quantitative_encoding: { ...quantitative, mark_semantics, ...extra },
  };
}

function specFor(mark_semantics, extra = {}) {
  return { schema_version: '1.5.0', modules: [moduleFor(mark_semantics, extra)] };
}

// (a) choropleth + color passes.
{
  const assets = { 'visualizations/m.json': { manifest: { chart_type: 'choropleth' } } };
  const issues = misleadingQuantitativeValidator(specFor('color'), assets);
  assert.ok(!issues.some((row) => row.rule_id === 'quantitative.color_mark_choropleth_only'), JSON.stringify(issues));
}

// (b) non-choropleth (horizontal_bar) + color is rejected with the new code.
{
  const assets = { 'visualizations/m.json': { manifest: { chart_type: 'horizontal_bar' } } };
  const issues = misleadingQuantitativeValidator(specFor('color', { baseline_policy: 'zero' }), assets);
  const hit = issues.find((row) => row.rule_id === 'quantitative.color_mark_choropleth_only');
  assert.ok(hit, JSON.stringify(issues));
  assert.equal(hit.severity, 'ERROR');
}

// (c) choropleth + area + area_proportional:false still fails area_must_be_proportional.
{
  const assets = { 'visualizations/m.json': { manifest: { chart_type: 'choropleth' } } };
  const issues = misleadingQuantitativeValidator(specFor('area', { area_proportional: false }), assets);
  assert.ok(issues.some((row) => row.rule_id === 'quantitative.area_must_be_proportional'), JSON.stringify(issues));
  assert.ok(!issues.some((row) => row.rule_id === 'quantitative.color_mark_choropleth_only'), JSON.stringify(issues));
}

// (d) an unrelated module with no manifest asset and a non-color mark stays clean.
{
  const issues = misleadingQuantitativeValidator(specFor('position'), {});
  assert.ok(!issues.some((row) => row.rule_id === 'quantitative.color_mark_choropleth_only'), JSON.stringify(issues));
}

console.log('editorial validators color mark: PASS');

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { compileEchartsEditorialScene } from '../runtime/web/echarts_editorial.mjs';
const s=compileEchartsEditorialScene({dataPath:'fixtures/realdata/worldbank-gdp-life-2024.csv',options:{chart_type:'scatter',x_field:'gdp_per_capita_usd',y_field:'life_expectancy_years',label_field:'country',x_scale:'log'}});
assert.equal(s.option.series[0].type,'scatter'); assert.equal(s.option.xAxis.type,'log'); assert.equal(s.option.series[0].data.length,12); assert.equal(s.option.series[0].label.formatter,'{b}');
console.log('echarts extensions v1.28: PASS');

#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildMovementTrack} from '../runtime/pi/movement_track.mjs';
for(const [file,type,tolerance] of [['adsb-dal1812-sampled.json','aircraft',10000],['ais-syros-sampled.json','vessel',20]]){
  const fixture=JSON.parse(await readFile(new URL(`../fixtures/v16-movement/${file}`,import.meta.url),'utf8'));
  const track=buildMovementTrack({track_id:fixture.track_id,object_type:type,source:fixture.source,source_id:fixture.source_blob_sha,points:fixture.points,gap_seconds:1800,simplify_tolerance_m:tolerance});
  assert.equal(track.raw_points.length,fixture.points.length);
  assert.ok(track.clean_points.length>=2);
  assert.ok(track.publication_points.length>=2);
  assert.ok(track.publication_points.length<=track.clean_points.length);
  assert.ok(track.metrics.observed_duration_s>0);
  assert.ok(track.metrics.segment_count>=1);
  console.log(`${type} ${track.track_id}: raw=${track.metrics.raw_point_count} clean=${track.metrics.clean_point_count} publication=${track.metrics.publication_point_count} segments=${track.metrics.segment_count} max_gap=${track.metrics.largest_time_gap_s}s`);
}
console.log('MovementTrack v1.8 PASS');

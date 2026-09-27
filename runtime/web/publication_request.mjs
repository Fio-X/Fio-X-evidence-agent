#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {renderPublication} from './publication.mjs';
function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null}
const reqPath=arg('--request'),outdir=arg('--output')||'outputs/browser-publication';if(!reqPath)throw new Error('usage: publication_request.mjs --request SPEC_JSON [--output DIR]');
const spec=JSON.parse(fs.readFileSync(reqPath,'utf8'));fs.mkdirSync(outdir,{recursive:true});const {html,manifest}=renderPublication(spec);fs.writeFileSync(path.join(outdir,'index.html'),html);fs.writeFileSync(path.join(outdir,'publication-manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({...manifest,html:'index.html'}));

import { createHash } from 'node:crypto';
import { wrapText } from './viz.mjs';

const PAPER='#fffdf9', INK='#1d2329', MUTED='#69727a', GRID='#d9dde1', ACCENT='#c9473d', DARK='#24313a', FAINT='#f1f0ec';
const SANS='Arial, Helvetica, sans-serif', SERIF="Georgia, 'Times New Roman', serif";
export const EXPLAINER_SCHEMA_VERSION='0.1.0';
export const EXPLAINER_VIEWS=['cutaway','exploded','anatomy','system'];

function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function hash(v){return createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');}
function lines(t,n,max=99){const all=wrapText(String(t??''),n);const out=all.slice(0,max);if(all.length>max&&out.length)out[out.length-1]=out[out.length-1].replace(/…?$/,'…');return out;}
function text(parts,text,x,y,{size=16,lh=Math.round(size*1.35),weight=400,fill=INK,family=SANS,anchor='start',maxChars=60,maxLines=99}={}){const rows=lines(text,maxChars,maxLines);rows.forEach((r,i)=>parts.push(`<text x="${x}" y="${y+i*lh}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(r)}</text>`));return rows.length*lh;}

export function validateExplanatorySpec(spec){
  const e=[];
  if(!spec||typeof spec!=='object')return ['explanatory spec must be an object'];
  if(spec.schema_version!==EXPLAINER_SCHEMA_VERSION)e.push(`schema_version must be ${EXPLAINER_SCHEMA_VERSION}`);
  if(!String(spec.title??'').trim())e.push('title is required');
  if(!String(spec.subject??'').trim())e.push('subject is required');
  if(!EXPLAINER_VIEWS.includes(spec.view))e.push(`view must be one of ${EXPLAINER_VIEWS.join(', ')}`);
  if(!String(spec.alt??'').trim()||String(spec.alt).length<30)e.push('alt must be at least 30 characters');
  if(spec.not_to_scale!==true)e.push('not_to_scale must be true for the deterministic semantic explainer');
  if(!Array.isArray(spec.parts)||spec.parts.length<2||spec.parts.length>10)e.push('parts must contain 2-10 items');
  const ids=new Set();
  for(const p of spec.parts??[]){
    if(!String(p?.id??'').trim())e.push('each part requires id'); else if(ids.has(p.id))e.push(`duplicate part id '${p.id}'`); else ids.add(p.id);
    if(!String(p?.label??'').trim())e.push(`part '${p?.id??'?'}' requires label`);
    if(p?.weight!==undefined&&(!Number.isFinite(Number(p.weight))||Number(p.weight)<=0))e.push(`part '${p.id}' weight must be positive`);
    if(p?.claim_ids!==undefined&&(!Array.isArray(p.claim_ids)||p.claim_ids.some(x=>!String(x).trim())))e.push(`part '${p.id}' claim_ids must be strings`);
  }
  for(const r of spec.relationships??[]){
    if(!ids.has(r.source)||!ids.has(r.target))e.push(`relationship '${r.source}' -> '${r.target}' references unknown part`);
    if(r.source===r.target)e.push(`relationship '${r.source}' cannot self-reference`);
  }
  return e;
}

export function lintExplanatorySpec(spec,context={}){
  const blockers=validateExplanatorySpec(spec),warnings=[],notes=[];
  const verified=new Set((context.verified_claim_ids??[]).map(String));
  for(const p of spec.parts??[])for(const id of p.claim_ids??[])if(verified.size&&!verified.has(String(id)))blockers.push(`part '${p.id}' references unverified claim '${id}'`);
  if((spec.parts??[]).length>7)warnings.push('More than seven labeled parts can overload a single explanatory panel');
  if(spec.view==='system'&&!(spec.relationships??[]).length)warnings.push('System view has no explicit relationships');
  if(String(spec.subtitle??'').length>240)warnings.push('Subtitle is long for an explanatory panel');
  notes.push(`parts=${spec.parts?.length??0}`);notes.push(`relationships=${spec.relationships?.length??0}`);notes.push('semantic_geometry=schematic_not_to_scale');
  return {schema_version:EXPLAINER_SCHEMA_VERSION,passed:blockers.length===0,blockers,warnings,notes,content_hash:hash(spec)};
}

function shell(spec,w,h,mobile){
  const margin=mobile?42:62;const parts=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="ex-title ex-desc" data-explainer-version="${EXPLAINER_SCHEMA_VERSION}" data-view="${esc(spec.view)}">`,`<title id="ex-title">${esc(spec.title)}</title>`,`<desc id="ex-desc">${esc(spec.alt)}</desc>`,`<rect width="${w}" height="${h}" fill="${PAPER}"/>`];
  text(parts,String(spec.eyebrow??'EXPLAINER').toUpperCase(),margin,38,{size:11,weight:700,fill:ACCENT,maxChars:50,maxLines:1});
  text(parts,spec.title,margin,72,{family:SERIF,size:mobile?29:35,lh:mobile?34:40,weight:700,maxChars:mobile?30:46,maxLines:3});
  const titleLines=lines(spec.title,mobile?30:46,3).length;
  let y=72+titleLines*(mobile?34:40)+12;
  if(spec.subtitle)y+=text(parts,spec.subtitle,margin,y,{size:mobile?14:15,lh:mobile?20:21,fill:MUTED,maxChars:mobile?48:82,maxLines:3})+8;
  parts.push(`<line x1="${margin}" y1="${y}" x2="${w-margin}" y2="${y}" stroke="${GRID}"/>`);
  return {parts,margin,contentY:y+24};
}

function callout(parts,x,y,label,detail,side,mobile){
  const anchor=side==='left'?'end':'start';const dx=side==='left'?-14:14;const tx=x+dx;
  parts.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="${ACCENT}"/>`);
  parts.push(`<line x1="${x}" y1="${y}" x2="${x+(side==='left'?-22:22)}" y2="${y}" stroke="${MUTED}"/>`);
  text(parts,label,tx+(side==='left'?-22:22),y-4,{anchor,size:mobile?12:13,weight:700,maxChars:mobile?22:30,maxLines:2});
  if(detail)text(parts,detail,tx+(side==='left'?-22:22),y+14,{anchor,size:mobile?10.5:11,lh:14,fill:MUTED,maxChars:mobile?25:36,maxLines:2});
}

function renderExploded(spec,mobile){
  const w=mobile?640:1040;const partH=mobile?76:82;const gap=mobile?32:34;const header=220;const h=header+(spec.parts.length*(partH+gap))+150;const {parts,margin,contentY}=shell(spec,w,h,mobile);const cx=w/2;let y=contentY+30;
  parts.push(`<line x1="${cx}" y1="${y-18}" x2="${cx}" y2="${h-105}" stroke="${GRID}" stroke-dasharray="5 7"/>`);
  spec.parts.forEach((p,i)=>{const bw=mobile?190:280;const x=cx-bw/2+(i%2===0?-12:12);parts.push(`<rect x="${x}" y="${y}" width="${bw}" height="${partH}" rx="5" fill="${i===0?DARK:FAINT}" stroke="${i===0?DARK:GRID}"/>`);text(parts,p.label,cx,y+31,{anchor:'middle',size:mobile?13:15,weight:700,fill:i===0?'#fff':INK,maxChars:mobile?22:30,maxLines:2});callout(parts,x+(i%2===0?0:bw),y+partH/2,p.label,p.detail,i%2===0?'left':'right',mobile);y+=partH+gap;});
  return finish(parts,spec,w,h,margin,mobile);
}

function renderCutaway(spec,mobile){
  const w=mobile?640:1040;const h=mobile?880:700;const {parts,margin,contentY}=shell(spec,w,h,mobile);const x=mobile?178:320;const bw=mobile?285:400;const totalH=mobile?430:370;const weights=spec.parts.map(p=>Number(p.weight)||1);const sum=weights.reduce((a,b)=>a+b,0);let y=contentY+26;
  spec.parts.forEach((p,i)=>{const ph=Math.max(42,totalH*weights[i]/sum);parts.push(`<rect x="${x}" y="${y}" width="${bw}" height="${ph}" fill="${i%2?FAINT:'#e3e8ea'}" stroke="${GRID}"/>`);text(parts,p.label,x+16,y+26,{size:mobile?12:14,weight:700,maxChars:mobile?24:34,maxLines:2});const side=i%2?'right':'left';callout(parts,side==='left'?x:x+bw,y+ph/2,p.label,p.detail,side,mobile);y+=ph;});
  return finish(parts,spec,w,h,margin,mobile);
}

function renderAnatomy(spec,mobile){
  const w=mobile?640:1040;const h=mobile?920:720;const {parts,margin,contentY}=shell(spec,w,h,mobile);const cx=w/2, top=contentY+42, bottom=h-125;parts.push(`<rect x="${cx-(mobile?72:95)}" y="${top}" width="${mobile?144:190}" height="${bottom-top}" rx="${mobile?70:92}" fill="${FAINT}" stroke="${GRID}" stroke-width="2"/>`);const step=(bottom-top)/(spec.parts.length+1);spec.parts.forEach((p,i)=>{const y=top+step*(i+1);const side=i%2?'right':'left';parts.push(`<circle cx="${cx}" cy="${y}" r="${mobile?16:19}" fill="${i===0?ACCENT:DARK}"/>`);callout(parts,cx,y,p.label,p.detail,side,mobile);});return finish(parts,spec,w,h,margin,mobile);
}

function renderSystem(spec,mobile){
  const w=mobile?640:1040;const cols=mobile?1:Math.min(4,Math.max(2,Math.ceil(Math.sqrt(spec.parts.length))));const rows=Math.ceil(spec.parts.length/cols);const cellH=mobile?118:130;const h=240+rows*cellH+155;const {parts,margin,contentY}=shell(spec,w,h,mobile);const innerW=w-margin*2;const cellW=innerW/cols;const pos=new Map();spec.parts.forEach((p,i)=>{const c=i%cols,r=Math.floor(i/cols),x=margin+c*cellW+cellW/2,y=contentY+52+r*cellH;pos.set(p.id,{x,y});});for(const r of spec.relationships??[]){const a=pos.get(r.source),b=pos.get(r.target);if(!a||!b)continue;parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${MUTED}" stroke-width="2"/>`);if(r.label)text(parts,r.label,(a.x+b.x)/2,(a.y+b.y)/2-6,{anchor:'middle',size:10.5,fill:MUTED,maxChars:22,maxLines:1});}spec.parts.forEach((p,i)=>{const q=pos.get(p.id);const bw=mobile?310:Math.min(205,cellW-24);parts.push(`<rect x="${q.x-bw/2}" y="${q.y-32}" width="${bw}" height="64" rx="5" fill="${i===0?DARK:FAINT}" stroke="${i===0?DARK:GRID}"/>`);text(parts,p.label,q.x,q.y+4,{anchor:'middle',size:mobile?13:13.5,weight:700,fill:i===0?'#fff':INK,maxChars:mobile?30:22,maxLines:2});});return finish(parts,spec,w,h,margin,mobile);
}

function finish(parts,spec,w,h,margin,mobile){const y=h-82;parts.push(`<line x1="${margin}" y1="${y-25}" x2="${w-margin}" y2="${y-25}" stroke="${GRID}"/>`);text(parts,'SCHEMATIC / NOT TO SCALE',margin,y,{size:10,weight:700,fill:ACCENT,maxChars:40,maxLines:1});if(spec.source_note)text(parts,`Source / basis: ${spec.source_note}`,margin,y+23,{size:mobile?9.5:10.5,fill:MUTED,maxChars:mobile?82:140,maxLines:2});parts.push('</svg>');return parts.join('\n')+'\n';}

export function renderExplanatoryBundle(spec){const e=validateExplanatorySpec(spec);if(e.length)throw new Error(e.join('; '));const render=spec.view==='cutaway'?renderCutaway:spec.view==='exploded'?renderExploded:spec.view==='anatomy'?renderAnatomy:renderSystem;return {desktop:render(spec,false),mobile:render(spec,true)};}

export function critiqueExplanatory(spec,bundle){const issues=[];let score=100;for(const [view,svg] of Object.entries(bundle)){if(!svg.includes('<title')||!svg.includes('<desc')){issues.push({severity:'blocker',code:'accessibility_markup_missing',viewport:view});score-=25;}if(!svg.includes('SCHEMATIC / NOT TO SCALE')){issues.push({severity:'blocker',code:'schematic_disclosure_missing',viewport:view});score-=30;}}if((spec.parts??[]).length>7){issues.push({severity:'warning',code:'label_density'});score-=8;}if(spec.view==='system'&&(spec.relationships??[]).length>14){issues.push({severity:'warning',code:'relationship_density'});score-=8;}return {schema_version:EXPLAINER_SCHEMA_VERSION,passed:!issues.some(i=>i.severity==='blocker')&&score>=88,score:Math.max(0,score),issues};}

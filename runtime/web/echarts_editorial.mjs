import fs from 'node:fs';

function csv(text){
  const lines=text.trim().split(/\r?\n/); if(!lines.length) return [];
  const parse=(line)=>{ const out=[]; let cur='',q=false; for(let i=0;i<line.length;i++){ const c=line[i]; if(c==='"'){ if(q&&line[i+1]==='"'){cur+='"';i++;} else q=!q; } else if(c===','&&!q){out.push(cur);cur='';} else cur+=c; } out.push(cur); return out; };
  const head=parse(lines[0]); return lines.slice(1).filter(Boolean).map(line=>Object.fromEntries(parse(line).map((v,i)=>[head[i],v])));
}
function num(x){ const n=Number(x); return Number.isFinite(n)?n:null; }
function readRows(path){ const text=fs.readFileSync(path,'utf8'); if(path.endsWith('.json')){ const j=JSON.parse(text); return Array.isArray(j)?j:(j.rows??j.data??[]); } return csv(text); }

export function compileEchartsEditorialScene({dataPath,options={},designSystem={}}){
  if(!dataPath) throw new Error('ECharts editorial scene requires dataPath');
  const rows=readRows(dataPath); const type=options.chart_type||options.renderer||'bar'; const t=designSystem.tokens||{}; const primary=t.primary||'#235f74', secondary=t.secondary||'#6f8f95', accent=t.accent||'#a84a32', text=t.text||'#151515', muted=t.muted||'#666666', grid=t.grid||'#d8d5cd';
  const base={
    animation:false,
    backgroundColor:'transparent',
    textStyle:{fontFamily:'Arial, sans-serif',color:text},
    title:{text:options.title||'',subtext:options.subtitle||'',left:0,top:0,textStyle:{fontSize:Number(t.title_size||22),fontWeight:700,color:text},subtextStyle:{fontSize:Number(t.subtitle_size||12),lineHeight:18,color:muted}},
    tooltip:{trigger:'item'}
  };
  if(type==='sankey'){
    const sf=options.source_field||'source',tf=options.target_field||'target',vf=options.value_field||'value';
    const links=rows.map(r=>({source:String(r[sf]),target:String(r[tf]),value:num(r[vf])??0})).sort((a,b)=>a.source.localeCompare(b.source)||a.target.localeCompare(b.target)||a.value-b.value);
    const names=[...new Set(links.flatMap(x=>[x.source,x.target]))].sort();
    return {schema_version:'1.0.0',renderer:'echarts',artifact_family:'flow',source_note:options.source_note||'',option:{...base,series:[{type:'sankey',data:names.map(name=>({name})),links,emphasis:{focus:'adjacency'},nodeAlign:'justify',nodeGap:12,nodeWidth:14,draggable:false,label:{fontSize:11},lineStyle:{color:'source',curveness:0.48,opacity:0.42}}]}};
  }
  if(type==='line'){
    const xf=options.x_field,yf=options.y_field; return {schema_version:'1.0.0',renderer:'echarts',artifact_family:'statistical',source_note:options.source_note||'',option:{...base,xAxis:{type:'category',data:rows.map(r=>r[xf]),name:options.x_label||''},yAxis:{type:'value',name:options.y_label||''},series:[{type:'line',data:rows.map(r=>num(r[yf])),symbol:'none',lineStyle:{color:primary,width:Number(t.line_width||2)},itemStyle:{color:primary}}]}};
  }
  if(type==='scatter'){
    const xf=options.x_field,yf=options.y_field,lf=options.label_field;
    const data=rows.map(r=>({value:[num(r[xf]),num(r[yf])],name:lf?String(r[lf]):''})).filter(x=>x.value.every(v=>v!=null));
    return {schema_version:'1.0.0',renderer:'echarts',artifact_family:'statistical',source_note:options.source_note||'',option:{...base,xAxis:{type:'value',name:options.x_label||'',logBase:10,...(options.x_scale==='log'?{type:'log'}:{})},yAxis:{type:'value',name:options.y_label||''},series:[{type:'scatter',data,symbolSize:Number(t.point_size||10),itemStyle:{color:primary},label:lf?{show:true,formatter:'{b}',position:'right',fontSize:10}:{show:false}}]}};
  }
  const cf=options.category_field,vf=options.value_field, vals=rows.map(r=>num(r[vf]));
  const series=t.bar_mode==='lollipop'
    ? [{type:'bar',data:vals,barWidth:2,itemStyle:{color:grid},silent:true},{type:'scatter',data:vals.map((v,i)=>[v,i]),symbolSize:Number(t.point_size||12),itemStyle:{color:accent}}]
    : [{type:'bar',data:vals,itemStyle:{color:secondary}}];
  return {schema_version:'1.0.0',renderer:'echarts',artifact_family:'statistical',source_note:options.source_note||'',option:{...base,xAxis:{type:'value',name:options.x_label||''},yAxis:{type:'category',data:rows.map(r=>r[cf])},series}};
}

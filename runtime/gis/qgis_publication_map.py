#!/usr/bin/env python3
"""Headless QGIS publication renderer for the viz-qgis runtime.

Supports two deterministic modes:
1) approved QGIS project + QPT template;
2) a programmatic trajectory layout for benchmark qualification.
The second mode uses QGIS geometry, labeling and layout APIs so the benchmark can
compare real QGIS output without maintaining a second hand-written SVG renderer.
"""
from __future__ import annotations
import argparse,json,math
from pathlib import Path

VIRIDIS=['#440154','#3b528b','#21918c','#5ec962','#fde725']


def export_layout(req,layout,QgsLayoutExporter):
    outdir=Path(req['output_dir']); outdir.mkdir(parents=True,exist_ok=True)
    out=outdir/(req.get('options',{}).get('filename') or 'figure.svg')
    exporter=QgsLayoutExporter(layout)
    if out.suffix.lower()=='.svg': result=exporter.exportToSvg(str(out),QgsLayoutExporter.SvgExportSettings())
    elif out.suffix.lower() in {'.png','.jpg','.jpeg'}: result=exporter.exportToImage(str(out),QgsLayoutExporter.ImageExportSettings())
    else: result=exporter.exportToPdf(str(out),QgsLayoutExporter.PdfExportSettings())
    if result!=QgsLayoutExporter.Success: raise SystemExit(f'QGIS export failed with code {result}')
    manifest={
      'schema_version':'1.1.0','backend':'qgis_cartography','artifact_status':'FINAL','output':str(out),
      'story_id':req.get('story_id'),'semantic_fingerprint':req.get('semantic_fingerprint'),
      'evidence_hashes':req.get('evidence_hashes',{}),'claim_ids':req.get('claim_ids',[]),'design_system_id':(req.get('design_system') or {}).get('id'),'design_system_hash':(req.get('design_system') or {}).get('content_hash')
    }
    (outdir/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')


def render_template(req,project,QgsPrintLayout,QgsLayoutExporter,QgsReadWriteContext,QDomDocument):
    project_path=req.get('inputs',{}).get('project'); template_path=req.get('template')
    if not project_path or not template_path: return False
    if not project.read(project_path): raise SystemExit(f'failed to read QGIS project: {project_path}')
    doc=QDomDocument(); doc.setContent(Path(template_path).read_text())
    layout=QgsPrintLayout(project); layout.initializeDefaults(); ok,_=layout.loadFromTemplate(doc,QgsReadWriteContext())
    if not ok: raise SystemExit('failed to load QPT template')
    export_layout(req,layout,QgsLayoutExporter)
    mp=Path(req['output_dir'])/'manifest.json'; m=json.loads(mp.read_text()); m.update({'project':project_path,'template':template_path,'renderer':'qpt_template'}); mp.write_text(json.dumps(m,indent=2)+'\n')
    return True


def render_trajectory(req,project,api):
    (QgsVectorLayer,QgsFeature,QgsGeometry,QgsPointXY,QgsField,QgsCoordinateReferenceSystem,QgsCoordinateTransform,
     QgsLineSymbol,QgsMarkerSymbol,QgsRendererRange,QgsGraduatedSymbolRenderer,QgsSingleSymbolRenderer,QgsPalLayerSettings,
     QgsVectorLayerSimpleLabeling,QgsTextFormat,QgsTextBufferSettings,QgsPrintLayout,QgsLayoutItemMap,QgsLayoutItemLabel,
     QgsLayoutItemScaleBar,QgsLayoutPoint,QgsLayoutSize,QgsUnitTypes,QgsLayoutExporter,QgsRectangle,QVariant,QColor,QFont)=api
    opt=req.get('options',{}); inputs=req.get('inputs',{}); tok=(req.get('design_system') or {}).get('tokens',{}); track_path=inputs.get('track')
    if not track_path: raise SystemExit('qgis trajectory renderer requires inputs.track')
    obj=json.loads(Path(track_path).read_text()); rows=obj.get('points',[])
    if len(rows)<2: raise SystemExit('track requires at least two points')
    crs_id=opt.get('crs') or ('EPSG:32635' if opt.get('map_scale')=='local' else 'EPSG:5070')
    target=QgsCoordinateReferenceSystem(crs_id); src=QgsCoordinateReferenceSystem('EPSG:4326'); project.setCrs(target)
    tx=QgsCoordinateTransform(src,target,project)
    pts=[]
    for r in rows:
        p=tx.transform(QgsPointXY(float(r['lon']),float(r['lat']))); pts.append((p,r))
    point_layer=QgsVectorLayer(f'Point?crs={crs_id}','observed fixes','memory'); pp=point_layer.dataProvider(); pp.addAttributes([QgsField('speed',QVariant.Double),QgsField('label',QVariant.String)]); point_layer.updateFields()
    feats=[]
    for i,(p,r) in enumerate(pts):
        f=QgsFeature(point_layer.fields()); f.setGeometry(QgsGeometry.fromPointXY(p)); f['speed']=float(r.get('ground_speed_kt',0) or 0); f['label']='START' if i==0 else ('END' if i==len(pts)-1 else ''); feats.append(f)
    pp.addFeatures(feats); point_layer.updateExtents()
    max_speed=max(float(r.get('ground_speed_kt',0) or 0) for _,r in pts) or 1.0
    ranges=[]
    for i,c in enumerate(VIRIDIS):
        lo=max_speed*i/len(VIRIDIS); hi=max_speed*(i+1)/len(VIRIDIS)+1e-9; sym=QgsMarkerSymbol.createSimple({'name':'circle','color':c,'size':'2.1','outline_color':'white','outline_width':'0.25'}); ranges.append(QgsRendererRange(lo,hi,sym,f'{lo:.1f}-{hi:.1f}'))
    point_layer.setRenderer(QgsGraduatedSymbolRenderer('speed',ranges))
    pal=QgsPalLayerSettings(); pal.fieldName='label'; pal.enabled=True; pal.placement=QgsPalLayerSettings.AroundPoint
    fmt=QgsTextFormat(); fmt.setFont(QFont('DejaVu Sans',9)); fmt.setSize(9); buf=QgsTextBufferSettings(); buf.setEnabled(True); buf.setSize(1.0); buf.setColor(QColor('white')); fmt.setBuffer(buf); pal.setFormat(fmt); point_layer.setLabeling(QgsVectorLayerSimpleLabeling(pal)); point_layer.setLabelsEnabled(True)

    line_layer=QgsVectorLayer(f'LineString?crs={crs_id}','observed trajectory','memory'); lp=line_layer.dataProvider(); lp.addAttributes([QgsField('speed',QVariant.Double)]); line_layer.updateFields()
    gap_layer=QgsVectorLayer(f'LineString?crs={crs_id}','observation gaps','memory'); gp=gap_layer.dataProvider(); gap_layer.updateFields()
    lfeats=[]; gfeats=[]
    for i in range(len(pts)-1):
        a,ra=pts[i]; b,rb=pts[i+1]; geom=QgsGeometry.fromPolylineXY([a,b]); gap=float(rb.get('elapsed_s',0))-float(ra.get('elapsed_s',0)); same=ra.get('segment',0)==rb.get('segment',0)
        if gap>=1800 or not same:
            f=QgsFeature(); f.setGeometry(geom); gfeats.append(f); continue
        f=QgsFeature(line_layer.fields()); f.setGeometry(geom); f['speed']=(float(ra.get('ground_speed_kt',0) or 0)+float(rb.get('ground_speed_kt',0) or 0))/2; lfeats.append(f)
    lp.addFeatures(lfeats); line_layer.updateExtents(); gp.addFeatures(gfeats); gap_layer.updateExtents()
    lranges=[]
    for i,c in enumerate(VIRIDIS):
        lo=max_speed*i/len(VIRIDIS); hi=max_speed*(i+1)/len(VIRIDIS)+1e-9; sym=QgsLineSymbol.createSimple({'color':c,'width':'1.3','capstyle':'round'}); lranges.append(QgsRendererRange(lo,hi,sym,f'{lo:.1f}-{hi:.1f}'))
    line_layer.setRenderer(QgsGraduatedSymbolRenderer('speed',lranges))
    gap_layer.setRenderer(QgsSingleSymbolRenderer(QgsLineSymbol.createSimple({'color':'#666666','width':'0.6','line_style':'dash'})))

    contexts=[]
    for key in ('basemap','island','shoreline'):
        src_path=inputs.get(key)
        if src_path:
            layer=QgsVectorLayer(src_path,key,'ogr')
            if layer.isValid():
                sym=QgsLineSymbol.createSimple({'color':tok.get('border','#aaa59c'),'width':'0.25'}) if layer.geometryType()==1 else None
                if sym: layer.setRenderer(QgsSingleSymbolRenderer(sym))
                contexts.append(layer)
    for layer in [*contexts,line_layer,gap_layer,point_layer]: project.addMapLayer(layer)

    layout=QgsPrintLayout(project); layout.initializeDefaults()
    map_item=QgsLayoutItemMap(layout); layout.addLayoutItem(map_item); map_item.attemptMove(QgsLayoutPoint(12,34,QgsUnitTypes.LayoutMillimeters)); map_item.attemptResize(QgsLayoutSize(185,150,QgsUnitTypes.LayoutMillimeters)); map_item.setLayers([point_layer,gap_layer,line_layer,*reversed(contexts)])
    ext=point_layer.extent(); dx=max(ext.width()*.14,100); dy=max(ext.height()*.14,100); map_item.setExtent(QgsRectangle(ext.xMinimum()-dx,ext.yMinimum()-dy,ext.xMaximum()+dx,ext.yMaximum()+dy))
    title=QgsLayoutItemLabel(layout); title.setText(opt.get('title','Trajectory')); title.setFont(QFont('DejaVu Sans',int(float(opt.get('title_size',tok.get('title_size',20)))),QFont.Bold)); title.adjustSizeToText(); layout.addLayoutItem(title); title.attemptMove(QgsLayoutPoint(12,10,QgsUnitTypes.LayoutMillimeters)); title.attemptResize(QgsLayoutSize(185,12,QgsUnitTypes.LayoutMillimeters))
    if opt.get('subtitle'):
        sub=QgsLayoutItemLabel(layout); sub.setText(opt['subtitle']); sub.setFont(QFont('DejaVu Sans',9)); layout.addLayoutItem(sub); sub.attemptMove(QgsLayoutPoint(12,23,QgsUnitTypes.LayoutMillimeters)); sub.attemptResize(QgsLayoutSize(185,8,QgsUnitTypes.LayoutMillimeters))
    if opt.get('source_note'):
        cap=QgsLayoutItemLabel(layout); cap.setText(opt['source_note']); cap.setFont(QFont('DejaVu Sans',7)); layout.addLayoutItem(cap); cap.attemptMove(QgsLayoutPoint(12,188,QgsUnitTypes.LayoutMillimeters)); cap.attemptResize(QgsLayoutSize(185,8,QgsUnitTypes.LayoutMillimeters))
    if opt.get('scale_bar',True):
        sb=QgsLayoutItemScaleBar(layout); sb.setStyle('Single Box'); sb.setLinkedMap(map_item); sb.setNumberOfSegments(2); sb.setUnitsPerSegment(float(opt.get('scale_segment_m',250))); sb.setUnitLabel('m'); layout.addLayoutItem(sb); sb.attemptMove(QgsLayoutPoint(18,172,QgsUnitTypes.LayoutMillimeters))
    export_layout(req,layout,QgsLayoutExporter)
    mp=Path(req['output_dir'])/'manifest.json'; m=json.loads(mp.read_text()); m.update({'renderer':'programmatic_trajectory','crs':crs_id,'track_points':len(rows),'gap_segments':len(gfeats),'qgis_label_engine':'PAL'}); mp.write_text(json.dumps(m,indent=2)+'\n')


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args(); req=json.loads(Path(args.request).read_text())
    if req.get('backend')!='qgis_cartography': raise SystemExit('request backend must be qgis_cartography')
    try:
        from qgis.core import (QgsApplication,QgsProject,QgsPrintLayout,QgsLayoutExporter,QgsReadWriteContext,QgsVectorLayer,QgsFeature,QgsGeometry,QgsPointXY,QgsField,QgsCoordinateReferenceSystem,QgsCoordinateTransform,QgsLineSymbol,QgsMarkerSymbol,QgsRendererRange,QgsGraduatedSymbolRenderer,QgsSingleSymbolRenderer,QgsPalLayerSettings,QgsVectorLayerSimpleLabeling,QgsTextFormat,QgsTextBufferSettings,QgsLayoutItemMap,QgsLayoutItemLabel,QgsLayoutItemScaleBar,QgsLayoutPoint,QgsLayoutSize,QgsUnitTypes,QgsRectangle)
        from qgis.PyQt.QtXml import QDomDocument
        from qgis.PyQt.QtCore import QVariant
        from qgis.PyQt.QtGui import QColor,QFont
    except Exception as e: raise SystemExit(f'QGIS runtime unavailable: {e}')
    qgs=QgsApplication([],False); qgs.initQgis()
    try:
        project=QgsProject.instance()
        if render_template(req,project,QgsPrintLayout,QgsLayoutExporter,QgsReadWriteContext,QDomDocument): return
        if req.get('options',{}).get('renderer')!='trajectory_map': raise SystemExit('qgis_cartography requires approved project+template or options.renderer=trajectory_map')
        api=(QgsVectorLayer,QgsFeature,QgsGeometry,QgsPointXY,QgsField,QgsCoordinateReferenceSystem,QgsCoordinateTransform,QgsLineSymbol,QgsMarkerSymbol,QgsRendererRange,QgsGraduatedSymbolRenderer,QgsSingleSymbolRenderer,QgsPalLayerSettings,QgsVectorLayerSimpleLabeling,QgsTextFormat,QgsTextBufferSettings,QgsPrintLayout,QgsLayoutItemMap,QgsLayoutItemLabel,QgsLayoutItemScaleBar,QgsLayoutPoint,QgsLayoutSize,QgsUnitTypes,QgsLayoutExporter,QgsRectangle,QVariant,QColor,QFont)
        render_trajectory(req,project,api)
    finally: qgs.exitQgis()
if __name__=='__main__': main()

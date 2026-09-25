#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, os, pwd, shutil, tempfile, time
from pathlib import Path

QA_SCHEMA='0.2.0'
def sha_file(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def resolve_chromium_executable(env=None):
    """Resolve an installed Chrome/Chromium binary without importing Playwright."""
    env = os.environ if env is None else env
    explicit = str(env.get('CHROMIUM_BIN', '')).strip()
    if explicit:
        candidate = Path(explicit).expanduser()
        if candidate.is_file() and os.access(candidate, os.X_OK): return str(candidate)
        return None
    for name in ('chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'):
        found = shutil.which(name, path=env.get('PATH'))
        if found: return found
    for raw in ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/google-chrome', '/snap/bin/chromium'):
        candidate = Path(raw)
        if candidate.is_file() and os.access(candidate, os.X_OK): return str(candidate)
    return None

def write_startup_failure(out: Path, profile: str, error: str, html=None):
    report = {'schema_version': QA_SCHEMA, 'profile': profile, 'status': 'FAIL', 'errors': [error]}
    if html is not None and Path(html).is_file(): report['html_sha256'] = sha_file(html)
    (out / 'browser-qa.json').write_text(json.dumps(report, indent=2) + '\n')
    return report

def drop_root_if_needed(out: Path):
    if os.geteuid()!=0: return {'mode':'native-user','sandbox':True}
    if os.environ.get('ADN_BROWSER_ALLOW_ROOT_NO_SANDBOX')=='1':
        return {'mode':'root-explicit-no-sandbox','sandbox':False}
    try:
        rec=pwd.getpwnam('nobody'); uid,gid=rec.pw_uid,rec.pw_gid
        out.mkdir(parents=True,exist_ok=True)
        os.chown(out,uid,gid)
        home=Path(tempfile.mkdtemp(prefix='adn-browser-'))
        os.chown(home,uid,gid)
        os.environ['HOME']=str(home); os.environ['XDG_CONFIG_HOME']=str(home/'config'); os.environ['XDG_CACHE_HOME']=str(home/'cache')
        os.setgid(gid); os.setuid(uid)
        return {'mode':'dropped-to-nobody','sandbox':True}
    except Exception as exc:
        raise RuntimeError(f'Browser QA refuses implicit --no-sandbox as root: {exc}. Set ADN_BROWSER_ALLOW_ROOT_NO_SANDBOX=1 only for an explicitly isolated CI exception.')

def inspect_page(page):
    return page.evaluate(r'''() => {
      const q=s=>[...document.querySelectorAll(s)];
      const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const modules=q('[data-module-id]').map(e=>({id:e.dataset.moduleId,...rect(e),engine:e.dataset.engine||'',visual_type:e.dataset.visualType||''}));
      const a11y=[];
      for(const m of q('.pub-visual')){
        const id=m.dataset.moduleId||'?'; const chart=m.querySelector('.pub-chart');
        if(!chart)a11y.push(`${id}:missing_chart`); else {
          if(chart.getAttribute('role')!=='img')a11y.push(`${id}:missing_role_img`);
          if(!(chart.getAttribute('aria-label')||'').trim())a11y.push(`${id}:missing_aria_label`);
          const desc=chart.getAttribute('aria-describedby'); if(!desc||!(document.getElementById(desc)?.textContent||'').trim())a11y.push(`${id}:missing_long_description`);
          if(!chart.hasAttribute('tabindex'))a11y.push(`${id}:not_focusable`);
        }
      }
      const plotly=q('.js-plotly-plot').map(e=>{
        const r=rect(e),svg=e.querySelector('svg.main-svg'),sr=svg?rect(svg):null;
        const texts=q.call?[]:[];
        const allText=[...e.querySelectorAll('svg.main-svg text')].map(t=>({text:(t.textContent||'').trim(),...rect(t)}));
        const clipped=allText.filter(t=>t.width>0&&t.height>0&&(t.left<r.left-1||t.right>r.right+1||t.top<r.top-1||t.bottom>r.bottom+1));
        const scatterText=[...e.querySelectorAll('g.scatterlayer g.textpoint text')].map(t=>({text:(t.textContent||'').trim(),...rect(t)})).filter(t=>t.width>0&&t.height>0);
        const overlaps=[]; for(let i=0;i<scatterText.length;i++)for(let j=i+1;j<scatterText.length;j++){const a=scatterText[i],b=scatterText[j],ox=Math.min(a.right,b.right)-Math.max(a.left,b.left),oy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(ox>2&&oy>2)overlaps.push({a:a.text,b:b.text,overlap_x:ox,overlap_y:oy});}
        const legend=e.querySelector('g.legend'); const legendRect=legend?rect(legend):null;
        const plot=e.querySelector('g.cartesianlayer .plot')||e.querySelector('g.subplot'); const plotRect=plot?rect(plot):null;
        let legendOverlap=0; if(legendRect&&plotRect){const ox=Math.max(0,Math.min(legendRect.right,plotRect.right)-Math.max(legendRect.left,plotRect.left)),oy=Math.max(0,Math.min(legendRect.bottom,plotRect.bottom)-Math.max(legendRect.top,plotRect.top));legendOverlap=(ox*oy)/Math.max(1,plotRect.width*plotRect.height);}
        const plotRatio=plotRect?(plotRect.width*plotRect.height)/Math.max(1,r.width*r.height):1;
        const layout=e.layout||{}; const geoDomainError=((layout.yaxis?.range||[]).some(v=>Number(v)<-90||Number(v)>90) && ['scientific_map','geo_linked'].includes(e.closest('[data-visual-type]')?.dataset.visualType||''));
        return {...r,svg_left:sr?.left,svg_right:sr?.right,svg_width:sr?.width,text_clipped:clipped.slice(0,12),text_clipped_count:clipped.length,scatter_text_overlaps:overlaps.slice(0,12),scatter_text_overlap_count:overlaps.length,legend_overlap_ratio:legendOverlap,plot_area_ratio:plotRatio,geo_domain_error:geoDomainError,text_count:allText.length};
      });
      return {style_profile:document.querySelector('.pub-page')?.dataset.styleProfile||'',sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,modules,blocked:q('[data-blocked]').map(e=>e.closest('[data-module-id]')?.dataset.moduleId),plotly,webgl_error:document.body.innerText.includes('WebGL is not supported'),font_status:document.fonts?.status||'unknown',accessibility_errors:a11y};
    }''')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--html',required=True);ap.add_argument('--spec',required=True);ap.add_argument('--output',required=True);ap.add_argument('--profile',choices=['cpu','gpu'],default='cpu');args=ap.parse_args()
    html=Path(args.html).resolve();spec=json.loads(Path(args.spec).read_text());out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    try:
        from playwright.sync_api import sync_playwright
    except (ImportError, ModuleNotFoundError):
        write_startup_failure(out, args.profile, 'playwright_dependency_unavailable', html)
        raise SystemExit(2)
    chromium = resolve_chromium_executable()
    if not chromium:
        write_startup_failure(out, args.profile, 'chromium_executable_unavailable', html)
        raise SystemExit(2)
    security=drop_root_if_needed(out)
    html_text=html.read_text()
    import re
    def _inline_local_script(match):
        rel=match.group(1); asset=(html.parent/rel).resolve()
        if not str(asset).startswith(str(html.parent.resolve())) or not asset.is_file(): raise RuntimeError(f'missing local publication asset: {rel}')
        return '<script>'+asset.read_text()+'</script>'
    html_for_qa=re.sub(r'<script src="([^"]+)"></script>',_inline_local_script,html_text)
    widths=sorted(set(int(x) for x in spec['delivery']['breakpoints']));errors=[];accessibility_errors=[];external=[];shots=[];viewport_reports=[];replay=[]
    launch_args=[]
    if args.profile=='cpu': launch_args.append('--disable-gpu')
    if not security['sandbox']: launch_args.append('--no-sandbox')
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=chromium,headless=True,args=launch_args)
        for width in widths:
            page=browser.new_page(viewport={'width':width,'height':900},device_scale_factor=1)
            page.on('console',lambda msg: errors.append(f'console:{msg.type}:{msg.text}') if msg.type=='error' else None)
            page.on('pageerror',lambda exc: errors.append(f'pageerror:{exc}'))
            page.on('request',lambda req: external.append(req.url) if req.url.startswith(('http://','https://')) else None)
            t0=time.perf_counter();page.set_content(html_for_qa,wait_until='load');page.wait_for_function('window.__ADN_READY === true',timeout=20000);ready_ms=round((time.perf_counter()-t0)*1000,1);page.wait_for_timeout(250)
            dims1=inspect_page(page);page.wait_for_timeout(250);dims=inspect_page(page)
            if dims1['modules']!=dims['modules']: errors.append(f'layout_instability:{width}')
            overflow=dims['sw']>dims['cw']+2 or any(m['left']<-2 or m['right']>width+2 for m in dims['modules']) or any((m.get('svg_right') or 0)>width+2 or (m.get('svg_left') or 0)<-2 for m in dims.get('plotly',[]))
            if overflow: errors.append(f'overflow:{width}')
            clipped=sum(int(m.get('text_clipped_count') or 0) for m in dims.get('plotly',[]));
            if clipped: errors.append(f'plotly_text_clipping:{width}:{clipped}')
            text_overlaps=sum(int(m.get('scatter_text_overlap_count') or 0) for m in dims.get('plotly',[]));
            if text_overlaps: errors.append(f'plotly_scatter_text_overlap:{width}:{text_overlaps}')
            if any(float(m.get('legend_overlap_ratio') or 0)>.15 for m in dims.get('plotly',[])): errors.append(f'legend_intrusion:{width}')
            if any(float(m.get('plot_area_ratio') or 1)<.20 for m in dims.get('plotly',[])): errors.append(f'plot_area_too_small:{width}')
            if any(bool(m.get('geo_domain_error')) for m in dims.get('plotly',[])): errors.append(f'geographic_axis_domain:{width}')
            if dims.get('font_status')!='loaded': errors.append(f'fonts_not_ready:{width}:{dims.get("font_status")}')
            for ae in dims.get('accessibility_errors',[]): accessibility_errors.append(f'{width}:{ae}')
            if dims.get('blocked'): errors.append(f'blocked_modules:{width}:' + ','.join(str(x) for x in dims.get('blocked',[]) if x))
            if dims.get('webgl_error'): errors.append(f'webgl_unavailable:{width}')
            if args.profile=='gpu':
                webgl2=page.evaluate("() => {const c=document.createElement('canvas');return !!c.getContext('webgl2');}")
                if not webgl2: errors.append(f'webgl2_unavailable:{width}')
            shot=out/f'publication-{width}.png';page.screenshot(path=str(shot),full_page=True);shots.append({'width':width,'path':shot.name,'sha256':sha_file(shot)})
            max_ready=int(spec.get('delivery',{}).get('max_ready_ms',8000));
            if ready_ms>max_ready: errors.append(f'ready_time:{width}:{ready_ms}>{max_ready}')
            viewport_reports.append({'width':width,'ready_ms':ready_ms,'max_ready_ms':max_ready,'style_profile':dims.get('style_profile'),'scroll_width':dims['sw'],'client_width':dims['cw'],'module_count':len(dims['modules']),'blocked_modules':[x for x in dims['blocked'] if x],'plotly_boxes':dims.get('plotly',[]),'font_status':dims.get('font_status')})
            page.close()
        if spec.get('interaction',{}).get('replay'):
            page=browser.new_page(viewport={'width':1024,'height':900},device_scale_factor=1);page.set_content(html_for_qa,wait_until='load');page.wait_for_function('window.__ADN_READY === true',timeout=20000)
            for step in spec['interaction']['replay']:
                sel=f'[data-interaction-id="{step["target"]}"]';action=step['action']
                if page.locator(sel).count()==0: errors.append(f'interaction_target_missing:{step["target"]}');continue
                if action=='click': page.locator(sel).first.click()
                elif action=='hover': page.locator(sel).first.hover()
                elif action=='focus': page.locator(sel).first.focus()
                state=page.evaluate('document.body.dataset.publicationState || ""');expected=step.get('expect_state')
                if expected and state!=expected: errors.append(f'interaction_state:{step["target"]}:{state}!={expected}')
                observed_title=None
                if step.get('expect_module_id') and step.get('expect_plotly_title'):
                    module_id=step['expect_module_id'];observed_title=page.evaluate("mid => { const el=document.getElementById('chart-'+mid); return el?.layout?.title?.text || ''; }",module_id)
                    if observed_title!=step['expect_plotly_title']: errors.append(f'interaction_plotly_title:{module_id}:{observed_title}!={step["expect_plotly_title"]}')
                replay.append({'action':action,'target':step['target'],'state':state,'observed_plotly_title':observed_title})
            page.close()
        browser.close()
    external=sorted(set(external));accessibility_errors=sorted(set(accessibility_errors))
    if external: errors.append('external_requests_detected')
    if accessibility_errors: errors.extend('accessibility:'+x for x in accessibility_errors)
    max_shot=max(shots,key=lambda x:x['width']) if shots else None;archive=None
    if max_shot:
        archive_path=out/'archive.png';shutil.copyfile(out/max_shot['path'],archive_path);archive={'path':'archive.png','sha256':sha_file(archive_path),'source_width':max_shot['width']}
    max_bytes=int(spec.get('delivery',{}).get('max_initial_bytes',20000000));html_bytes=html.stat().st_size
    if html_bytes>max_bytes: errors.append(f'initial_bytes:{html_bytes}>{max_bytes}')
    report={'schema_version':QA_SCHEMA,'profile':args.profile,'security':security,'status':'PASS' if not errors else 'FAIL','html_sha256':sha_file(html),'viewports':viewport_reports,'screenshots':shots,'archive_fallback':archive,'initial_bytes':html_bytes,'max_initial_bytes':max_bytes,'interaction_replay':{'status':'PASS' if not any(e.startswith('interaction_') for e in errors) else 'FAIL','steps':replay},'external_requests':external,'accessibility_errors':accessibility_errors,'errors':errors}
    (out/'browser-qa.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));raise SystemExit(0 if report['status']=='PASS' else 2)
if __name__=='__main__': main()

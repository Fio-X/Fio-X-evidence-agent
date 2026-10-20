"""Field-level audit of two run folders. usage: run_audit.py <label> <saved run> <replay run> [--date-saved D --date-replay D]
Prints only: file shape (dir + extension, hash names shortened), class numbers, key names, counts, cmp results."""
import sys, os, json, re, hashlib, collections, glob
label, O, R = sys.argv[1:4]
args = sys.argv[4:]
DS = args[args.index('--date-saved') + 1] if '--date-saved' in args else None
DR = args[args.index('--date-replay') + 1] if '--date-replay' in args else None
DIRS = ('infographics', 'publications', 'visualizations', 'maps', 'computations')
HEX = re.compile(r'[0-9a-f]{64}')
sha = lambda b: hashlib.sha256(b).hexdigest()
CLASS = {'ready_ms': 1, 'render_qa': 3, 'render_qa_ref': 3, 'replay': 4, 'frozen_data_sha256': 4}


def files(b):
    s = set()
    for d in DIRS:
        for r, _, fs in os.walk(b + '/' + d):
            for f in fs:
                s.add(os.path.relpath(r + '/' + f, b))
    if os.path.exists(b + '/answer.md'):
        s.add('answer.md')
    return s


def shape(p):
    return '/'.join(('H' + x[64:]) if HEX.fullmatch(x[:64]) and (len(x) == 64 or x[64] == '.') else x for x in p.split('/'))


def walk(x, y, p=''):
    out = []
    if isinstance(x, dict) and isinstance(y, dict):
        for k in sorted(set(x) | set(y)):
            if k not in x:
                out.append(('replay-only', p + '/' + k))
            elif k not in y:
                out.append(('saved-only', p + '/' + k))
            else:
                out += walk(x[k], y[k], p + '/' + k)
    elif isinstance(x, list) and isinstance(y, list) and len(x) == len(y):
        for u, v in zip(x, y):
            out += walk(u, v, p + '[]')
    elif x != y:
        out.append(('differs', p))
    return out


def classify(diffs):
    cls = collections.Counter(); other = []
    for side, path in diffs:
        leaf = path.split('/')[-1].replace('[]', '')
        top = path.count('/') == 1
        if leaf == 'ready_ms':
            cls[1] += 1
        elif top and leaf in ('render_qa', 'render_qa_ref'):
            cls[3] += 1
        elif top and leaf in ('replay', 'frozen_data_sha256'):
            cls[4] += 1
        else:
            other.append((side, path))
    return cls, other


so, sr = files(O), files(R)
common = sorted(so & sr)
deferred_answer = False
report = collections.defaultdict(lambda: collections.Counter())
findings = []
bad_same = []
for rel in common:
    a = open(O + '/' + rel, 'rb').read(); b = open(R + '/' + rel, 'rb').read()
    if a == b:
        continue
    if rel == 'answer.md' and DR:
        deferred_answer = True
        continue
    if rel.endswith('.json'):
        cls, other = classify(walk(json.loads(a), json.loads(b)))
        for c, n in cls.items():
            report[shape(rel)][c] += n
        for side, path in other:
            findings.append((shape(rel), side, path))
    else:
        findings.append((shape(rel), 'bytes differ', ''))
mo, mr = sorted(so - sr), sorted(sr - so)
if deferred_answer:
    mo.append('answer.md'); mr.append('answer.md')
print(f'== {label}: same-name files differing: classes by file shape (count of fields)')
for s, c in sorted(report.items()):
    print('  ', s, dict(c))
print('  same-name findings (outside classes 1-4):', findings or 'none')
print(f'  saved-only names {len(mo)}, replay-only names {len(mr)}')

# ---- hash-name mapping (names that embed a content hash) ----
if mo or mr:
    mapping = {}  # replay hex -> saved hex
    def norm_text(t):
        if DR and DS:
            t = t.replace(DR, DS)
        for k, v in mapping.items():
            t = t.replace(k, v)
        return t
    def jclean(t):
        d = json.loads(t)
        def strip(x, top=True):
            if isinstance(x, dict):
                return {k: strip(v, False) for k, v in x.items()
                        if not (CLASS.get(k) in (1, 3, 4) and (k != 'ready_ms' or True) and k in CLASS)}
            if isinstance(x, list):
                return [strip(v, False) for v in x]
            return x
        return strip(d)
    textlike = ('.json', '.svg', '.html', '.md')
    unmatched_r = list(mr); unmatched_o = list(mo)
    pairs = []
    for rnd in range(12):
        progress = False
        for rr in list(unmatched_r):
            if not rr.endswith(textlike):
                continue
            rt = norm_text(open(R + '/' + rr, encoding='utf8').read())
            rname = rr
            for oo in list(unmatched_o):
                if shape(oo) != shape(rr):
                    continue
                ot = open(O + '/' + oo, encoding='utf8').read()
                rt_save = rt
                for h1, h2 in zip(HEX.findall(rr), HEX.findall(oo)):
                    rt = rt.replace(h1, h2)
                if oo.endswith('.json'):
                    try:
                        same = jclean(rt) == jclean(ot)
                    except Exception:
                        print('   (not parseable json, compared as text)', shape(oo)); same = rt == ot
                else:
                    same = rt == ot
                if not same:
                    rt = rt_save
                if same:
                    # learn hex name mappings from the path
                    for h1, h2 in zip(HEX.findall(rr), HEX.findall(oo)):
                        mapping[h1] = h2
                    pairs.append((rr, oo, 'text equal after date+names' + ('+class keys stripped' if oo.endswith('.json') else '')))
                    unmatched_r.remove(rr); unmatched_o.remove(oo); progress = True
                    break
        if not progress:
            break
    # ---- phase 2: pair json files whose only remaining differences are hash-valued leaves ----
    def leafdiffs(a, b, p=''):
        out = []
        if isinstance(a, dict) and isinstance(b, dict):
            for k in sorted(set(a) | set(b)):
                if k in a and k in b: out += leafdiffs(a[k], b[k], p + '/' + k)
                else: out.append((p + '/' + k, None, None, 'keyset'))
        elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            for u, v in zip(a, b): out += leafdiffs(u, v, p + '[]')
        elif a != b:
            out.append((p, a, b, 'leaf'))
        return out
    allr = set(h for x in mr for h in HEX.findall(x)); allo = set(h for x in mo for h in HEX.findall(x))
    for rr in mr:
        if rr.endswith(('.svg', '.png')): allr.add(sha(open(R + '/' + rr, 'rb').read()))
    for oo in mo:
        if oo.endswith(('.svg', '.png')): allo.add(sha(open(O + '/' + oo, 'rb').read()))
    # svg shas of the normalised replay svg equal the saved svg (checked above), so svg sha is legit on both sides
    derived = collections.Counter(); bad_leaf = []
    for rnd in range(6):
        prog = False
        for rr in list(unmatched_r):
            if not rr.endswith('.json'): continue
            rt = json.loads(norm_text(open(R + '/' + rr, encoding='utf8').read()))
            mapped = norm_text(rr)
            cands = [oo for oo in unmatched_o if shape(oo) == shape(rr)]
            if mapped in cands: cands = [mapped]
            elif len(cands) > 1 and rnd < 3: continue
            best = None
            for oo in cands:
                sv = json.loads(open(O + '/' + oo, encoding='utf8').read())
                ld = leafdiffs(jclean(json.dumps(rt)), jclean(json.dumps(sv)))
                if best is None or len(ld) < len(best[1]): best = (oo, ld)
            if not best: continue
            oo, ld = best
            if any(k == 'keyset' for *_, k in ld): continue
            ok = True; learn = {}
            for p, a, b, _ in ld:
                if not (isinstance(a, str) and isinstance(b, str)): ok = False; break
                ha, hb = HEX.findall(a), HEX.findall(b)
                if len(ha) != len(hb) or not ha or HEX.sub('#', a) != HEX.sub('#', b): ok = False; break
                for x, y in zip(ha, hb): learn[(x, y)] = p
            if not ok: continue
            for (x, y), p in learn.items():
                derived[(shape(rr), p.split('/')[-1] if p else p)] += 1
                if x not in allr and x not in {sha(open(R + '/' + q, 'rb').read()) for q in mr if q.endswith(('.svg','.png'))} and False: pass
                mapping[x] = y
            for h1, h2 in zip(HEX.findall(rr), HEX.findall(oo)): mapping[h1] = h2
            pairs.append((rr, oo, 'text equal after date+names' + '+class keys stripped+derived hash leaves'))
            unmatched_r.remove(rr); unmatched_o.remove(oo); prog = True
        if not prog: break
    print('  phase2 derived hash-valued fields (file shape, field, count):')
    for k, v in sorted(derived.items(), key=str): print('     ', k, v)
    # binary files: pair by shape (single candidate)
    from PIL import Image
    import numpy as np
    png_notes = []
    for rr in list(unmatched_r):
        cand = [oo for oo in unmatched_o if shape(oo) == shape(rr)]
        if rr.endswith('.png') and len(cand) == 1:
            oo = cand[0]
            ia = Image.open(O + '/' + oo).convert('RGB'); ib = Image.open(R + '/' + rr).convert('RGB')
            if ia.size != ib.size:
                png_notes.append((shape(rr), 'size differs', ia.size, ib.size))
            else:
                da = np.array(ia).astype(int); db = np.array(ib).astype(int)
                mask = (da != db).any(axis=2)
                ys, xs = np.where(mask)
                bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None
                png_notes.append((shape(rr), 'same size', ia.size, 'differing pixels', int(mask.sum()), 'bbox', bbox))
            pairs.append((rr, oo, 'png paired by role'))
            unmatched_r.remove(rr); unmatched_o.remove(oo)
    print(f'  hash-name mapping: {len(mapping)} names; paired {len(pairs)} of {len(mr)}; unpaired replay {len(unmatched_r)}, saved {len(unmatched_o)}')
    for rr in unmatched_r:
        if rr.endswith('.json'):
            rt = norm_text(open(R + '/' + rr, encoding='utf8').read())
            best = None
            for oo in unmatched_o:
                if shape(oo) != shape(rr): continue
                try:
                    df = walk(jclean(rt), json.loads(open(O + '/' + oo, encoding='utf8').read()))
                except Exception: continue
                if best is None or len(df) < len(best): best = df
            print('   UNPAIRED replay', shape(rr), 'closest saved differs in:', best)
        else:
            print('   UNPAIRED replay', shape(rr))
    for oo in unmatched_o: print('   UNPAIRED saved', shape(oo))
    for n in png_notes: print('   png', n)
    # per-pair cmp of normalised copy
    cmp_results = collections.Counter()
    for rr, oo, how in pairs:
        if rr.endswith('.svg') or rr.endswith('.html'):
            t = norm_text(open(R + '/' + rr, encoding='utf8').read())
            ok = t.encode('utf8') == open(O + '/' + oo, 'rb').read()
            cmp_results[(shape(rr), 'byte-identical after normalising' if ok else 'DIFFERS')] += 1
        elif rr.endswith('.json'):
            t = norm_text(open(R + '/' + rr, encoding='utf8').read())
            raw_same = t.encode('utf8') == open(O + '/' + oo, 'rb').read()
            cmp_results[(shape(rr), 'byte-identical after normalising' if raw_same else 'equal after stripping class keys')] += 1
        elif rr.endswith('.md'):
            t = norm_text(open(R + '/' + rr, encoding='utf8').read())
            ok = t.encode('utf8') == open(O + '/' + oo, 'rb').read()
            cmp_results[(shape(rr), 'byte-identical after normalising' if ok else 'DIFFERS')] += 1
    for k, v in sorted(cmp_results.items()):
        print('   cmp', k, v)
    # recompute product names
    def jsjson(o):
        return json.dumps(o, separators=(',', ':'), ensure_ascii=False)
    checks = collections.Counter()
    for rr, oo, how in pairs:
        name_o = oo.split('/')[-1].split('.')[0]
        if oo.startswith('infographics/') and oo.endswith('.svg') and shape(oo) == 'infographics/H.svg':
            svgsha = sha(norm_text(open(R + '/' + rr, encoding='utf8').read()).encode('utf8'))
            man = json.load(open(O + '/' + oo.replace('.svg', '.json')))
            key = sha(jsjson({'plan_ref': man['plan_ref'], 'desktopSha': svgsha}).encode('utf8'))
            checks['infographic key = sha256(JSON.stringify({plan_ref, desktopSha}))', key == name_o] += 1
            checks['desktop_sha256 of normalised svg equals saved manifest hashes.desktop_sha256', svgsha == man['hashes']['desktop_sha256']] += 1
        if shape(oo) == 'publications/H/index.html':
            h = sha(norm_text(open(R + '/' + rr, encoding='utf8').read()).encode('utf8'))
            checks['publication dir = sha256(html)', h == oo.split('/')[1]] += 1
        if shape(oo) in ('infographics/plans/H.json', 'publications/plans/H.json'):
            d = json.load(open(R + '/' + rr, encoding='utf8')) if False else json.loads(norm_text(open(R + '/' + rr, encoding='utf8').read()))
            for dk in ('content_hash', 'portable_fallback'):
                d.pop(dk, None)
            checks[shape(oo) + ' name = sha256(JSON.stringify(spec core)) on normalised replay', sha(jsjson(d).encode('utf8')) == name_o] += 1
            ds = json.load(open(O + '/' + oo, encoding='utf8'))
            for dk in ('content_hash', 'portable_fallback'):
                ds.pop(dk, None)
            checks[shape(oo) + ' recipe check on the saved file itself', sha(jsjson(ds).encode('utf8')) == name_o] += 1
    for k, v in sorted(checks.items(), key=str):
        print('   recompute', k, v)
    ap = [x for x in pairs if x[0] == 'answer.md' or x[0].endswith('answer.md')]

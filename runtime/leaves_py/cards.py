"""Pure card functions. Every printed number goes through fmt()."""
from words import word
def fmt(v, scale=1, dec=1):
    return f"{v/scale:,.{dec}f}"
def esc(s): return str(s).replace("&","&amp;").replace("<","&lt;")

def big_number(value, unit, label, sentence, scale=1, dec=1):
    return (f'<div class="bign"><div style="font:900 88px/1.1 var(--serif);color:var(--accent)">'
            f'{fmt(value,scale,dec)}<span style="font:600 28px var(--sans)"> {esc(unit)}</span></div>'
            f'<div style="font:600 22px/30px var(--sans);color:var(--t-title);margin-top:8px">{esc(label)}</div>'
            f'<div style="color:var(--t-dek)">{esc(sentence)}</div></div>')

def hbar(rows, unit, ref=None, title="", scale=1, dec=1, gap_word="", W=1100, bracket=None):
    # rows: [{label,value,highlight?}] sorted desc by caller
    rh, top, lw, rw = 26, 34, 100, 170
    H = top + rh*len(rows) + 16
    mx = max(max(r["value"] for r in rows), ref[1] if ref else 0) or 1
    bw = W - lw - rw
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img">']
    if ref:
        x = lw + ref[1]/mx*bw
        o.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{top-8}" y2="{H-14}" stroke="var(--t-title)" stroke-dasharray="4 3"/>'
                 f'<text x="{x:.1f}" y="{top-14}" text-anchor="middle" font-size="14" font-weight="600" fill="var(--t-title)">{esc(ref[0])} {fmt(ref[1],scale,dec)}</text>')
    for i, r in enumerate(rows):
        y = top + i*rh
        w = max(0, r["value"]/mx*bw)
        hi = r.get("highlight")
        c = "var(--accent)" if hi else "var(--bar)"
        o.append(f'<text x="{lw-10}" y="{y+17}" text-anchor="end" font-size="14" fill="{"var(--t-title)" if hi else "var(--t-body)"}" font-weight="{700 if hi else 400}">{esc(r["label"])}</text>'
                 f'<rect x="{lw}" y="{y+3}" width="{w:.1f}" height="{rh-6}" fill="{c}"/>'
                 f'<text class="v" x="{lw+w+6:.1f}" y="{y+17}" font-size="13" fill="{"var(--accent)" if hi else "var(--t-sec)"}" font-weight="{700 if hi else 400}">{fmt(r["value"],scale,dec)}</text>')
    if bracket is None and len(rows) > 1: bracket = (0, len(rows) - 1)
    if bracket:  # (i, j): the two rows the heading compares
        i, j = bracket
        bx = W - 110; y1 = top + rh*i + rh/2; y2 = top + rh*j + rh/2
        gap = rows[i]["value"] - rows[j]["value"]
        o.append(f'<path d="M{bx-8} {y1} H{bx} V{y2} H{bx-8}" fill="none" stroke="var(--t-sec)"/>'
                 f'<text x="{bx+8}" y="{(y1+y2)/2-6}" font-size="16" fill="var(--t-title)" font-weight="700">{word("gap", v=fmt(gap,scale,dec))}</text>'
                 f'<text x="{bx+8}" y="{(y1+y2)/2+14}" font-size="14" fill="var(--t-sec)">{esc(gap_word)}</text>')
    o.append('</svg>')
    return f'<div class="card wide"><h3>{esc(title)}</h3>{"".join(o)}</div>'

def _ticks(hi, n=4):
    import math
    raw = hi/n; p = 10**math.floor(math.log10(raw)); st = next(m*p for m in (1,2,2.5,5,10) if m*p >= raw)
    t = []; v = 0.0
    while v < hi + st*0.999: t.append(v); v += st
    return t

def line(main, unit, title="", scale=1, dec=1, main_name="", agg=None, agg_name="", W=1100, H=340):
    """main: protagonist series (or None). agg: aggregate series (grey). Draw whichever exist."""
    ml, mr, mt, mb = 56, min(190, int(W * 0.26)), 24, 32
    allv = [s for s in (main, agg) if s]
    xs = [p[0] for s in allv for p in s]; ys = [p[1] for s in allv for p in s]
    x0, x1 = min(xs), max(xs)
    tk = _ticks(max(ys) or 1); hi = tk[-1]
    px = lambda x: ml + (x-x0)/((x1-x0) or 1)*(W-ml-mr)
    py = lambda y: mt + (1-y/hi)*(H-mt-mb)
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img">']
    for t in tk:
        o.append(f'<line x1="{ml}" x2="{W-mr}" y1="{py(t):.1f}" y2="{py(t):.1f}" stroke="#e5e5e5"/>'
                 f'<text x="{ml-8}" y="{py(t)+5:.1f}" text-anchor="end" font-size="13" fill="var(--t-sec)">{fmt(t,scale,dec if t != int(t) and scale==1 else 0)}</text>')
    o.append(f'<text x="{px(x0):.1f}" y="{H-8}" font-size="13" fill="var(--t-sec)">{x0}</text>'
             f'<text x="{px(x1):.1f}" y="{H-8}" text-anchor="end" font-size="13" fill="var(--t-sec)">{x1}</text>')
    ends = []
    for s, col, sw, nm in ((agg, "#9a9a9a", 2, agg_name), (main, "var(--accent)", 2.5, main_name)):
        if not s: continue
        pts = " ".join(f"{px(x):.1f},{py(y):.1f}" for x, y in s)
        o.append(f'<polyline points="{pts}" fill="none" stroke="{col}" stroke-width="{sw}" stroke-linejoin="round"/>')
        ends.append([py(s[-1][1]), s, col, nm])
    # start labels: higher series above, lower below
    for k, e in enumerate(sorted(ends, key=lambda e: py(e[1][0][1]))):
        s = e[1]; sy = py(s[0][1]); above = (k == 0)
        o.append(f'<circle cx="{px(s[0][0]):.1f}" cy="{sy:.1f}" r="3.5" fill="{e[2]}"/>'
                 f'<text x="{px(s[0][0])+6:.1f}" y="{sy+(-10 if above else 20):.1f}" font-size="14" font-weight="600" fill="{e[2] if e[2]!="#9a9a9a" else "var(--t-sec)"}">{fmt(s[0][1],scale,dec)}</text>')
    ends.sort(key=lambda e: e[0])
    for i in range(1, len(ends)):
        if ends[i][0] - ends[i-1][0] < 22: ends[i][0] = ends[i-1][0] + 22
    for ey0, s, col, nm in ends:
        ey = py(s[-1][1]); tc = col if col != "#9a9a9a" else "var(--t-sec)"
        o.append(f'<circle cx="{px(x1):.1f}" cy="{ey:.1f}" r="5" fill="{col}"/>'
                 f'<text x="{px(x1)+12:.1f}" y="{ey0+5:.1f}" font-size="16" font-weight="700" fill="{tc}">{fmt(s[-1][1],scale,dec)}<tspan font-size="13" font-weight="400" fill="var(--t-sec)"> {esc(nm)}</tspan></text>')
    o.append('</svg>')
    return f'<div class="card wide"><h3>{esc(title)}</h3>{"".join(o)}</div>'

"""Line-art illustration library: each art draws in a 400x260 local box and names one anchor for its leader line.
Numbers never live here: the caller passes the note and sub-note already filled from facts. One accent colour only."""
INK, THIN, ACC = "var(--t-title)", "#8a8a8a", "var(--accent2)"

def _waves(x0, x1, y, amp=3, step=18):
    d = f"M{x0},{y}"
    for x in range(x0, x1, step): d += f" q{step / 4},{-amp} {step / 2},0 t{step / 2},0"
    return f'<path d="{d}" fill="none" stroke="{THIN}" stroke-width="1"/>'

def pipeline():
    """Offshore platform on the left, pipe running along the seabed to the right, cut-away end with a ring."""
    o = [_waves(0, 400, 70), _waves(10, 400, 82, 2, 24)]
    o.append(f'<path d="M0,210 C80,200 160,214 240,206 S360,200 400,208" fill="none" stroke="{INK}" stroke-width="1.4"/>')
    for x in range(8, 400, 14): o.append(f'<line x1="{x}" y1="{214 + (x % 3)}" x2="{x - 8}" y2="{228}" stroke="{THIN}" stroke-width="0.7"/>')
    # platform: jacket legs with cross bracing, deck, flare boom
    o.append(f'<path d="M36,206 L48,40 M92,206 L80,40 M48,40 L80,40" fill="none" stroke="{INK}" stroke-width="1.4"/>')
    for y0, y1 in ((60, 110), (110, 160), (160, 206)):
        o.append(f'<path d="M{48 - (y0 - 40) * 0.07:.1f},{y0} L{92 - (206 - y1) * 0.07:.1f},{y1} M{80 + (y0 - 40) * 0.07:.1f},{y0} L{36 + (206 - y1) * 0.07:.1f},{y1}" stroke="{THIN}" stroke-width="0.8" fill="none"/>')
    o.append(f'<rect x="30" y="24" width="68" height="16" fill="#fff" stroke="{INK}" stroke-width="1.4"/><path d="M98,26 L124,8" stroke="{INK}" stroke-width="1.2"/>'
             f'<path d="M124,8 q3,-6 0,-10 q-4,5 0,10" fill="none" stroke="{ACC}" stroke-width="1"/>')
    # pipe: riser down the leg, then along the seabed, drawn as a cylinder with joints
    o.append(f'<path d="M70,40 L70,196" stroke="{INK}" stroke-width="1.2"/><path d="M76,40 L76,190" stroke="{INK}" stroke-width="1.2"/>')
    o.append(f'<path d="M70,196 Q72,204 84,204 L360,198" fill="none" stroke="{INK}" stroke-width="1.4"/>'
             f'<path d="M76,190 Q78,194 86,194 L360,186" fill="none" stroke="{INK}" stroke-width="1.4"/>')
    for x in range(110, 360, 30): o.append(f'<path d="M{x},{193 - (x - 86) * 0.029:.1f} l0,{10.5:.1f}" stroke="{THIN}" stroke-width="0.8"/>')
    o.append(f'<ellipse cx="362" cy="192" rx="4" ry="6.5" fill="#fff" stroke="{ACC}" stroke-width="1.6"/><ellipse cx="362" cy="192" rx="2" ry="3.5" fill="none" stroke="{ACC}" stroke-width="1"/>')
    o.append(f'<path d="M366,190 l18,-8 M366,194 l18,6" stroke="{ACC}" stroke-width="1" stroke-dasharray="2 2"/>')
    return "".join(o), (300, 192)

def lng_ship():
    """Side view of a gas carrier with four spherical tanks, bridge at the stern."""
    o = [_waves(0, 400, 182), _waves(12, 400, 194, 2, 24)]
    o.append(f'<path d="M14,150 L386,150 L372,186 L40,186 Q22,184 14,150 Z" fill="#fff" stroke="{INK}" stroke-width="1.5"/>'
             f'<line x1="24" y1="164" x2="380" y2="164" stroke="{THIN}" stroke-width="0.8"/>')
    for i, cx in enumerate((92, 162, 232, 302)):
        o.append(f'<path d="M{cx - 30},150 A30,30 0 0 1 {cx + 30},150" fill="#fff" stroke="{ACC if i == 1 else INK}" stroke-width="1.5"/>'
                 f'<path d="M{cx - 30},150 A30,10 0 0 0 {cx + 30},150" fill="none" stroke="{THIN}" stroke-width="0.7"/>'
                 f'<path d="M{cx - 18},132 A22,22 0 0 1 {cx + 4},124" fill="none" stroke="{THIN}" stroke-width="0.7"/>')
    o.append(f'<path d="M340,150 L340,104 L372,104 L372,150" fill="#fff" stroke="{INK}" stroke-width="1.4"/>'
             f'<path d="M336,104 L376,104 M344,112 h24 M344,120 h24" stroke="{INK}" stroke-width="1"/><path d="M356,104 L356,86 M350,90 h12" stroke="{INK}" stroke-width="1.2"/>')
    o.append(f'<path d="M14,150 L8,138 L40,138 L40,150" fill="none" stroke="{INK}" stroke-width="1.2"/>')
    return "".join(o), (162, 122)

ART = dict(pipeline=pipeline, lng_ship=lng_ship)

def scene(items, W, H=300):
    """items: [(art, note_html, sub_html)]; arts side by side, each note above its anchor with a short leader."""
    n = len(items); cw = W / n; sc = min(cw / 420, (H - 70) / 260)
    o = [f'<div class="illus-scene" style="position:relative"><svg viewBox="0 0 {W} {H}" width="100%" role="img">']
    notes = []
    for i, (art, note, sub) in enumerate(items):
        body, (ax, ay) = ART[art]()
        tx, ty = i * cw + (cw - 400 * sc) / 2, 64
        o.append(f'<g transform="translate({tx:.1f},{ty}) scale({sc:.3f})">{body}</g>')
        x, y = tx + ax * sc, ty + ay * sc
        lx = i * cw + 12
        o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.5" fill="{INK}"/><path d="M{x:.1f},{y:.1f} L{x:.1f},40 L{lx + 4:.1f},40" fill="none" stroke="{INK}" stroke-width="0.8"/>')
        notes.append(f'<div class="inote" style="left:{lx / W * 100:.2f}%;top:0"><div class="in1">{note}</div><div class="in2">{sub}</div></div>')
    o.append("</svg>" + "".join(notes) + "</div>")
    css = ('<style>.inote{position:absolute;font:600 15px/20px var(--sans);color:var(--t-title);background:#fff;padding-right:6px}'
           '.inote b.n{color:var(--accent2)}.in2{font:400 12px/16px var(--sans);color:var(--t-sec)}.in2 b.n{color:var(--t-sec);font-weight:400}</style>')
    return css + "".join(o)

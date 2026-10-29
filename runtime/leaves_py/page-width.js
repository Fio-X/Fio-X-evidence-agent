() => { // page check: any text laid out past the page's content box (.pg inside its padding), left or right, html and svg alike
  const pg = document.querySelector('.pg'); if (!pg) return 'clean';
  const r = pg.getBoundingClientRect(), s = getComputedStyle(pg), L = r.left + parseFloat(s.paddingLeft), R = r.right - parseFloat(s.paddingRight);
  const out = [], w = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (!n.textContent.trim() || n.parentElement.closest('script, style')) continue;
    const g = document.createRange(); g.selectNodeContents(n);
    if ([...g.getClientRects()].some(b => b.width && (b.left < L - 1 || b.right > R + 1))) out.push(`past the page: ${n.textContent.trim().slice(0, 20)}`);
  }
  return out.join('\n') || 'clean';
}

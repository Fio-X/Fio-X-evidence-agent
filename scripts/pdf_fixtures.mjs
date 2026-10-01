// Synthetic PDF builder for offline tests. Pages are lists of text cells
// {x, y, text}; every glyph is a 2-byte code in an Identity-H Type0 font
// with a ToUnicode map, so Latin and CJK text extract identically through
// pdftotext without embedding any font.
export function buildPdf(pages) {
  const chars = [...new Set(pages.flat().flatMap((cell) => [...cell.text]))];
  const code = new Map(chars.map((ch, i) => [ch, i + 1]));
  const hex4 = (n) => n.toString(16).padStart(4, "0");
  const utf16 = (ch) => [...ch].map((c) => hex4(c.codePointAt(0))).join("");
  const toUnicode = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <0000> <ffff> endcodespacerange
${chars.length} beginbfchar
${chars.map((ch) => `<${hex4(code.get(ch))}> <${utf16(ch)}>`).join("\n")}
endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const objs = [];
  const n = pages.length;
  const fontNum = 3 + n * 2;
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`);
  pages.forEach((cells, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`);
    const stream = cells.map((c) => `BT /F1 10 Tf ${c.x} ${c.y} Td <${[...c.text].map((ch) => hex4(code.get(ch))).join("")}> Tj ET`).join("\n");
    objs.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objs.push(`<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [${fontNum + 1} 0 R] /ToUnicode ${fontNum + 2} 0 R >>`);
  objs.push(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 >>`);
  objs.push(`<< /Length ${Buffer.byteLength(toUnicode)} >>\nstream\n${toUnicode}\nendstream`);
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "utf8");
}

// A report-style table in a given layout. `rows` are arrays of cell strings;
// `colX` the x of each column. Every page repeats `header` (running page
// header) and the column titles, as printed reports do.
export function reportPages({ header, columns, rowsByPage, colX, leftX = 40 }) {
  return rowsByPage.map((rows) => {
    const cells = [{ x: leftX, y: 760, text: header }];
    cells.push(...columns.map((text, c) => ({ x: colX[c], y: 730, text })));
    rows.forEach((row, r) => row.forEach((text, c) => { if (text !== "") cells.push({ x: colX[c], y: 700 - r * 16, text }); }));
    return cells;
  });
}

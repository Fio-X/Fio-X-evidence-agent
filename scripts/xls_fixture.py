#!/usr/bin/env python3
"""Test fixtures for the spreadsheet converter: a tiny BIFF8 .xls (inside a CFB container) and a tiny .ods, written from scratch.

  xls_fixture.py DIR      writes DIR/sample.xls and DIR/sample.ods (same rows) and DIR/bad.xls (not a spreadsheet)
Rows: a header of strings, then a float that is a whole number, a float with decimals, a negative, a date cell, an empty cell.
"""
import datetime
import os
import struct
import sys
import zipfile

ROWS = [
    ["Age", "Total", "Share", "Date"],
    ["0", 1811000.0, 0.256, datetime.date(2024, 3, 5)],
    ["1", 3162567.0, -12.5, datetime.date(1999, 12, 31)],
    ["Note, with comma", 7.0, None, datetime.date(2000, 1, 1)],
]


def rec(rid, payload):
    return struct.pack("<HH", rid, len(payload)) + payload


def bstr(text):
    return struct.pack("<BB", len(text), 0) + text.encode("latin-1")


def serial(day):
    return (day - datetime.date(1899, 12, 30)).days


def xf(fmt, style):
    # font, format, flags(style bit), alignment, rotation, indent, used, borders, pattern
    return struct.pack("<HHHBBBBIIH", 0, fmt, 0xFFF5 if style else 0x0001, 0, 0, 0, 0, 0, 0, 0)


def biff(rows):
    out = rec(0x0809, struct.pack("<HHHHII", 0x0600, 0x0005, 0x0DBB, 0x07CC, 0, 6))
    out += rec(0x0042, struct.pack("<H", 1200))
    for index in range(16):
        out += rec(0x00E0, xf(14 if index == 15 else 0, index != 15))
    strings = []
    for row in rows:
        for value in row:
            if isinstance(value, str) and value not in strings:
                strings.append(value)
    sst = b"".join(struct.pack("<HB", len(t), 0) + t.encode("latin-1") for t in strings)
    out += rec(0x00FC, struct.pack("<II", len(strings), len(strings)) + sst)
    sheet_name = bstr("Data")
    bound_len = 4 + 6 + len(sheet_name)
    eof = rec(0x000A, b"")
    sheet_at = len(out) + bound_len + len(eof)
    out += rec(0x0085, struct.pack("<IBB", sheet_at, 0, 0) + sheet_name)
    out += eof
    sheet = rec(0x0809, struct.pack("<HHHHII", 0x0600, 0x0010, 0x0DBB, 0x07CC, 0, 6))
    width = max(len(r) for r in rows)
    sheet += rec(0x0200, struct.pack("<IIHHH", 0, len(rows), 0, width, 0))
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            if value is None:
                continue
            if isinstance(value, str):
                sheet += rec(0x00FD, struct.pack("<HHHI", r, c, 0, strings.index(value)))
            elif isinstance(value, datetime.date):
                sheet += rec(0x0203, struct.pack("<HHHd", r, c, 15, float(serial(value))))
            else:
                sheet += rec(0x0203, struct.pack("<HHHd", r, c, 0, float(value)))
    sheet += eof
    return out + sheet


def cfb(stream):
    sector = 512
    data = stream.ljust(max(4096, len(stream)), b"\x00")
    data += b"\x00" * (-len(data) % sector)
    count = len(data) // sector
    end, free, fat_sect = 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFD
    fat = [fat_sect, end] + [i + 3 for i in range(count - 1)] + [end]
    fat += [free] * (128 - len(fat))
    header = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" + b"\x00" * 16
    header += struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6) + b"\x00" * 6
    header += struct.pack("<IIIIIIIIII", 0, 1, 1, 0, 4096, end, 0, end, 0, 0)[:36]
    header += struct.pack("<109I", 0, *([free] * 108))
    assert len(header) == 512, len(header)

    def entry(name, kind, left, right, child, start, size):
        raw = (name.encode("utf-16-le") + b"\x00\x00") if name else b""
        head = raw.ljust(64, b"\x00") + struct.pack("<HBBIII", len(raw), kind, 1, left, right, child)
        return head + b"\x00" * 16 + struct.pack("<I", 0) + b"\x00" * 16 + struct.pack("<IQ", start, size)
    directory = entry("Root Entry", 5, free, free, 1, end, 0) + entry("Workbook", 2, free, free, free, 2, len(data))
    directory += entry("", 0, free, free, free, 0, 0) * 2
    return header + struct.pack("<128I", *fat) + directory + data


def make_xls(path, rows=ROWS):
    with open(path, "wb") as sink:
        sink.write(cfb(biff(rows)))


def make_ods(path, rows=ROWS):
    def cell(value):
        if value is None:
            return "<table:table-cell/>"
        if isinstance(value, str):
            text = value.replace("&", "&amp;").replace("<", "&lt;")
            return f'<table:table-cell office:value-type="string"><text:p>{text}</text:p></table:table-cell>'
        if isinstance(value, datetime.date):
            return f'<table:table-cell office:value-type="date" office:date-value="{value.isoformat()}"><text:p>{value.isoformat()}</text:p></table:table-cell>'
        return f'<table:table-cell office:value-type="float" office:value="{value!r}"><text:p>{value!r}</text:p></table:table-cell>'
    body = "".join("<table:table-row>" + "".join(cell(v) for v in row) + "</table:table-row>" for row in rows)
    content = ('<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
               'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">'
               f'<office:body><office:spreadsheet><table:table table:name="Data">{body}</table:table></office:spreadsheet></office:body></office:document-content>')
    manifest = ('<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
                '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>'
                '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>')
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(zipfile.ZipInfo("mimetype"), "application/vnd.oasis.opendocument.spreadsheet")
        archive.writestr("META-INF/manifest.xml", manifest)
        archive.writestr("content.xml", content)


if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    make_xls(os.path.join(out, "sample.xls"))
    make_ods(os.path.join(out, "sample.ods"))
    with open(os.path.join(out, "bad.xls"), "wb") as sink:
        sink.write(b"this is not a spreadsheet")

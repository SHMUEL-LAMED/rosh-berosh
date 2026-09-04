type ExportRow = { place: number; title: string; album: string; votes: number };

const encoder = new TextEncoder();
const xml = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16le(buf: Uint8Array, off: number, v: number) { buf[off] = v & 255; buf[off + 1] = (v >>> 8) & 255; }
function u32le(buf: Uint8Array, off: number, v: number) { buf[off] = v & 255; buf[off + 1] = (v >>> 8) & 255; buf[off + 2] = (v >>> 16) & 255; buf[off + 3] = (v >>> 24) & 255; }

function zip(files: Array<{ name: string; content: string }>) {
  const entries = files.map((f) => ({ name: encoder.encode(f.name), data: encoder.encode(f.content) }));
  entries.forEach((e) => Object.assign(e, { crc: crc32(e.data) }));
  let localSize = 0, centralSize = 0;
  for (const e of entries) { localSize += 30 + e.name.length + e.data.length; centralSize += 46 + e.name.length; }
  const out = new Uint8Array(localSize + centralSize + 22);
  let lo = 0, co = localSize;
  for (const e of entries) {
    const c = crc32(e.data);
    u32le(out, lo, 0x04034b50); u16le(out, lo + 4, 20); u32le(out, lo + 14, c);
    u32le(out, lo + 18, e.data.length); u32le(out, lo + 22, e.data.length); u16le(out, lo + 26, e.name.length);
    out.set(e.name, lo + 30); out.set(e.data, lo + 30 + e.name.length);
    u32le(out, co, 0x02014b50); u16le(out, co + 4, 20); u16le(out, co + 6, 20); u32le(out, co + 16, c);
    u32le(out, co + 20, e.data.length); u32le(out, co + 24, e.data.length); u16le(out, co + 28, e.name.length);
    u32le(out, co + 42, lo);
    out.set(e.name, co + 46);
    lo += 30 + e.name.length + e.data.length; co += 46 + e.name.length;
  }
  const eo = co;
  u32le(out, eo, 0x06054b50); u16le(out, eo + 8, files.length); u16le(out, eo + 10, files.length);
  u32le(out, eo + 12, centralSize); u32le(out, eo + 16, localSize);
  return out;
}

function textCell(ref: string, value: unknown, style = 0) { return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t>${xml(value)}</t></is></c>`; }
function numberCell(ref: string, value: number) { return `<c r="${ref}"><v>${Number(value) || 0}</v></c>`; }

function buildSheet(rows: ExportRow[], heading: string) {
  return [
    `<row r="1">${textCell("A1", "מקום", 1)}${textCell("B1", heading, 1)}${textCell("C1", "אלבום", 1)}${textCell("D1", "קולות", 1)}</row>`,
    ...rows.map((row, index) => { const line = index + 2; return `<row r="${line}">${numberCell(`A${line}`, row.place)}${textCell(`B${line}`, row.title)}${textCell(`C${line}`, row.album)}${numberCell(`D${line}`, row.votes)}</row>`; }),
  ].join("");
}

function downloadXlsx(files: Array<{ name: string; content: string }>, filename: string) {
  const blob = new Blob([zip(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), link = document.createElement("a");
  link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFB89530"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`;
const SHEET_XML = (sheetRows: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="10" customWidth="1"/><col min="2" max="3" width="34" customWidth="1"/><col min="4" max="4" width="12" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`;

export function downloadResultsXlsx(rows: ExportRow[], heading: string, filename: string) {
  const files = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(heading)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: STYLES_XML },
    { name: "xl/worksheets/sheet1.xml", content: SHEET_XML(buildSheet(rows, heading)) },
  ];
  downloadXlsx(files, filename);
}

export function downloadAllResultsXlsx(sheets: { rows: ExportRow[]; heading: string }[], filename: string) {
  const allRows: string[] = [];
  let line = 1;
  for (const section of sheets) {
    if (line > 1) line++;
    allRows.push(`<row r="${line}">${textCell(`A${line}`, "מקום", 1)}${textCell(`B${line}`, section.heading, 1)}${textCell(`C${line}`, "אלבום", 1)}${textCell(`D${line}`, "קולות", 1)}</row>`);
    line++;
    for (const row of section.rows) {
      allRows.push(`<row r="${line}">${numberCell(`A${line}`, row.place)}${textCell(`B${line}`, row.title)}${textCell(`C${line}`, row.album)}${numberCell(`D${line}`, row.votes)}</row>`);
      line++;
    }
  }
  const files = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="כל הנתונים" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: STYLES_XML },
    { name: "xl/worksheets/sheet1.xml", content: SHEET_XML(allRows.join("")) },
  ];
  downloadXlsx(files, filename);
}

type SubscriberRow = { email: string; name?: string | null; source?: string | null; createdAt?: number | null; unsubscribedAt?: number | null };

const SUBSCRIBER_SHEET_XML = (sheetRows: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="38" customWidth="1"/><col min="2" max="2" width="26" customWidth="1"/><col min="3" max="3" width="14" customWidth="1"/><col min="4" max="4" width="20" customWidth="1"/><col min="5" max="5" width="14" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`;

const sourceLabel = (source?: string | null) => source === "import" ? "ייבוא" : source === "admin" ? "הוספה ידנית" : "האתר";
const stamp = (value?: number | null) => value ? new Date(value < 1_000_000_000_000 ? value * 1000 : value).toLocaleString("he-IL") : "";

export function downloadSubscribersXlsx(rows: SubscriberRow[], filename: string) {
  const sheetRows = [
    `<row r="1">${textCell("A1", "כתובת דוא״ל", 1)}${textCell("B1", "שם", 1)}${textCell("C1", "מקור", 1)}${textCell("D1", "תאריך הרשמה", 1)}${textCell("E1", "סטטוס", 1)}</row>`,
    ...rows.map((row, index) => {
      const line = index + 2;
      return `<row r="${line}">${textCell(`A${line}`, row.email)}${textCell(`B${line}`, row.name || "")}${textCell(`C${line}`, sourceLabel(row.source))}${textCell(`D${line}`, stamp(row.createdAt))}${textCell(`E${line}`, row.unsubscribedAt ? "הוסר" : "פעיל")}</row>`;
    }),
  ].join("");
  const files = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="רשימת תפוצה" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: STYLES_XML },
    { name: "xl/worksheets/sheet1.xml", content: SUBSCRIBER_SHEET_XML(sheetRows) },
  ];
  downloadXlsx(files, filename);
}

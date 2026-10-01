/* קריאת קובץ רשימה לטקסט: אקסל (.xlsx), CSV או טקסט — לייבוא כתובות לרשימת התפוצה.
   בקובץ אקסל כל שורה בגיליון הופכת לשורה אחת, והתאים מופרדים בטאב (כמו ב־CSV),
   כך שהכתובת והשם נמצאים כמו בכל קובץ אחר. בלי ספריות: קובץ xlsx הוא zip, והדפדפן
   יודע לפתוח אותו לבד (DecompressionStream). קורא את כל הגיליונות שבקובץ.
     RoshSheet.text(file) → Promise<string>
     RoshSheet.xlsxText(bytes) → Promise<string> */
(function () {
  'use strict';

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const BAD = 'לא הצלחנו לפתוח את קובץ האקסל. נסו לשמור אותו מחדש (או כ־CSV) ולהעלות שוב.';

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  /** הקבצים שבתוך ה־zip ששמם עובר את want, כטקסט */
  async function unzip(bytes, want) {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(bytes, i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error(BAD);
    const count = u16(bytes, end + 10), dec = new TextDecoder(), out = {};
    let p = u32(bytes, end + 16);
    for (let n = 0; n < count && u32(bytes, p) === 0x02014b50; n++) {
      const method = u16(bytes, p + 10), size = u32(bytes, p + 20), nameLen = u16(bytes, p + 28);
      const skip = nameLen + u16(bytes, p + 30) + u16(bytes, p + 32), local = u32(bytes, p + 42);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + skip;
      if (!want(name)) continue;
      const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      const data = bytes.subarray(start, start + size);
      if (method !== 0 && method !== 8) throw new Error(BAD);
      out[name] = dec.decode(method === 8 ? await inflate(data) : data);
    }
    return out;
  }

  const unescapeXml = (v) => String(v)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&');
  /** כל הטקסט שבתוך תגיות <t> (גם כשתא מחולק לכמה קטעים מעוצבים) */
  const texts = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

  async function xlsxText(bytes) {
    let files;
    try { files = await unzip(bytes, (n) => /^xl\/(sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n)); }
    catch { throw new Error(BAD); }
    const shared = files['xl/sharedStrings.xml'] ? [...files['xl/sharedStrings.xml'].matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
    const lines = [];
    for (const name of Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort()) {
      for (const row of files[name].matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const type = /\bt="([^"]+)"/.exec(cell[1])?.[1] || '';
          const inner = cell[2] || '';
          const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          cells.push(type === 's' ? shared[Number(value)] ?? '' : type === 'inlineStr' ? texts(inner) : value == null ? '' : unescapeXml(value));
        }
        const line = cells.map((c) => c.replace(/[\t\r\n]+/g, ' ').trim()).join('\t').trim();
        if (line) lines.push(line);
      }
    }
    return lines.join('\n');
  }

  /** קובץ שנבחר → טקסט: אקסל נפתח, CSV וטקסט נקראים לפי הקידוד שלהם */
  async function text(file) {
    if (/\.xlsx$/i.test(file.name || '') || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return xlsxText(new Uint8Array(await file.arrayBuffer()));
    if (/\.xls$/i.test(file.name || '')) throw new Error('קובץ אקסל ישן (.xls) לא נתמך. שמרו אותו כ־xlsx או כ־CSV ונסו שוב.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    // "טקסט Unicode" מאקסל: UTF-16 עם BOM
    const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : '';
    if (bom) return new TextDecoder(bom).decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('windows-1255').decode(bytes); }   // CSV שאקסל בעברית שמר ("CSV (מופרד בפסיקים)") — לא UTF-8
  }

  window.RoshSheet = { text, xlsxText };
})();

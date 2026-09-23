/**
 * קריאת קובץ אקסל (.xlsx) לשורות טקסט — לייבוא כתובות לרשימת התפוצה.
 * כל שורה בגיליון הופכת לשורה עם התאים מופרדים בטאב, כך ש-`parseSubscriberList`
 * מוצא בה את הכתובת ואת השם כמו בקובץ CSV. קורא את כל הגיליונות שבקובץ.
 */
import { unzipSync, strFromU8 } from "fflate";

const unescapeXml = (value) => String(value)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, "&");
/** כל הטקסט שבתוך תגיות <t> (גם כשהתא מחולק לכמה קטעים מעוצבים) */
const texts = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join("");

/** @param {Uint8Array} bytes @returns {string} */
export function xlsxToText(bytes) {
  let files;
  try { files = unzipSync(bytes, { filter: (file) => /^xl\/(sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(file.name) }); }
  catch { throw new Error("לא הצלחנו לפתוח את קובץ האקסל. נסו לשמור אותו מחדש (או כ-CSV) ולהעלות שוב."); }
  const shared = files["xl/sharedStrings.xml"] ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
  const lines = [];
  for (const name of Object.keys(files).filter((n) => n.startsWith("xl/worksheets/")).sort()) {
    for (const row of strFromU8(files[name]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1] || "";
        const inner = cell[2] || "";
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (type === "s") cells.push(shared[Number(value)] ?? "");
        else if (type === "inlineStr") cells.push(texts(inner));
        else cells.push(value == null ? "" : unescapeXml(value));
      }
      const line = cells.map((c) => c.replace(/[\t\r\n]+/g, " ").trim()).join("\t").trim();
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}

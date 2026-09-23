import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { xlsxToText } from "../app/admin/xlsx-import.js";

/** קובץ אקסל כמו שאקסל וגוגל שיטס שומרים: מחרוזות משותפות, תא טקסט ישיר ותא מספר */
function workbook() {
  const shared = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>כתובת</t></si><si><t>שם</t></si><si><t>Sara@Example.com</t></si><si><r><t>שרה </t></r><r><rPr><b/></rPr><t>כהן &amp; בנות</t></r></si></sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>david@example.com</t></is></c><c r="B3"/><c r="C3"><v>42</v></c></row>
</sheetData></worksheet>`;
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "xl/sharedStrings.xml": strToU8(shared), "xl/worksheets/sheet1.xml": strToU8(sheet) });
}

test("Excel rows become tab-separated lines the subscriber import understands", () => {
  assert.equal(xlsxToText(workbook()), "כתובת\tשם\nSara@Example.com\tשרה כהן & בנות\ndavid@example.com\t\t42");
});

test("a file that is not an Excel workbook gets a readable error", () => {
  assert.throws(() => xlsxToText(strToU8("just text")), /אקסל/);
});

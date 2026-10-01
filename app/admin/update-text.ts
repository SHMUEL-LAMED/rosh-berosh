/* הטקסט של עדכון בדף העדכונים של אתר התוכניות: [מילה](כתובת) — קישור על מילה, **מודגש**,
   וכתובת גלויה הופכת לקישור לבד. שורה ריקה מפרידה פסקאות. אותם כללים כמו RoshUI.updateText
   באתר התוכניות (assets/js/ui.js במאגר rosh-berosh-2) — לעדכן יחד. */

export type UpdateSegment =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; url: string; bare?: boolean };

/** כתובת שמותר לקשר אליה: http(s), mailto:, tel: או דף באתר. אחרת — "" (בלי javascript: וכדומה) */
export function updateUrl(raw: string): string {
  const url = String(raw || "").trim();
  if (!url || /^\/\//.test(url)) return "";
  if (/^(mailto|tel):/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    try { const u = new URL(url); return /^https?:$/.test(u.protocol) && u.hostname ? u.href : ""; } catch { return ""; }
  }
  return /^(\/|\.\/|#|[\w-]+\.html\b)/.test(url) ? url : "";
}

const TAIL = /[.,;:!?)\]}״׳'"]+$/;
export const LINK_MARK = /\[([^\]\n]{1,300})\]\(([^)\s]{1,1000})\)/g;

/** פסקאות → שורות → קטעים */
export function parseUpdateText(text: string): UpdateSegment[][][] {
  const line = (value: string): UpdateSegment[] => {
    const out: UpdateSegment[] = [];
    const push = (segment: UpdateSegment) => {
      const last = out[out.length - 1];
      if (segment.kind === "text" && last?.kind === "text") last.text += segment.text; else if (segment.text) out.push(segment);
    };
    const re = /\[([^\]\n]{1,300})\]\(([^)\s]{1,1000})\)|\*\*([^*\n]{1,500})\*\*|(https?:\/\/[^\s<>"]+)/g;
    let last = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(value));) {
      push({ kind: "text", text: value.slice(last, m.index) }); last = re.lastIndex;
      if (m[1] != null) { const url = updateUrl(m[2]); push(url ? { kind: "link", text: m[1], url } : { kind: "text", text: m[0] }); }
      else if (m[3] != null) push({ kind: "bold", text: m[3] });
      else {
        const tail = m[4].match(TAIL)?.[0] || "", raw = m[4].slice(0, m[4].length - tail.length), url = updateUrl(raw);
        const shown = raw.replace(/^https?:\/\/(www\.)?/i, "");
        push(url ? { kind: "link", text: shown.length > 40 ? `${shown.slice(0, 38)}…` : shown, url, bare: true } : { kind: "text", text: raw });
        push({ kind: "text", text: tail });
      }
    }
    push({ kind: "text", text: value.slice(last) });
    return out;
  };
  return String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => p.split("\n").map(line));
}

/** קישורים על מילים שהכתובת שלהם לא תקינה (לא יהיו קישור באתר) */
export const badLinks = (text: string) => [...String(text || "").matchAll(LINK_MARK)].filter((m) => !updateUrl(m[2])).map((m) => m[1]);

const FILE_KINDS: Array<[RegExp, string, string]> = [[/\.pdf$/i, "📄", "PDF"], [/\.(docx?|odt|rtf)$/i, "📝", "Word"], [/\.(xlsx?|csv|ods)$/i, "📊", "גיליון"], [/\.(pptx?|odp)$/i, "📽️", "מצגת"], [/\.(jpe?g|png|webp|gif)$/i, "🖼️", "תמונה"], [/\.(mp3|m4a|wav|ogg|aac)$/i, "🎧", "שמע"], [/\.(mp4|mov|webm)$/i, "🎬", "וידאו"], [/\.zip$/i, "🗜️", "ZIP"], [/\.txt$/i, "📃", "טקסט"]];
/** הסמל והסוג של קובץ מצורף, לפי השם או הכתובת */
export function fileKindOf(file: { name?: string; url?: string }) {
  const probe = [file.name || "", (file.url || "").split("?")[0]];
  for (const [re, icon, label] of FILE_KINDS) if (probe.some((x) => re.test(x))) return { icon, label };
  return { icon: "📎", label: "קובץ" };
}
export function fmtSize(n: number) {
  if (!(n > 0)) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

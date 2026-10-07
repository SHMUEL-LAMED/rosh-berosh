/* המיקום בהקלטה של תוכנית, בחשבון של המאזין — אותם נתונים אישיים שאתר התוכניות שומר
   (/api/program/userdata: positions לפי מזהה תוכנית, ו־last — התוכנית האחרונה), כך שהאזנה
   שממשיכה כאן, בדף הניהול, נשמרת ובחזרה לאתר ממשיכים מאותה נקודה.
   השרת אינו ממזג: קוראים מה יש, מעדכנים רק את המיקום הזה, וכותבים חזרה. בסגירת הדף אין
   זמן לקריאה — נשלח מה שנקרא לאחרונה עם המיקום החדש (keepalive). */

type Position = { t: number; dur: number; at: number };
type UserData = { positions?: Record<string, Position>; last?: { id: string; t: number } | null; [key: string]: unknown };

let cached: UserData | null = null;
let lastSaved = 0;
let pending: Promise<void> | null = null;

async function read(): Promise<UserData> {
  const response = await fetch("/api/program/userdata", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`userdata ${response.status}`);
  const body = await response.json().catch(() => ({}));
  const data = body && typeof body.data === "object" && body.data && !Array.isArray(body.data) ? (body.data as UserData) : {};
  cached = data;
  return data;
}

function withPosition(data: UserData, id: string, t: number, dur: number): UserData {
  const positions = { ...(data.positions && typeof data.positions === "object" ? data.positions : {}) };
  const previous = positions[id];
  positions[id] = { t: Math.floor(t), dur: Math.floor(dur || 0) || previous?.dur || 0, at: Date.now() };
  return { ...data, positions, last: { id, t: Math.floor(t) } };
}

/** שמירת המיקום. force — גם אם נשמר לפני רגע (עצירה, סגירת הדף); keepalive — בסגירת הדף, בלי קריאה קודם. */
export function saveListenPosition(id: string, t: number, dur: number, { force = false, keepalive = false } = {}): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSaved < 30000) return Promise.resolve();
  if (pending && !keepalive) return pending.then(() => saveListenPosition(id, t, dur, { force, keepalive }));
  lastSaved = now;
  const run = (async () => {
    try {
      const base = keepalive ? cached || {} : await read();
      const body = JSON.stringify({ data: withPosition(base, id, t, dur) });
      const response = await fetch("/api/program/userdata", {
        method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body, cache: "no-store",
        keepalive: keepalive && new Blob([body]).size < 60000,
      });
      if (response.ok) cached = JSON.parse(body).data;
    } catch { /* בלי רשת — המיקום יישמר בפעם הבאה */ }
  })();
  if (!keepalive) { pending = run.finally(() => { if (pending === run) pending = null; }); }
  return run;
}

/** המיקום השמור של תוכנית (או null) — למשל כדי להמשיך מאותה נקודה כשהקישור לא נשא אותה */
export async function savedListenPosition(id: string): Promise<Position | null> {
  try { const data = await read(); return data.positions?.[id] || null; } catch { return null; }
}

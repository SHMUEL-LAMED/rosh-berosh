/* איתור ההקלטה של תוכנית: מפתח ב־R2 או מזהה קובץ בדרייב. משותף להורדה
   (/api/program/download), לתמלול, ולסימון ההקלטות שהועברו ל־R2. */

export const DRIVE_ID = /^[\w-]{10,128}$/;
export const DRIVE_DOWNLOAD = (id: string) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
export const programAudioKey = (driveId: string) => `program-recordings/${driveId}.mp3`;

type AudioSource = { audio?: unknown; links?: Array<{ url?: unknown } | null | undefined> | unknown; r2Key?: unknown };

/** מזהה קובץ דרייב מתוך כתובת ההקלטה או אחד הקישורים של התוכנית. */
export function driveIdOf(episode: AudioSource): string {
  const links = Array.isArray(episode.links) ? episode.links : [];
  const values = [episode.audio, ...links.map((link) => (link && typeof link === "object" ? (link as { url?: unknown }).url : null))]
    .filter((value): value is string => typeof value === "string" && !!value);
  for (const value of values) {
    const pathMatch = value.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
    if (pathMatch?.[1]) return pathMatch[1];
    try {
      const url = new URL(value);
      if (url.hostname === "drive.google.com") {
        const id = url.searchParams.get("id") || "";
        if (DRIVE_ID.test(id)) return id;
      }
    } catch { /* לא כתובת */ }
  }
  return "";
}

/** מפתח R2 בטוח: בלי "..", בלי / בהתחלה, ורק תווים רגילים. */
export function safeMediaKey(key: string): boolean {
  return !!key && !key.includes("..") && !key.startsWith("/") && /^[\w./-]+$/.test(key) && key.length <= 512;
}

/**
 * המפתחות ב־R2 שבהם ההקלטה עשויה להיות, לפי סדר העדיפות: `r2Key` שנשמר,
 * כתובת `/media/<key>` של הוורקר הזה, ולבסוף ההעתק של קובץ הדרייב.
 */
export function audioKeysOf(episode: AudioSource, origin: string): string[] {
  const keys: string[] = [];
  if (typeof episode.r2Key === "string" && safeMediaKey(episode.r2Key)) keys.push(episode.r2Key);
  if (typeof episode.audio === "string" && episode.audio) {
    try {
      const url = new URL(episode.audio, origin);
      if (url.origin === origin && url.pathname.startsWith("/media/")) {
        const key = url.pathname.slice("/media/".length).split("/").map(decodeURIComponent).join("/");
        if (safeMediaKey(key)) keys.push(key);
      }
    } catch { /* כתובת פגומה */ }
  }
  const driveId = driveIdOf(episode);
  if (driveId) keys.push(programAudioKey(driveId));
  return [...new Set(keys)];
}

type DbEnv = { DB: D1Database; MEDIA: R2Bucket };
export type StoredEpisode = { id: string; visible: boolean; data: Record<string, unknown> & { id: string } };

/** תוכנית לפי מזהה או slug, כולל מוסתרות — הבדיקה הציבורית נעשית אצל הקורא. */
export async function loadEpisode(env: DbEnv, idOrSlug: string): Promise<StoredEpisode | null> {
  if (!idOrSlug) return null;
  const row = await env.DB.prepare("SELECT id,visible,data_json FROM program_episodes WHERE id=? OR slug=? ORDER BY id=? DESC LIMIT 1")
    .bind(idOrSlug, idOrSlug, idOrSlug).first<{ id: string; visible: number; data_json: string }>();
  if (!row) return null;
  try { return { id: row.id, visible: !!Number(row.visible), data: { ...JSON.parse(row.data_json), id: row.id } }; }
  catch { return null; }
}

/** המפתח הראשון מבין האפשריים שקיים בפועל ב־R2, עם גודלו. */
export async function locateAudio(env: DbEnv, data: AudioSource, origin: string): Promise<{ key: string; size: number } | null> {
  for (const key of audioKeysOf(data, origin)) {
    const head = await env.MEDIA.head(key);
    if (head) return { key, size: head.size };
  }
  return null;
}

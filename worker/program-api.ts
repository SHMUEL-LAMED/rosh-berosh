import { createSession, GOOGLE_CLIENT_ID, readSession, sessionCookie, verifyGoogleCredential } from "./auth";
import seed from "./program-seed.json";
import { latestVersion, PROGRAM_SITE, programToolsApi, publicSettings, readSetting, settingsStatements, versionStatements } from "./program-tools";
import { DRIVE_DOWNLOAD, DRIVE_ID, driveIdOf, loadEpisode, programAudioKey, safeMediaKey, audioKeysOf } from "./program-audio";
import { isPublic, israelWallClock } from "./program-schedule.js";
import { NOTIFIED_KEY, notifiedStatement, notifyEpisodes, programPushApi } from "./program-push";
import { programAiApi, type AiBinding } from "./program-ai";
import { runTextFixes } from "./program-text-fixes";

type Env = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string; AI?: AiBinding; ANTHROPIC_API_KEY?: string };
type Ctx = { waitUntil(promise: Promise<unknown>): void };
const ORIGIN = "https://shmuel-lamed.github.io";
const MAX_FILE = 50 * 1024 * 1024;
// העלאה בחלקים (R2 multipart) לקבצים גדולים: הקלטה עד 1GB, עטיפה עד 15MB.
const MAX_MULTIPART_AUDIO = 1024 * 1024 * 1024;
const MAX_MULTIPART_COVER = 15 * 1024 * 1024;
const PART_SIZE = 20 * 1024 * 1024;
// Recordings live in shared Google Drive files. Google serves them as plain
// audio with Range support to servers, but answers 403 to any browser request
// that carries `Sec-Fetch-Site: cross-site` — so the program site's own player
// cannot load them directly and streams them through this worker instead.
const STREAM_HEADERS = ["content-type", "content-length", "content-range", "etag", "last-modified"];
const AUDIO = new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac", "audio/aac"]);
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const R2_BACKFILL_KEY = "program-recordings-r2-v1";
const seedDriveId = driveIdOf;

// The one-time GitHub migration uploaded all 86 recordings to R2, but its API
// token cannot write this D1 database. Mark the already-uploaded objects from
// inside the Worker instead: the Worker has the real DB binding. A DB marker
// makes this idempotent across isolates and avoids re-touching the catalogue.
async function backfillSeedR2Metadata(env: Env): Promise<void> {
  const done = await env.DB.prepare("SELECT 1 AS done FROM program_settings WHERE key=? LIMIT 1").bind(R2_BACKFILL_KEY).first();
  if (done) return;

  const migratedAt = new Date().toISOString();
  const updates = seed.episodes.flatMap((episode) => {
    const driveId = seedDriveId(episode);
    if (!driveId) return [];
    const expectedSize = Math.max(0, Math.floor(Number(episode.sourceFileBytes) || 0));
    return [env.DB.prepare(
      "UPDATE program_episodes SET data_json=json_set(data_json,'$.r2Key',?,'$.audioSource','r2','$.audioSize',?,'$.audioMigratedAt',?),updated_at=unixepoch() WHERE id=?"
    ).bind(programAudioKey(driveId), expectedSize, migratedAt, episode.id)];
  });
  if (updates.length !== 86) throw new Error(`Expected 86 seeded recordings for R2 backfill, found ${updates.length}`);
  updates.push(
    env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()")
      .bind(R2_BACKFILL_KEY, JSON.stringify({ count: updates.length, migratedAt })),
  );
  await env.DB.batch(updates);
}

async function r2AudioResponse(request: Request, env: Env, key: string, disposition = "inline"): Promise<Response | null> {
  const range = request.headers.get("range");
  const object = range ? await env.MEDIA.get(key, { range: request.headers }) : await env.MEDIA.get(key);
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("content-disposition", disposition);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  if ("range" in object && object.range) {
    const value = object.range as { offset: number; length: number };
    headers.set("content-range", `bytes ${value.offset}-${value.offset + value.length - 1}/${object.size}`);
    headers.set("content-length", String(value.length));
  } else headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: range && "range" in object ? 206 : 200, headers });
}

function cors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (origin === ORIGIN) {
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", ORIGIN);
    headers.set("access-control-allow-headers", "authorization,content-type,range");
    headers.set("access-control-allow-methods", "GET,HEAD,POST,PUT,DELETE,OPTIONS");
    headers.set("access-control-expose-headers", "content-length,content-range,accept-ranges,content-disposition");
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const reply = (request: Request, body: unknown, status = 200) => cors(request, json(body, status));
const safeId = (value: unknown) => String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);

const LOGIN_STYLE = "body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Arial,sans-serif;background:#0d1d35;color:#fff}.card{width:min(380px,calc(100% - 40px));padding:36px;border:1px solid #d9b85c;border-radius:24px;text-align:center;background:#142642;box-shadow:0 24px 70px #0006}h1{margin:0 0 12px}p{color:#ccd5e4;line-height:1.6}.who{color:#d9b85c;font-weight:700;direction:ltr;unicode-bidi:isolate}#google{display:grid;place-items:center;margin-top:24px}#google:empty{display:none}.error{color:#ffd2d2}";

// Runs inside the login window. `known` (the voting-site session seen by the
// server, or null) is defined by the page before this script.
const LOGIN_SCRIPT = `const target=${JSON.stringify(ORIGIN)};const out=document.getElementById('status');
const fail=(message)=>{out.className='error';out.textContent=message};
const deliver=(data)=>{if(!window.opener){fail('החלון הזה לא נפתח מאתר התוכניות. סגרו אותו ולחצו שם על "התחברות".');return}window.opener.postMessage({type:'rosh-program-auth',...data},target);out.className='';out.textContent='התחברתם. אפשר לסגור את החלון.';setTimeout(()=>window.close(),500)};
const exchange=async(url,body)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'הכניסה נכשלה.');return data};
const showGoogle=()=>{if(!window.google){fail('כפתור Google לא נטען. רעננו את החלון ונסו שוב.');return}google.accounts.id.initialize({client_id:${JSON.stringify(GOOGLE_CLIENT_ID)},callback:async({credential})=>{out.className='';out.textContent='בודקים הרשאה…';try{deliver(await exchange('/api/program/auth/google',{credential}))}catch(e){fail(e.message)}}});google.accounts.id.renderButton(document.getElementById('google'),{theme:'filled_blue',size:'large',shape:'pill',text:'continue_with',locale:'he',width:280})};
window.onload=async()=>{if(known){out.textContent=known.isAdmin?'מעבירים אתכם לניהול התוכניות…':'מעבירים אתכם לאזור האישי…';try{return deliver(await exchange('/api/program/auth/session'))}catch(e){fail(e.message)}}showGoogle()};`;

/** שם קובץ להורדה: חלופת ASCII ולצדה השם המלא בעברית (RFC 6266 / RFC 5987). */
export function downloadDisposition(title: string, id: string, ext: string) {
  const ascii = title.replace(/[^\x20-\x7e]+/g, " ").replace(/["\\]/g, "").replace(/\s+/g, " ").trim();
  const fallback = /[a-z]/i.test(ascii) ? ascii : `rosh-berosh-${id}`;
  const encoded = encodeURIComponent(`${title}.${ext}`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}.${ext}"; filename*=UTF-8''${encoded}`;
}

async function admin(request: Request, env: Env) {
  const user = await readSession(request, env);
  return user?.isAdmin ? user : null;
}

// What the program site learns about whoever signed in. Everyone gets a
// session and a personal area; only `isAdmin` opens the management area, and
// it is recomputed from the voting site's admin list on every request.
const publicUser = (user: { email: string; name: string; picture?: string; isAdmin: boolean }) =>
  ({ email: user.email, name: user.name, picture: user.picture, isAdmin: !!user.isAdmin });

async function catalog(env: Env, includeHidden = false, origin = "") {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_episodes").first<{ total: number }>();
  if (!Number(existing?.total)) {
    const inserts = seed.episodes.map((episode) => env.DB.prepare("INSERT OR IGNORE INTO program_episodes (id,slug,number,date,visible,data_json,updated_at) VALUES (?,?,?,?,?,?,unixepoch())")
      .bind(episode.id, episode.slug, episode.number, episode.date || null, episode.visible === false ? 0 : 1, JSON.stringify(episode)));
    inserts.push(env.DB.prepare("INSERT OR IGNORE INTO program_settings (key,value_json,updated_at) VALUES ('seasons',?,unixepoch())").bind(JSON.stringify(seed.seasons)));
    await env.DB.batch(inserts);
  }
  await backfillSeedR2Metadata(env);
  await runTextFixes(env);   // תיקוני כתיב חד־פעמיים בשמות ובתיאורים
  const [episodes, settings] = await env.DB.batch([
    env.DB.prepare(`SELECT id,data_json FROM program_episodes ${includeHidden ? "" : "WHERE visible=1"} ORDER BY date DESC,number DESC`),
    env.DB.prepare("SELECT key,value_json FROM program_settings"),
  ]);
  const values = new Map((settings.results as Array<{ key: string; value_json: string }>).map((row) => {
    try { return [row.key, JSON.parse(row.value_json)]; } catch { return [row.key, null]; }
  }));
  // תוכנית מתוזמנת (publishAt בעתיד, בשעון ישראל) אינה מגיעה לציבור; מנהלים רואים הכול
  const now = israelWallClock();
  return {
    version: 1,
    seasons: values.get("seasons") || [],
    episodes: (episodes.results as Array<{ id: string; data_json: string }>).flatMap((row) => {
      try {
        const data = { ...JSON.parse(row.data_json), id: row.id };
        return includeHidden || isPublic(data, true, now) ? [data] : [];
      } catch { return []; }
    }),
    // ההגדרות הציבוריות של אתר התוכניות (ההודעה בדף הבית ודף העדכונים)
    settings: await publicSettings(env, origin),
  };
}

export async function programApi(request: Request, env: Env, ctx: Ctx): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/program/")) return null;
  if (request.method === "OPTIONS") return cors(request, new Response(null, { status: 204 }));

  if (url.pathname === "/api/program/login" && request.method === "GET") {
    // The window is opened on this origin, so it carries the voting site's own
    // session cookie. Whoever is signed in there as an administrator is handed
    // a program token at once; everyone else gets the Google button, and the
    // same admin list decides in both cases.
    const user = await readSession(request, env);
    const known = user ? { email: user.email, isAdmin: user.isAdmin } : null;
    const intro = known
      ? `מחוברים לאתר הסקר כ־<span class="who">${escapeHtml(known.email)}</span>.`
      : "התחברו עם חשבון Google כדי לפתוח את האזור האישי. מנהלי אתר הסקר מקבלים גם גישה לניהול.";
    const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>כניסה לראש בראש</title><script src="https://accounts.google.com/gsi/client" async defer></script><style>${LOGIN_STYLE}</style></head><body><main class="card"><h1>כניסה לראש בראש</h1><p>${intro}</p><div id="google"></div><p id="status"></p></main><script>const known=${JSON.stringify(known).replace(/</g, "\\u003c")};${LOGIN_SCRIPT}</script></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; style-src 'unsafe-inline' https://accounts.google.com/gsi/style; img-src data: https://*.googleusercontent.com" } });
  }

  if (url.pathname === "/api/program/catalog" && request.method === "GET") {
    const user = await readSession(request, env);
    const data = await catalog(env, !!user?.isAdmin, url.origin);
    // למנהלים: מזהה הגרסה האחרונה, שנשלח בחזרה בפרסום (baseVersion) כהגנה מהתנגשות
    if (user?.isAdmin) return reply(request, { ...data, versionId: (await latestVersion(env))?.id ?? null });
    return reply(request, data, 200);
  }
  if (url.pathname === "/api/program/auth/google" && request.method === "POST") {
    try {
      const { credential } = await request.json<{ credential?: string }>();
      if (!credential) return reply(request, { error: "חסר אישור Google." }, 400);
      const user = await verifyGoogleCredential(credential, env);
      const token = await createSession(env, user);
      // בחלון הכניסה (אותה כתובת של אתר הסקר) זה מחבר גם את אתר הסקר עצמו
      const response = reply(request, { token, user: publicUser(user) });
      response.headers.append("set-cookie", sessionCookie(token));
      return response;
    } catch (error) {
      console.error("program google auth error", error);
      return reply(request, { error: "ההתחברות באמצעות Google נכשלה." }, 401);
    }
  }
  if (url.pathname === "/api/program/auth/session" && request.method === "POST") {
    // Same-origin only: the login window exchanges the voting site's session
    // cookie for a program token. A cross-site caller never carries that cookie
    // (SameSite=Lax), this route deliberately sends no CORS headers, and a
    // bearer token is ignored so a program token cannot renew itself.
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    const user = await readSession(new Request(request.url, { method: request.method, headers }), env);
    if (!user) return json({ error: "לא מחוברים לאתר הסקר." }, 401);
    const token = await createSession(env, user);
    return json({ token, user: publicUser(user) });
  }
  if (url.pathname === "/api/program/me" && request.method === "GET") {
    const user = await readSession(request, env);
    return user ? reply(request, { user: publicUser(user) }) : reply(request, { user: null }, 401);
  }
  if (url.pathname.startsWith("/api/program/stream/") && (request.method === "GET" || request.method === "HEAD")) {
    // R2 is the permanent source. Drive remains a read-only fallback while
    // older recordings are being migrated, so playback never goes offline.
    const id = url.pathname.slice("/api/program/stream/".length);
    if (!DRIVE_ID.test(id)) return reply(request, { error: "מזהה הקלטה לא תקין." }, 400);
    const stored = await r2AudioResponse(request, env, programAudioKey(id));
    if (stored) return cors(request, stored);
    const upstreamHeaders = new Headers();
    const range = request.headers.get("range");
    if (range) upstreamHeaders.set("range", range);
    let upstream: Response;
    try {
      upstream = await fetch(DRIVE_DOWNLOAD(id), { method: request.method, headers: upstreamHeaders, redirect: "follow" });
    } catch (error) {
      console.error("program stream fetch error", error);
      return reply(request, { error: "ההקלטה אינה זמינה כרגע." }, 502);
    }
    const type = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!(upstream.status === 200 || upstream.status === 206) || !type.startsWith("audio/")) {
      await upstream.body?.cancel().catch(() => {});
      return reply(request, { error: upstream.status === 416 ? "טווח לא תקין." : "ההקלטה אינה זמינה כרגע." }, upstream.status === 416 ? 416 : 502);
    }
    const headers = new Headers();
    for (const name of STREAM_HEADERS) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
    headers.set("accept-ranges", "bytes");
    headers.set("content-disposition", "inline");
    headers.set("cache-control", "public, max-age=3600");
    headers.set("x-content-type-options", "nosniff");
    return cors(request, new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers }));
  }
  if (url.pathname === "/api/program/import-drive" && request.method === "POST") {
    if (!await admin(request, env)) return reply(request, { error: "אין הרשאת ניהול." }, 403);
    let body: { driveId?: string; episodeId?: string; expectedSize?: number };
    try { body = await request.json(); } catch { return reply(request, { error: "בקשה לא תקינה." }, 400); }
    const driveId = String(body.driveId || "").trim();
    const episodeId = safeId(body.episodeId);
    const expectedSize = Math.max(0, Math.floor(Number(body.expectedSize) || 0));
    if (!DRIVE_ID.test(driveId) || !episodeId) return reply(request, { error: "פרטי ההקלטה אינם תקינים." }, 400);
    const key = programAudioKey(driveId);
    const existing = await env.MEDIA.head(key);
    if (existing && (!expectedSize || existing.size === expectedSize)) {
      return reply(request, { ok: true, status: "existing", key, size: existing.size });
    }
    let upstream: Response;
    try { upstream = await fetch(DRIVE_DOWNLOAD(driveId), { redirect: "follow" }); }
    catch (error) { console.error("program import fetch error", driveId, error); return reply(request, { error: "הורדת ההקלטה מדרייב נכשלה." }, 502); }
    const type = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!upstream.ok || !type.startsWith("audio/") || !upstream.body) {
      await upstream.body?.cancel().catch(() => {});
      return reply(request, { error: "דרייב לא החזיר קובץ שמע תקין." }, 502);
    }
    try {
      const saved = await env.MEDIA.put(key, upstream.body, {
        httpMetadata: { contentType: type || "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { driveId, episodeId, migratedAt: new Date().toISOString(), expectedSize: String(expectedSize || "") },
      });
      if (expectedSize && saved.size !== expectedSize) {
        await env.MEDIA.delete(key);
        return reply(request, { error: `גודל הקובץ אינו תואם: ${saved.size} במקום ${expectedSize}.` }, 502);
      }
      const row = await env.DB.prepare("SELECT data_json FROM program_episodes WHERE id=?").bind(episodeId).first<{ data_json: string }>();
      if (row?.data_json) {
        try {
          const data = JSON.parse(row.data_json);
          data.r2Key = key;
          data.audioSource = "r2";
          data.audioSize = saved.size;
          data.audioMigratedAt = new Date().toISOString();
          await env.DB.prepare("UPDATE program_episodes SET data_json=?,updated_at=unixepoch() WHERE id=?").bind(JSON.stringify(data), episodeId).run();
        } catch (error) { console.error("program import catalog marker error", episodeId, error); }
      }
      return reply(request, { ok: true, status: "uploaded", key, size: saved.size });
    } catch (error) {
      console.error("program import R2 error", driveId, error);
      return reply(request, { error: "שמירת ההקלטה ב־R2 נכשלה." }, 500);
    }
  }
  if (url.pathname === "/api/program/catalog" && request.method === "POST") {
    const publisher = await admin(request, env);
    if (!publisher) return reply(request, { error: "אין הרשאת ניהול." }, 403);
    let body: { seasons?: unknown[]; episodes?: Array<Record<string, unknown>>; removedIds?: string[]; settings?: Record<string, unknown>; baseVersion?: string | null; force?: boolean; notify?: boolean };
    try { body = await request.json(); } catch { return reply(request, { error: "בקשה לא תקינה." }, 400); }
    if (!Array.isArray(body.episodes) || !Array.isArray(body.seasons) || body.episodes.length > 2000) return reply(request, { error: "נתוני התוכניות אינם תקינים." }, 400);
    // הגנה מהתנגשות: מי שפותח את העורך מקבל את מזהה הגרסה האחרונה; אם מאז
    // מישהו אחר פרסם, הפרסום נעצר (אלא אם ביקשו במפורש לדרוס).
    if ("baseVersion" in body && body.force !== true) {
      const latest = await latestVersion(env);
      if ((latest?.id ?? null) !== (body.baseVersion ?? null)) {
        return reply(request, { error: "מישהו אחר פרסם בינתיים. טענו מחדש את הנתונים כדי לא לדרוס את השינויים שלו, או פרסמו בכל זאת.", conflict: true, latest }, 409);
      }
    }
    // מה היה גלוי לציבור לפני הפרסום — כדי לדעת אילו תוכניות חדשות עכשיו
    const beforeNow = israelWallClock();
    const before = new Set(((await env.DB.prepare("SELECT id,data_json FROM program_episodes WHERE visible=1").all<{ id: string; data_json: string }>()).results).flatMap((row) => {
      try { return isPublic(JSON.parse(row.data_json), true, beforeNow) ? [row.id] : []; } catch { return []; }
    }));
    const statements = body.episodes.map((episode) => {
      const id = safeId(episode.id || episode.slug);
      const slug = safeId(episode.slug || episode.id);
      if (!id || !slug || !String(episode.title || "").trim()) throw new Error("invalid episode");
      const data = { ...episode, id, slug };
      return env.DB.prepare("INSERT INTO program_episodes (id,slug,number,date,visible,data_json,updated_at) VALUES (?,?,?,?,?,?,unixepoch()) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,number=excluded.number,date=excluded.date,visible=excluded.visible,data_json=excluded.data_json,updated_at=unixepoch()")
        .bind(id, slug, Number.isFinite(Number(episode.number)) ? Number(episode.number) : null, String(episode.date || "") || null, episode.visible === false ? 0 : 1, JSON.stringify(data));
    });
    statements.push(env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('seasons',?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()").bind(JSON.stringify(body.seasons)));
    const removed = [...new Set((body.removedIds || []).map(safeId).filter(Boolean))].slice(0, 2000);
    for (const id of removed) statements.push(env.DB.prepare("DELETE FROM program_episodes WHERE id=?").bind(id));
    // ההודעה בדף הבית ודף העדכונים מתפרסמים יחד עם הקטלוג
    statements.push(...settingsStatements(env, body.settings));
    // כל פרסום נשמר כגרסה — גיבוי אוטומטי שאפשר לחזור אליו מאזור הניהול
    const versionId = crypto.randomUUID();
    statements.push(...versionStatements(env, publisher.email, { seasons: body.seasons, episodes: body.episodes, settings: body.settings }, versionId));
    // תוכניות שהפכו עכשיו לציבוריות נרשמות כ"כבר הודיעו", כדי שהבדיקה
    // המתוזמנת לא תשלח עליהן התראה מאוחרת; notify שולח עליהן התראה מיד.
    const fresh = body.episodes
      .map((episode) => ({ ...episode, id: safeId(episode.id || episode.slug), slug: safeId(episode.slug || episode.id) }))
      .filter((episode) => episode.visible !== false && isPublic(episode, true, beforeNow) && !before.has(episode.id));
    const notified = await readSetting<string[]>(env, NOTIFIED_KEY);
    if (fresh.length || !Array.isArray(notified)) {
      statements.push(notifiedStatement(env, [...(Array.isArray(notified) ? notified : before), ...fresh.map((episode) => episode.id)]));
    }
    // הטיוטה המשותפת מולאה בפרסום הזה; קישור התצוגה המקדימה כבר אינו נחוץ
    statements.push(env.DB.prepare("DELETE FROM program_settings WHERE key IN ('draft')"));
    try { await env.DB.batch(statements); }
    catch (error) { console.error("program catalog write error", error); return reply(request, { error: "שמירת התוכניות נכשלה." }, 500); }
    if (body.notify === true && fresh.length) ctx.waitUntil(notifyEpisodes(env, fresh).catch((error) => console.error("program publish push error", error)));
    return reply(request, { ok: true, episodes: body.episodes.length, removed: removed.length, versionId, notified: body.notify === true ? fresh.length : 0 });
  }
  if (url.pathname === "/api/program/upload" && request.method === "POST") {
    if (!await admin(request, env)) return reply(request, { error: "אין הרשאת ניהול." }, 403);
    const episodeId = safeId(url.searchParams.get("episode"));
    const kind = url.searchParams.get("kind") === "cover" ? "cover" : "audio";
    const contentType = (request.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const length = Number(request.headers.get("content-length") || 0);
    if (!episodeId || !length || length > MAX_FILE || !(kind === "audio" ? AUDIO : IMAGE).has(contentType)) return reply(request, { error: "הקובץ אינו נתמך או גדול מ־50MB." }, 400);
    const ext = contentType === "audio/mpeg" ? "mp3" : contentType.split("/")[1].replace("jpeg", "jpg").replace("mp4", "m4a");
    const key = `program/${episodeId}/${crypto.randomUUID()}.${ext}`;
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" } });
    return reply(request, { url: `${url.origin}/media/${key}` });
  }
  /* ---------- העלאה בחלקים (R2 multipart) לקבצים גדולים ----------
     start → part (PUT לכל חלק של 20MB) → complete, או abort בביטול. */
  if (url.pathname.startsWith("/api/program/upload/")) {
    if (!await admin(request, env)) return reply(request, { error: "אין הרשאת ניהול." }, 403);
    const step = url.pathname.slice("/api/program/upload/".length);
    const validKey = (key: unknown): key is string => typeof key === "string" && key.startsWith("program/") && !key.includes("..") && safeMediaKey(key);
    const readBody = async <T>() => { try { return await request.json<T>(); } catch { return null; } };
    if (step === "start" && request.method === "POST") {
      const episodeId = safeId(url.searchParams.get("episode"));
      const kind = url.searchParams.get("kind") === "cover" ? "cover" : "audio";
      const input = await readBody<{ contentType?: string; size?: number; name?: string }>();
      const contentType = String(input?.contentType || "").split(";")[0].trim().toLowerCase();
      const size = Number(input?.size || 0);
      const limit = kind === "audio" ? MAX_MULTIPART_AUDIO : MAX_MULTIPART_COVER;
      if (!episodeId || !(kind === "audio" ? AUDIO : IMAGE).has(contentType)) return reply(request, { error: "סוג הקובץ אינו נתמך." }, 400);
      if (!Number.isFinite(size) || size <= 0 || size > limit) return reply(request, { error: kind === "audio" ? "הקובץ גדול מ־1GB." : "התמונה גדולה מ־15MB." }, 400);
      const ext = contentType === "audio/mpeg" ? "mp3" : contentType.split("/")[1].replace("jpeg", "jpg").replace("mp4", "m4a");
      const key = `program/${episodeId}/${crypto.randomUUID()}.${ext}`;
      const upload = await env.MEDIA.createMultipartUpload(key, {
        httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { episodeId, kind, name: String(input?.name || "").slice(0, 200) },
      });
      return reply(request, { key, uploadId: upload.uploadId, partSize: PART_SIZE });
    }
    if (step === "part" && request.method === "PUT") {
      const key = url.searchParams.get("key"), uploadId = url.searchParams.get("uploadId") || "";
      const part = Number(url.searchParams.get("part"));
      if (!validKey(key) || !uploadId || !Number.isInteger(part) || part < 1 || part > 10000) return reply(request, { error: "פרטי החלק אינם תקינים." }, 400);
      if (!request.body) return reply(request, { error: "החלק ריק." }, 400);
      try {
        const uploaded = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(part, request.body);
        return reply(request, { part: uploaded.partNumber, etag: uploaded.etag });
      } catch (error) {
        console.error("program multipart part error", key, part, error);
        return reply(request, { error: "העלאת החלק נכשלה." }, 500);
      }
    }
    if (step === "complete" && request.method === "POST") {
      const input = await readBody<{ key?: string; uploadId?: string; parts?: Array<{ part?: number; etag?: string }> }>();
      const key = input?.key;
      const parts = Array.isArray(input?.parts) ? input!.parts.map((item) => ({ partNumber: Number(item?.part), etag: String(item?.etag || "") })) : [];
      if (!validKey(key) || !input?.uploadId || !parts.length || parts.some((item) => !Number.isInteger(item.partNumber) || item.partNumber < 1 || !item.etag)) return reply(request, { error: "פרטי ההעלאה אינם תקינים." }, 400);
      try {
        const object = await env.MEDIA.resumeMultipartUpload(key, String(input.uploadId)).complete(parts.sort((a, b) => a.partNumber - b.partNumber));
        return reply(request, { url: `${url.origin}/media/${key}`, key, size: object.size });
      } catch (error) {
        console.error("program multipart complete error", key, error);
        return reply(request, { error: "סיום ההעלאה נכשל." }, 500);
      }
    }
    if (step === "abort" && request.method === "POST") {
      const input = await readBody<{ key?: string; uploadId?: string }>();
      if (!validKey(input?.key) || !input?.uploadId) return reply(request, { error: "פרטי ההעלאה אינם תקינים." }, 400);
      try { await env.MEDIA.resumeMultipartUpload(input.key, String(input.uploadId)).abort(); }
      catch (error) { console.error("program multipart abort error", input.key, error); }
      return reply(request, { ok: true });
    }
    return reply(request, { error: "הנתיב לא נמצא." }, 404);
  }

  /* ---------- הורדת תוכנית עם שם קובץ נכון ---------- */
  if (url.pathname.startsWith("/api/program/download/") && (request.method === "GET" || request.method === "HEAD")) {
    let requested = "";
    try { requested = decodeURIComponent(url.pathname.slice("/api/program/download/".length)); } catch { /* נשאר ריק */ }
    const episode = await loadEpisode(env, safeId(requested));
    const user = episode && !(episode.visible && isPublic(episode.data, true)) ? await readSession(request, env) : null;
    if (!episode || (!(episode.visible && isPublic(episode.data, true)) && !user?.isAdmin)) return reply(request, { error: "התוכנית לא נמצאה." }, 404);
    const title = String(episode.data.title || "").replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || episode.id;
    for (const key of audioKeysOf(episode.data, url.origin)) {
      const ext = (key.match(/\.([a-z0-9]{2,4})$/i)?.[1] || "mp3").toLowerCase();
      const response = await r2AudioResponse(request, env, key, downloadDisposition(title, episode.id, ext));
      if (response) {
        response.headers.set("cache-control", "public, max-age=3600");
        return cors(request, response);
      }
    }
    const driveId = driveIdOf(episode.data);
    if (driveId) return cors(request, new Response(null, { status: 302, headers: { location: DRIVE_DOWNLOAD(driveId), "cache-control": "no-store" } }));
    return reply(request, { error: "ההקלטה של התוכנית אינה זמינה להורדה." }, 404);
  }

  const push = await programPushApi(request, env, { reply, admin });
  if (push) return push;
  const ai = await programAiApi(request, env, { reply, admin, safeId });
  if (ai) return ai;
  const tools = await programToolsApi(request, env, { reply, admin, safeId });
  if (tools) return tools;
  return reply(request, { error: "הנתיב לא נמצא." }, 404);
}

const OG_DEFAULT_IMAGE = `${PROGRAM_SITE}assets/img/og-default.png`;

/**
 * דף שיתוף לתוכנית: `GET /p/<slug>`. וואטסאפ ופייסבוק קוראים ממנו תגי Open
 * Graph (כותרת, תיאור, תמונה) ומקבלים 200 — לא הפניה — ואדם שנכנס מועבר מיד
 * לדף התוכנית באתר התוכניות, כולל נקודת ההתחלה (`?t=<שניות>`) אם צוינה.
 */
export async function programSharePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let requested = "";
  try { requested = decodeURIComponent(url.pathname.slice("/p/".length).replace(/\/+$/, "")); } catch { /* נשאר ריק */ }
  const episode = await loadEpisode(env, safeId(requested));
  const html = (body: string, status: number, cache: string) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff" } });
  if (!episode || !episode.visible || !isPublic(episode.data, true)) {
    const home = escapeHtml(PROGRAM_SITE);
    return html(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>התוכנית לא נמצאה — ראש בראש</title><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${home}"></head><body><p>התוכנית לא נמצאה. <a href="${home}">לאתר התוכניות</a></p><script>location.replace(${JSON.stringify(PROGRAM_SITE).replace(/</g, "\\u003c")})</script></body></html>`, 404, "public, max-age=60");
  }
  const data = episode.data;
  const slug = String(data.slug || episode.id);
  const title = String(data.title || "").trim() || "תוכנית";
  const number = Number(data.number);
  const ogTitle = Number.isFinite(number) && number > 0 && data.number !== null && data.number !== "" ? `תוכנית ${number} · ${title}` : title;
  const description = String(data.description || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const cover = typeof data.cover === "string" && /^https:\/\//i.test(data.cover) ? data.cover : "";
  const image = cover || OG_DEFAULT_IMAGE;
  const canonical = `${PROGRAM_SITE}episode.html?ep=${encodeURIComponent(slug)}`;
  const seconds = Math.floor(Number(url.searchParams.get("t")));
  const target = Number.isFinite(seconds) && seconds > 0 ? `${canonical}&t=${seconds}` : canonical;
  const shareUrl = `${url.origin}${url.pathname}${url.search}`;
  const e = (value: string) => escapeHtml(value);
  const meta = [
    `<meta name="description" content="${e(description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="ראש בראש">`,
    `<meta property="og:locale" content="he_IL">`,
    `<meta property="og:title" content="${e(ogTitle)}">`,
    `<meta property="og:description" content="${e(description)}">`,
    `<meta property="og:url" content="${e(shareUrl)}">`,
    `<meta property="og:image" content="${e(image)}">`,
    ...(cover ? [] : [`<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`]),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(ogTitle)}">`,
    `<meta name="twitter:description" content="${e(description)}">`,
    `<meta name="twitter:image" content="${e(image)}">`,
    `<link rel="canonical" href="${e(canonical)}">`,
    `<meta http-equiv="refresh" content="0;url=${e(target)}">`,
  ].join("");
  const body = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(title)} — ראש בראש</title>${meta}</head><body><p><a href="${e(target)}">${e(ogTitle)}</a></p><script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")})</script></body></html>`;
  return html(body, 200, "public, max-age=300");
}

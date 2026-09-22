import { createSession, GOOGLE_CLIENT_ID, readSession, verifyGoogleCredential } from "./auth";
import seed from "./program-seed.json";

type Env = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string };
type Ctx = { waitUntil(promise: Promise<unknown>): void };
const ORIGIN = "https://shmuel-lamed.github.io";
const MAX_FILE = 50 * 1024 * 1024;
// Recordings live in shared Google Drive files. Google serves them as plain
// audio with Range support to servers, but answers 403 to any browser request
// that carries `Sec-Fetch-Site: cross-site` — so the program site's own player
// cannot load them directly and streams them through this worker instead.
const DRIVE_ID = /^[\w-]{10,128}$/;
const DRIVE_DOWNLOAD = (id: string) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
const STREAM_HEADERS = ["content-type", "content-length", "content-range", "etag", "last-modified"];
const AUDIO = new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac", "audio/aac"]);
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const programAudioKey = (driveId: string) => `program-recordings/${driveId}.mp3`;

async function r2AudioResponse(request: Request, env: Env, key: string): Promise<Response | null> {
  const range = request.headers.get("range");
  const object = range ? await env.MEDIA.get(key, { range: request.headers }) : await env.MEDIA.get(key);
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("content-disposition", "inline");
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
    headers.set("access-control-allow-methods", "GET,HEAD,POST,DELETE,OPTIONS");
    headers.set("access-control-expose-headers", "content-length,content-range,accept-ranges");
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
const exchange=async(url,body)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'הכניסה נכשלה');return data};
const showGoogle=()=>{if(!window.google){fail('כפתור Google לא נטען. רעננו את החלון ונסו שוב.');return}google.accounts.id.initialize({client_id:${JSON.stringify(GOOGLE_CLIENT_ID)},callback:async({credential})=>{out.className='';out.textContent='בודק הרשאה…';try{deliver(await exchange('/api/program/auth/google',{credential}))}catch(e){fail(e.message)}}});google.accounts.id.renderButton(document.getElementById('google'),{theme:'filled_blue',size:'large',shape:'pill',text:'continue_with',locale:'he',width:280})};
window.onload=async()=>{if(known){out.textContent=known.isAdmin?'מעבירים אתכם לניהול התוכניות…':'מעבירים אתכם לאזור האישי…';try{return deliver(await exchange('/api/program/auth/session'))}catch(e){fail(e.message)}}showGoogle()};`;

async function admin(request: Request, env: Env) {
  const user = await readSession(request, env);
  return user?.isAdmin ? user : null;
}

// What the program site learns about whoever signed in. Everyone gets a
// session and a personal area; only `isAdmin` opens the management area, and
// it is recomputed from the voting site's admin list on every request.
const publicUser = (user: { email: string; name: string; picture?: string; isAdmin: boolean }) =>
  ({ email: user.email, name: user.name, picture: user.picture, isAdmin: !!user.isAdmin });

async function catalog(env: Env, includeHidden = false) {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_episodes").first<{ total: number }>();
  if (!Number(existing?.total)) {
    const inserts = seed.episodes.map((episode) => env.DB.prepare("INSERT OR IGNORE INTO program_episodes (id,slug,number,date,visible,data_json,updated_at) VALUES (?,?,?,?,?,?,unixepoch())")
      .bind(episode.id, episode.slug, episode.number, episode.date || null, episode.visible === false ? 0 : 1, JSON.stringify(episode)));
    inserts.push(env.DB.prepare("INSERT OR IGNORE INTO program_settings (key,value_json,updated_at) VALUES ('seasons',?,unixepoch())").bind(JSON.stringify(seed.seasons)));
    await env.DB.batch(inserts);
  }
  const [episodes, settings] = await env.DB.batch([
    env.DB.prepare(`SELECT id,data_json FROM program_episodes ${includeHidden ? "" : "WHERE visible=1"} ORDER BY date DESC,number DESC`),
    env.DB.prepare("SELECT key,value_json FROM program_settings"),
  ]);
  const values = new Map((settings.results as Array<{ key: string; value_json: string }>).map((row) => {
    try { return [row.key, JSON.parse(row.value_json)]; } catch { return [row.key, null]; }
  }));
  return {
    version: 1,
    seasons: values.get("seasons") || [],
    episodes: (episodes.results as Array<{ id: string; data_json: string }>).flatMap((row) => {
      try { return [{ ...JSON.parse(row.data_json), id: row.id }]; } catch { return []; }
    }),
  };
}

export async function programApi(request: Request, env: Env, ctx: Ctx): Promise<Response | null> {
  void ctx;
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
    return reply(request, await catalog(env, !!user?.isAdmin), 200);
  }
  if (url.pathname === "/api/program/auth/google" && request.method === "POST") {
    try {
      const { credential } = await request.json<{ credential?: string }>();
      if (!credential) return reply(request, { error: "חסר אישור Google." }, 400);
      const user = await verifyGoogleCredential(credential, env);
      const token = await createSession(env, user);
      return reply(request, { token, user: publicUser(user) });
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
    if (!await admin(request, env)) return reply(request, { error: "אין הרשאת ניהול." }, 403);
    let body: { seasons?: unknown[]; episodes?: Array<Record<string, unknown>>; removedIds?: string[] };
    try { body = await request.json(); } catch { return reply(request, { error: "בקשה לא תקינה." }, 400); }
    if (!Array.isArray(body.episodes) || !Array.isArray(body.seasons) || body.episodes.length > 2000) return reply(request, { error: "נתוני התוכניות אינם תקינים." }, 400);
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
    try { await env.DB.batch(statements); }
    catch (error) { console.error("program catalog write error", error); return reply(request, { error: "שמירת התוכניות נכשלה." }, 500); }
    return reply(request, { ok: true, episodes: body.episodes.length, removed: removed.length });
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
  return reply(request, { error: "הנתיב לא נמצא." }, 404);
}

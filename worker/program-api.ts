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

// `data/episodes.json` in the program site's own repository is the catalogue's
// source of truth: it is built from the program's Drive folders and from the
// mailing-list announcements, and it is what the site falls back to when this
// worker is unreachable. D1 holds the working copy that the admin area edits.
// Whenever CATALOG_VERSION below changes, the published catalogue is fetched
// once and written over D1 — so a catalogue fix committed to the site reaches
// the live database on deploy, with no manual publish. Between version bumps
// the admin area is free to edit, and those edits stand until the next bump.
// `program-seed.json` stays as the offline seed for a brand-new database.
const CATALOG_SOURCE = "https://shmuel-lamed.github.io/Ringtones/data/episodes.json";
const CATALOG_VERSION = "2026-09-22-drive-and-mail";

type SeedCatalog = { seasons: unknown[]; episodes: Array<Record<string, unknown>> };

async function publishedCatalog(): Promise<SeedCatalog | null> {
  try {
    const response = await fetch(CATALOG_SOURCE, { cf: { cacheTtl: 0 } });
    if (!response.ok) return null;
    const body = await response.json<SeedCatalog>();
    return Array.isArray(body?.episodes) && body.episodes.length && Array.isArray(body?.seasons) ? body : null;
  } catch (error) {
    console.error("program catalog fetch error", error);
    return null;
  }
}

function writeCatalog(env: Env, source: SeedCatalog, version: string | null) {
  const statements = source.episodes.flatMap((episode) => {
    const id = safeId(episode.id as string);
    const slug = safeId((episode.slug as string) || (episode.id as string));
    if (!id || !slug || !String(episode.title || "").trim()) return [];
    const number = Number.isFinite(Number(episode.number)) ? Number(episode.number) : null;
    return [env.DB.prepare("INSERT INTO program_episodes (id,slug,number,date,visible,data_json,updated_at) VALUES (?,?,?,?,?,?,unixepoch()) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,number=excluded.number,date=excluded.date,visible=excluded.visible,data_json=excluded.data_json,updated_at=unixepoch()")
      .bind(id, slug, number, String(episode.date || "") || null, episode.visible === false ? 0 : 1, JSON.stringify({ ...episode, id, slug }))];
  });
  statements.push(env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('seasons',?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()").bind(JSON.stringify(source.seasons)));
  if (version) statements.push(env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('catalog_version',?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()").bind(JSON.stringify(version)));
  return statements;
}

async function syncCatalog(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT value_json FROM program_settings WHERE key='catalog_version'").first<{ value_json: string }>();
  let current = "";
  try { current = String(JSON.parse(row?.value_json ?? '""') ?? ""); } catch { current = ""; }
  if (current === CATALOG_VERSION) return;
  const published = await publishedCatalog();
  // Without the published catalogue, only a brand-new database is filled, from
  // the offline seed — and the version is left unset so the next request tries
  // again rather than freezing an out-of-date catalogue in place.
  if (!published) {
    const existing = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_episodes").first<{ total: number }>();
    if (Number(existing?.total)) return;
  }
  try { await env.DB.batch(writeCatalog(env, published || (seed as SeedCatalog), published ? CATALOG_VERSION : null)); }
  catch (error) { console.error("program catalog sync error", error); }
}

async function catalog(env: Env, includeHidden = false) {
  await syncCatalog(env);
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

/* ---------- The recordings, served from the site itself ----------
   The masters live in the program's Drive folder. The first time a recording
   is played it is copied, in the background, into the site's own R2 bucket;
   every play after that is served straight from Cloudflare — real Range
   seeking, no Google round trip, and nothing for the listener's filter to
   block. If the copy has not happened yet (or fails), the Drive proxy below
   still answers, so playback never depends on it. */
const MEDIA_KEY = (id: string) => `program/drive/${id}.mp3`;
const MAX_CACHED = 400 * 1024 * 1024;
const copying = new Set<string>();

async function readCached(env: Env, id: string, request: Request, range: string | null): Promise<Response | null> {
  const key = MEDIA_KEY(id);
  let object: R2Object | R2ObjectBody | null = null;
  try {
    object = request.method === "HEAD"
      ? await env.MEDIA.head(key)
      : await env.MEDIA.get(key, range ? { range: request.headers } : undefined);
  } catch (error) { console.error("program media read error", error); return null; }
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.get("content-type")) headers.set("content-type", "audio/mpeg");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.httpEtag);
  headers.set("content-disposition", "inline");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  const part = (object as R2ObjectBody).range as { offset?: number; length?: number } | undefined;
  let status = 200;
  if (range && part && typeof part.offset === "number" && typeof part.length === "number") {
    status = 206;
    headers.set("content-range", `bytes ${part.offset}-${part.offset + part.length - 1}/${object.size}`);
    headers.set("content-length", String(part.length));
  } else {
    headers.set("content-length", String(object.size));
  }
  const body = request.method === "HEAD" ? null : ((object as R2ObjectBody).body ?? null);
  return new Response(body, { status, headers });
}

async function cacheRecording(env: Env, id: string): Promise<void> {
  const key = MEDIA_KEY(id);
  if (copying.has(id)) return;
  copying.add(id);
  try {
    if (await env.MEDIA.head(key)) return;
    const upstream = await fetch(DRIVE_DOWNLOAD(id), { redirect: "follow" });
    const type = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const size = Number(upstream.headers.get("content-length") || 0);
    if (!upstream.ok || !upstream.body || !type.startsWith("audio/") || size > MAX_CACHED) {
      await upstream.body?.cancel().catch(() => {});
      return;
    }
    await env.MEDIA.put(key, upstream.body, {
      httpMetadata: { contentType: type || "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch (error) {
    console.error("program media copy error", error);
  } finally {
    copying.delete(id);
  }
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
    // Range-transparent proxy for a shared Drive recording. The response is
    // the recording itself (audio/*, 200 or 206), never Google's HTML pages.
    const id = url.pathname.slice("/api/program/stream/".length);
    if (!DRIVE_ID.test(id)) return reply(request, { error: "מזהה הקלטה לא תקין." }, 400);
    const range = request.headers.get("range");

    // Served from the site's own storage once the recording has been copied
    // there; the copy is made in the background the first time it is played.
    const cached = await readCached(env, id, request, range);
    if (cached) return cors(request, cached);
    if (request.method === "GET") ctx.waitUntil(cacheRecording(env, id));

    const upstreamHeaders = new Headers();
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

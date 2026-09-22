import { createSession, readSession, verifyGoogleCredential } from "./auth";
import seed from "./program-seed.json";

type Env = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string };
type Ctx = { waitUntil(promise: Promise<unknown>): void };
const ORIGIN = "https://shmuel-lamed.github.io";
const MAX_FILE = 50 * 1024 * 1024;
const AUDIO = new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac", "audio/aac"]);
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);

function cors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (origin === ORIGIN) {
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", ORIGIN);
    headers.set("access-control-allow-headers", "authorization,content-type");
    headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const reply = (request: Request, body: unknown, status = 200) => cors(request, json(body, status));
const safeId = (value: unknown) => String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);

async function admin(request: Request, env: Env) {
  const user = await readSession(request, env);
  return user?.isAdmin ? user : null;
}

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

  if (url.pathname === "/api/program/catalog" && request.method === "GET") {
    const user = await readSession(request, env);
    return reply(request, await catalog(env, !!user?.isAdmin), 200);
  }
  if (url.pathname === "/api/program/auth/google" && request.method === "POST") {
    try {
      const { credential } = await request.json<{ credential?: string }>();
      if (!credential) return reply(request, { error: "חסר אישור Google." }, 400);
      const user = await verifyGoogleCredential(credential, env);
      if (!user.isAdmin) return reply(request, { error: "לחשבון הזה אין הרשאת ניהול." }, 403);
      const token = await createSession(env, user);
      return reply(request, { token, user: { email: user.email, name: user.name, picture: user.picture, isAdmin: true } });
    } catch (error) {
      console.error("program google auth error", error);
      return reply(request, { error: "ההתחברות באמצעות Google נכשלה." }, 401);
    }
  }
  if (url.pathname === "/api/program/me" && request.method === "GET") {
    const user = await admin(request, env);
    return user ? reply(request, { user }) : reply(request, { user: null }, 401);
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

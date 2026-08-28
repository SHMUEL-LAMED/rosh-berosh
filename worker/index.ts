/** Cloudflare Worker entry point. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { clearSessionCookie, GOOGLE_CLIENT_ID, migrateLegacyAdminEmails, readSession, sessionCookie, verifyGoogleCredential } from "./auth";
import { adminApi } from "./admin";
import { ensureRuntimeSchema } from "./schema";
import { readIvrPrompts, readIvrRecorders, saveIvrPrompts, syncPromptToYemot } from "./ivr-prompts";
import { normalizePhone } from "./phone";
import { checkBallotRate } from "./rate-limit";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  YEMOT_TOKEN?: string;
  YEMOT_API_BASE?: string;
  IVR_SECRET?: string;
  ADMIN_EMAILS?: string;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }
type Submission = { voterKey?: string; albumIds?: string[]; songIdsByAlbum?: Record<string, string | string[]>; artistIds?: string[]; channel?: "site" | "phone"; fingerprint?: string };
type Rules = { votingOpen: number; albumsEnabled: number; albumsMin: number; albumsMax: number; songsEnabled: number; songsMin: number; songsMax: number; artistsEnabled: number; artistsMin: number; artistsMax: number };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const unique = (items: string[]) => [...new Set(items)];
const placeholders = (count: number) => Array(count).fill("?").join(",");

function verifyIvrSecret(request: Request, env: Env): boolean {
  if (!env.IVR_SECRET) return false;
  const header = request.headers.get("x-ivr-secret");
  return header === env.IVR_SECRET;
}

async function activeSurveyId(env: Env): Promise<string> {
  try {
    const row = await env.DB.prepare("SELECT id FROM surveys WHERE active = 1 ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
    return row?.id ?? "main";
  } catch {
    return "main";
  }
}

async function readRules(env: Env, surveyId: string): Promise<Rules> {
  await ensureRuntimeSchema(env);
  const defaults = { votingOpen: 0, albumsEnabled: 1, albumsMin: 5, albumsMax: 5, songsEnabled: 1, songsMin: 1, songsMax: 1, artistsEnabled: 1, artistsMin: 1, artistsMax: 3 };
  try {
    return await env.DB.prepare("SELECT voting_open AS votingOpen, albums_enabled AS albumsEnabled, albums_min AS albumsMin, albums_max AS albumsMax, songs_enabled AS songsEnabled, songs_min AS songsMin, songs_max AS songsMax, artists_enabled AS artistsEnabled, artists_min AS artistsMin, artists_max AS artistsMax FROM poll_settings WHERE id=?").bind(surveyId).first<Rules>() ?? defaults;
  } catch {
    return defaults;
  }
}

async function catalog(env: Env): Promise<Response> {
  try {
    const surveyId = await activeSurveyId(env);
    const rules = await readRules(env, surveyId);
    const [albums, artists] = await env.DB.batch([
      env.DB.prepare("SELECT id, title, artist_name AS artistName, cover_url AS coverUrl FROM albums WHERE active = 1 AND survey_id = ? ORDER BY position, title").bind(surveyId),
      env.DB.prepare("SELECT id, name, image_url AS imageUrl FROM artists WHERE active = 1 AND survey_id = ? ORDER BY position, name").bind(surveyId),
    ]);
    let songs;
    try {
      songs = await env.DB.prepare("SELECT s.id, s.album_id AS albumId, s.title, s.audio_url AS audioUrl, s.cover_url AS coverUrl, s.preview_start AS previewStart, s.preview_end AS previewEnd FROM songs s JOIN albums a ON a.id = s.album_id WHERE s.active = 1 AND a.survey_id = ? ORDER BY s.position, s.title").bind(surveyId).all();
    } catch {
      songs = await env.DB.prepare("SELECT s.id, s.album_id AS albumId, s.title, s.audio_url AS audioUrl, NULL AS coverUrl, 0 AS previewStart, 0 AS previewEnd FROM songs s JOIN albums a ON a.id = s.album_id WHERE s.active = 1 AND a.survey_id = ? ORDER BY s.position, s.title").bind(surveyId).all();
    }
    const songsMap = new Map<string, Array<{ coverUrl?: string }>>();
    (songs.results || []).forEach((song: Record<string, unknown>) => {
      const covers = songsMap.get(song.albumId as string) || [];
      if (song.coverUrl) covers.push({ coverUrl: song.coverUrl as string });
      songsMap.set(song.albumId as string, covers);
    });
    const albumsWithCovers = albums.results.map((album: Record<string, unknown>) => {
      const albumSongs = songsMap.get(album.id as string) || [];
      if (!album.coverUrl && albumSongs.length > 0) {
        const uniqueCovers = [...new Set(albumSongs.map((s) => s.coverUrl).filter(Boolean))];
        if (uniqueCovers.length) album.coverUrl = uniqueCovers[0];
      }
      return album;
    });
    const ivrPrompts = await readIvrPrompts(env);
    return json({ surveyId, albums: albumsWithCovers, songs: songs.results, artists: artists.results, rules, ivrPrompts });
  } catch (error) {
    console.error("catalog error", error);
    return json({ error: "לא ניתן לטעון את רשימת המצעד." }, 500);
  }
}

async function submitBallot(request: Request, env: Env): Promise<Response> {
  let body: Submission;
  try { body = await request.json<Submission>(); } catch { return json({ error: "בקשה לא תקינה." }, 400); }
  const surveyId = await activeSurveyId(env);
  const rules = await readRules(env, surveyId);
  if (!rules.votingOpen) return json({ error: "ההצבעה סגורה כרגע." }, 403);

  const channel = body.channel === "phone" ? "phone" : "site";
  const rawVoterKey = body.voterKey?.trim().toLowerCase() || "";
  const voterKey = channel === "phone" ? normalizePhone(rawVoterKey) : rawVoterKey;
  const albumIds = unique(body.albumIds ?? []);
  const artistIds = unique(body.artistIds ?? []);
  const songMap = Object.fromEntries(Object.entries(body.songIdsByAlbum ?? {}).map(([albumId, value]) => [albumId, unique(Array.isArray(value) ? value : value ? [value] : [])]));
  const albumMin = rules.albumsEnabled ? rules.albumsMin : 0, albumMax = rules.albumsEnabled ? rules.albumsMax : 0;
  const songMin = rules.songsEnabled ? rules.songsMin : 0, songMax = rules.songsEnabled ? rules.songsMax : 0;
  const artistMin = rules.artistsEnabled ? rules.artistsMin : 0, artistMax = rules.artistsEnabled ? rules.artistsMax : 0;
  if (!voterKey || albumIds.length < albumMin || albumIds.length > albumMax || artistIds.length < artistMin || artistIds.length > artistMax || albumIds.some((id) => (songMap[id]?.length ?? 0) > songMax)) {
    return json({ error: "הבחירות אינן תואמות להגדרות הסקר." }, 400);
  }

  // An album can end up holding fewer active songs than songsMin (a track
  // deactivated mid-poll), and then no voter could ever satisfy the minimum.
  // Require only what the album can actually offer.
  const availableSongs = albumIds.length && songMin
    ? await env.DB.prepare(`SELECT album_id AS albumId, COUNT(*) AS total FROM songs WHERE active=1 AND album_id IN (${placeholders(albumIds.length)}) GROUP BY album_id`).bind(...albumIds).all<{ albumId: string; total: number }>()
    : { results: [] as { albumId: string; total: number }[] };
  const availableByAlbum = new Map(availableSongs.results.map((row) => [row.albumId, Number(row.total)]));
  if (albumIds.some((id) => (songMap[id]?.length ?? 0) < Math.min(songMin, availableByAlbum.get(id) ?? 0))) {
    return json({ error: "הבחירות אינן תואמות להגדרות הסקר." }, 400);
  }

  const validAlbums = albumIds.length ? await env.DB.prepare(`SELECT id FROM albums WHERE active=1 AND survey_id=? AND id IN (${placeholders(albumIds.length)})`).bind(surveyId, ...albumIds).all<{ id: string }>() : { results: [] };
  const validArtists = artistIds.length ? await env.DB.prepare(`SELECT id FROM artists WHERE active=1 AND survey_id=? AND id IN (${placeholders(artistIds.length)})`).bind(surveyId, ...artistIds).all<{ id: string }>() : { results: [] };
  const songIds = unique(albumIds.flatMap((id) => songMap[id] ?? []));
  const validSongs = songIds.length ? await env.DB.prepare(`SELECT s.id, s.album_id AS albumId FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.active=1 AND a.survey_id=? AND s.id IN (${placeholders(songIds.length)})`).bind(surveyId, ...songIds).all<{ id: string; albumId: string }>() : { results: [] };
  if (validAlbums.results.length !== albumIds.length || validArtists.results.length !== artistIds.length || validSongs.results.length !== songIds.length || validSongs.results.some((song) => !songMap[song.albumId]?.includes(song.id))) {
    return json({ error: "אחת הבחירות אינה קיימת או אינה פעילה." }, 400);
  }

  const ballotId = crypto.randomUUID();
  const statements = [
    env.DB.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,fingerprint) VALUES (?,?,?,?,?)").bind(ballotId, surveyId, voterKey, channel, body.fingerprint || null),
    ...albumIds.map((id) => env.DB.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES (?,?)").bind(ballotId, id)),
    ...albumIds.flatMap((id) => (songMap[id] ?? []).map((songId) => env.DB.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES (?,?,?)").bind(ballotId, id, songId))),
    ...artistIds.map((id) => env.DB.prepare("INSERT INTO artist_votes (ballot_id,artist_id) VALUES (?,?)").bind(ballotId, id)),
  ];
  try {
    await env.DB.batch(statements);
    return json({ ok: true, ballotId }, 201);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ error: "כבר התקבלה הצבעה מהמזהה הזה." }, 409);
    console.error("ballot error", error);
    return json({ error: "שמירת ההצבעה נכשלה." }, 500);
  }
}

async function serveMedia(request: Request, env: Env, pathname: string): Promise<Response> {
  let key = "";
  try { key = pathname.slice(7).split("/").map(decodeURIComponent).join("/"); } catch { return new Response("Not Found", { status: 404 }); }
  const ivrPromptObject = key.startsWith("ivr-prompts/");
  const ivrPromptAudio = ivrPromptObject && /\.(?:wav|mp3|m4a|ogg|aac|flac|webm)$/i.test(key);
  const privateObject = key.startsWith("settings/") || key.startsWith("poll-archives/") || key.startsWith("ivr-progress/") || (ivrPromptObject && !ivrPromptAudio);
  if (!key || key.includes("..") || privateObject) return new Response("Not Found", { status: 404 });
  const rangeHeader = request.headers.get("range");
  const object = rangeHeader
    ? await env.MEDIA.get(key, { range: request.headers })
    : await env.MEDIA.get(key);
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (ivrPromptObject && !/^audio\//i.test(headers.get("content-type") || "")) return new Response("Not Found", { status: 404 });
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", headers.get("cache-control") || "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  headers.set("accept-ranges", "bytes");
  if ("range" in object && object.range) {
    const r = object.range as { offset: number; length: number };
    headers.set("content-range", `bytes ${r.offset}-${r.offset + r.length - 1}/${object.size}`);
    headers.set("content-length", String(r.length));
  }
  const ct = headers.get("content-type") || "";
  if (ct.includes("svg") || ct.includes("html") || ct.includes("xml")) {
    headers.set("content-type", "application/octet-stream");
  }
  const status = rangeHeader && "range" in object ? 206 : 200;
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) return serveMedia(request, env, url.pathname);
    await migrateLegacyAdminEmails(env);

    if (url.pathname === "/api/auth/config" && request.method === "GET") return json({ clientId: GOOGLE_CLIENT_ID });
    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      try {
        const { credential } = await request.json<{ credential?: string }>();
        if (!credential) return json({ error: "חסר אישור Google." }, 400);
        const user = await verifyGoogleCredential(credential, env);
        const response = json({ user: { email: user.email, name: user.name, picture: user.picture, isAdmin: user.isAdmin } });
        response.headers.set("set-cookie", sessionCookie(credential));
        return response;
      } catch (error) { console.error("google auth error", error); return json({ error: "ההתחברות באמצעות Google נכשלה." }, 401); }
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const user = await readSession(request, env);
      return user ? json({ user: { email: user.email, name: user.name, picture: user.picture, isAdmin: user.isAdmin } }) : json({ user: null }, 401);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") { const response = json({ ok: true }); response.headers.set("set-cookie", clearSessionCookie); return response; }
    if (url.pathname.startsWith("/api/admin/")) return adminApi(request, env);
    if (url.pathname === "/api/catalog" && request.method === "GET") return catalog(env);
    if (url.pathname === "/api/ivr/recorders/check" && request.method === "GET") {
      if (!verifyIvrSecret(request, env)) return json({ error: "אין הרשאה." }, 401);
      const phone = normalizePhone(url.searchParams.get("phone") || "");
      const recorders = await readIvrRecorders(env);
      return json({ allowed: !!phone && recorders.includes(phone) });
    }
    if (url.pathname === "/api/ivr/prompt" && request.method === "POST") {
      if (!verifyIvrSecret(request, env)) return json({ error: "אין הרשאה." }, 401);
      const form = await request.formData();
      const file = form.get("file"), key = String(form.get("key") || "").trim(), label = String(form.get("label") || "").trim();
      if (!(file instanceof File) || !/^[a-z0-9:_-]+$/i.test(key) || !label || label.length > 300) {
        return json({ error: "פרטי הקריינות אינם תקינים." }, 400);
      }
      if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|ogg)$/i.test(file.name)) return json({ error: "יש לשלוח קובץ שמע." }, 415);
      if (file.size > 25 * 1024 * 1024) return json({ error: "קובץ הקריינות גדול מ־25MB." }, 413);
      const sync = await syncPromptToYemot(env, key, file);
      if (!sync.path) return json({ error: sync.warning || "העברת הקריינות לקו ההצבעה נכשלה." }, 502);
      const mediaKey = `ivr-prompts/${key.replace(/[^a-z0-9_-]+/gi, "-")}-${crypto.randomUUID()}-phone.wav`;
      await env.MEDIA.put(mediaKey, file.stream(), {
        httpMetadata: { contentType: file.type || "audio/wav", cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { originalName: file.name, promptKey: key, source: "phone" },
      });
      const prompts = await readIvrPrompts(env);
      const previous = prompts.find((item) => item.key === key);
      const next = prompts.filter((item) => item.key !== key);
      const audioUrl = `/media/${mediaKey.split("/").map(encodeURIComponent).join("/")}`;
      next.push({ key, label, audioUrl, yemotPath: sync.path, updatedAt: Date.now() });
      await saveIvrPrompts(env, next);
      if (previous?.audioUrl.startsWith("/media/") && previous.audioUrl !== audioUrl) {
        await env.MEDIA.delete(decodeURIComponent(previous.audioUrl.slice(7)));
      }
      return json({ ok: true, prompt: { key, label, audioUrl, yemotPath: sync.path } });
    }
    if (url.pathname === "/api/ballots/check" && request.method === "GET") {
      const isIvr = verifyIvrSecret(request, env);
      if (!isIvr) {
        const user = await readSession(request, env);
        if (!user) return json({ error: "אין הרשאה." }, 401);
      }
      const rawVoterKey = url.searchParams.get("voterKey")?.trim().toLowerCase() || "";
      const voterKey = isIvr ? normalizePhone(rawVoterKey) : rawVoterKey;
      if (!voterKey) return json({ voted: false });
      const surveyId = await activeSurveyId(env);
      const existing = await env.DB.prepare("SELECT id FROM ballots WHERE survey_id=? AND voter_key=?").bind(surveyId, voterKey).first();
      return json({ voted: !!existing });
    }
    if (url.pathname === "/api/ballots/progress" && verifyIvrSecret(request, env)) {
      const surveyId = await activeSurveyId(env);
      const voterKey = normalizePhone(url.searchParams.get("voterKey") || "");
      if (!voterKey) return json({ error: "חסר מזהה מצביע." }, 400);
      const progressKey = `ivr-progress/${surveyId}/${voterKey}.json`;
      if (request.method === "GET") {
        const obj = await env.MEDIA.get(progressKey);
        if (!obj) return json({ progress: null });
        return json({ progress: await obj.json() });
      }
      if (request.method === "POST") {
        const body = await request.json<Record<string, unknown>>();
        await env.MEDIA.put(progressKey, JSON.stringify(body), { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } });
        return json({ ok: true });
      }
      if (request.method === "DELETE") {
        await env.MEDIA.delete(progressKey);
        return json({ ok: true });
      }
    }
    if (url.pathname === "/api/ballots" && request.method === "POST") {
      // Every phone ballot reaches us from the single IVR server, so the per-IP
      // limit would reject callers past the fifth in a minute. Trust the shared
      // secret instead; a request claiming "phone" without it is still rejected.
      const fromIvr = verifyIvrSecret(request, env);
      const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
      if (!fromIvr) {
        await ensureRuntimeSchema(env);
        if (!(await checkBallotRate(env.DB, clientIp))) return json({ error: "יותר מדי בקשות. נסו שוב בעוד דקה." }, 429);
      }
      let original: Submission;
      try { original = await request.json<Submission>(); } catch { return json({ error: "בקשה לא תקינה." }, 400); }
      if (original.channel === "phone") {
        if (!fromIvr) return json({ error: "אין הרשאה לערוץ טלפוני." }, 403);
        return submitBallot(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(original) }), env);
      }
      const user = await readSession(request, env);
      if (!user) return json({ error: "יש להתחבר באמצעות Google." }, 401);
      return submitBallot(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...original, voterKey: user.sub }) }), env);
    }
    if (url.pathname === "/_vinext/image") {
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => (await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality })).response(),
      }, [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES]);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;

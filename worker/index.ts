/** Cloudflare Worker entry point. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { clearSessionCookie, GOOGLE_CLIENT_ID, readSession, sessionCookie, verifyGoogleCredential } from "./auth";
import { adminApi } from "./admin";
import { ensureRuntimeSchema } from "./schema";
import { readIvrPrompts } from "./ivr-prompts";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  YEMOT_TOKEN?: string;
  YEMOT_API_BASE?: string;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }
type Submission = { voterKey?: string; albumIds?: string[]; songIdsByAlbum?: Record<string, string | string[]>; artistIds?: string[]; channel?: "site" | "phone"; fingerprint?: string };
type Rules = { votingOpen: number; albumsEnabled: number; albumsMin: number; albumsMax: number; songsEnabled: number; songsMin: number; songsMax: number; artistsEnabled: number; artistsMin: number; artistsMax: number };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const unique = (items: string[]) => [...new Set(items)];
const placeholders = (count: number) => Array(count).fill("?").join(",");

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
  const defaults = { votingOpen: 1, albumsEnabled: 1, albumsMin: 5, albumsMax: 5, songsEnabled: 1, songsMin: 1, songsMax: 1, artistsEnabled: 1, artistsMin: 1, artistsMax: 3 };
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
    (songs.results || []).forEach((song: any) => {
      const covers = songsMap.get(song.albumId) || [];
      if (song.coverUrl) covers.push({ coverUrl: song.coverUrl });
      songsMap.set(song.albumId, covers);
    });
    const albumsWithCovers = albums.results.map((album: any) => {
      const albumSongs = songsMap.get(album.id) || [];
      if (!album.coverUrl && albumSongs.length > 0) {
        const uniqueCovers = [...new Set(albumSongs.map((s) => s.coverUrl).filter(Boolean))];
        if (uniqueCovers.length === 1) album.coverUrl = uniqueCovers[0];
        else if (uniqueCovers.length > 1) album.coverUrl = uniqueCovers[0];
      }
      return album;
    });
    const ivrPrompts = await readIvrPrompts(env);
    return json({ albums: albumsWithCovers, songs: songs.results, artists: artists.results, rules, ivrPrompts });
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

  const voterKey = body.voterKey?.trim().toLowerCase();
  const albumIds = unique(body.albumIds ?? []);
  const artistIds = unique(body.artistIds ?? []);
  const songMap = Object.fromEntries(Object.entries(body.songIdsByAlbum ?? {}).map(([albumId, value]) => [albumId, unique(Array.isArray(value) ? value : value ? [value] : [])]));
  const albumMin = rules.albumsEnabled ? rules.albumsMin : 0, albumMax = rules.albumsEnabled ? rules.albumsMax : 0;
  const songMin = rules.songsEnabled ? rules.songsMin : 0, songMax = rules.songsEnabled ? rules.songsMax : 0;
  const artistMin = rules.artistsEnabled ? rules.artistsMin : 0, artistMax = rules.artistsEnabled ? rules.artistsMax : 0;
  if (!voterKey || albumIds.length < albumMin || albumIds.length > albumMax || artistIds.length < artistMin || artistIds.length > artistMax || albumIds.some((id) => (songMap[id]?.length ?? 0) < songMin || (songMap[id]?.length ?? 0) > songMax)) {
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
    env.DB.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,fingerprint) VALUES (?,?,?,?,?)").bind(ballotId, surveyId, voterKey, body.channel === "phone" ? "phone" : "site", body.fingerprint || null),
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
  const key = pathname.slice(7).split("/").map(decodeURIComponent).join("/");
  const privateObject = key.startsWith("settings/") || key.startsWith("poll-archives/") || key === "ivr-prompts/config.json";
  if (!key || key.includes("..") || privateObject) return new Response("Not Found", { status: 404 });
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", headers.get("cache-control") || "public, max-age=31536000, immutable");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) return serveMedia(request, env, url.pathname);

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
    if (url.pathname === "/api/ballots/check" && request.method === "GET") {
      const voterKey = url.searchParams.get("voterKey")?.trim().toLowerCase();
      if (!voterKey) return json({ voted: false });
      const surveyId = await activeSurveyId(env);
      const existing = await env.DB.prepare("SELECT id FROM ballots WHERE survey_id=? AND voter_key=?").bind(surveyId, voterKey).first();
      return json({ voted: !!existing });
    }
    if (url.pathname === "/api/ballots" && request.method === "POST") {
      const original = await request.json<Submission>();
      if (original.channel === "phone") return submitBallot(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(original) }), env);
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

import { readSession } from "./auth";
import { ensureRuntimeSchema } from "./schema";
import { readIvrPrompts, saveIvrPrompts, syncPromptToYemot } from "./ivr-prompts";

type AdminEnv = { DB: D1Database; MEDIA: R2Bucket; YEMOT_TOKEN?: string; YEMOT_API_BASE?: string };
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function requireAdmin(request: Request) {
  const user = await readSession(request);
  return user?.isAdmin ? user : null;
}

const text = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const flag = (value: unknown) => value === true || value === 1 || value === "1" || value === "true" || value === "on";
const mediaUrl = (key: string) => `/media/${key.split("/").map(encodeURIComponent).join("/")}`;
const safeName = (name: string) => name.normalize("NFKD").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 110) || "file";

export async function adminApi(request: Request, env: AdminEnv): Promise<Response> {
  if (!await requireAdmin(request)) return json({ error: "אין הרשאת מנהל." }, 403);
  await ensureRuntimeSchema(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/overview") {
    const [albums, songs, artists, ballots, settings, albumResults, songResults, artistResults] = await env.DB.batch([
      env.DB.prepare("SELECT id, title, artist_name AS artistName, cover_url AS coverUrl, position, active FROM albums ORDER BY position, title"),
      env.DB.prepare("SELECT id, album_id AS albumId, title, audio_url AS audioUrl, preview_start AS previewStart, preview_end AS previewEnd, position, active FROM songs ORDER BY album_id, position, title"),
      env.DB.prepare("SELECT id, name, image_url AS imageUrl, position, active FROM artists ORDER BY position, name"),
      env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN channel = 'phone' THEN 1 ELSE 0 END) AS phone, SUM(CASE WHEN channel = 'site' THEN 1 ELSE 0 END) AS site FROM ballots"),
      env.DB.prepare("SELECT voting_open AS votingOpen, albums_enabled AS albumsEnabled, albums_min AS albumsMin, albums_max AS albumsMax, songs_enabled AS songsEnabled, songs_min AS songsMin, songs_max AS songsMax, artists_enabled AS artistsEnabled, artists_min AS artistsMin, artists_max AS artistsMax FROM poll_settings WHERE id = 'main'"),
      env.DB.prepare("SELECT a.id,a.title,COUNT(v.album_id) AS votes FROM albums a LEFT JOIN album_votes v ON v.album_id=a.id GROUP BY a.id ORDER BY votes DESC,a.title"),
      env.DB.prepare("SELECT s.id,s.title,a.title AS albumTitle,COUNT(v.song_id) AS votes FROM songs s JOIN albums a ON a.id=s.album_id LEFT JOIN song_votes v ON v.song_id=s.id GROUP BY s.id ORDER BY votes DESC,s.title"),
      env.DB.prepare("SELECT a.id,a.name,COUNT(v.artist_id) AS votes FROM artists a LEFT JOIN artist_votes v ON v.artist_id=a.id GROUP BY a.id ORDER BY votes DESC,a.name"),
    ]);
    const ivrPrompts = await readIvrPrompts(env);
    return json({ albums: albums.results, songs: songs.results, artists: artists.results, votes: ballots.results[0] ?? { total: 0, phone: 0, site: 0 }, settings: settings.results[0], ivrPrompts, results: { albums: albumResults.results, songs: songResults.results, artists: artistResults.results } });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/ivr-prompt") {
    const form = await request.formData();
    const file = form.get("file"), key = text(form.get("key")), label = text(form.get("label"));
    if (!(file instanceof File) || !key || !label || !/^[a-z0-9:_-]+$/i.test(key)) return json({ error: "קובץ או סוג קריינות חסרים." }, 400);
    if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|ogg)$/i.test(file.name)) return json({ error: "יש לבחור קובץ שמע." }, 415);
    if (file.size > 25 * 1024 * 1024) return json({ error: "קובץ הקריינות גדול מ־25MB." }, 413);
    const mediaKey = `ivr-prompts/${safeName(key)}-${crypto.randomUUID()}-${safeName(file.name)}`;
    await env.MEDIA.put(mediaKey, file.stream(), { httpMetadata: { contentType: file.type || "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { originalName: file.name, promptKey: key } });
    const sync = await syncPromptToYemot(env, key, file);
    const prompts = await readIvrPrompts(env), previous = prompts.find((prompt) => prompt.key === key);
    const next = prompts.filter((prompt) => prompt.key !== key);
    next.push({ key, label, audioUrl: mediaUrl(mediaKey), yemotPath: sync.path || previous?.yemotPath || "", updatedAt: Date.now() });
    await saveIvrPrompts(env, next);
    if (previous?.audioUrl.startsWith("/media/") && previous.audioUrl !== mediaUrl(mediaKey)) {
      await env.MEDIA.delete(decodeURIComponent(previous.audioUrl.slice(7)));
    }
    return json({ ok: true, warning: sync.warning, yemotPath: sync.path || previous?.yemotPath || "" });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/ivr-prompt") {
    const body = await request.json<{ key?: string }>();
    if (!body.key) return json({ error: "סוג הקריינות חסר." }, 400);
    const prompts = await readIvrPrompts(env), current = prompts.find((prompt) => prompt.key === body.key);
    if (current?.audioUrl.startsWith("/media/")) await env.MEDIA.delete(decodeURIComponent(current.audioUrl.slice(7)));
    await saveIvrPrompts(env, prompts.filter((prompt) => prompt.key !== body.key));
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/settings") {
    const body = await request.json<Record<string, unknown>>();
    const pairs = [
      ["albums", number(body.albumsMin, 5), number(body.albumsMax, 5)],
      ["songs", number(body.songsMin, 1), number(body.songsMax, 1)],
      ["artists", number(body.artistsMin, 1), number(body.artistsMax, 3)],
    ] as const;
    if (pairs.some(([, min, max]) => min < 0 || max < min || max > 50)) return json({ error: "טווחי הבחירה אינם תקינים." }, 400);
    await env.DB.prepare(`UPDATE poll_settings SET voting_open=?, albums_enabled=?, albums_min=?, albums_max=?, songs_enabled=?, songs_min=?, songs_max=?, artists_enabled=?, artists_min=?, artists_max=? WHERE id='main'`)
      .bind(flag(body.votingOpen) ? 1 : 0, flag(body.albumsEnabled) ? 1 : 0, pairs[0][1], pairs[0][2], flag(body.songsEnabled) ? 1 : 0, pairs[1][1], pairs[1][2], flag(body.artistsEnabled) ? 1 : 0, pairs[2][1], pairs[2][2]).run();
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/catalog") {
    const body = await request.json<Record<string, unknown>>();
    const kind = text(body.kind);
    const id = text(body.id) || crypto.randomUUID();
    if (kind === "album") {
      const title = text(body.title), artistName = text(body.artistName);
      if (!title || !artistName) return json({ error: "חובה להזין שם אלבום ושם אמן." }, 400);
      await env.DB.prepare("INSERT INTO albums (id,title,artist_name,cover_url,position,active) VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist_name=excluded.artist_name,cover_url=COALESCE(excluded.cover_url,albums.cover_url),position=excluded.position")
        .bind(id, title, artistName, text(body.coverUrl) || null, number(body.position)).run();
    } else if (kind === "song") {
      const title = text(body.title), albumId = text(body.albumId);
      if (!title || !albumId) return json({ error: "חובה לבחור אלבום ולהזין שם שיר." }, 400);
      await env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,preview_start,preview_end,position,active) VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET album_id=excluded.album_id,title=excluded.title,audio_url=COALESCE(excluded.audio_url,songs.audio_url),preview_start=excluded.preview_start,preview_end=excluded.preview_end,position=excluded.position")
        .bind(id, albumId, title, text(body.audioUrl) || null, number(body.previewStart), number(body.previewEnd), number(body.position)).run();
    } else if (kind === "artist") {
      const name = text(body.name);
      if (!name) return json({ error: "חובה להזין שם זמר." }, 400);
      await env.DB.prepare("INSERT INTO artists (id,name,image_url,position,active) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,image_url=COALESCE(excluded.image_url,artists.image_url),position=excluded.position")
        .bind(id, name, text(body.imageUrl) || null, number(body.position)).run();
    } else return json({ error: "סוג פריט לא מוכר." }, 400);
    return json({ ok: true, id });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/media") {
    const form = await request.formData();
    const file = form.get("file");
    const albumId = text(form.get("albumId"));
    const kind = text(form.get("kind"));
    if (!(file instanceof File) || !albumId || !["cover", "audio"].includes(kind)) return json({ error: "קובץ או אלבום חסרים." }, 400);
    if (file.size > 75 * 1024 * 1024) return json({ error: "הקובץ גדול מ־75MB." }, 413);
    const key = `albums/${albumId}/${kind}-${crypto.randomUUID()}-${safeName(file.name)}`;
    await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { originalName: file.name, albumId, kind } });
    const urlPath = mediaUrl(key);
    if (kind === "cover") {
      await env.DB.prepare("UPDATE albums SET cover_url=? WHERE id=?").bind(urlPath, albumId).run();
      return json({ ok: true, url: urlPath });
    }
    const songId = crypto.randomUUID();
    const title = text(form.get("title")) || file.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]*/, "");
    await env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,preview_start,preview_end,position,active) VALUES (?,?,?,?,0,0,?,1)")
      .bind(songId, albumId, title, urlPath, number(form.get("position"))).run();
    return json({ ok: true, id: songId, url: urlPath });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/toggle") {
    const body = await request.json<{ kind?: string; id?: string; active?: boolean }>();
    const tables: Record<string, string> = { album: "albums", song: "songs", artist: "artists" };
    const table = tables[body.kind ?? ""];
    if (!table || !body.id) return json({ error: "בקשה לא תקינה." }, 400);
    await env.DB.prepare(`UPDATE ${table} SET active = ? WHERE id = ?`).bind(body.active ? 1 : 0, body.id).run();
    return json({ ok: true });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/catalog") {
    const body = await request.json<{ kind?: string; id?: string }>();
    const tables: Record<string, string> = { album: "albums", song: "songs", artist: "artists" };
    const table = tables[body.kind ?? ""];
    if (!table || !body.id) return json({ error: "בקשה לא תקינה." }, 400);
    await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(body.id).run();
    return json({ ok: true });
  }

  return json({ error: "Not Found" }, 404);
}

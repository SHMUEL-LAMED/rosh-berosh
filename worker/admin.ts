import { readAdminEmails, readSession, saveAdminEmails } from "./auth";
import { ensureRuntimeSchema } from "./schema";
import { readIvrPrompts, saveIvrPrompts, syncPromptToYemot } from "./ivr-prompts";

type AdminEnv = { DB: D1Database; MEDIA: R2Bucket; YEMOT_TOKEN?: string; YEMOT_API_BASE?: string };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const ARCHIVE_PREFIX = "poll-archives/";

type PollSnapshot = {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  albums: Record<string, unknown>[];
  songs: Record<string, unknown>[];
  artists: Record<string, unknown>[];
  ballots: Record<string, unknown>[];
  albumVotes: Record<string, unknown>[];
  songVotes: Record<string, unknown>[];
  artistVotes: Record<string, unknown>[];
  settings: Record<string, unknown> | null;
};

async function requireAdmin(request: Request, env: AdminEnv) {
  const user = await readSession(request, env);
  return user?.isAdmin ? user : null;
}

const text = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const flag = (value: unknown) => value === true || value === 1 || value === "1" || value === "true" || value === "on";
const mediaUrl = (key: string) => `/media/${key.split("/").map(encodeURIComponent).join("/")}`;
const safeName = (name: string) => name.normalize("NFKD").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 110) || "file";
const keyFromMediaUrl = (url?: string | null) => url?.startsWith("/media/") ? decodeURIComponent(url.slice(7)) : null;

async function deleteMediaUrls(env: AdminEnv, urls: Array<string | null | undefined>) {
  const keys = [...new Set(urls.map(keyFromMediaUrl).filter((key): key is string => !!key))];
  if (keys.length) {
    const results = await Promise.allSettled(keys.map((key) => env.MEDIA.delete(key)));
    results.forEach((result, index) => { if (result.status === "rejected") console.error("media cleanup failed", keys[index], result.reason); });
  }
}

async function readPollSnapshot(env: AdminEnv, key: string) {
  if (!key.startsWith(ARCHIVE_PREFIX) || !key.endsWith(".json")) throw new Error("invalid archive key");
  const object = await env.MEDIA.get(key);
  if (!object) return null;
  return JSON.parse(await object.text()) as PollSnapshot;
}

async function createPollSnapshot(env: AdminEnv, requestedName = "") {
  const [albums, songs, artists, ballots, albumVotes, songVotes, artistVotes, settings] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM albums ORDER BY position,title"),
    env.DB.prepare("SELECT * FROM songs ORDER BY album_id,position,title"),
    env.DB.prepare("SELECT * FROM artists ORDER BY position,name"),
    env.DB.prepare("SELECT * FROM ballots ORDER BY created_at"),
    env.DB.prepare("SELECT * FROM album_votes"),
    env.DB.prepare("SELECT * FROM song_votes"),
    env.DB.prepare("SELECT * FROM artist_votes"),
    env.DB.prepare("SELECT * FROM poll_settings WHERE id='main'"),
  ]);
  const createdAt = Date.now(), id = crypto.randomUUID();
  const name = requestedName.trim() || `סקר ${new Date(createdAt).toLocaleDateString("he-IL")}`;
  const snapshot: PollSnapshot = { version: 1, id, name, createdAt, albums: albums.results, songs: songs.results, artists: artists.results, ballots: ballots.results, albumVotes: albumVotes.results, songVotes: songVotes.results, artistVotes: artistVotes.results, settings: settings.results[0] || null };
  const key = `${ARCHIVE_PREFIX}${createdAt}-${id}.json`;
  await env.MEDIA.put(key, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" }, customMetadata: { name, createdAt: String(createdAt), votes: String(ballots.results.length) } });
  return { key, name, createdAt, votes: ballots.results.length, albums: albums.results.length, songs: songs.results.length, artists: artists.results.length, snapshot };
}

async function clearCurrentPoll(env: AdminEnv) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM song_votes"), env.DB.prepare("DELETE FROM album_votes"), env.DB.prepare("DELETE FROM artist_votes"),
    env.DB.prepare("DELETE FROM ballots"), env.DB.prepare("DELETE FROM songs"), env.DB.prepare("DELETE FROM albums"), env.DB.prepare("DELETE FROM artists"),
    env.DB.prepare("UPDATE poll_settings SET voting_open=0, albums_enabled=1, albums_min=5, albums_max=5, songs_enabled=1, songs_min=1, songs_max=1, artists_enabled=1, artists_min=1, artists_max=3 WHERE id='main'"),
  ]);
}

async function pollReadiness(env: AdminEnv) {
  const [albums, songs, artists, settingsResult] = await env.DB.batch([
    env.DB.prepare("SELECT id,title,cover_url AS coverUrl FROM albums WHERE active=1"),
    env.DB.prepare("SELECT album_id AS albumId,COUNT(*) AS total,SUM(CASE WHEN audio_url IS NOT NULL AND audio_url<>'' THEN 1 ELSE 0 END) AS withAudio FROM songs WHERE active=1 GROUP BY album_id"),
    env.DB.prepare("SELECT COUNT(*) AS total FROM artists WHERE active=1"),
    env.DB.prepare("SELECT * FROM poll_settings WHERE id='main'"),
  ]);
  const settings = settingsResult.results[0] || {};
  const songMap = new Map(songs.results.map((row) => [String(row.albumId), Number(row.total || 0)]));
  const requiredSongs = Number(settings.songs_enabled) ? Number(settings.songs_max || 1) : 0;
  const missingSongs = albums.results.filter((album) => (songMap.get(String(album.id)) || 0) < requiredSongs).map((album) => String(album.title));
  const artistCount = Number(artists.results[0]?.total || 0);
  const warnings: string[] = [];
  if (Number(settings.albums_enabled) && albums.results.length < Number(settings.albums_max || 1)) warnings.push(`צריך לפחות ${settings.albums_max} אלבומים פעילים`);
  if (Number(settings.songs_enabled) && missingSongs.length) warnings.push(`${missingSongs.length} אלבומים בלי מספיק שירים לבחירה`);
  if (Number(settings.artists_enabled) && artistCount < Number(settings.artists_max || 1)) warnings.push(`צריך לפחות ${settings.artists_max} זמרים פעילים`);
  return { ready: warnings.length === 0, warnings, counts: { albums: albums.results.length, songs: songs.results.reduce((sum, row) => sum + Number(row.total || 0), 0), artists: artistCount, missingCovers: albums.results.filter((album) => !album.coverUrl).length, missingSongs: missingSongs.length } };
}

export async function adminApi(request: Request, env: AdminEnv): Promise<Response> {
  const currentAdmin = await requireAdmin(request, env);
  if (!currentAdmin) return json({ error: "אין הרשאת מנהל." }, 403);
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
    const [ivrPrompts, managers, readiness] = await Promise.all([readIvrPrompts(env), readAdminEmails(env), pollReadiness(env)]);
    return json({ albums: albums.results, songs: songs.results, artists: artists.results, votes: ballots.results[0] ?? { total: 0, phone: 0, site: 0 }, settings: settings.results[0], readiness, ivrPrompts, managers, yemotConnected: Boolean(env.YEMOT_TOKEN), results: { albums: albumResults.results, songs: songResults.results, artists: artistResults.results } });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/archives") {
    const listed = await env.MEDIA.list({ prefix: ARCHIVE_PREFIX });
    const archives = await Promise.all(listed.objects.map(async (object) => {
      const snapshot = await readPollSnapshot(env, object.key);
      return snapshot ? { key: object.key, name: snapshot.name, createdAt: snapshot.createdAt, votes: snapshot.ballots.length, albums: snapshot.albums.length, songs: snapshot.songs.length, artists: snapshot.artists.length } : null;
    }));
    return json({ archives: archives.filter(Boolean).sort((a, b) => Number(b?.createdAt) - Number(a?.createdAt)) });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/backup") {
    const backup = await createPollSnapshot(env, text(url.searchParams.get("name")));
    return new Response(JSON.stringify(backup.snapshot, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="rosh-berosh-backup-${backup.createdAt}.json"` } });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/archive") {
    const body = await request.json<{ name?: string; restoreKey?: string }>();
    if (!body.restoreKey) return json({ ok: true, archive: await createPollSnapshot(env, text(body.name)) });
    const snapshot = await readPollSnapshot(env, body.restoreKey);
    if (!snapshot) return json({ error: "הסקר שבארכיון לא נמצא." }, 404);
    await createPollSnapshot(env, "גיבוי אוטומטי לפני שחזור");
    await clearCurrentPoll(env);
    const statements = [
      ...snapshot.albums.map((row) => env.DB.prepare("INSERT INTO albums (id,title,artist_name,cover_url,position,active) VALUES (?,?,?,?,?,?)").bind(row.id, row.title, row.artist_name, row.cover_url, row.position, row.active)),
      ...snapshot.songs.map((row) => env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,preview_start,preview_end,position,active) VALUES (?,?,?,?,?,?,?,?)").bind(row.id, row.album_id, row.title, row.audio_url, row.preview_start || 0, row.preview_end || 0, row.position, row.active)),
      ...snapshot.artists.map((row) => env.DB.prepare("INSERT INTO artists (id,name,image_url,position,active) VALUES (?,?,?,?,?)").bind(row.id, row.name, row.image_url, row.position, row.active)),
      ...snapshot.ballots.map((row) => env.DB.prepare("INSERT INTO ballots (id,voter_key,channel,created_at) VALUES (?,?,?,?)").bind(row.id, row.voter_key, row.channel, row.created_at)),
      ...snapshot.albumVotes.map((row) => env.DB.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES (?,?)").bind(row.ballot_id, row.album_id)),
      ...snapshot.songVotes.map((row) => env.DB.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES (?,?,?)").bind(row.ballot_id, row.album_id, row.song_id)),
      ...snapshot.artistVotes.map((row) => env.DB.prepare("INSERT INTO artist_votes (ballot_id,artist_id) VALUES (?,?)").bind(row.ballot_id, row.artist_id)),
    ];
    for (let index = 0; index < statements.length; index += 80) await env.DB.batch(statements.slice(index, index + 80));
    const settings = snapshot.settings;
    if (settings) await env.DB.prepare("UPDATE poll_settings SET voting_open=0,albums_enabled=?,albums_min=?,albums_max=?,songs_enabled=?,songs_min=?,songs_max=?,artists_enabled=?,artists_min=?,artists_max=? WHERE id='main'").bind(settings.albums_enabled, settings.albums_min, settings.albums_max, settings.songs_enabled, settings.songs_min, settings.songs_max, settings.artists_enabled, settings.artists_min, settings.artists_max).run();
    return json({ ok: true });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/archive") {
    const body = await request.json<{ key?: string }>();
    if (!body.key?.startsWith(ARCHIVE_PREFIX)) return json({ error: "ארכיון לא תקין." }, 400);
    await env.MEDIA.delete(body.key);
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/managers") {
    const body = await request.json<{ email?: string }>();
    const email = text(body.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "כתובת הדוא״ל אינה תקינה." }, 400);
    const managers = await readAdminEmails(env);
    if (!managers.includes(email)) managers.push(email);
    return json({ ok: true, managers: await saveAdminEmails(env, managers) });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/managers") {
    const body = await request.json<{ email?: string }>();
    const email = text(body.email).toLowerCase();
    if (!email) return json({ error: "כתובת מנהל חסרה." }, 400);
    if (email === currentAdmin.email) return json({ error: "אי אפשר להסיר את החשבון שבו אתם מחוברים." }, 400);
    const protectedEmails = new Set(["o0534169095@gmail.com", "0534169095@xn--4dbjbascrao3i.com"]);
    if (protectedEmails.has(email)) return json({ error: "זהו חשבון מנהל ראשי ואי אפשר להסירו." }, 400);
    const managers = (await readAdminEmails(env)).filter((item) => item !== email);
    return json({ ok: true, managers: await saveAdminEmails(env, managers) });
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
    if (flag(body.votingOpen)) {
      const readiness = await pollReadiness(env);
      if (!readiness.ready) return json({ error: `אי אפשר לפרסם עדיין: ${readiness.warnings.join(", ")}.`, readiness }, 400);
    }
    await env.DB.prepare(`UPDATE poll_settings SET voting_open=?, albums_enabled=?, albums_min=?, albums_max=?, songs_enabled=?, songs_min=?, songs_max=?, artists_enabled=?, artists_min=?, artists_max=? WHERE id='main'`)
      .bind(flag(body.votingOpen) ? 1 : 0, flag(body.albumsEnabled) ? 1 : 0, pairs[0][1], pairs[0][2], flag(body.songsEnabled) ? 1 : 0, pairs[1][1], pairs[1][2], flag(body.artistsEnabled) ? 1 : 0, pairs[2][1], pairs[2][2]).run();
    return json({ ok: true });
  }

  // A poll stays a draft while voting_open is 0. This route intentionally clears
  // the current poll only after an explicit confirmation in the admin UI.
  if (request.method === "DELETE" && url.pathname === "/api/admin/poll") {
    const archive = url.searchParams.get("skipArchive") === "1" ? null : await createPollSnapshot(env, "ארכיון אוטומטי לפני מחיקה");
    await clearCurrentPoll(env);
    return json({ ok: true, archive });
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
      const previous = await env.DB.prepare("SELECT cover_url AS coverUrl FROM albums WHERE id=?").bind(albumId).first<{ coverUrl?: string }>();
      await env.DB.prepare("UPDATE albums SET cover_url=? WHERE id=?").bind(urlPath, albumId).run();
      await deleteMediaUrls(env, [previous?.coverUrl]);
      return json({ ok: true, url: urlPath });
    }
    const songId = crypto.randomUUID();
    const title = text(form.get("title")) || file.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]*/, "");
    await env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,preview_start,preview_end,position,active) VALUES (?,?,?,?,0,0,?,1)")
      .bind(songId, albumId, title, urlPath, number(form.get("position"))).run();
    return json({ ok: true, id: songId, url: urlPath });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/media") {
    const body = await request.json<{ albumId?: string; kind?: string }>();
    if (!body.albumId || body.kind !== "cover") return json({ error: "בקשת מחיקת הקובץ אינה תקינה." }, 400);
    const album = await env.DB.prepare("SELECT cover_url AS coverUrl FROM albums WHERE id=?").bind(body.albumId).first<{ coverUrl?: string }>();
    if (!album) return json({ error: "האלבום לא נמצא." }, 404);
    await env.DB.prepare("UPDATE albums SET cover_url=NULL WHERE id=?").bind(body.albumId).run();
    await deleteMediaUrls(env, [album.coverUrl]);
    return json({ ok: true });
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
    if (!body.id || !["album", "song", "artist"].includes(body.kind ?? "")) return json({ error: "בקשה לא תקינה." }, 400);
    if (body.kind === "album") {
      const album = await env.DB.prepare("SELECT cover_url AS coverUrl FROM albums WHERE id=?").bind(body.id).first<{ coverUrl?: string }>();
      const songs = await env.DB.prepare("SELECT audio_url AS audioUrl FROM songs WHERE album_id=?").bind(body.id).all<{ audioUrl?: string }>();
      if (!album) return json({ error: "האלבום כבר אינו קיים." }, 404);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM song_votes WHERE album_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM album_votes WHERE album_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM songs WHERE album_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM albums WHERE id=?").bind(body.id),
      ]);
      await deleteMediaUrls(env, [album.coverUrl, ...songs.results.map((song) => song.audioUrl)]);
    } else if (body.kind === "song") {
      const song = await env.DB.prepare("SELECT audio_url AS audioUrl FROM songs WHERE id=?").bind(body.id).first<{ audioUrl?: string }>();
      if (!song) return json({ error: "השיר כבר אינו קיים." }, 404);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM song_votes WHERE song_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM songs WHERE id=?").bind(body.id),
      ]);
      await deleteMediaUrls(env, [song.audioUrl]);
    } else {
      const artist = await env.DB.prepare("SELECT id FROM artists WHERE id=?").bind(body.id).first();
      if (!artist) return json({ error: "הזמר כבר אינו קיים." }, 404);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM artist_votes WHERE artist_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM artists WHERE id=?").bind(body.id),
      ]);
    }
    return json({ ok: true });
  }

  return json({ error: "Not Found" }, 404);
}

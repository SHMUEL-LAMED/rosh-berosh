import { readSession } from "./auth";

type AdminEnv = { DB: D1Database };
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function requireAdmin(request: Request, env: AdminEnv) {
  const user = await readSession(request);
  return user?.isAdmin ? user : null;
}

export async function adminApi(request: Request, env: AdminEnv): Promise<Response> {
  if (!await requireAdmin(request, env)) return json({ error: "אין הרשאת מנהל." }, 403);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/overview") {
    const [albums, songs, artists, ballots] = await env.DB.batch([
      env.DB.prepare("SELECT id, title, artist_name AS artistName, cover_url AS coverUrl, position, active FROM albums ORDER BY position, title"),
      env.DB.prepare("SELECT id, album_id AS albumId, title, audio_url AS audioUrl, position, active FROM songs ORDER BY album_id, position, title"),
      env.DB.prepare("SELECT id, name, image_url AS imageUrl, position, active FROM artists ORDER BY position, name"),
      env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN channel = 'phone' THEN 1 ELSE 0 END) AS phone, SUM(CASE WHEN channel = 'site' THEN 1 ELSE 0 END) AS site FROM ballots"),
    ]);
    return json({ albums: albums.results, songs: songs.results, artists: artists.results, votes: ballots.results[0] ?? { total: 0, phone: 0, site: 0 } });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/catalog") {
    const body = await request.json<Record<string, unknown>>();
    const kind = String(body.kind ?? "");
    const id = String(body.id || crypto.randomUUID());
    if (kind === "album") {
      const title = String(body.title ?? "").trim();
      const artistName = String(body.artistName ?? "").trim();
      if (!title || !artistName) return json({ error: "חובה להזין שם אלבום ושם אמן." }, 400);
      await env.DB.prepare("INSERT INTO albums (id,title,artist_name,cover_url,position,active) VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist_name=excluded.artist_name,cover_url=excluded.cover_url,position=excluded.position")
        .bind(id, title, artistName, String(body.coverUrl ?? "") || null, Number(body.position ?? 0)).run();
    } else if (kind === "song") {
      const title = String(body.title ?? "").trim();
      const albumId = String(body.albumId ?? "");
      if (!title || !albumId) return json({ error: "חובה לבחור אלבום ולהזין שם שיר." }, 400);
      await env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,position,active) VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET album_id=excluded.album_id,title=excluded.title,audio_url=excluded.audio_url,position=excluded.position")
        .bind(id, albumId, title, String(body.audioUrl ?? "") || null, Number(body.position ?? 0)).run();
    } else if (kind === "artist") {
      const name = String(body.name ?? "").trim();
      if (!name) return json({ error: "חובה להזין שם זמר." }, 400);
      await env.DB.prepare("INSERT INTO artists (id,name,image_url,position,active) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,image_url=excluded.image_url,position=excluded.position")
        .bind(id, name, String(body.imageUrl ?? "") || null, Number(body.position ?? 0)).run();
    } else return json({ error: "סוג פריט לא מוכר." }, 400);
    return json({ ok: true, id });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/toggle") {
    const body = await request.json<{ kind?: string; id?: string; active?: boolean }>();
    const tables: Record<string, string> = { album: "albums", song: "songs", artist: "artists" };
    const table = tables[body.kind ?? ""];
    if (!table || !body.id) return json({ error: "בקשה לא תקינה." }, 400);
    await env.DB.prepare(`UPDATE ${table} SET active = ? WHERE id = ?`).bind(body.active ? 1 : 0, body.id).run();
    return json({ ok: true });
  }

  return json({ error: "Not Found" }, 404);
}

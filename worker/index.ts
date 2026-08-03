/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { clearSessionCookie, GOOGLE_CLIENT_ID, readSession, sessionCookie, verifyGoogleCredential } from "./auth";
import { adminApi } from "./admin";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type Submission = {
  voterKey?: string;
  albumIds?: string[];
  songIdsByAlbum?: Record<string, string>;
  artistIds?: string[];
  channel?: "site" | "phone";
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const unique = (items: string[]) => [...new Set(items)];
const placeholders = (count: number) => Array(count).fill("?").join(",");

async function catalog(env: Env): Promise<Response> {
  try {
    const [albums, songs, artists] = await env.DB.batch([
      env.DB.prepare("SELECT id, title, artist_name AS artistName, cover_url AS coverUrl FROM albums WHERE active = 1 ORDER BY position, title"),
      env.DB.prepare("SELECT id, album_id AS albumId, title, audio_url AS audioUrl FROM songs WHERE active = 1 ORDER BY position, title"),
      env.DB.prepare("SELECT id, name, image_url AS imageUrl FROM artists WHERE active = 1 ORDER BY position, name"),
    ]);
    return json({
      albums: albums.results,
      songs: songs.results,
      artists: artists.results,
      rules: { albums: 5, artistsMin: 1, artistsMax: 3 },
    });
  } catch (error) {
    console.error("catalog error", error);
    return json({ error: "לא ניתן לטעון את רשימת המצעד." }, 500);
  }
}

async function submitBallot(request: Request, env: Env): Promise<Response> {
  let body: Submission;
  try {
    body = (await request.json()) as Submission;
  } catch {
    return json({ error: "בקשה לא תקינה." }, 400);
  }

  const voterKey = body.voterKey?.trim().toLowerCase();
  const albumIds = unique(body.albumIds ?? []);
  const artistIds = unique(body.artistIds ?? []);
  const songMap = body.songIdsByAlbum ?? {};
  if (!voterKey || albumIds.length !== 5 || artistIds.length < 1 || artistIds.length > 3 || albumIds.some((id) => !songMap[id])) {
    return json({ error: "יש לבחור 5 אלבומים, שיר מכל אלבום, ובין 1 ל־3 זמרים." }, 400);
  }

  const validAlbums = await env.DB.prepare(`SELECT id FROM albums WHERE active = 1 AND id IN (${placeholders(albumIds.length)})`).bind(...albumIds).all<{ id: string }>();
  const validArtists = await env.DB.prepare(`SELECT id FROM artists WHERE active = 1 AND id IN (${placeholders(artistIds.length)})`).bind(...artistIds).all<{ id: string }>();
  const songIds = albumIds.map((id) => songMap[id]);
  const validSongs = await env.DB.prepare(`SELECT id, album_id AS albumId FROM songs WHERE active = 1 AND id IN (${placeholders(songIds.length)})`).bind(...songIds).all<{ id: string; albumId: string }>();
  if (validAlbums.results.length !== 5 || validArtists.results.length !== artistIds.length || validSongs.results.length !== 5 || validSongs.results.some((song) => songMap[song.albumId] !== song.id)) {
    return json({ error: "אחת הבחירות אינה קיימת או אינה פעילה." }, 400);
  }

  const ballotId = crypto.randomUUID();
  const statements = [
    env.DB.prepare("INSERT INTO ballots (id, voter_key, channel) VALUES (?, ?, ?)").bind(ballotId, voterKey, body.channel === "phone" ? "phone" : "site"),
    ...albumIds.map((id) => env.DB.prepare("INSERT INTO album_votes (ballot_id, album_id) VALUES (?, ?)").bind(ballotId, id)),
    ...albumIds.map((id) => env.DB.prepare("INSERT INTO song_votes (ballot_id, album_id, song_id) VALUES (?, ?, ?)").bind(ballotId, id, songMap[id])),
    ...artistIds.map((id) => env.DB.prepare("INSERT INTO artist_votes (ballot_id, artist_id) VALUES (?, ?)").bind(ballotId, id)),
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

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/auth/config" && request.method === "GET") {
      return json({ clientId: GOOGLE_CLIENT_ID });
    }
    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      try {
        const { credential } = await request.json<{ credential?: string }>();
        if (!credential) return json({ error: "חסר אישור Google." }, 400);
        const user = await verifyGoogleCredential(credential);
        const response = json({ user: { email: user.email, name: user.name, picture: user.picture, isAdmin: user.isAdmin } });
        response.headers.set("set-cookie", sessionCookie(credential));
        return response;
      } catch (error) {
        console.error("google auth error", error);
        return json({ error: "ההתחברות באמצעות Google נכשלה." }, 401);
      }
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const user = await readSession(request);
      return user ? json({ user: { email: user.email, name: user.name, picture: user.picture, isAdmin: user.isAdmin } }) : json({ user: null }, 401);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const response = json({ ok: true });
      response.headers.set("set-cookie", clearSessionCookie);
      return response;
    }
    if (url.pathname.startsWith("/api/admin/")) return adminApi(request, env);

    // Vinext currently returns a plain 404 for route handlers on the deployed
    // Worker. Handle the two public API endpoints at the Worker boundary so
    // both the website and the IVR always reach D1.
    if (url.pathname === "/api/catalog" && request.method === "GET") {
      return catalog(env);
    }
    if (url.pathname === "/api/ballots" && request.method === "POST") {
      const original = (await request.json()) as Submission;
      if (original.channel === "phone") {
        return submitBallot(new Request(request, { body: JSON.stringify(original) }), env);
      }
      const user = await readSession(request);
      if (!user) return json({ error: "יש להתחבר באמצעות Google." }, 401);
      return submitBallot(new Request(request, { body: JSON.stringify({ ...original, voterKey: user.sub }) }), env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;

import { NextResponse } from "next/server";
import { getD1 } from "@/db/d1";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getD1();
    const [albumsResult, songsResult, artistsResult] = await db.batch([
      db.prepare("SELECT id, title, artist_name AS artistName, cover_url AS coverUrl FROM albums WHERE active = 1 ORDER BY position, title"),
      db.prepare("SELECT id, album_id AS albumId, title, audio_url AS audioUrl FROM songs WHERE active = 1 ORDER BY position, title"),
      db.prepare("SELECT id, name, image_url AS imageUrl FROM artists WHERE active = 1 ORDER BY position, name"),
    ]);
    return NextResponse.json({ albums: albumsResult.results, songs: songsResult.results, artists: artistsResult.results, rules: { albums: 5, artistsMin: 1, artistsMax: 3 } });
  } catch (error) {
    console.error("catalog error", error);
    return NextResponse.json({ error: "לא ניתן לטעון את רשימת המצעד." }, { status: 500 });
  }
}

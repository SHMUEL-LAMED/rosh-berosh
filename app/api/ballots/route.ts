import { NextRequest, NextResponse } from "next/server";
import { getD1 } from "@/db/d1";

type Submission = { voterKey?: string; albumIds?: string[]; songIdsByAlbum?: Record<string, string>; artistIds?: string[]; channel?: "site" | "phone" };
const unique = (items: string[]) => [...new Set(items)];

export async function POST(request: NextRequest) {
  let body: Submission;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "בקשה לא תקינה." }, { status: 400 }); }

  const voterKey = body.voterKey?.trim().toLowerCase();
  const albumIds = unique(body.albumIds ?? []);
  const artistIds = unique(body.artistIds ?? []);
  const songMap = body.songIdsByAlbum ?? {};
  if (!voterKey || albumIds.length !== 5 || artistIds.length < 1 || artistIds.length > 3 || albumIds.some((id) => !songMap[id])) {
    return NextResponse.json({ error: "יש לבחור 5 אלבומים, שיר מכל אלבום, ובין 1 ל־3 זמרים." }, { status: 400 });
  }

  const db = await getD1();
  const placeholders = (count: number) => Array(count).fill("?").join(",");
  const validAlbums = await db.prepare(`SELECT id FROM albums WHERE active = 1 AND id IN (${placeholders(albumIds.length)})`).bind(...albumIds).all<{ id: string }>();
  const validArtists = await db.prepare(`SELECT id FROM artists WHERE active = 1 AND id IN (${placeholders(artistIds.length)})`).bind(...artistIds).all<{ id: string }>();
  const songIds = albumIds.map((id) => songMap[id]);
  const validSongs = await db.prepare(`SELECT id, album_id AS albumId FROM songs WHERE active = 1 AND id IN (${placeholders(songIds.length)})`).bind(...songIds).all<{ id: string; albumId: string }>();
  if (validAlbums.results.length !== 5 || validArtists.results.length !== artistIds.length || validSongs.results.length !== 5 || validSongs.results.some((song: { id: string; albumId: string }) => songMap[song.albumId] !== song.id)) {
    return NextResponse.json({ error: "אחת הבחירות אינה קיימת או אינה פעילה." }, { status: 400 });
  }

  const ballotId = crypto.randomUUID();
  const statements = [
    db.prepare("INSERT INTO ballots (id, voter_key, channel) VALUES (?, ?, ?)").bind(ballotId, voterKey, body.channel === "phone" ? "phone" : "site"),
    ...albumIds.map((id) => db.prepare("INSERT INTO album_votes (ballot_id, album_id) VALUES (?, ?)").bind(ballotId, id)),
    ...albumIds.map((id) => db.prepare("INSERT INTO song_votes (ballot_id, album_id, song_id) VALUES (?, ?, ?)").bind(ballotId, id, songMap[id])),
    ...artistIds.map((id) => db.prepare("INSERT INTO artist_votes (ballot_id, artist_id) VALUES (?, ?)").bind(ballotId, id)),
  ];
  try {
    await db.batch(statements);
    return NextResponse.json({ ok: true, ballotId }, { status: 201 });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return NextResponse.json({ error: "כבר התקבלה הצבעה מהמזהה הזה." }, { status: 409 });
    console.error("ballot error", error);
    return NextResponse.json({ error: "שמירת ההצבעה נכשלה." }, { status: 500 });
  }
}

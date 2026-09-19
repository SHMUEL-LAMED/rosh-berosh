import { readIvrPrompts } from "./ivr-prompts";
import type { Analytics, AlbumBreakdown, DurationSummary, RankedItem, StageDurations } from "../app/admin/analytics-types";

/**
 * נתונים מתקדמים ללשונית "נתונים" בניהול. הכול נגזר מהטבלאות הקיימות של
 * הסקר הפעיל: הצלבות בין הצבעות, פערים, זמני הצבעה ומצב תוכן. הלשונית
 * הזו נוספת לצד "תוצאות" ו"מצביעים" ואינה משנה את מה שהם מציגים.
 */

type Env = { DB: D1Database; MEDIA: R2Bucket };
type Channel = "site" | "phone";
type ItemRow = { id: string; title: string; albumId?: string; albumTitle?: string; artistName?: string; coverUrl?: string | null; imageUrl?: string | null; active: number; votes: number; site: number; phone: number };
type PairRow = { a: string; b: string; votes: number };
type TimingRow = { channel: Channel; createdAt: number; startedAt: number; albumsDoneAt: number | null; songsDoneAt: number | null; artistsDoneAt: number | null; sessions: number | null };

export type { Analytics };

const num = (value: unknown) => Number(value) || 0;
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const share = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100) : 0);

function summarize(values: number[]): DurationSummary {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, average: 0, median: 0, total: 0 };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { count: sorted.length, average: Math.round(total / sorted.length), median: Math.round(median), total };
}

function rankWith<T extends ItemRow>(rows: T[], key: "votes" | "site" | "phone"): Map<string, number> {
  const ordered = [...rows].sort((a, b) => num(b[key]) - num(a[key]));
  const places = new Map<string, number>();
  let place = 0, previous: number | null = null;
  ordered.forEach((row, index) => {
    const value = num(row[key]);
    if (previous === null || value !== previous) place = index + 1;
    previous = value;
    places.set(row.id, place);
  });
  return places;
}

function rankList(rows: ItemRow[], totalBallots: number, subtitle?: (row: ItemRow) => string | undefined): RankedItem[] {
  const sorted = [...rows].sort((a, b) => num(b.votes) - num(a.votes) || a.title.localeCompare(b.title, "he"));
  const sitePlaces = rankWith(sorted, "site"), phonePlaces = rankWith(sorted, "phone");
  return sorted.map((row, index) => {
    const votes = num(row.votes);
    const above = index > 0 ? num(sorted[index - 1].votes) : null;
    const below = index < sorted.length - 1 ? num(sorted[index + 1].votes) : null;
    return {
      id: row.id, title: row.title, subtitle: subtitle?.(row), votes, site: num(row.site), phone: num(row.phone), share: share(votes, totalBallots), place: index + 1,
      sitePlace: sitePlaces.get(row.id) || 0, phonePlace: phonePlaces.get(row.id) || 0,
      gapAbove: above === null ? null : above - votes, gapBelow: below === null ? null : votes - below,
    };
  });
}

// זמר "שייך" לאלבום כששמו מופיע בשדה האמן של האלבום. ההשוואה סובלת רווחים
// כפולים ואותיות שונות, אך לא מנחשת מעבר לכך.
const normalizeName = (value: string) => value.toLowerCase().replace(/[\u0591-\u05C7]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function albumBelongsToArtist(albumArtist: string, artistName: string): boolean {
  const album = ` ${normalizeName(albumArtist)} `, artist = normalizeName(artistName);
  return artist.length >= 2 && album.includes(` ${artist} `);
}

export async function buildAnalytics(env: Env, surveyId: string): Promise<Analytics> {
  const channelSums = "SUM(CASE WHEN b.channel='site' THEN 1 ELSE 0 END) AS site, SUM(CASE WHEN b.channel='phone' THEN 1 ELSE 0 END) AS phone";
  const comboSource = "SELECT av.ballot_id AS ballotId, GROUP_CONCAT(av.album_id, ',') AS combo FROM (SELECT x.ballot_id, x.album_id FROM album_votes x JOIN ballots bl ON bl.id=x.ballot_id WHERE bl.survey_id=?1 ORDER BY x.ballot_id, x.album_id) av GROUP BY av.ballot_id";
  const [albums, songs, artists, ballots, artistAlbum, albumPairs, artistPairs, combos, comboStats, timingRows, daily, blocked, audit, auditTotalsRows] = await env.DB.batch([
    env.DB.prepare(`SELECT a.id, a.title, a.artist_name AS artistName, a.cover_url AS coverUrl, a.active, COUNT(v.album_id) AS votes, ${channelSums} FROM albums a LEFT JOIN album_votes v ON v.album_id=a.id LEFT JOIN ballots b ON b.id=v.ballot_id WHERE a.survey_id=?1 GROUP BY a.id ORDER BY votes DESC, a.position, a.title`).bind(surveyId),
    env.DB.prepare(`SELECT s.id, s.title, s.album_id AS albumId, a.title AS albumTitle, s.active, s.audio_url AS audioUrl, s.preview_start AS previewStart, s.preview_end AS previewEnd, COUNT(v.song_id) AS votes, ${channelSums} FROM songs s JOIN albums a ON a.id=s.album_id LEFT JOIN song_votes v ON v.song_id=s.id LEFT JOIN ballots b ON b.id=v.ballot_id WHERE a.survey_id=?1 GROUP BY s.id ORDER BY votes DESC, s.album_id, s.position, s.title`).bind(surveyId),
    env.DB.prepare(`SELECT a.id, a.name AS title, a.image_url AS imageUrl, a.active, COUNT(v.artist_id) AS votes, ${channelSums} FROM artists a LEFT JOIN artist_votes v ON v.artist_id=a.id LEFT JOIN ballots b ON b.id=v.ballot_id WHERE a.survey_id=?1 GROUP BY a.id ORDER BY votes DESC, a.position, a.name`).bind(surveyId),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN channel='site' THEN 1 ELSE 0 END) AS site, SUM(CASE WHEN channel='phone' THEN 1 ELSE 0 END) AS phone, MIN(created_at) AS firstAt, MAX(created_at) AS lastAt FROM ballots WHERE survey_id=?1").bind(surveyId),
    env.DB.prepare("SELECT av.artist_id AS a, alv.album_id AS b, COUNT(*) AS votes FROM artist_votes av JOIN ballots bl ON bl.id=av.ballot_id JOIN album_votes alv ON alv.ballot_id=av.ballot_id WHERE bl.survey_id=?1 GROUP BY av.artist_id, alv.album_id").bind(surveyId),
    env.DB.prepare("SELECT x.album_id AS a, y.album_id AS b, COUNT(*) AS votes FROM album_votes x JOIN album_votes y ON y.ballot_id=x.ballot_id AND y.album_id>x.album_id JOIN ballots bl ON bl.id=x.ballot_id WHERE bl.survey_id=?1 GROUP BY x.album_id, y.album_id").bind(surveyId),
    env.DB.prepare("SELECT x.artist_id AS a, y.artist_id AS b, COUNT(*) AS votes FROM artist_votes x JOIN artist_votes y ON y.ballot_id=x.ballot_id AND y.artist_id>x.artist_id JOIN ballots bl ON bl.id=x.ballot_id WHERE bl.survey_id=?1 GROUP BY x.artist_id, y.artist_id ORDER BY votes DESC LIMIT 20").bind(surveyId),
    env.DB.prepare(`SELECT combo, COUNT(*) AS votes FROM (${comboSource}) GROUP BY combo ORDER BY votes DESC, combo LIMIT 10`).bind(surveyId),
    env.DB.prepare(`SELECT COUNT(*) AS combos, COALESCE(SUM(CASE WHEN cnt > 1 THEN cnt ELSE 0 END), 0) AS repeated FROM (SELECT combo, COUNT(*) AS cnt FROM (${comboSource}) GROUP BY combo)`).bind(surveyId),
    env.DB.prepare("SELECT channel, created_at AS createdAt, started_at AS startedAt, albums_done_at AS albumsDoneAt, songs_done_at AS songsDoneAt, artists_done_at AS artistsDoneAt, sessions FROM ballots WHERE survey_id=?1 AND started_at IS NOT NULL").bind(surveyId),
    env.DB.prepare("SELECT CAST(created_at/86400 AS INTEGER)*86400 AS bucket, channel, COUNT(*) AS votes FROM ballots WHERE survey_id=?1 GROUP BY bucket, channel ORDER BY bucket").bind(surveyId),
    env.DB.prepare("SELECT bf.fingerprint, bf.blocked_by AS blockedBy, bf.created_at AS createdAt, (SELECT COUNT(*) FROM ballots b WHERE b.survey_id=bf.survey_id AND b.fingerprint=bf.fingerprint) AS ballots, (SELECT MAX(b.created_at) FROM ballots b WHERE b.survey_id=bf.survey_id AND b.fingerprint=bf.fingerprint) AS lastBallotAt FROM blocked_fingerprints bf WHERE bf.survey_id=?1 ORDER BY bf.created_at DESC").bind(surveyId),
    env.DB.prepare("SELECT id, phone, action, target, status, created_at AS createdAt FROM ivr_admin_audit ORDER BY created_at DESC LIMIT 60"),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed FROM ivr_admin_audit WHERE created_at >= unixepoch() - 30*86400"),
  ]);

  const totals = ballots.results[0] as { total: number; site: number; phone: number; firstAt: number | null; lastAt: number | null } | undefined;
  const totalBallots = num(totals?.total);
  const albumRows = albums.results as ItemRow[], songRows = songs.results as Array<ItemRow & { audioUrl?: string | null; previewStart: number; previewEnd: number }>, artistRows = artists.results as ItemRow[];
  const albumTitle = new Map(albumRows.map((row) => [row.id, row.title]));
  const artistTitle = new Map(artistRows.map((row) => [row.id, row.title]));
  const artistVotesById = new Map(artistRows.map((row) => [row.id, num(row.votes)]));

  // פירוט השירים בכל אלבום והשיר המוביל בו. "ריכוזיות" היא חלקו של השיר
  // המוביל מכלל קולות השירים באלבום: קרוב ל-100 כשהשיר לוקח הכול.
  const songsByAlbum = new Map<string, typeof songRows>();
  for (const song of songRows) { const list = songsByAlbum.get(String(song.albumId)) || []; list.push(song); songsByAlbum.set(String(song.albumId), list); }
  const albumBreakdown: AlbumBreakdown[] = albumRows.map((album) => {
    const list = (songsByAlbum.get(album.id) || []).slice().sort((a, b) => num(b.votes) - num(a.votes) || a.title.localeCompare(b.title, "he"));
    const songVotes = list.reduce((sum, song) => sum + num(song.votes), 0);
    const items = list.map((song) => ({ id: song.id, title: song.title, votes: num(song.votes), share: share(num(song.votes), songVotes) }));
    const topSong = items.length && items[0].votes > 0 ? items[0] : null;
    return { id: album.id, title: album.title, artistName: String(album.artistName || ""), coverUrl: album.coverUrl, votes: num(album.votes), songs: items, topSong, songVotes, concentration: topSong ? topSong.share : 0 };
  });

  const rankedAlbums = rankList(albumRows, totalBallots, (row) => row.artistName);
  const rankedSongs = rankList(songRows, totalBallots, (row) => row.albumTitle);
  const rankedArtists = rankList(artistRows, totalBallots);

  const zeroVotes = {
    albums: albumRows.filter((row) => !num(row.votes)).map((row) => ({ id: row.id, title: row.title, subtitle: row.artistName, active: num(row.active) })),
    songs: songRows.filter((row) => !num(row.votes)).map((row) => ({ id: row.id, title: row.title, subtitle: row.albumTitle, active: num(row.active) })),
    artists: artistRows.filter((row) => !num(row.votes)).map((row) => ({ id: row.id, title: row.title, active: num(row.active) })),
  };

  // הצלבת זמר–אלבום: לכל זמר, האלבומים שבחרו מי שהצביעו לו, וגם האלבומים
  // שלו עצמו (לפי שם האמן באלבום) עם החפיפה בין שני הקהלים.
  const crossByArtist = new Map<string, Array<{ albumId: string; votes: number }>>();
  for (const row of artistAlbum.results as PairRow[]) { const list = crossByArtist.get(row.a) || []; list.push({ albumId: row.b, votes: num(row.votes) }); crossByArtist.set(row.a, list); }
  const artistAlbums = artistRows.filter((artist) => num(artist.votes) > 0).map((artist) => {
    const artistVotes = num(artist.votes);
    const cross = (crossByArtist.get(artist.id) || []).sort((a, b) => b.votes - a.votes);
    const crossById = new Map(cross.map((item) => [item.albumId, item.votes]));
    const own = albumRows.filter((album) => albumBelongsToArtist(String(album.artistName || ""), artist.title)).map((album) => {
      const both = crossById.get(album.id) || 0, albumVotes = num(album.votes);
      return { id: album.id, title: album.title, albumVotes, both, ofArtistVoters: share(both, artistVotes), ofAlbumVoters: share(both, albumVotes) };
    });
    return { id: artist.id, name: artist.title, votes: artistVotes, top: cross.slice(0, 5).map((item) => ({ id: item.albumId, title: albumTitle.get(item.albumId) || "", votes: item.votes, share: share(item.votes, artistVotes) })), own };
  });

  // "מי שבחר X בחר גם Y": חמשת האלבומים שהכי הולכים עם כל אלבום.
  const companions = new Map<string, Array<{ id: string; votes: number }>>();
  for (const row of albumPairs.results as PairRow[]) {
    for (const [from, to] of [[row.a, row.b], [row.b, row.a]] as const) { const list = companions.get(from) || []; list.push({ id: to, votes: num(row.votes) }); companions.set(from, list); }
  }
  const albumCompanions = albumRows.filter((album) => num(album.votes) > 0).map((album) => ({
    id: album.id, title: album.title, votes: num(album.votes),
    top: (companions.get(album.id) || []).sort((a, b) => b.votes - a.votes).slice(0, 5).map((item) => ({ id: item.id, title: albumTitle.get(item.id) || "", votes: item.votes, share: share(item.votes, num(album.votes)) })),
  }));

  const artistPairList = (artistPairs.results as PairRow[]).map((row) => ({ a: artistTitle.get(row.a) || "", b: artistTitle.get(row.b) || "", votes: num(row.votes), shareOfA: share(num(row.votes), artistVotesById.get(row.a) || 0), shareOfB: share(num(row.votes), artistVotesById.get(row.b) || 0) }));

  const comboList = (combos.results as Array<{ combo: string; votes: number }>).map((row) => ({ albums: String(row.combo).split(",").map((id) => albumTitle.get(id) || "").filter(Boolean), votes: num(row.votes), share: share(num(row.votes), totalBallots) }));
  const comboTotals = comboStats.results[0] as { combos: number; repeated: number } | undefined;

  // זמני הצבעה. שלב "אישור" הוא מהסיום של השלב האחרון שנמדד ועד שמירת הפתק.
  const rows = timingRows.results as TimingRow[];
  const durationOf = (row: TimingRow) => row.createdAt - row.startedAt;
  const byChannel = (channel: Channel | "all") => rows.filter((row) => channel === "all" || row.channel === channel);
  const stageDurations = (list: TimingRow[]): StageDurations => ({
    albums: summarize(list.filter((row) => row.albumsDoneAt).map((row) => Number(row.albumsDoneAt) - row.startedAt)),
    songs: summarize(list.filter((row) => row.songsDoneAt && row.albumsDoneAt).map((row) => Number(row.songsDoneAt) - Number(row.albumsDoneAt))),
    artists: summarize(list.filter((row) => row.artistsDoneAt).map((row) => Number(row.artistsDoneAt) - Number(row.songsDoneAt || row.albumsDoneAt || row.startedAt))),
    summary: summarize(list.filter((row) => row.artistsDoneAt || row.songsDoneAt || row.albumsDoneAt).map((row) => row.createdAt - Number(row.artistsDoneAt || row.songsDoneAt || row.albumsDoneAt))),
  });
  const bucketsSpec = [{ label: "עד דקה", max: 60 }, { label: "1–3 דקות", max: 180 }, { label: "3–5 דקות", max: 300 }, { label: "5–10 דקות", max: 600 }, { label: "10–30 דקות", max: 1800 }, { label: "יותר מחצי שעה", max: Infinity }];
  const distribution = (list: TimingRow[]) => bucketsSpec.map((bucket, index) => { const min = index ? bucketsSpec[index - 1].max : -1; const count = list.filter((row) => { const d = durationOf(row); return d > min && d <= bucket.max; }).length; return { label: bucket.label, count, share: share(count, list.length) }; });
  const sessionsHistogram = (list: TimingRow[]) => {
    const spec = [{ label: "ביקור אחד", test: (n: number) => n === 1 }, { label: "שני ביקורים", test: (n: number) => n === 2 }, { label: "שלושה ומעלה", test: (n: number) => n >= 3 }];
    const known = list.filter((row) => Number(row.sessions) >= 1);
    return spec.map((item) => { const count = known.filter((row) => item.test(Number(row.sessions))).length; return { label: item.label, count, share: share(count, known.length) }; });
  };
  const timingFor = (channel: Channel | "all") => { const list = byChannel(channel); return { overall: summarize(list.map(durationOf)), stages: stageDurations(list), distribution: distribution(list), sessions: sessionsHistogram(list), fastest: list.length ? Math.min(...list.map(durationOf)) : 0, slowest: list.length ? Math.max(...list.map(durationOf)) : 0 }; };
  const timing = { all: timingFor("all"), site: timingFor("site"), phone: timingFor("phone"), untracked: totalBallots - rows.length };

  // הצבעות לפי יום מאז ההצבעה הראשונה, כולל מצטבר.
  const dailyMap = new Map<number, { bucket: number; site: number; phone: number; total: number; cumulative: number }>();
  for (const row of daily.results as Array<{ bucket: number; channel: Channel; votes: number }>) {
    const point = dailyMap.get(num(row.bucket)) || { bucket: num(row.bucket), site: 0, phone: 0, total: 0, cumulative: 0 };
    point[row.channel === "phone" ? "phone" : "site"] += num(row.votes); point.total += num(row.votes); dailyMap.set(point.bucket, point);
  }
  const dailySeries = [...dailyMap.values()].sort((a, b) => a.bucket - b.bucket);
  let running = 0;
  for (const point of dailySeries) { running += point.total; point.cumulative = running; }
  const peakDay = dailySeries.reduce<typeof dailySeries[number] | null>((best, point) => (!best || point.total > best.total ? point : best), null);

  // מצב התוכן: מה חסר כדי שהאתר והקו יהיו שלמים.
  const prompts = await readIvrPrompts(env).catch(() => [] as Array<{ key: string }>);
  const promptKeys = new Set(prompts.map((prompt) => prompt.key));
  const content = {
    songsWithoutAudio: songRows.filter((row) => !row.audioUrl).map((row) => ({ id: row.id, title: row.title, subtitle: row.albumTitle })),
    songsWithoutPreview: songRows.filter((row) => row.audioUrl && num(row.previewEnd) <= num(row.previewStart)).map((row) => ({ id: row.id, title: row.title, subtitle: row.albumTitle })),
    albumsWithoutCover: albumRows.filter((row) => !row.coverUrl).map((row) => ({ id: row.id, title: row.title, subtitle: row.artistName })),
    artistsWithoutImage: artistRows.filter((row) => !row.imageUrl).map((row) => ({ id: row.id, title: row.title })),
    missingPrompts: [
      ...albumRows.filter((row) => !promptKeys.has(`album:${row.id}`)).map((row) => ({ id: row.id, title: row.title, subtitle: "אלבום" })),
      ...artistRows.filter((row) => !promptKeys.has(`artist:${row.id}`)).map((row) => ({ id: row.id, title: row.title, subtitle: "זמר" })),
      ...songRows.filter((row) => !promptKeys.has(`song:${row.id}`)).map((row) => ({ id: row.id, title: row.title, subtitle: `שיר · ${row.albumTitle || ""}` })),
    ],
    inactive: { albums: albumRows.filter((row) => !num(row.active)).length, songs: songRows.filter((row) => !num(row.active)).length, artists: artistRows.filter((row) => !num(row.active)).length },
  };

  const auditTotals = auditTotalsRows.results[0] as { total: number; failed: number } | undefined;
  return {
    generatedAt: Math.floor(Date.now() / 1000),
    totals: { ballots: totalBallots, site: num(totals?.site), phone: num(totals?.phone), firstAt: totals?.firstAt ?? null, lastAt: totals?.lastAt ?? null, albums: albumRows.length, songs: songRows.length, artists: artistRows.length },
    rankings: { albums: rankedAlbums, songs: rankedSongs, artists: rankedArtists },
    albumBreakdown,
    zeroVotes,
    artistAlbums,
    albumCompanions,
    artistPairs: artistPairList,
    combos: { top: comboList, distinct: num(comboTotals?.combos), repeated: num(comboTotals?.repeated) },
    timing,
    daily: { series: dailySeries, peak: peakDay },
    blocked: (blocked.results as Array<{ fingerprint: string; blockedBy: string; createdAt: number; ballots: number; lastBallotAt: number | null }>).map((row) => ({ ...row, ballots: num(row.ballots) })),
    audit: { recent: audit.results as Analytics["audit"]["recent"], last30Days: { total: num(auditTotals?.total), failed: num(auditTotals?.failed) } },
    content,
  };
}

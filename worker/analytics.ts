import { placeholders } from "./sql.js";
import { competitionPlaces, concentrationIndex, giniCoefficient, israelParts, pearson, summarize } from "./analytics-math.js";
import type {
  AbandonedStage, AlbumBreakdown, Analytics, Anomaly, CompositeBallot, Concentration, DailyPoint,
  PaceWindow, PositionBias, RaceSeries, RankedItem, StageDurations, SurveyComparison, TasteGroup,
} from "../app/admin/analytics-types";

/**
 * נתונים מתקדמים ללשונית "נתונים מתקדמים" בניהול. הכול נגזר מהטבלאות
 * הקיימות של הסקר הפעיל, בלי שום נתיב כתיבה חדש. הלשונית נוספת לצד
 * "תוצאות" ו"מצביעים" ואינה משנה את מה שהם מציגים.
 *
 * הכל רץ בשתי אצוות D1 ולא באחת: אצווה אחת היא עסקה אחת, וככל שיש בה
 * יותר משפטים כך גדל הסיכוי שמשפט אחד שנכשל מפיל את כל המסך. הפיצול גם
 * מאפשר לשאול על הסקר הקודם רק אחרי שידוע מיהו.
 */

type Env = { DB: D1Database; MEDIA: R2Bucket };
type Channel = "site" | "phone";
type ItemRow = { id: string; title: string; albumId?: string; albumTitle?: string; artistName?: string; coverUrl?: string | null; imageUrl?: string | null; position: number; active: number; votes: number; site: number; phone: number };
type SongRow = ItemRow & { audioUrl?: string | null; previewStart: number; previewEnd: number; albumActive: number };
type PairRow = { a: string; b: string; votes: number };
type TimingRow = { channel: Channel; createdAt: number; startedAt: number; albumsDoneAt: number | null; songsDoneAt: number | null; artistsDoneAt: number | null; sessions: number | null };
type StageFlags = { albums: boolean; songs: boolean; artists: boolean };
type HourRow = { bucket: number; channel: Channel; votes: number };
type RaceRow = { id: string; bucket: number; votes: number };

export type { Analytics };

// תקרה על מספר הפתקים שמשוך במלואו לחישוב זמנים. מעבר לה הסטטיסטיקה
// מחושבת על הפתקים האחרונים והמסך אומר זאת, במקום למשוך מסד שלם לזיכרון.
const TIMING_ROW_LIMIT = 5000;
// עמוד אחד של רשימת R2. טיוטות הקו נספרות ממנו, וגלישה מסומנת כ"לפחות".
const DRAFT_LIST_LIMIT = 1000;
const RACE_SERIES = 5;
// חלון החריגה, וכמה קולות דרושים לפני שקפיצה נחשבת לאות ולא לרעש.
const ANOMALY_WINDOW = 24 * 3600;
const ANOMALY_MIN_VOTES = 8;
const TASTE_GROUPS = 4;
// מטמון קצר בתוך האיזולייט. מסך השידור מרענן את עצמו, ובלעדיו כל רענון היה
// מריץ את כל השאילתות מחדש ומתחרה בכתיבת הפתקים. בקשה עם ?fresh=1 מדלגת.
const MEMO_SECONDS = 15;
const memo = new Map<string, { at: number; value: Analytics }>();
const heCollator = new Intl.Collator("he");

const num = (value: unknown) => Number(value) || 0;
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const share = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100) : 0);
const HOUR = 3600, DAY = 86400;

function rankList(rows: ItemRow[], totalBallots: number, subtitle?: (row: ItemRow) => string | undefined): RankedItem[] {
  const sorted = [...rows].sort((a, b) => num(b.votes) - num(a.votes) || heCollator.compare(a.title, b.title));
  const votePlaces = competitionPlaces(sorted, (row: ItemRow) => num(row.votes));
  const sitePlaces = competitionPlaces(sorted, (row: ItemRow) => num(row.site));
  const phonePlaces = competitionPlaces(sorted, (row: ItemRow) => num(row.phone));
  return sorted.map((row, index) => {
    const votes = num(row.votes);
    const above = index > 0 ? num(sorted[index - 1].votes) : null;
    const below = index < sorted.length - 1 ? num(sorted[index + 1].votes) : null;
    return {
      id: row.id, title: row.title, subtitle: subtitle?.(row), votes, site: num(row.site), phone: num(row.phone), share: share(votes, totalBallots), place: votePlaces.get(row.id) || index + 1,
      // בלי קולות בערוץ אין מקום בערוץ: אחרת ערוץ ריק לגמרי היה נותן לכולם
      // מקום ראשון, והטבלה הייתה מסמנת "פער בין הערוצים" משום מקום.
      sitePlace: num(row.site) > 0 ? sitePlaces.get(row.id) || 0 : 0,
      phonePlace: num(row.phone) > 0 ? phonePlaces.get(row.id) || 0 : 0,
      gapAbove: above === null ? null : above - votes, gapBelow: below === null ? null : votes - below,
    };
  });
}

// זמר "שייך" לאלבום כששמו מופיע בשדה האמן שלו. ההשוואה היא על קטע קרדיט
// שלם ולא על תת-מחרוזת — "מאיר" אינו "יצחק מאיר" — ומכירה בוו החיבור,
// אחרת כל אלבום דואט ("אייל גולן ואיתי לוי") היה מפספס את השותף.
const normalizeName = (value: string) => value.toLowerCase().replace(/[\u0591-\u05C7]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const CREDIT_SPLIT = /\s*(?:,|&|\||\/|\bעם\b|\bfeat\b|\bft\b)\s*/;
function albumBelongsToArtist(albumArtist: string, artistName: string): boolean {
  const artist = normalizeName(artistName);
  if (artist.length < 2) return false;
  return normalizeName(albumArtist)
    .split(CREDIT_SPLIT)
    .flatMap((part) => part.split(/ (?=ו[\u05d0-\u05ea])/))
    .some((segment) => segment.trim() === artist || segment.trim() === "ו" + artist);
}

/** ריכוזיות: כמה המרוץ סגור. כולל כמה פריטים מחזיקים יחד חצי מהקולות. */
function concentrationOf(rows: ItemRow[]): Concentration {
  const counts = rows.map((row) => num(row.votes)).filter((value) => value > 0).sort((a, b) => b - a);
  const total = counts.reduce((sum, value) => sum + value, 0);
  let running = 0, itemsForHalf = 0;
  for (const value of counts) { running += value; itemsForHalf++; if (running * 2 >= total) break; }
  const leadPercent = counts.length > 1 && counts[1] > 0 ? round(((counts[0] - counts[1]) / counts[1]) * 100) : null;
  return {
    index: concentrationIndex(counts),
    gini: giniCoefficient(counts),
    topFiveShare: share(counts.slice(0, 5).reduce((sum, value) => sum + value, 0), total),
    itemsForHalf: total ? itemsForHalf : 0,
    leadPercent,
  };
}

/** הטיית מיקום: האם פריטים בראש הרשימה מקבלים יותר קולות. */
function positionBiasOf(rows: ItemRow[]): PositionBias {
  const usable = rows.filter((row) => Number.isFinite(Number(row.position)));
  const correlation = pearson(usable.map((row) => num(row.position)), usable.map((row) => num(row.votes)));
  const strength = correlation === null ? 0 : Math.abs(correlation);
  return { correlation, items: usable.length, verdict: correlation === null || strength < 0.25 ? "none" : strength < 0.5 ? "weak" : "clear" };
}

/** קולות מצטברים לפי יום לכל אחד מהפריטים המובילים, למרוץ הדירוג. */
function buildRace(rows: RaceRow[], leaders: ItemRow[], days: number[]): RaceSeries[] {
  const byItem = new Map<string, Map<number, number>>();
  for (const row of rows) {
    // הדלי מגיע כשעת UTC ומקופל כאן ליום מקומי, בדיוק כמו סדרת הימים,
    // אחרת המצטבר מחפש מפתחות שאינם קיימים ונשאר אפס.
    const { dayStart } = israelParts(num(row.bucket));
    const perDay = byItem.get(row.id) || new Map<number, number>();
    perDay.set(dayStart, (perDay.get(dayStart) || 0) + num(row.votes));
    byItem.set(row.id, perDay);
  }
  return leaders.map((item, index) => {
    const perDay = byItem.get(item.id) || new Map<number, number>();
    const points: Array<{ bucket: number; cumulative: number }> = [];
    for (const bucket of days) points.push({ bucket, cumulative: (points[points.length - 1]?.cumulative ?? 0) + (perDay.get(bucket) || 0) });
    return { id: item.id, title: item.title, points, finalPlace: index + 1 };
  });
}

/**
 * קבוצות טעם: אלבומים שנוטים להיבחר יחד מקובצים לפי "הרמה" — כמה יותר
 * הם מופיעים יחד ממה שהיה צפוי במקרה — וכל פתק משויך לקבוצה שבה נמצאים
 * רוב האלבומים שבחר. עונה על השאלה אם מול המצעד עומד קהל אחד או כמה.
 */
function buildTasteGroups(albumSets: string[][], albums: ItemRow[], totalBallots: number): TasteGroup[] {
  const ranked = albums.filter((album) => num(album.votes) > 0).sort((a, b) => num(b.votes) - num(a.votes));
  if (ranked.length < 4 || totalBallots < 20) return [];
  const votesOf = new Map(ranked.map((album) => [album.id, num(album.votes)]));
  const together = new Map<string, number>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const set of albumSets) {
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) together.set(key(set[i], set[j]), (together.get(key(set[i], set[j])) || 0) + 1);
  }
  // הרמה: צפי הוא מכפלת השכיחויות; מעל 1 פירושו שהזוג נבחר יחד יותר מהמקרה.
  const lift = (a: string, b: string) => {
    const expected = ((votesOf.get(a) || 0) * (votesOf.get(b) || 0)) / Math.max(1, totalBallots);
    return expected > 0 ? (together.get(key(a, b)) || 0) / expected : 0;
  };
  // זרעים: האלבום המוביל, ואחריו האלבומים הרחוקים ביותר מהזרעים שכבר נבחרו.
  const seeds: string[] = [ranked[0].id];
  while (seeds.length < Math.min(TASTE_GROUPS, ranked.length)) {
    let best: { id: string; score: number } | null = null;
    for (const album of ranked) {
      if (seeds.includes(album.id)) continue;
      const score = Math.max(...seeds.map((seed) => lift(seed, album.id)));
      if (!best || score < best.score) best = { id: album.id, score };
    }
    if (!best) break;
    seeds.push(best.id);
  }
  const members = new Map<string, string[]>(seeds.map((seed) => [seed, [seed]]));
  for (const album of ranked) {
    if (seeds.includes(album.id)) continue;
    let home = seeds[0], bestLift = -1;
    for (const seed of seeds) { const value = lift(seed, album.id); if (value > bestLift) { bestLift = value; home = seed; } }
    members.get(home)!.push(album.id);
  }
  const titleOf = new Map(albums.map((album) => [album.id, album.title]));
  const counts = new Map<string, number>(seeds.map((seed) => [seed, 0]));
  for (const set of albumSets) {
    let home: string | null = null, bestOverlap = 0;
    for (const seed of seeds) {
      const overlap = set.filter((id) => members.get(seed)!.includes(id)).length;
      if (overlap > bestOverlap) { bestOverlap = overlap; home = seed; }
    }
    if (home) counts.set(home, (counts.get(home) || 0) + 1);
  }
  return seeds.map((seed, index) => {
    const group = members.get(seed)!.slice().sort((a, b) => (votesOf.get(b) || 0) - (votesOf.get(a) || 0));
    const voters = counts.get(seed) || 0;
    return {
      id: seed,
      // התווית היא האלבום המוביל בקבוצה ולא הזרע שממנו היא נבנתה: הזרע הוא
      // פרט טכני, והקורא מזהה את הקבוצה לפי מה שבולט בה.
      label: titleOf.get(group[0]) || titleOf.get(seed) || `קבוצה ${index + 1}`,
      albums: group.map((id) => titleOf.get(id) || ""),
      voters, share: share(voters, totalBallots),
      // הזרע והאלבום שנתן לקבוצה את שמה מוחרגים מהחתימה: הראשון תמיד אפס
      // ("נבחר יחד עם עצמו") והשני היה חוזר על הכותרת.
      signature: group.filter((id) => id !== seed && id !== group[0]).slice(0, 3).map((id) => ({ title: titleOf.get(id) || "", lift: round(lift(seed, id), 2) })),
    };
  }).filter((group) => group.voters > 0).sort((a, b) => b.voters - a.voters);
}

/** חריגה: פריט שחלקו ביממה האחרונה גדול בהרבה מחלקו לאורך הסקר כולו. */
function findAnomalies(kind: Anomaly["kind"], recent: Map<string, number>, items: ItemRow[], recentTotal: number, totalBallots: number): Anomaly[] {
  if (recentTotal < ANOMALY_MIN_VOTES || totalBallots < 40) return [];
  const found: Anomaly[] = [];
  for (const item of items) {
    const count = recent.get(item.id) || 0;
    if (count < ANOMALY_MIN_VOTES) continue;
    const baselineShare = share(num(item.votes) - count, Math.max(1, totalBallots - recentTotal));
    const recentShare = share(count, recentTotal);
    if (baselineShare <= 0) continue;
    const ratio = round(recentShare / baselineShare, 2);
    if (ratio < 2) continue;
    found.push({ kind, id: item.id, title: item.title, recent: count, recentShare, baselineShare, ratio, severity: ratio >= 3 ? "high" : "watch" });
  }
  return found.sort((a, b) => b.ratio - a.ratio).slice(0, 6);
}

export async function buildAnalytics(env: Env, surveyId: string, options: { fresh?: boolean } = {}): Promise<Analytics> {
  const now = Math.floor(Date.now() / 1000);
  const cached = memo.get(surveyId);
  if (!options.fresh && cached && now - cached.at < MEMO_SECONDS) return cached.value;
  const built = await computeAnalytics(env, surveyId, now);
  memo.set(surveyId, { at: now, value: built });
  return built;
}

async function computeAnalytics(env: Env, surveyId: string, now: number): Promise<Analytics> {
  const channelSums = "SUM(CASE WHEN b.channel='site' THEN 1 ELSE 0 END) AS site, SUM(CASE WHEN b.channel='phone' THEN 1 ELSE 0 END) AS phone";
  // שיר נספר לפי פתקים ולא לפי שורות, והחיבור מוגבל לאלבום של השיר עצמו:
  // `song_votes` ייחודי ל-(פתק, אלבום, שיר), ולכן שורה ישנה שנכתבה תחת
  // אלבום זר הייתה מוסיפה לשיר קול נוסף מאותו פתק.
  const songChannelSums = "COUNT(DISTINCT CASE WHEN b.channel='site' THEN v.ballot_id END) AS site, COUNT(DISTINCT CASE WHEN b.channel='phone' THEN v.ballot_id END) AS phone";
  // ORDER BY בתת-השאילתה אינו מבטיח את סדר ה-GROUP_CONCAT בכל גרסת SQLite,
  // ולכן המזהים ממוינים שוב ב-JS לפני שמשווים שילובים.
  const comboSource = "SELECT av.ballot_id AS ballotId, GROUP_CONCAT(av.album_id, ',') AS combo FROM album_votes av JOIN ballots bl ON bl.id=av.ballot_id WHERE bl.survey_id=?1 GROUP BY av.ballot_id";

  const [albums, songs, artists, ballots, artistAlbum, albumPairs, artistPairs, combos, timingRows, stageFlagRows, hourly, blocked] = await env.DB.batch([
    env.DB.prepare(`SELECT a.id, a.title, a.artist_name AS artistName, a.cover_url AS coverUrl, a.position, a.active, COUNT(v.album_id) AS votes, ${channelSums} FROM albums a LEFT JOIN album_votes v ON v.album_id=a.id LEFT JOIN ballots b ON b.id=v.ballot_id AND b.survey_id=?1 WHERE a.survey_id=?1 GROUP BY a.id ORDER BY votes DESC, a.position, a.title`).bind(surveyId),
    env.DB.prepare(`SELECT s.id, s.title, s.album_id AS albumId, a.title AS albumTitle, s.position, s.active, s.audio_url AS audioUrl, s.preview_start AS previewStart, s.preview_end AS previewEnd, a.active AS albumActive, COUNT(DISTINCT v.ballot_id) AS votes, ${songChannelSums} FROM songs s JOIN albums a ON a.id=s.album_id LEFT JOIN song_votes v ON v.song_id=s.id AND v.album_id=s.album_id LEFT JOIN ballots b ON b.id=v.ballot_id AND b.survey_id=?1 WHERE a.survey_id=?1 GROUP BY s.id ORDER BY votes DESC, s.album_id, s.position, s.title`).bind(surveyId),
    env.DB.prepare(`SELECT a.id, a.name AS title, a.image_url AS imageUrl, a.position, a.active, COUNT(v.artist_id) AS votes, ${channelSums} FROM artists a LEFT JOIN artist_votes v ON v.artist_id=a.id LEFT JOIN ballots b ON b.id=v.ballot_id AND b.survey_id=?1 WHERE a.survey_id=?1 GROUP BY a.id ORDER BY votes DESC, a.position, a.name`).bind(surveyId),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN channel='site' THEN 1 ELSE 0 END) AS site, SUM(CASE WHEN channel='phone' THEN 1 ELSE 0 END) AS phone, MIN(created_at) AS firstAt, MAX(created_at) AS lastAt FROM ballots WHERE survey_id=?1").bind(surveyId),
    env.DB.prepare("SELECT av.artist_id AS a, alv.album_id AS b, COUNT(*) AS votes FROM artist_votes av JOIN ballots bl ON bl.id=av.ballot_id JOIN album_votes alv ON alv.ballot_id=av.ballot_id WHERE bl.survey_id=?1 GROUP BY av.artist_id, alv.album_id").bind(surveyId),
    env.DB.prepare("SELECT x.album_id AS a, y.album_id AS b, COUNT(*) AS votes FROM album_votes x JOIN album_votes y ON y.ballot_id=x.ballot_id AND y.album_id>x.album_id JOIN ballots bl ON bl.id=x.ballot_id WHERE bl.survey_id=?1 GROUP BY x.album_id, y.album_id").bind(surveyId),
    env.DB.prepare("SELECT x.artist_id AS a, y.artist_id AS b, COUNT(*) AS votes FROM artist_votes x JOIN artist_votes y ON y.ballot_id=x.ballot_id AND y.artist_id>x.artist_id JOIN ballots bl ON bl.id=x.ballot_id WHERE bl.survey_id=?1 GROUP BY x.artist_id, y.artist_id ORDER BY votes DESC LIMIT 20").bind(surveyId),
    env.DB.prepare(`SELECT combo FROM (${comboSource})`).bind(surveyId),
    // החותמות מוחזרות כמות שהן והחיסור נעשה ב-JS, כי רק שם ידוע אילו שלבים
    // פעילים בסקר. COALESCE בין שלבים היה גורם לשלב אחד לבלוע שלב חסר.
    env.DB.prepare(`SELECT channel, created_at AS createdAt, started_at AS startedAt, albums_done_at AS albumsDoneAt, songs_done_at AS songsDoneAt, artists_done_at AS artistsDoneAt, sessions FROM ballots WHERE survey_id=?1 AND started_at IS NOT NULL ORDER BY created_at DESC LIMIT ${TIMING_ROW_LIMIT}`).bind(surveyId),
    env.DB.prepare("SELECT albums_enabled AS albums, songs_enabled AS songs, artists_enabled AS artists FROM poll_settings WHERE id=?1").bind(surveyId),
    env.DB.prepare("SELECT CAST(created_at/3600 AS INTEGER)*3600 AS bucket, channel, COUNT(*) AS votes FROM ballots WHERE survey_id=?1 GROUP BY bucket, channel ORDER BY bucket").bind(surveyId),
    env.DB.prepare("SELECT bf.fingerprint, bf.blocked_by AS blockedBy, bf.created_at AS createdAt, COUNT(b.id) AS ballots, MAX(b.created_at) AS lastBallotAt FROM blocked_fingerprints bf LEFT JOIN ballots b ON b.survey_id=bf.survey_id AND b.fingerprint=bf.fingerprint WHERE bf.survey_id=?1 GROUP BY bf.fingerprint, bf.blocked_by, bf.created_at ORDER BY bf.created_at DESC LIMIT 200").bind(surveyId),
  ]);

  const albumRows = albums.results as ItemRow[], songRows = songs.results as SongRow[], artistRows = artists.results as ItemRow[];
  const topOf = (rows: ItemRow[]) => rows.filter((row) => num(row.votes) > 0).sort((a, b) => num(b.votes) - num(a.votes)).slice(0, RACE_SERIES);
  const albumLeaders = topOf(albumRows), artistLeaders = topOf(artistRows);
  const raceStatement = (table: string, column: string, leaders: ItemRow[]) => env.DB
    .prepare(`SELECT v.${column} AS id, CAST(b.created_at/3600 AS INTEGER)*3600 AS bucket, COUNT(*) AS votes FROM ${table} v JOIN ballots b ON b.id=v.ballot_id WHERE b.survey_id=? AND v.${column} IN (${placeholders(leaders.length)}) GROUP BY v.${column}, bucket`)
    .bind(surveyId, ...leaders.map((item) => item.id));
  const emptyStatement = env.DB.prepare("SELECT NULL AS id, 0 AS bucket, 0 AS votes WHERE 0");

  const [albumRace, artistRace, drafts, returningRow, surveyTotals, subscriberRows, dropoff, recentAlbums, recentArtists, draftPicks] = await env.DB.batch([
    albumLeaders.length ? raceStatement("album_votes", "album_id", albumLeaders) : emptyStatement,
    artistLeaders.length ? raceStatement("artist_votes", "artist_id", artistLeaders) : emptyStatement,
    // ההתקדמות נמחקת כששולחים את הפתק, ולכן שורה שנשארה היא באמת נטושה.
    env.DB.prepare("SELECT COALESCE(json_extract(data_json,'$.stageIndex'),0) AS stage, COUNT(*) AS total, MIN(updated_at) AS oldestAt, MAX(updated_at) AS newestAt FROM site_ballot_progress WHERE survey_id=?1 GROUP BY stage ORDER BY stage").bind(surveyId),
    env.DB.prepare("SELECT COUNT(*) AS total FROM ballots b WHERE b.survey_id=?1 AND EXISTS (SELECT 1 FROM ballots o WHERE o.voter_key=b.voter_key AND o.survey_id<>?1)").bind(surveyId),
    env.DB.prepare("SELECT s.id, s.name, COUNT(b.id) AS total, MIN(b.created_at) AS firstAt FROM surveys s LEFT JOIN ballots b ON b.survey_id=s.id GROUP BY s.id ORDER BY firstAt"),
    // ההרשמה לרשימה נעשית תמיד מתוך חשבון Google מחובר, ולכן user_sub הוא
    // הקישור המהימן; כתובת דואר נשמרת בפתק רק בערוץ האתר.
    env.DB.prepare("SELECT (SELECT COUNT(*) FROM subscribers WHERE unsubscribed_at IS NULL) AS total, (SELECT COUNT(DISTINCT b.voter_key) FROM ballots b JOIN subscribers s ON s.user_sub=b.voter_key WHERE b.survey_id=?1 AND b.channel='site' AND s.unsubscribed_at IS NULL) AS fromSurvey").bind(surveyId),
    env.DB.prepare("SELECT v.album_id AS id, COUNT(*) AS withoutSong FROM album_votes v JOIN ballots b ON b.id=v.ballot_id LEFT JOIN song_votes sv ON sv.ballot_id=v.ballot_id AND sv.album_id=v.album_id WHERE b.survey_id=?1 AND sv.song_id IS NULL GROUP BY v.album_id").bind(surveyId),
    env.DB.prepare("SELECT v.album_id AS id, COUNT(*) AS votes FROM album_votes v JOIN ballots b ON b.id=v.ballot_id WHERE b.survey_id=?1 AND b.created_at >= ?2 GROUP BY v.album_id").bind(surveyId, now - ANOMALY_WINDOW),
    env.DB.prepare("SELECT v.artist_id AS id, COUNT(*) AS votes FROM artist_votes v JOIN ballots b ON b.id=v.ballot_id WHERE b.survey_id=?1 AND b.created_at >= ?2 GROUP BY v.artist_id").bind(surveyId, now - ANOMALY_WINDOW),
    // מה בחרו מי שפתחו טיוטה ולא שלחו: התוכן יושב ב-data_json ולא נקרא עד היום.
    env.DB.prepare("SELECT picks.value AS id, COUNT(*) AS drafts FROM site_ballot_progress p, json_each(json_extract(p.data_json,'$.albumIds')) AS picks WHERE p.survey_id=?1 GROUP BY picks.value").bind(surveyId),
  ]);

  // יומן הקו והקריינויות יושבים בטבלאות שנוצרות בעצלתיים. הן נשאלות בנפרד
  // ובנסיעה שנתפסת, כדי שמסד חדש יראה מסך מלא ובו רק החלק הזה ריק.
  const optional = await env.DB.batch([
    env.DB.prepare("SELECT id, phone, action, target, status, created_at AS createdAt FROM ivr_admin_audit ORDER BY created_at DESC LIMIT 60"),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed FROM ivr_admin_audit WHERE created_at >= unixepoch() - 30*86400"),
    // אותו תנאי שקטלוג הקו משתמש בו: הקלטה שלא הסתנכרנה לימות המשיח אינה
    // מושמעת, ולכן היא חסרה גם כאן ולא "קיימת".
    env.DB.prepare("SELECT key FROM ivr_prompts WHERE yemot_path IS NOT NULL AND yemot_path != ''"),
  ]).catch((error) => { console.error("optional analytics tables unavailable", error); return null; });
  const audit = optional?.[0] ?? { results: [] };
  const auditTotalsRows = optional?.[1] ?? { results: [] };
  const promptKeyRows = optional?.[2] ?? { results: [] };

  const totals = ballots.results[0] as { total: number; site: number; phone: number; firstAt: number | null; lastAt: number | null } | undefined;
  const totalBallots = num(totals?.total);
  const albumTitle = new Map(albumRows.map((row) => [row.id, row.title]));
  const artistTitle = new Map(artistRows.map((row) => [row.id, row.title]));
  const artistVotesById = new Map(artistRows.map((row) => [row.id, num(row.votes)]));

  // פירוט השירים בכל אלבום והשיר המוביל בו. "ריכוזיות" היא חלקו של השיר
  // המוביל מכלל קולות השירים באלבום: קרוב ל-100 כשהשיר לוקח הכול.
  const songsByAlbum = new Map<string, SongRow[]>();
  for (const song of songRows) { const list = songsByAlbum.get(String(song.albumId)) || []; list.push(song); songsByAlbum.set(String(song.albumId), list); }
  const albumBreakdown: AlbumBreakdown[] = albumRows.map((album) => {
    const list = (songsByAlbum.get(album.id) || []).slice().sort((a, b) => num(b.votes) - num(a.votes) || heCollator.compare(a.title, b.title));
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

  // הצלבת זמר–אלבום, וגם האלבומים של הזמר עצמו לפי שם האמן באלבום.
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

  const companions = new Map<string, Array<{ id: string; votes: number }>>();
  for (const row of albumPairs.results as PairRow[]) {
    for (const [from, to] of [[row.a, row.b], [row.b, row.a]] as const) { const list = companions.get(from) || []; list.push({ id: to, votes: num(row.votes) }); companions.set(from, list); }
  }
  const albumCompanions = albumRows.filter((album) => num(album.votes) > 0).map((album) => ({
    id: album.id, title: album.title, votes: num(album.votes),
    top: (companions.get(album.id) || []).sort((a, b) => b.votes - a.votes).slice(0, 5).map((item) => ({ id: item.id, title: albumTitle.get(item.id) || "", votes: item.votes, share: share(item.votes, num(album.votes)) })),
  }));

  const artistPairList = (artistPairs.results as PairRow[]).map((row) => ({ a: artistTitle.get(row.a) || "", b: artistTitle.get(row.b) || "", votes: num(row.votes), shareOfA: share(num(row.votes), artistVotesById.get(row.a) || 0), shareOfB: share(num(row.votes), artistVotesById.get(row.b) || 0) }));

  // שילובי אלבומים: המזהים ממוינים כאן ולא ב-SQL, כדי ששני פתקים עם אותה
  // חמישייה בסדר אחר ייספרו כשילוב אחד.
  const comboCounts = new Map<string, number>();
  const albumSets: string[][] = [];
  for (const row of combos.results as Array<{ combo: string | null }>) {
    const ids = String(row.combo || "").split(",").map((id) => id.trim()).filter(Boolean).sort();
    if (!ids.length) continue;
    albumSets.push(ids);
    const key = ids.join(",");
    comboCounts.set(key, (comboCounts.get(key) || 0) + 1);
  }
  // רק שילוב שיש לו לפחות תאום אחד: הכותרת מבטיחה "חוזרים על עצמם", ובסקר
  // שבו כל פתק ייחודי הרשימה צריכה להיות ריקה ולא מלאה בשילובים בודדים.
  const comboList = [...comboCounts.entries()].filter(([, votes]) => votes > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)
    .map(([key, votes]) => ({ albums: key.split(",").map((id) => albumTitle.get(id) || "אלבום שנמחק"), votes, share: share(votes, totalBallots) }));
  const repeatedBallots = [...comboCounts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);

  // זמני הצבעה. שלב "אישור" הוא מסיום השלב האחרון שנמדד ועד שמירת הפתק.
  const flagRow = stageFlagRows.results[0] as { albums: number; songs: number; artists: number } | undefined;
  const stageFlags: StageFlags = { albums: flagRow ? !!num(flagRow.albums) : true, songs: flagRow ? !!num(flagRow.songs) : true, artists: flagRow ? !!num(flagRow.artists) : true };
  const timing = buildTiming(timingRows.results as TimingRow[], totalBallots, stageFlags);

  // שעות ההצבעה: הדלי הוא שעת UTC, והשעה המקומית נגזרת ממנו בשעון ישראל,
  // כולל מעברי שעון קיץ. כך אין צורך למשוך פתק־פתק.
  const hourRows = hourly.results as HourRow[];
  const { daily, activity, pace, peakHour } = buildTime(hourRows, now);

  const raceDays = daily.map((point) => point.bucket);
  const race = {
    albums: buildRace(albumRace.results as RaceRow[], albumLeaders, raceDays),
    artists: buildRace(artistRace.results as RaceRow[], artistLeaders, raceDays),
  };

  const concentration = { albums: concentrationOf(albumRows), artists: concentrationOf(artistRows), songs: concentrationOf(songRows) };
  const positionBias = { albums: positionBiasOf(albumRows), artists: positionBiasOf(artistRows), songs: positionBiasOf(songRows) };

  // stageIndex הוא מיקום ברשימת השלבים הפעילים שהאתר בונה, לא מספר קבוע:
  // עם שלב כבוי, רשימה קבועה הייתה מדביקה לטיוטה את שם השלב הקודם.
  const stageLabels = [stageFlags.albums && "בחירת אלבומים", stageFlags.songs && "בחירת שירים", stageFlags.artists && "בחירת זמרים", "אישור ההצבעה"].filter(Boolean) as string[];
  const siteDrafts: AbandonedStage[] = (drafts.results as Array<{ stage: number; total: number; oldestAt: number; newestAt: number }>).map((row) => ({
    stage: num(row.stage), label: stageLabels[num(row.stage)] || `שלב ${num(row.stage) + 1}`, count: num(row.total), oldestAt: row.oldestAt ?? null, newestAt: row.newestAt ?? null,
  }));
  const siteDraftTotal = siteDrafts.reduce((sum, row) => sum + row.count, 0);
  const phoneDrafts = await countPhoneDrafts(env, surveyId);
  const startedTotal = totalBallots + siteDraftTotal + phoneDrafts.count;
  const abandoned = {
    site: siteDrafts, siteTotal: siteDraftTotal, phoneTotal: phoneDrafts.count, phoneTruncated: phoneDrafts.truncated,
    completionRate: startedTotal ? share(totalBallots, startedTotal) : null,
  };

  const surveyRows = (surveyTotals.results as Array<{ id: string; name: string; total: number; firstAt: number | null }>)
    .map((row) => ({ id: row.id, name: String(row.name || ""), total: num(row.total), firstAt: row.firstAt ?? null, atSameElapsed: null as number | null }));
  const current = surveyRows.find((row) => row.id === surveyId) ?? null;
  const previous = await comparePreviousSurvey(env, surveyRows, current, totals?.firstAt ?? null, now);

  const subscriberRow = subscriberRows.results[0] as { total: number; fromSurvey: number } | undefined;
  const siteBallots = num(totals?.site);

  const dropoffById = new Map((dropoff.results as Array<{ id: string; withoutSong: number }>).map((row) => [row.id, num(row.withoutSong)]));
  const stageDropoff = albumRows
    .map((album) => ({ id: album.id, title: album.title, albumVotes: num(album.votes), withoutSong: dropoffById.get(album.id) || 0, share: share(dropoffById.get(album.id) || 0, num(album.votes)) }))
    .filter((row) => row.withoutSong > 0)
    .sort((a, b) => b.share - a.share || b.withoutSong - a.withoutSong);

  // הפתק שמייצג את הקהל: הנבחרים בכל שלב, ובכמה פתקים הם מופיעים יחד.
  const settingsMax = { albums: albumLeaders.length ? 5 : 0, artists: 3 };
  const compositeAlbums = rankedAlbums.filter((item) => item.votes > 0).slice(0, settingsMax.albums).map((item) => {
    const album = albumBreakdown.find((row) => row.id === item.id);
    const source = albumRows.find((row) => row.id === item.id);
    return { id: item.id, title: item.title, artistName: String(source?.artistName || ""), coverUrl: source?.coverUrl ?? null, votes: item.votes, share: item.share, song: album?.topSong ?? null };
  });
  const compositeAlbumIds = compositeAlbums.map((item) => item.id);
  const composite: CompositeBallot = {
    albums: compositeAlbums,
    artists: rankedArtists.filter((item) => item.votes > 0).slice(0, settingsMax.artists).map((item) => ({ id: item.id, title: item.title, votes: item.votes, share: item.share })),
    matching: compositeAlbumIds.length ? albumSets.filter((set) => compositeAlbumIds.every((id) => set.includes(id))).length : 0,
  };

  const tasteGroups = buildTasteGroups(albumSets, albumRows, totalBallots);

  const recentAlbumMap = new Map((recentAlbums.results as Array<{ id: string; votes: number }>).map((row) => [row.id, num(row.votes)]));
  const recentArtistMap = new Map((recentArtists.results as Array<{ id: string; votes: number }>).map((row) => [row.id, num(row.votes)]));
  const recentBallots = hourRows.reduce((sum, row) => (num(row.bucket) >= now - ANOMALY_WINDOW ? sum + num(row.votes) : sum), 0);
  const anomalies = [
    ...findAnomalies("album", recentAlbumMap, albumRows, recentBallots, totalBallots),
    ...findAnomalies("artist", recentArtistMap, artistRows, recentBallots, totalBallots),
  ].sort((a, b) => b.ratio - a.ratio);

  const abandonedPicks = (draftPicks.results as Array<{ id: string; drafts: number }>)
    .map((row) => {
      const album = albumRows.find((item) => item.id === row.id);
      return { id: row.id, title: album?.title || "", drafts: num(row.drafts), share: share(num(row.drafts), siteDraftTotal), finishedShare: share(num(album?.votes), totalBallots) };
    })
    .filter((row) => row.title)
    .sort((a, b) => b.drafts - a.drafts);

  // מצב התוכן: מה חסר כדי שהאתר והקו יהיו שלמים.
  const promptKeys = new Set((promptKeyRows.results as Array<{ key: string }>).map((row) => row.key));
  // פריט מוסתר אינו מוצג באתר ואינו מושמע בקו, ולכן אינו יכול להפוך את
  // התוכן ללא שלם. בלי הסינון הזה פריט ישן שהוסתר היה משאיר את המסך אדום
  // לנצח. המספר הכולל של המוסתרים נשאר מוצג בנפרד.
  const liveAlbums = albumRows.filter((row) => num(row.active));
  const liveArtists = artistRows.filter((row) => num(row.active));
  const liveSongs = songRows.filter((row) => num(row.active) && num(row.albumActive));
  const content = {
    songsWithoutAudio: liveSongs.filter((row) => !row.audioUrl).map((row) => ({ id: row.id, title: row.title, subtitle: row.albumTitle })),
    songsWithoutPreview: liveSongs.filter((row) => row.audioUrl && num(row.previewEnd) <= num(row.previewStart)).map((row) => ({ id: row.id, title: row.title, subtitle: row.albumTitle })),
    albumsWithoutCover: liveAlbums.filter((row) => !row.coverUrl).map((row) => ({ id: row.id, title: row.title, subtitle: row.artistName })),
    artistsWithoutImage: liveArtists.filter((row) => !row.imageUrl).map((row) => ({ id: row.id, title: row.title })),
    missingPrompts: [
      ...liveAlbums.filter((row) => !promptKeys.has(`album:${row.id}`)).map((row) => ({ id: row.id, title: row.title, subtitle: "אלבום" })),
      ...liveArtists.filter((row) => !promptKeys.has(`artist:${row.id}`)).map((row) => ({ id: row.id, title: row.title, subtitle: "זמר" })),
      ...liveSongs.filter((row) => !promptKeys.has(`song:${row.id}`)).map((row) => ({ id: row.id, title: row.title, subtitle: `שיר · ${row.albumTitle || ""}` })),
    ],
    inactive: { albums: albumRows.filter((row) => !num(row.active)).length, songs: songRows.filter((row) => !num(row.active)).length, artists: artistRows.filter((row) => !num(row.active)).length },
  };

  const auditTotals = auditTotalsRows.results[0] as { total: number; failed: number } | undefined;
  const peakDay = daily.reduce<DailyPoint | null>((best, point) => (!best || point.total > best.total ? point : best), null);

  return {
    generatedAt: now,
    totals: { ballots: totalBallots, site: siteBallots, phone: num(totals?.phone), firstAt: totals?.firstAt ?? null, lastAt: totals?.lastAt ?? null, albums: albumRows.length, songs: songRows.length, artists: artistRows.length },
    rankings: { albums: rankedAlbums, songs: rankedSongs, artists: rankedArtists },
    albumBreakdown,
    zeroVotes,
    artistAlbums,
    albumCompanions,
    artistPairs: artistPairList,
    combos: { top: comboList, distinct: comboCounts.size, repeated: repeatedBallots },
    timing,
    daily: { series: daily, peak: peakDay, peakHour },
    activity,
    pace,
    race,
    concentration,
    positionBias,
    abandoned,
    returning: {
      voters: num((returningRow.results[0] as { total: number } | undefined)?.total),
      share: share(num((returningRow.results[0] as { total: number } | undefined)?.total), totalBallots),
      surveys: surveyRows.filter((row) => row.total > 0),
      previous,
    },
    subscribers: { total: num(subscriberRow?.total), fromThisSurvey: num(subscriberRow?.fromSurvey), share: share(num(subscriberRow?.fromSurvey), siteBallots) },
    stageDropoff,
    composite,
    tasteGroups,
    anomalies,
    abandonedPicks,
    blocked: (blocked.results as Array<{ fingerprint: string; blockedBy: string; createdAt: number; ballots: number; lastBallotAt: number | null }>).map((row) => ({ ...row, ballots: num(row.ballots) })),
    audit: { recent: audit.results as Analytics["audit"]["recent"], last30Days: { total: num(auditTotals?.total), failed: num(auditTotals?.failed) } },
    content,
  };
}

function buildTiming(rows: TimingRow[], totalBallots: number, flags: StageFlags): Analytics["timing"] {
  const at = (value: number | null | undefined) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  // משך שלב נמדד רק כשגם נקודת ההתחלה שלו וגם נקודת הסיום קיימות. שלב
  // כבוי בסקר מדלג לשלב שלפניו, ושלב חסר מחזיר null במקום להיבלע בשלב הבא.
  const previousStamp = (row: TimingRow, stage: "songs" | "artists" | "confirm") => {
    if (stage === "songs") return flags.albums ? at(row.albumsDoneAt) : at(row.startedAt);
    const beforeArtists = flags.songs ? at(row.songsDoneAt) : flags.albums ? at(row.albumsDoneAt) : at(row.startedAt);
    if (stage === "artists") return beforeArtists;
    return flags.artists ? at(row.artistsDoneAt) : beforeArtists;
  };
  const delta = (from: number | null, to: number | null) => (from !== null && to !== null && to >= from ? to - from : null);
  const durationOf = (row: TimingRow) => Math.max(0, num(row.createdAt) - num(row.startedAt));
  const kept = (values: Array<number | null>) => values.filter((value): value is number => value !== null);
  const byChannel = (channel: Channel | "all") => rows.filter((row) => channel === "all" || row.channel === channel);
  const stageDurations = (list: TimingRow[]): StageDurations => ({
    albums: summarize(kept(list.map((row) => (flags.albums ? delta(at(row.startedAt), at(row.albumsDoneAt)) : null)))),
    songs: summarize(kept(list.map((row) => (flags.songs ? delta(previousStamp(row, "songs"), at(row.songsDoneAt)) : null)))),
    artists: summarize(kept(list.map((row) => (flags.artists ? delta(previousStamp(row, "artists"), at(row.artistsDoneAt)) : null)))),
    summary: summarize(kept(list.map((row) => delta(previousStamp(row, "confirm"), at(row.createdAt))))),
  });
  // הדליים סוגרים כל משך בדיוק פעם אחת, כולל משך אפס.
  const bucketsSpec = [{ label: "עד דקה", max: 60 }, { label: "1–3 דקות", max: 180 }, { label: "3–5 דקות", max: 300 }, { label: "5–10 דקות", max: 600 }, { label: "10–30 דקות", max: 1800 }, { label: "יותר מחצי שעה", max: Infinity }];
  const distribution = (durations: number[]) => {
    return bucketsSpec.map((bucket, index) => {
      const min = index ? bucketsSpec[index - 1].max : -Infinity;
      const count = durations.filter((value) => value > min && value <= bucket.max).length;
      return { label: bucket.label, count, share: share(count, durations.length) };
    });
  };
  const sessionsHistogram = (list: TimingRow[]) => {
    const known = list.map((row) => Number(row.sessions)).filter((value) => Number.isFinite(value) && value >= 1);
    return [{ label: "ביקור אחד", test: (n: number) => n === 1 }, { label: "שני ביקורים", test: (n: number) => n === 2 }, { label: "שלושה ומעלה", test: (n: number) => n >= 3 }]
      .map((item) => { const count = known.filter(item.test).length; return { label: item.label, count, share: share(count, known.length) }; });
  };
  const timingFor = (channel: Channel | "all") => {
    const list = byChannel(channel);
    // אוכלוסייה אחת לכל שלושת החישובים, אחרת האחוזים אינם מסתכמים למה שנספר.
    const durations = list.map(durationOf);
    const overall = summarize(durations);
    return { overall, stages: stageDurations(list), distribution: distribution(durations), sessions: sessionsHistogram(list), fastest: overall.min, slowest: overall.max };
  };
  // מעבר לתקרה הסטטיסטיקה מתארת את הפתקים האחרונים, והמסך אומר זאת במקום
  // להציג ממוצע שנראה כאילו הוא של כל הסקר.
  const sampled = rows.length >= TIMING_ROW_LIMIT;
  return { all: timingFor("all"), site: timingFor("site"), phone: timingFor("phone"), untracked: sampled ? 0 : Math.max(0, totalBallots - rows.length), sampled, sampleSize: rows.length };
}

function buildTime(hourRows: HourRow[], now: number) {
  const cells = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const siteCells = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const phoneCells = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const dayMap = new Map<number, DailyPoint>();
  let max = 0, peakHour: { weekday: number; hour: number; votes: number } | null = null;

  for (const row of hourRows) {
    const votes = num(row.votes);
    const { hour, weekday, dayStart } = israelParts(num(row.bucket));
    const channel: Channel = row.channel === "phone" ? "phone" : "site";
    cells[weekday][hour] += votes;
    (channel === "phone" ? phoneCells : siteCells)[weekday][hour] += votes;
    if (cells[weekday][hour] > max) { max = cells[weekday][hour]; peakHour = { weekday, hour, votes: cells[weekday][hour] }; }
    const point = dayMap.get(dayStart) || { bucket: dayStart, site: 0, phone: 0, total: 0, cumulative: 0 };
    point[channel] += votes; point.total += votes; dayMap.set(dayStart, point);
  }
  const observed = [...dayMap.values()].sort((a, b) => a.bucket - b.bucket);
  // הגרפים ממקמים לפי מיקום ברשימה, ולכן יום בלי הצבעות חייב להופיע כשורה
  // של אפסים; בלעדיו שבוע שקט נדחס לרוחב של יום ומשנה את שיפוע הקו המצטבר.
  const daily: DailyPoint[] = [];
  for (const point of observed) {
    const previous = daily[daily.length - 1];
    if (previous) {
      const missing = Math.min(400, Math.round((point.bucket - previous.bucket) / DAY) - 1);
      for (let step = 1; step <= missing; step++) daily.push({ bucket: previous.bucket + step * DAY, site: 0, phone: 0, total: 0, cumulative: 0 });
    }
    daily.push(point);
  }
  let running = 0;
  for (const point of daily) { running += point.total; point.cumulative = running; }

  const windowVotes = (from: number, to: number) => hourRows.reduce((sum, row) => {
    const bucket = num(row.bucket);
    if (bucket < from || bucket >= to) return sum;
    return { total: sum.total + num(row.votes), site: sum.site + (row.channel === "site" ? num(row.votes) : 0), phone: sum.phone + (row.channel === "phone" ? num(row.votes) : 0) };
  }, { total: 0, site: 0, phone: 0 });
  // הדלי הוא שעה שלמה, ולכן החלון מיושר לתחילת השעה הנוכחית ולא לרגע הזה.
  const currentHour = Math.floor(now / HOUR) * HOUR;
  const windows: PaceWindow[] = [
    { label: "השעה האחרונה", seconds: HOUR },
    { label: "24 השעות האחרונות", seconds: DAY },
    { label: "שבעת הימים האחרונים", seconds: 7 * DAY },
  ].map((spec) => {
    const to = currentHour + HOUR, from = to - spec.seconds;
    const current = windowVotes(from, to), earlier = windowVotes(from - spec.seconds, from);
    return {
      label: spec.label, seconds: spec.seconds, votes: current.total, site: current.site, phone: current.phone,
      previous: earlier.total, changePercent: earlier.total > 0 ? round(((current.total - earlier.total) / earlier.total) * 100) : null,
    };
  });
  // reduce ולא spread: מערך ארוך מאוד מפיל קריאה עם spread על מחסנית הקריאות.
  const lastBucket = hourRows.length ? hourRows.reduce((best, row) => Math.max(best, num(row.bucket)), 0) : null;
  const perDay = daily.length ? Math.round(daily.reduce((sum, point) => sum + point.total, 0) / daily.length) : 0;
  return {
    daily,
    activity: { cells, site: siteCells, phone: phoneCells, max },
    pace: { windows, perDay, quietHours: lastBucket === null ? null : Math.max(0, Math.floor((now - lastBucket - HOUR) / HOUR)) },
    peakHour,
  };
}

/** טיוטות הקו יושבות ב-R2, לא ב-D1. עמוד אחד מספיק כדי לדעת סדר גודל. */
async function countPhoneDrafts(env: Env, surveyId: string): Promise<{ count: number; truncated: boolean }> {
  try {
    const listed = await env.MEDIA.list({ prefix: `ivr-progress/${surveyId}/`, limit: DRAFT_LIST_LIMIT });
    return { count: listed.objects.length, truncated: Boolean((listed as { truncated?: boolean }).truncated) };
  } catch (error) {
    console.error("phone draft count failed", error);
    return { count: 0, truncated: false };
  }
}

/**
 * הסקר הקודם שהיו בו הצבעות, וכמה הצבעות היו לו באותה נקודת זמן מתחילתו.
 * בלי היישור הזה ההשוואה היא בין סקר שרץ שבוע לסקר שרץ חודש.
 */
async function comparePreviousSurvey(env: Env, surveys: SurveyComparison[], current: SurveyComparison | null, currentFirstAt: number | null, now: number): Promise<SurveyComparison | null> {
  if (!current || currentFirstAt === null) return null;
  const earlier = surveys.filter((row) => row.id !== current.id && row.total > 0 && row.firstAt !== null && row.firstAt < currentFirstAt);
  const previous = earlier.sort((a, b) => Number(b.firstAt) - Number(a.firstAt))[0];
  if (!previous) return null;
  const elapsed = Math.max(0, now - currentFirstAt);
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM ballots WHERE survey_id=?1 AND created_at <= ?2")
      .bind(previous.id, Number(previous.firstAt) + elapsed).first<{ total: number }>();
    return { ...previous, atSameElapsed: num(row?.total) };
  } catch (error) {
    console.error("previous survey comparison failed", error);
    return { ...previous, atSameElapsed: null };
  }
}

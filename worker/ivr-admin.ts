import { readIvrPrompts, readIvrRecorders, saveIvrPrompts, saveIvrRecorders } from "./ivr-prompts";
import { normalizePhone } from "./phone";

type IvrAdminEnv = { DB: D1Database; MEDIA: R2Bucket };
type Settings = {
  votingOpen: number;
  albumsEnabled: number;
  albumsMin: number;
  albumsMax: number;
  songsEnabled: number;
  songsMin: number;
  songsMax: number;
  artistsEnabled: number;
  artistsMin: number;
  artistsMax: number;
};

type ActionBody = {
  phone?: string;
  action?: string;
  value?: boolean;
  id?: string;
  kind?: "album" | "song" | "artist";
  stage?: "albums" | "songs" | "artists";
  min?: number;
  max?: number;
  key?: string;
  targetPhone?: string;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const DEFAULT_SETTINGS: Settings = {
  votingOpen: 0,
  albumsEnabled: 1,
  albumsMin: 5,
  albumsMax: 5,
  songsEnabled: 1,
  songsMin: 1,
  songsMax: 1,
  artistsEnabled: 1,
  artistsMin: 1,
  artistsMax: 3,
};

async function activeSurvey(env: IvrAdminEnv): Promise<{ id: string; name: string }> {
  const current = await env.DB.prepare("SELECT id,name FROM surveys WHERE active=1 ORDER BY created_at DESC LIMIT 1").first<{ id: string; name: string }>();
  if (current) return current;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO surveys (id,name,active) VALUES ('main','הסקר הראשי',1)"),
    env.DB.prepare("INSERT OR IGNORE INTO poll_settings (id) VALUES ('main')"),
  ]);
  return { id: "main", name: "הסקר הראשי" };
}

async function readSettings(env: IvrAdminEnv, surveyId: string): Promise<Settings> {
  return await env.DB.prepare(
    "SELECT voting_open AS votingOpen,albums_enabled AS albumsEnabled,albums_min AS albumsMin,albums_max AS albumsMax,songs_enabled AS songsEnabled,songs_min AS songsMin,songs_max AS songsMax,artists_enabled AS artistsEnabled,artists_min AS artistsMin,artists_max AS artistsMax FROM poll_settings WHERE id=?",
  ).bind(surveyId).first<Settings>() ?? DEFAULT_SETTINGS;
}

async function readiness(env: IvrAdminEnv, surveyId: string, settings: Settings) {
  const [albums, songs, artists] = await env.DB.batch([
    env.DB.prepare("SELECT id,title FROM albums WHERE active=1 AND survey_id=?").bind(surveyId),
    env.DB.prepare("SELECT s.album_id AS albumId,COUNT(*) AS total FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.active=1 AND a.active=1 AND a.survey_id=? GROUP BY s.album_id").bind(surveyId),
    env.DB.prepare("SELECT COUNT(*) AS total FROM artists WHERE active=1 AND survey_id=?").bind(surveyId),
  ]);
  const songCounts = new Map(songs.results.map((row) => [String(row.albumId), Number(row.total || 0)]));
  const missingSongs = settings.songsEnabled
    ? albums.results.filter((album) => (songCounts.get(String(album.id)) || 0) < settings.songsMin).length
    : 0;
  const artistCount = Number(artists.results[0]?.total || 0);
  const warnings: string[] = [];
  if (settings.albumsEnabled && albums.results.length < settings.albumsMin) warnings.push(`צריך לפחות ${settings.albumsMin} אלבומים פעילים`);
  if (settings.songsEnabled && missingSongs) warnings.push(`${missingSongs} אלבומים בלי מספיק שירים פעילים`);
  if (settings.artistsEnabled && artistCount < settings.artistsMin) warnings.push(`צריך לפחות ${settings.artistsMin} זמרים פעילים`);
  return {
    ready: warnings.length === 0,
    warnings,
    counts: {
      albums: albums.results.length,
      songs: songs.results.reduce((sum, row) => sum + Number(row.total || 0), 0),
      artists: artistCount,
    },
  };
}

function validateSettings(settings: Settings): string {
  const stages = [
    [settings.albumsEnabled, settings.albumsMin, settings.albumsMax],
    [settings.songsEnabled, settings.songsMin, settings.songsMax],
    [settings.artistsEnabled, settings.artistsMin, settings.artistsMax],
  ];
  if (!settings.albumsEnabled && !settings.songsEnabled && !settings.artistsEnabled) return "צריך להשאיר לפחות שלב הצבעה אחד פעיל.";
  if (settings.songsEnabled && !settings.albumsEnabled) return "אי אפשר להפעיל בחירת שירים בלי בחירת אלבומים.";
  if (stages.some(([enabled, min, max]) => enabled && (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 50))) return "כמויות הבחירה אינן תקינות.";
  return "";
}

async function saveSettings(env: IvrAdminEnv, surveyId: string, settings: Settings): Promise<void> {
  await env.DB.prepare(
    "UPDATE poll_settings SET voting_open=?,albums_enabled=?,albums_min=?,albums_max=?,songs_enabled=?,songs_min=?,songs_max=?,artists_enabled=?,artists_min=?,artists_max=? WHERE id=?",
  ).bind(
    settings.votingOpen,
    settings.albumsEnabled,
    settings.albumsMin,
    settings.albumsMax,
    settings.songsEnabled,
    settings.songsMin,
    settings.songsMax,
    settings.artistsEnabled,
    settings.artistsMin,
    settings.artistsMax,
    surveyId,
  ).run();
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function requireRecorder(env: IvrAdminEnv, rawPhone: string): Promise<{ phone: string; recorders: string[] } | null> {
  const phone = normalizePhone(rawPhone);
  const recorders = await readIvrRecorders(env);
  return phone && recorders.includes(phone) ? { phone, recorders } : null;
}

async function overview(env: IvrAdminEnv, callerPhone: string): Promise<Response> {
  const access = await requireRecorder(env, callerPhone);
  if (!access) return json({ error: "מספר הטלפון אינו מורשה לניהול." }, 403);
  const survey = await activeSurvey(env);
  const [surveys, settings, albums, songs, artists, votes, albumResults, songResults, artistResults] = await env.DB.batch([
    env.DB.prepare("SELECT s.id,s.name,s.active,COALESCE(p.voting_open,0) AS votingOpen FROM surveys s LEFT JOIN poll_settings p ON p.id=s.id ORDER BY s.active DESC,s.created_at DESC"),
    env.DB.prepare("SELECT voting_open AS votingOpen,albums_enabled AS albumsEnabled,albums_min AS albumsMin,albums_max AS albumsMax,songs_enabled AS songsEnabled,songs_min AS songsMin,songs_max AS songsMax,artists_enabled AS artistsEnabled,artists_min AS artistsMin,artists_max AS artistsMax FROM poll_settings WHERE id=?").bind(survey.id),
    env.DB.prepare("SELECT id,title,artist_name AS artistName,active FROM albums WHERE survey_id=? ORDER BY position,title").bind(survey.id),
    env.DB.prepare("SELECT s.id,s.album_id AS albumId,s.title,s.active FROM songs s JOIN albums a ON a.id=s.album_id WHERE a.survey_id=? ORDER BY s.album_id,s.position,s.title").bind(survey.id),
    env.DB.prepare("SELECT id,name,active FROM artists WHERE survey_id=? ORDER BY position,name").bind(survey.id),
    env.DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN channel='phone' THEN 1 ELSE 0 END) AS phone,SUM(CASE WHEN channel='site' THEN 1 ELSE 0 END) AS site FROM ballots WHERE survey_id=?").bind(survey.id),
    env.DB.prepare("SELECT a.title AS label,COUNT(v.album_id) AS votes FROM albums a LEFT JOIN album_votes v ON v.album_id=a.id WHERE a.survey_id=? GROUP BY a.id ORDER BY votes DESC,a.title LIMIT 5").bind(survey.id),
    env.DB.prepare("SELECT s.title AS label,COUNT(v.song_id) AS votes FROM songs s JOIN albums a ON a.id=s.album_id LEFT JOIN song_votes v ON v.song_id=s.id WHERE a.survey_id=? GROUP BY s.id ORDER BY votes DESC,s.title LIMIT 5").bind(survey.id),
    env.DB.prepare("SELECT a.name AS label,COUNT(v.artist_id) AS votes FROM artists a LEFT JOIN artist_votes v ON v.artist_id=a.id WHERE a.survey_id=? GROUP BY a.id ORDER BY votes DESC,a.name LIMIT 5").bind(survey.id),
  ]);
  const currentSettings = (settings.results[0] as unknown as Settings | undefined) ?? DEFAULT_SETTINGS;
  const [prompts, currentReadiness] = await Promise.all([readIvrPrompts(env), readiness(env, survey.id, currentSettings)]);
  return json({
    activeSurvey: survey,
    surveys: surveys.results,
    settings: currentSettings,
    albums: albums.results,
    songs: songs.results,
    artists: artists.results,
    votes: votes.results[0] ?? { total: 0, phone: 0, site: 0 },
    results: { albums: albumResults.results, songs: songResults.results, artists: artistResults.results },
    readiness: currentReadiness,
    prompts,
    recorders: access.recorders,
  });
}

async function action(env: IvrAdminEnv, body: ActionBody): Promise<Response> {
  const access = await requireRecorder(env, body.phone || "");
  if (!access) return json({ error: "מספר הטלפון אינו מורשה לניהול." }, 403);

  if (body.action === "add-recorder") {
    const targetPhone = normalizePhone(body.targetPhone || "");
    if (!targetPhone) return json({ error: "מספר הטלפון שהוקש אינו תקין." }, 400);
    const next = [...new Set([...access.recorders, targetPhone])].sort();
    await saveIvrRecorders(env, next);
    return json({ ok: true, message: "המספר נוסף לרשימת המקליטים המורשים.", recorders: next });
  }

  if (body.action === "remove-recorder") {
    const targetPhone = normalizePhone(body.targetPhone || "");
    if (!targetPhone || !access.recorders.includes(targetPhone)) return json({ error: "המספר אינו נמצא ברשימת המקליטים." }, 404);
    if (access.recorders.length <= 1) return json({ error: "אי אפשר להסיר את המספר המורשה האחרון." }, 400);
    const next = access.recorders.filter((phone) => phone !== targetPhone);
    await saveIvrRecorders(env, next);
    return json({ ok: true, message: "הרשאת ההקלטה של המספר הוסרה.", recorders: next });
  }

  const survey = await activeSurvey(env);

  if (body.action === "set-voting-open") {
    const settings = await readSettings(env, survey.id);
    const next = { ...settings, votingOpen: body.value ? 1 : 0 };
    if (next.votingOpen) {
      const currentReadiness = await readiness(env, survey.id, next);
      if (!currentReadiness.ready) return json({ error: `אי אפשר לפתוח את ההצבעה: ${currentReadiness.warnings.join(", ")}.` }, 400);
    }
    await saveSettings(env, survey.id, next);
    if (settings.votingOpen && !next.votingOpen) await deleteR2Prefix(env.MEDIA, `ivr-progress/${survey.id}/`);
    return json({ ok: true, message: next.votingOpen ? "ההצבעה נפתחה." : "ההצבעה נסגרה." });
  }

  if (body.action === "activate-survey") {
    const id = String(body.id || "").trim();
    const target = id ? await env.DB.prepare("SELECT id,name FROM surveys WHERE id=?").bind(id).first<{ id: string; name: string }>() : null;
    if (!target) return json({ error: "הסקר לא נמצא." }, 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE surveys SET active=0"),
      env.DB.prepare("UPDATE surveys SET active=1 WHERE id=?").bind(id),
    ]);
    if (survey.id !== id) await deleteR2Prefix(env.MEDIA, `ivr-progress/${survey.id}/`);
    return json({ ok: true, message: `הסקר ${target.name} הופעל.` });
  }

  if (body.action === "set-stage-enabled" || body.action === "set-quota") {
    const stage = body.stage;
    if (!stage || !["albums", "songs", "artists"].includes(stage)) return json({ error: "שלב ההצבעה אינו תקין." }, 400);
    const settings = await readSettings(env, survey.id);
    const next = { ...settings };
    const enabledKey = `${stage}Enabled` as "albumsEnabled" | "songsEnabled" | "artistsEnabled";
    const minKey = `${stage}Min` as "albumsMin" | "songsMin" | "artistsMin";
    const maxKey = `${stage}Max` as "albumsMax" | "songsMax" | "artistsMax";
    if (body.action === "set-stage-enabled") next[enabledKey] = body.value ? 1 : 0;
    else {
      next[minKey] = Number(body.min);
      next[maxKey] = Number(body.max);
    }
    const invalid = validateSettings(next);
    if (invalid) return json({ error: invalid }, 400);
    if (next.votingOpen) {
      const currentReadiness = await readiness(env, survey.id, next);
      if (!currentReadiness.ready) return json({ error: `השינוי לא נשמר: ${currentReadiness.warnings.join(", ")}.` }, 400);
    }
    await saveSettings(env, survey.id, next);
    return json({ ok: true, message: "הגדרות ההצבעה עודכנו." });
  }

  if (body.action === "toggle-item") {
    const id = String(body.id || "").trim();
    const lookups = {
      album: "SELECT a.id,a.title AS label,a.active FROM albums a WHERE a.id=? AND a.survey_id=?",
      song: "SELECT s.id,s.title AS label,s.active FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.id=? AND a.survey_id=?",
      artist: "SELECT a.id,a.name AS label,a.active FROM artists a WHERE a.id=? AND a.survey_id=?",
    } as const;
    const tables = { album: "albums", song: "songs", artist: "artists" } as const;
    const kind = body.kind;
    if (!kind || !id) return json({ error: "הפריט לא נבחר." }, 400);
    const item = await env.DB.prepare(lookups[kind]).bind(id, survey.id).first<{ id: string; label: string; active: number }>();
    if (!item) return json({ error: "הפריט לא נמצא בסקר הפעיל." }, 404);
    const nextActive = body.value ? 1 : 0;
    await env.DB.prepare(`UPDATE ${tables[kind]} SET active=? WHERE id=?`).bind(nextActive, id).run();
    const settings = await readSettings(env, survey.id);
    if (settings.votingOpen) {
      const currentReadiness = await readiness(env, survey.id, settings);
      if (!currentReadiness.ready) {
        await env.DB.prepare(`UPDATE ${tables[kind]} SET active=? WHERE id=?`).bind(item.active, id).run();
        return json({ error: `השינוי לא נשמר: ${currentReadiness.warnings.join(", ")}.` }, 400);
      }
    }
    return json({ ok: true, message: `${item.label} ${nextActive ? "הופעל" : "הושבת"}.` });
  }

  if (body.action === "delete-prompt") {
    const key = String(body.key || "").trim();
    if (!/^[a-z0-9:_-]+$/i.test(key)) return json({ error: "סוג הקריינות אינו תקין." }, 400);
    const prompts = await readIvrPrompts(env);
    const current = prompts.find((prompt) => prompt.key === key);
    if (!current) return json({ error: "אין קריינות מוקלטת למחיקה." }, 404);
    if (current.audioUrl.startsWith("/media/")) await env.MEDIA.delete(decodeURIComponent(current.audioUrl.slice(7)));
    await saveIvrPrompts(env, prompts.filter((prompt) => prompt.key !== key));
    return json({ ok: true, message: "הקריינות נמחקה והקו יחזור לקריינות האוטומטית." });
  }

  return json({ error: "פעולת הניהול אינה מוכרת." }, 400);
}

export async function ivrAdminApi(request: Request, env: IvrAdminEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/ivr/admin/overview") {
    return overview(env, url.searchParams.get("phone") || "");
  }
  if (request.method === "POST" && url.pathname === "/api/ivr/admin/action") {
    let body: ActionBody;
    try { body = await request.json<ActionBody>(); }
    catch { return json({ error: "בקשת הניהול אינה תקינה." }, 400); }
    return action(env, body);
  }
  return json({ error: "הפעולה לא נמצאה." }, 404);
}

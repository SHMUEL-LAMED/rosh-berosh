export const IVR_CATALOG_DEFAULTS = {
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

// הסקר הפעיל נבחר בתוך השאילתות עצמן ולא בפנייה נפרדת לפניהן. קודם רצה
// SELECT על surveys, ורק כשחזר נשלחה שאר הקבוצה, כך שכל שיחה נכנסת שילמה
// שתי הליכות אל D1 במקום אחת. זו אותה תבנית שכבר הופעלה על קטלוג האתר.
const ACTIVE_SURVEY_SQL = "COALESCE((SELECT id FROM surveys WHERE active = 1 ORDER BY created_at DESC LIMIT 1), 'main')";

// Keep the phone payload to one D1 round trip and include only data used by
// the voting flow. Website image/audio URLs belong in /api/catalog, not here.
export async function readIvrCatalog(db) {
  const [catalogResults, prompts] = await Promise.all([
    db.batch([
      db.prepare(`SELECT ${ACTIVE_SURVEY_SQL} AS id`),
      db.prepare(`SELECT voting_open AS votingOpen, albums_enabled AS albumsEnabled, albums_min AS albumsMin, albums_max AS albumsMax, songs_enabled AS songsEnabled, songs_min AS songsMin, songs_max AS songsMax, artists_enabled AS artistsEnabled, artists_min AS artistsMin, artists_max AS artistsMax FROM poll_settings WHERE id = ${ACTIVE_SURVEY_SQL}`),
      db.prepare(`SELECT id, title, artist_name AS artistName FROM albums WHERE active = 1 AND survey_id = ${ACTIVE_SURVEY_SQL} ORDER BY position, title`),
      db.prepare(`SELECT s.id, s.album_id AS albumId, s.title FROM songs s JOIN albums a ON a.id = s.album_id WHERE s.active = 1 AND a.active = 1 AND a.survey_id = ${ACTIVE_SURVEY_SQL} ORDER BY a.position, s.position, s.title`),
      db.prepare(`SELECT id, name FROM artists WHERE active = 1 AND survey_id = ${ACTIVE_SURVEY_SQL} ORDER BY position, name`),
    ]),
    db.prepare("SELECT key, yemot_path AS yemotPath FROM ivr_prompts WHERE yemot_path IS NOT NULL AND yemot_path != '' ORDER BY key").all().catch(() => ({ results: [] })),
  ]);
  const [survey, settings, albums, songs, artists] = catalogResults;
  return {
    surveyId: String(survey.results[0]?.id || "main"),
    albums: albums.results,
    songs: songs.results,
    artists: artists.results,
    rules: settings.results[0] ?? IVR_CATALOG_DEFAULTS,
    ivrPrompts: prompts.results,
  };
}

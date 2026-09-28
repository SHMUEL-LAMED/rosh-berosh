import seed from './program-seed.json';
import { DEFAULT_HOSTS, HOST_LIMITS } from './program-hosts.js';
import { guestKey } from './program-guests.js';

const MARKER = 'program-people-2026-09-v1';
const SINGER_PROFILES = [
  { name: 'משה קליין', role: 'זמר', bio: 'התארח בתוכנית לשיחה על אלבומו והמופע בבנייני האומה.' },
  { name: 'משה פלד', role: 'זמר', bio: 'התראיין במשדר המצעד השנתי.' },
  { name: 'אלחנן ענבל', role: 'זמר', bio: 'התראיין לקראת גמר הקול החדש ובמשדר המצעד השנתי.' },
  { name: 'יהודה בורן', role: 'זמר', bio: 'התראיין לקראת גמר הקול החדש.' },
  { name: 'פיני איינהורן', role: 'זמר', bio: 'התראיין על האלבום עולמות ועל מופע פיני 2026.' },
];

/** העשרת קטלוג קיים פעם אחת, בלי להחליף תיאורים, הקלטות או שיוכים שנערכו בניהול. */
export async function backfillProgramPeople(env: { DB: D1Database }) {
  if (await env.DB.prepare('SELECT 1 FROM program_settings WHERE key=?').bind(MARKER).first()) return;
  const rows = (await env.DB.prepare('SELECT id,data_json FROM program_episodes').all<{ id: string; data_json: string }>()).results;
  const byId = new Map((seed.episodes as Array<Record<string, unknown>>).map((e) => [e.id, e]));
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const source = byId.get(row.id);
    if (!source || !Array.isArray(source.hosts)) continue;
    let current: Record<string, unknown>;
    try { current = JSON.parse(row.data_json); } catch { continue; }
    const merge = (field: 'hosts' | 'guests' | 'panelists') => {
      const before = Array.isArray(current[field]) ? current[field].filter((v): v is string => typeof v === 'string') : [];
      const additions = Array.isArray(source[field]) ? source[field].filter((v): v is string => typeof v === 'string') : [];
      return [...before, ...additions.filter((v) => !before.some((b) => guestKey(b) === guestKey(v)))];
    };
    const next = { ...current, hosts: merge('hosts'), guests: merge('guests'), panelists: merge('panelists') };
    if (JSON.stringify(next) !== row.data_json) statements.push(env.DB.prepare('UPDATE program_episodes SET data_json=?,updated_at=unixepoch() WHERE id=?').bind(JSON.stringify(next), row.id));
  }
  const settings = (await env.DB.prepare("SELECT key,value_json FROM program_settings WHERE key IN ('hosts','guests')").all<{ key: string; value_json: string }>()).results;
  const values = new Map(settings.map((r) => { try { return [r.key, JSON.parse(r.value_json)]; } catch { return [r.key, null]; } }));
  const savedHosts = values.get('hosts');
  const hosts = Array.isArray(savedHosts) ? savedHosts as Array<{ name: string }> : [];
  // מערך ריק שנשמר בניהול הוא בחירה מפורשת להסתיר מגישים.
  const newHosts = Array.isArray(savedHosts) && hosts.length === 0 ? hosts :
    [...hosts, ...DEFAULT_HOSTS.filter((h) => !hosts.some((v) => guestKey(v.name) === guestKey(h.name)))];
  const guests = Array.isArray(values.get('guests')) ? values.get('guests') as Array<{ name: string }> : [];
  const newGuests = [...guests, ...SINGER_PROFILES.filter((g) => !guests.some((v) => guestKey(v.name) === guestKey(g.name)))];
  for (const [key, value] of [['hosts', newHosts], ['guests', newGuests]] as const) {
    statements.push(env.DB.prepare('INSERT INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()').bind(key, JSON.stringify(value)));
  }
  statements.push(env.DB.prepare('INSERT OR IGNORE INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch())').bind(MARKER, JSON.stringify({ at: new Date().toISOString(), episodes: statements.length - 2 })));
  await env.DB.batch(statements);
}

const CORRECTIONS_MARKER = 'program-people-2026-09-v4';
const EPISODE_77_ID = 'drive-1i7sD0TJPpGZeyODR5_TM8UdiKSIrfPow';
const EPISODE_88_ID = 'drive-1-d-Y4TFP0PJ7_yQzt5iisOAC8MsOy5ll';
const VERIFIED_PROFILE_PHOTOS: Record<string, string> = {
  'אלחנן ענבל': 'https://www.emess.co.il/upload/pictures/16/16674.jpg',
  'גיא מרוז': 'https://www.kan.org.il/media/ehnpf3ly/%D7%9C%D7%99%D7%90%D7%95%D7%A8%D7%A8%D7%A8.jpg?height=630&rmode=pad&width=1200',
  'יהודה בורן': 'https://www.emess.co.il/resize/?height=0&url=%2Fuploads%2F2025%2F02%2F%D7%99%D7%94%D7%95%D7%93%D7%94-%D7%91%D7%95%D7%A8%D7%9F-%D7%94%D7%A7%D7%95%D7%9C-%D7%94%D7%97%D7%93%D7%A9.png&width=800',
  'מיכאל מלכיאלי': 'https://storage.bhol.co.il/articles/153885_tumb_800X480.jpg',
  'משה פלד': 'https://static.tickchak.co.il/all/liveNew_090TQkp2RmN1U0IXWoJjUBp2cyd2a5c1Ku_k90TQpNjRCVlYGZWMvg1VSdmQIt2StFmR.jpeg_1465b436-6168-4fdb-98ea-b0f1492c5673.jpeg',
  'משה קליין': 'https://media.kore.co.il/articles/71813_tumb_800X480.jpg',
  'פיני איינהורן': 'https://images.babli.co.il/2026/02/22/6af67360-0ff0-11f1-9096-adc0e27576ae__h1066_w1600.jpeg',
  'רונן צור': 'https://image-resizer.walla.cloud/image/2025/8/4/images/1756055590591_picture_1253x1600.webp',
};

/** הסימונים של שתי ההכנות — כשהם במסד, אין צורך להריץ אותן */
export const PEOPLE_MARKERS = [MARKER, CORRECTIONS_MARKER];

const peopleArray = (raw: unknown) => (Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
const addPerson = (raw: unknown, name: string) => {
  const list = peopleArray(raw);
  return list.some((value) => guestKey(value) === guestKey(name)) ? list : [...list, name];
};

function correctedEpisode(raw: Record<string, unknown>) {
  const guests = peopleArray(raw.guests).filter((name) => guestKey(name) !== guestKey('קובי בלום'));
  const next: Record<string, unknown> = { ...raw, guests };

  // כל תקופת הארכיון שלפני עונת מיכאל לוי/קובי בלום משויכת לשלמה גולדברג.
  if (raw.season === 'legacy') next.hosts = ['שלמה גולדברג'];

  // תיקונים לפרקים מסוימים לפי מזהה יציב — לא לפי מספר פרק, שאינו בהכרח ייחודי.
  if (raw.id === EPISODE_77_ID) {
    next.hosts = ['מיכאל לוי', 'קובי בלום'];
    next.guests = guests.filter((name) => guestKey(name) !== guestKey('מיכאל לוי'));
    next.panelists = addPerson(raw.panelists, 'דודי זינגר');
  }
  if (raw.id === EPISODE_88_ID) {
    next.guests = guests.filter((name) => guestKey(name) !== guestKey('יאיר שטיין'));
    next.panelists = addPerson(raw.panelists, 'יאיר שטיין');
  }
  return next;
}

function correctedHosts(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) return raw;
  const shlomo = DEFAULT_HOSTS.find((host) => host.name === 'שלמה גולדברג');
  const list = raw
    .filter((host): host is Record<string, unknown> => !!host && typeof host === 'object' && !Array.isArray(host))
    .filter((host) => guestKey(host.name) !== guestKey('דודי זינגר'))
    .map((host) => guestKey(host.name) === guestKey('שלמה גולדברג')
      ? { ...host, role: 'מייסד ראש בראש', seasons: [...new Set([...peopleArray(host.seasons), 'legacy'])], current: false }
      : host);

  if (!shlomo || list.some((host) => guestKey(host.name) === guestKey(shlomo.name))) return list.slice(0, HOST_LIMITS.hosts);
  return [...list.slice(0, Math.max(0, HOST_LIMITS.hosts - 1)), { ...shlomo, role: 'מייסד ראש בראש' }];
}

function correctedGuestProfiles(raw: unknown) {
  const profiles = (Array.isArray(raw) ? raw : [])
    .filter((profile): profile is Record<string, unknown> => !!profile && typeof profile === 'object' && !Array.isArray(profile))
    .filter((profile) => guestKey(profile.name) !== guestKey('קובי בלום'));
  const panelistProfiles = [
    { name: 'דודי זינגר', role: 'חבר פאנל', bio: 'השתתף בפאנל התוכנית.' },
    { name: 'יאיר שטיין', role: 'חבר פאנל', bio: 'חבר המערכת; השתתף בסקירת המופעים בפרק 88.' },
    { name: 'יוסי קאהן', role: 'חבר פאנל', bio: '' },
  ];
  const merged = [...profiles];
  for (const profile of panelistProfiles) {
    const index = merged.findIndex((item) => guestKey(item.name) === guestKey(profile.name));
    if (index < 0) merged.push(profile);
    else merged[index] = { ...merged[index], role: profile.role };
  }
  for (const [name, photo] of Object.entries(VERIFIED_PROFILE_PHOTOS)) {
    const index = merged.findIndex((item) => guestKey(item.name) === guestKey(name));
    if (index < 0) merged.push({ name, photo, role: '', bio: '', links: [] });
    else merged[index] = { ...merged[index], photo };
  }
  return merged;
}

function correctedCatalogData(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const data = raw as Record<string, unknown>;
  const episodes = Array.isArray(data.episodes)
    ? data.episodes.map((episode) => episode && typeof episode === 'object' && !Array.isArray(episode) ? correctedEpisode(episode as Record<string, unknown>) : episode)
    : data.episodes;
  const rawSettings = data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings as Record<string, unknown> : {};
  const settings = {
    ...rawSettings,
    hosts: correctedHosts(rawSettings.hosts),
    guests: correctedGuestProfiles(rawSettings.guests),
  };
  return { ...data, episodes, settings };
}

/** תיקונים שקבע בעל התוכנית: תפקיד מדויק, בלי להמציא הופעה בפרק שלא תועדה. */
export async function correctProgramPeople(env: { DB: D1Database }) {
  if (await env.DB.prepare('SELECT 1 FROM program_settings WHERE key=?').bind(CORRECTIONS_MARKER).first()) return;

  const rows = (await env.DB.prepare('SELECT id,data_json FROM program_episodes').all<{ id: string; data_json: string }>()).results;
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    let current: Record<string, unknown>;
    try { current = JSON.parse(row.data_json); } catch { continue; }
    const next = correctedEpisode({ ...current, id: row.id });
    if (JSON.stringify(next) !== row.data_json) {
      statements.push(env.DB.prepare('UPDATE program_episodes SET data_json=?,updated_at=unixepoch() WHERE id=?').bind(JSON.stringify(next), row.id));
    }
  }

  const settings = (await env.DB.prepare("SELECT key,value_json FROM program_settings WHERE key IN ('hosts','guests','draft')").all<{ key: string; value_json: string }>()).results;
  const values = new Map(settings.map((row) => {
    try { return [row.key, JSON.parse(row.value_json)] as const; }
    catch { return [row.key, null] as const; }
  }));

  const savedHosts = values.get('hosts');
  if (Array.isArray(savedHosts) && savedHosts.length) {
    statements.push(env.DB.prepare("UPDATE program_settings SET value_json=?,updated_at=unixepoch() WHERE key='hosts'")
      .bind(JSON.stringify(correctedHosts(savedHosts))));
  }

  const guestProfiles = correctedGuestProfiles(values.get('guests'));
  statements.push(env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('guests',?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()")
    .bind(JSON.stringify(guestProfiles)));

  // אם כבר קיימת טיוטה משותפת, מתקנים גם אותה. אחרת הפרסום הבא היה יכול להחזיר את השיוכים הישנים.
  const draft = values.get('draft');
  if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
    const record = draft as Record<string, unknown>;
    const fixedDraft = { ...record, data: correctedCatalogData(record.data) };
    statements.push(env.DB.prepare("UPDATE program_settings SET value_json=?,updated_at=unixepoch() WHERE key='draft'")
      .bind(JSON.stringify(fixedDraft)));
  }

  statements.push(env.DB.prepare('INSERT OR IGNORE INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch())')
    .bind(CORRECTIONS_MARKER, JSON.stringify({ at: new Date().toISOString() })));
  await env.DB.batch(statements);
}

import seed from './program-seed.json';
import { DEFAULT_HOSTS } from './program-hosts.js';
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

const CORRECTIONS_MARKER = 'program-people-2026-09-v2';
/** הסימונים של שתי ההכנות — כשהם במסד, אין צורך להריץ אותן */
export const PEOPLE_MARKERS = [MARKER, CORRECTIONS_MARKER];

/** תיקונים שקבע בעל התוכנית: תפקיד מדויק, בלי להמציא הופעה בפרק שלא תועדה. */
export async function correctProgramPeople(env: { DB: D1Database }) {
  if (await env.DB.prepare('SELECT 1 FROM program_settings WHERE key=?').bind(CORRECTIONS_MARKER).first()) return;
  const rows = (await env.DB.prepare('SELECT id,number,data_json FROM program_episodes').all<{ id: string; number: number | null; data_json: string }>()).results;
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(row.data_json); } catch { continue; }
    const guests = Array.isArray(e.guests) ? e.guests.filter((g): g is string => typeof g === 'string' && guestKey(g) !== guestKey('קובי בלום')) : [];
    const next = { ...e, guests };
    if (e.season === 'legacy' && Number.isInteger(row.number)) next.hosts = ['שלמה גולדברג'];
    if (row.number === 77) {
      next.hosts = ['מיכאל לוי', 'קובי בלום'];
      next.guests = guests.filter((g) => guestKey(g) !== guestKey('מיכאל לוי'));
      next.panelists = [...new Set([...(Array.isArray(e.panelists) ? e.panelists : []), 'דודי זינגר'])];
    }
    if (row.number === 88) {
      next.guests = guests.filter((g) => guestKey(g) !== guestKey('יאיר שטיין'));
      next.panelists = [...new Set([...(Array.isArray(e.panelists) ? e.panelists : []), 'יאיר שטיין'])];
    }
    if (JSON.stringify(next) !== row.data_json) statements.push(env.DB.prepare('UPDATE program_episodes SET data_json=?,updated_at=unixepoch() WHERE id=?').bind(JSON.stringify(next), row.id));
  }
  const settings = (await env.DB.prepare("SELECT key,value_json FROM program_settings WHERE key IN ('hosts','guests')").all<{ key: string; value_json: string }>()).results;
  const values = new Map(settings.map((r) => { try { return [r.key, JSON.parse(r.value_json)]; } catch { return [r.key, null]; } }));
  const savedHosts = values.get('hosts');
  if (Array.isArray(savedHosts) && savedHosts.length) {
    const withoutDudi = savedHosts.filter((h) => guestKey(h?.name) !== guestKey('דודי זינגר'));
    const shlomo = DEFAULT_HOSTS.find((h) => h.name === 'שלמה גולדברג');
    if (shlomo && !withoutDudi.some((h) => guestKey(h?.name) === guestKey(shlomo.name))) withoutDudi.push(shlomo);
    statements.push(env.DB.prepare("UPDATE program_settings SET value_json=?,updated_at=unixepoch() WHERE key='hosts'").bind(JSON.stringify(withoutDudi)));
  }
  const guestProfiles = Array.isArray(values.get('guests')) ? values.get('guests') as Array<{ name: string; role?: string; bio?: string }> : [];
  const panelistProfiles = [
    { name: 'דודי זינגר', role: 'חבר פאנל', bio: 'השתתף בפאנל התוכנית.' },
    { name: 'יאיר שטיין', role: 'חבר פאנל', bio: 'חבר המערכת; השתתף בסקירת המופעים בפרק 88.' },
    { name: 'יוסי קאהן', role: 'חבר פאנל', bio: '' },
  ];
  const merged = [...guestProfiles];
  for (const profile of panelistProfiles) {
    const idx = merged.findIndex((g) => guestKey(g.name) === guestKey(profile.name));
    if (idx < 0) merged.push(profile);
    else merged[idx] = { ...merged[idx], role: profile.role };
  }
  statements.push(env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('guests',?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()").bind(JSON.stringify(merged)));
  statements.push(env.DB.prepare('INSERT OR IGNORE INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch())').bind(CORRECTIONS_MARKER, JSON.stringify({ at: new Date().toISOString() })));
  await env.DB.batch(statements);
}

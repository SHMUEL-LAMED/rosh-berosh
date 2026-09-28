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
  const hosts = Array.isArray(values.get('hosts')) ? values.get('hosts') as Array<{ name: string }> : [];
  const newHosts = [...hosts, ...DEFAULT_HOSTS.filter((h) => !hosts.some((v) => guestKey(v.name) === guestKey(h.name)))];
  const guests = Array.isArray(values.get('guests')) ? values.get('guests') as Array<{ name: string }> : [];
  const newGuests = [...guests, ...SINGER_PROFILES.filter((g) => !guests.some((v) => guestKey(v.name) === guestKey(g.name)))];
  for (const [key, value] of [['hosts', newHosts], ['guests', newGuests]] as const) {
    statements.push(env.DB.prepare('INSERT INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()').bind(key, JSON.stringify(value)));
  }
  statements.push(env.DB.prepare('INSERT OR IGNORE INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch())').bind(MARKER, JSON.stringify({ at: new Date().toISOString(), episodes: statements.length - 2 })));
  await env.DB.batch(statements);
}

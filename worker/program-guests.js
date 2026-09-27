/* האורחים של אתר התוכניות — כללים משותפים לשרת ולדף הניהול.

   אורח מזוהה לפי השם שלו בשדה `guests` של התוכניות. `guestKey` מנרמל אותו (בלי ניקוד,
   רווחים כפולים ואותיות גדולות), כך ש"יואלי  קליין" ו"יואלי קליין" הם אותו אורח — בדיוק
   כמו בסינון לפי אורח בארכיון (rosh-berosh-2/assets/js/store.js).

   הפרופיל (תמונה, שורת תפקיד, כמה מילים וקישורים) נשמר ב־settings.guests ומתפרסם עם
   הקטלוג; דף האורח באתר (guest.html) מציג אותו ליד כל התוכניות של האורח. */

export const GUEST_LIMITS = { profiles: 500, name: 80, role: 80, bio: 1500, links: 6, label: 40, url: 500 };

export function guestKey(name) {
  return String(name ?? "").replace(/[֑-ׇ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const clean = (value, max) => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
const oneLine = (value, max) => clean(value, max).replace(/\s+/g, " ");

/** הפרופילים כפי שהם נשמרים: שם חובה, מפתח ייחודי, תמונה וקישורים רק בכתובת https. */
export function normalizeGuests(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = oneLine(item.name, GUEST_LIMITS.name), key = guestKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const photo = oneLine(item.photo, GUEST_LIMITS.url);
    const links = (Array.isArray(item.links) ? item.links : []).flatMap((link) => {
      const url = oneLine(link?.url, GUEST_LIMITS.url);
      return /^https?:\/\/[^\s]+$/i.test(url) ? [{ label: oneLine(link?.label, GUEST_LIMITS.label), url }] : [];
    }).slice(0, GUEST_LIMITS.links);
    const profile = { name, role: oneLine(item.role, GUEST_LIMITS.role), bio: clean(item.bio, GUEST_LIMITS.bio), photo: /^https:\/\/[^\s]+$/i.test(photo) ? photo : "", links };
    // פרופיל ריק (רק שם) לא נשמר — האורח מופיע באתר ממילא, מהתוכניות
    if (profile.role || profile.bio || profile.photo || profile.links.length) out.push(profile);
    if (out.length >= GUEST_LIMITS.profiles) break;
  }
  return out;
}

/** כל האורחים בקטלוג (כולל תוכניות מוסתרות — זה בשביל הניהול), עם הכתיב הנפוץ ביותר. */
export function collectGuests(episodes, profiles = []) {
  const map = new Map();
  for (const episode of episodes) {
    for (const raw of Array.isArray(episode.guests) ? episode.guests : []) {
      const key = guestKey(raw); if (!key) continue;
      const name = String(raw).replace(/\s+/g, " ").trim();
      const guest = map.get(key) || { key, spellings: new Map(), episodeIds: [] };
      guest.spellings.set(name, (guest.spellings.get(name) || 0) + 1);
      if (!guest.episodeIds.includes(episode.id)) guest.episodeIds.push(episode.id);
      map.set(key, guest);
    }
  }
  const byKey = new Map(profiles.map((profile) => [guestKey(profile.name), profile]));
  const list = [...map.values()].map((guest) => {
    const spellings = [...guest.spellings].sort((a, b) => b[1] - a[1]);
    const profile = byKey.get(guest.key) || null;
    return { key: guest.key, name: profile?.name || spellings[0][0], spellings: spellings.map(([name]) => name), episodeIds: guest.episodeIds, count: guest.episodeIds.length, profile };
  });
  // פרופיל שכבר אין לו אף תוכנית (למשל אחרי שינוי שם) — נשאר ברשימה, כדי שאפשר יהיה למחוק או לשייך אותו
  for (const [key, profile] of byKey) if (!map.has(key)) list.push({ key, name: profile.name, spellings: [profile.name], episodeIds: [], count: 0, profile });
  return list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "he"));
}

/** שינוי שם של אורח בכל התוכניות (או איחוד שני אורחים: `to` הוא שם של אורח קיים).
    אם בתוכנית כבר מופיע היעד, המקור פשוט יורד ממנה — בלי כפילות. */
export function renameGuest(episodes, from, to) {
  const fromKey = guestKey(from), name = String(to ?? "").replace(/\s+/g, " ").trim(), toKey = guestKey(name);
  if (!fromKey || !toKey) return episodes;
  return episodes.map((episode) => {
    if (!episode.guests?.some((g) => guestKey(g) === fromKey)) return episode;
    const next = [];
    for (const g of episode.guests) {
      const key = guestKey(g) === fromKey ? toKey : guestKey(g);
      if (next.some((x) => guestKey(x) === key)) continue;
      next.push(guestKey(g) === fromKey ? name : g);
    }
    return { ...episode, guests: next };
  });
}

/** הסרת אורח מכל התוכניות. */
export function removeGuest(episodes, name) {
  const key = guestKey(name);
  return episodes.map((episode) => (episode.guests?.some((g) => guestKey(g) === key) ? { ...episode, guests: episode.guests.filter((g) => guestKey(g) !== key) } : episode));
}

/** הצעות להשלמת האורחים מהסיכומים של התמלולים (הבינה המלאכותית מחזירה `guests` בכל סיכום).
    לכל תוכנית: רק שמות שעוד לא מופיעים בה, בכתיב שכבר קיים בקטלוג אם יש כזה.
    שם שנראה כמו אחד המגישים — מופיע בשם העונה של התוכנית, או חוזר ביותר משליש מהסיכומים —
    מוצע בלי סימון, עם הסבר, כדי שלא ייכנס בטעות. */
export function guestSuggestions(episodes, summaries, seasons = []) {
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  const seasonTitle = new Map(seasons.map((season) => [season.id, guestKey(season.title)]));
  const known = new Map(collectGuests(episodes).map((guest) => [guest.key, guest.name]));
  const usable = summaries.filter((row) => byId.has(row.episodeId) && Array.isArray(row.guests));
  const frequency = new Map();
  for (const row of usable) for (const key of new Set(row.guests.map(guestKey).filter(Boolean))) frequency.set(key, (frequency.get(key) || 0) + 1);
  const often = Math.max(3, Math.ceil(usable.length / 3));
  const out = [];
  for (const row of usable) {
    const episode = byId.get(row.episodeId);
    const have = new Set((episode.guests || []).map(guestKey));
    const add = [];
    for (const raw of row.guests) {
      const key = guestKey(raw);
      if (!key || key.length < 2 || have.has(key) || add.some((item) => guestKey(item.name) === key)) continue;
      const name = known.get(key) || String(raw).replace(/\s+/g, " ").trim().slice(0, GUEST_LIMITS.name);
      const inSeason = seasonTitle.get(episode.season)?.includes(key);
      const recurring = (frequency.get(key) || 0) >= often;
      add.push({ name, checked: !inSeason && !recurring, reason: inSeason ? "מופיע בשם העונה — כנראה אחד המגישים" : recurring ? `חוזר ב־${frequency.get(key)} תוכניות — אולי מגיש קבוע` : "" });
    }
    if (add.length) out.push({ episodeId: episode.id, title: episode.title, add });
  }
  return out;
}

/** מחילה הצעות שאושרו: מוסיפה לכל תוכנית את השמות המסומנים, בלי כפילויות. */
export function applyGuestSuggestions(episodes, accepted) {
  const byId = new Map(accepted.map((item) => [item.episodeId, item.names]));
  return episodes.map((episode) => {
    const names = byId.get(episode.id);
    if (!names?.length) return episode;
    const guests = [...(episode.guests || [])];
    for (const name of names) if (!guests.some((g) => guestKey(g) === guestKey(name))) guests.push(name);
    return guests.length === (episode.guests || []).length ? episode : { ...episode, guests: guests.slice(0, 20) };
  });
}

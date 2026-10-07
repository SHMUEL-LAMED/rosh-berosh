/* האורחים של אתר התוכניות — כללים משותפים לשרת ולדף הניהול.

   אורח מזוהה לפי השם שלו בשדה `guests` של התוכניות. `guestKey` מנרמל אותו (בלי ניקוד,
   רווחים כפולים ואותיות גדולות), כך ש"יואלי  קליין" ו"יואלי קליין" הם אותו אורח — בדיוק
   כמו בסינון לפי אורח בארכיון (rosh-berosh-2/assets/js/store.js).

   הפרופיל (תמונה, שורת תפקיד, כמה מילים וקישורים) נשמר ב־settings.guests ומתפרסם עם
   הקטלוג. באתר אין דף אורח: השמות בדפי התוכניות מובילים לארכיון המסונן לפי האדם (archive.html?guest=…). */

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

/** טיוטה מול הפרופילים שבאתר: תמונה שכבר מפורסמת אינה נעלמת בגלל טיוטה שאינה מכירה אותה.
    טיוטה שנשמרה לפני שנוספו התמונות (או מלשונית שנפתחה לפני כן) מחזיקה פרופילים בלי `photo` —
    בניהול נראה כאילו אין תמונות, והפרסום הבא ממנה היה מוחק אותן מהאתר. לכן:
    פרופיל בטיוטה בלי תמונה מקבל את התמונה של אותו אורח מהפרופילים המפורסמים (`published`), ואורח
    שמופיע בתוכניות שבטיוטה ואין לו בה פרופיל בכלל מקבל את הפרופיל המפורסם כמו שהוא. אורח שהוסר
    מהתוכניות אינו חוזר; טיוטה בלי `settings` (פרסום שלה אינו נוגע בהגדרות) נשארת כמו שהיא.
    תמונה שהוסרה בטיוטה מתפרסמת כהסרה ב"פרסום"; עד אז, טעינה מחדש מחזירה אותה.
    מחזירה את אותו אובייקט כשאין מה להשלים. */
export function withPublishedPhotos(data, published) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const settings = data.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return data;
  const photos = new Map();
  for (const profile of Array.isArray(published) ? published : []) {
    if (!profile || typeof profile !== "object") continue;
    const key = guestKey(profile.name), photo = String(profile.photo ?? "").trim();
    if (key && photo && !photos.has(key)) photos.set(key, { ...profile, photo });
  }
  if (!photos.size) return data;
  const have = new Set();
  let changed = false;
  const guests = (Array.isArray(settings.guests) ? settings.guests : []).map((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile;
    const key = guestKey(profile.name);
    have.add(key);
    if (String(profile.photo ?? "").trim() || !photos.has(key)) return profile;
    changed = true;
    return { ...profile, photo: photos.get(key).photo };
  });
  const inEpisodes = new Set();
  for (const episode of Array.isArray(data.episodes) ? data.episodes : []) {
    for (const raw of [...(Array.isArray(episode?.guests) ? episode.guests : []), ...(Array.isArray(episode?.panelists) ? episode.panelists : [])]) {
      const key = guestKey(raw);
      if (key) inEpisodes.add(key);
    }
  }
  for (const [key, profile] of photos) {
    if (have.has(key) || !inEpisodes.has(key)) continue;
    guests.push(profile);
    changed = true;
  }
  return changed ? { ...data, settings: { ...settings, guests } } : data;
}

/** כל האורחים בקטלוג (כולל תוכניות מוסתרות — זה בשביל הניהול), עם הכתיב הנפוץ ביותר. */
export function collectGuests(episodes, profiles = []) {
  const map = new Map();
  for (const episode of episodes) {
    for (const raw of [...(Array.isArray(episode.guests) ? episode.guests : []), ...(Array.isArray(episode.panelists) ? episode.panelists : [])]) {
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

/** ההשלמה בשדה "אורחים" של תוכנית: כל האורחים בקטלוג שעוד לא ברשימה של התוכנית (`chosen`),
    מסוננים לפי מה שהוקלד — קודם מי שהשם שלו מתחיל בזה, אחר כך מי שמכיל אותו — ובלי הקלדה כולם,
    הנפוצים קודם (הסדר של `collectGuests`). כל פריט: השם בכתיב הנפוץ, ובכמה תוכניות הוא מופיע. */
export function guestOptions(episodes, profiles = [], chosen = [], query = "", limit = 50) {
  const have = new Set((Array.isArray(chosen) ? chosen : []).map(guestKey).filter(Boolean));
  const q = guestKey(query);
  const starts = [], contains = [];
  for (const guest of collectGuests(episodes, profiles)) {
    if (have.has(guest.key)) continue;
    const keys = [guest.key, ...guest.spellings.map(guestKey)];
    if (!q) starts.push(guest);
    else if (keys.some((key) => key.startsWith(q))) starts.push(guest);
    else if (keys.some((key) => key.includes(q))) contains.push(guest);
  }
  return [...starts, ...contains].slice(0, Math.max(0, limit)).map((guest) => ({ name: guest.name, count: guest.count }));
}

/** הוספת שמות לרשימת האורחים של תוכנית — מהקלדה או מהדבקה (פסיק או שורה חדשה מפרידים בין שמות).
    רווחים כפולים מתאחדים, שם ארוך נחתך, שם ריק או שכבר ברשימה (לפי `guestKey`) מדולג, ושם שכבר
    מוכר בקטלוג (`known`: שמות) נכנס בכתיב המוכר — כך שאותו אורח לא נכתב בכל תוכנית אחרת.
    מחזירה את אותו מערך כשאין מה להוסיף. */
export function addGuests(list, text, known = []) {
  const current = Array.isArray(list) ? list : [];
  const spelling = new Map();
  for (const name of Array.isArray(known) ? known : []) { const key = guestKey(name); if (key && !spelling.has(key)) spelling.set(key, String(name).replace(/\s+/g, " ").trim()); }
  const next = [...current];
  for (const raw of String(text ?? "").split(/[,،\n]/)) {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, GUEST_LIMITS.name), key = guestKey(name);
    if (!key || next.some((g) => guestKey(g) === key)) continue;
    next.push(spelling.get(key) || name);
  }
  return next.length === current.length ? current : next;
}

/** שינוי שם של אורח בכל התוכניות (או איחוד שני אורחים: `to` הוא שם של אורח קיים).
    אם בתוכנית כבר מופיע היעד, המקור פשוט יורד ממנה — בלי כפילות. */
export function renameGuest(episodes, from, to) {
  const fromKey = guestKey(from), name = String(to ?? "").replace(/\s+/g, " ").trim(), toKey = guestKey(name);
  if (!fromKey || !toKey) return episodes;
  const renameList = (values = []) => {
    const next = [];
    for (const value of values) {
      const key = guestKey(value) === fromKey ? toKey : guestKey(value);
      if (next.some((x) => guestKey(x) === key)) continue;
      next.push(guestKey(value) === fromKey ? name : value);
    }
    return next;
  };
  return episodes.map((episode) => {
    const guests = Array.isArray(episode.guests) ? episode.guests : [];
    const panelists = Array.isArray(episode.panelists) ? episode.panelists : [];
    const inGuests = guests.some((g) => guestKey(g) === fromKey);
    const inPanel = panelists.some((g) => guestKey(g) === fromKey);
    if (!inGuests && !inPanel) return episode;
    return { ...episode, guests: renameList(guests), panelists: renameList(panelists) };
  });
}

/** הסרת אורח/חבר פאנל מכל התוכניות. */
export function removeGuest(episodes, name) {
  const key = guestKey(name);
  return episodes.map((episode) => {
    const guests = Array.isArray(episode.guests) ? episode.guests : [];
    const panelists = Array.isArray(episode.panelists) ? episode.panelists : [];
    const nextGuests = guests.filter((g) => guestKey(g) !== key);
    const nextPanelists = panelists.filter((g) => guestKey(g) !== key);
    return nextGuests.length === guests.length && nextPanelists.length === panelists.length
      ? episode
      : { ...episode, guests: nextGuests, panelists: nextPanelists };
  });
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

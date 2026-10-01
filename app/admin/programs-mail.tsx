"use client";

/* מייל למאזינים — עורך טיוטת המייל לרשימת התפוצה, בתוך דף הניהול. העורך עצמו (העיצוב, הנמענים,
   הבדיקה, ההיסטוריה ויצירת הטיוטות בג'ימייל) הוא הקוד שהיה בדף mail.html של אתר התוכניות, והועבר
   לכאן כמו שהוא: public/mail-tool/ (mail-composer.js, newsletter.js, sheet-read.js ועיצוב). bridge.js
   נותן לו את מה שהוא קיבל מאתר התוכניות — החשבון, ההעדפות שבחשבון ורשימת התפוצה — מתוך דף הניהול.
   התוכניות: הטיוטה של הניהול (כולל מה שעוד לא פורסם); "באתר" — לפי מה שמפורסם. */

import { useEffect, useRef, useState } from "react";
import { PROGRAM_SITE, type Catalog } from "./programs-core";

const STYLES = ["/mail-tool/base.css", "/mail-tool/mail.css"];
const SCRIPTS = ["/mail-tool/bridge.js", "/mail-tool/newsletter.js", "/mail-tool/sheet-read.js", "/mail-tool/mail-composer.js"];

type Composer = { mount(root: HTMLElement, cfg: Record<string, unknown>): { flush?(): void } | undefined };
type Bridge = { configure(cfg: Record<string, unknown>): void; loadPrefs(): Promise<void>; flush(): Promise<void> };
declare global { interface Window { RoshMailComposer?: Composer; RoshMailBridge?: Bridge } }

/** התוכנית שנבחרה ב„מייל למאזינים” של תוכנית (או אחרי פרסום) — נקראת כשהחלק נפתח */
let pendingEpisode = "";
export function openMailFor(id: string) {
  pendingEpisode = id;
  if (window.location.hash === "#prog-mail") window.dispatchEvent(new Event("mail-tool-episode"));
  else window.location.hash = "#prog-mail";
}

let loading: Promise<void> | null = null;
/** טוען את העורך פעם אחת: קודם העיצוב, ואז הסקריפטים לפי הסדר (bridge.js לפני העורך) */
function loadTool(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    for (const href of STYLES) {
      if (document.querySelector(`link[href="${href}"]`)) continue;
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = href; document.head.appendChild(link);
    }
    for (const src of SCRIPTS) {
      if (document.querySelector(`script[src="${src}"]`)) continue;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script"); script.src = src;
        script.onload = () => resolve(); script.onerror = () => { script.remove(); reject(new Error("עורך המייל לא נטען. בדקו את החיבור ונסו שוב.")); };
        document.head.appendChild(script);
      });
    }
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export function MailSection({ data, origin, onMessage }: { data: Catalog; origin: Catalog; onMessage(message: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  // התוכנית: מהכפתור „✉ מייל למאזינים”, או מקישור ישן ל־mail.html (‎/admin?mail=<id>&kind=…)
  const [fromUrl] = useState(() => {
    const q = new URLSearchParams(window.location.search), out = { mail: q.get("mail") || "", kind: q.get("kind") || "" };
    if (q.has("mail") || q.has("kind")) { q.delete("mail"); q.delete("kind"); window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`); }
    return out;
  });
  const [error, setError] = useState(""), [episodeId, setEpisodeId] = useState(() => { const id = pendingEpisode || fromUrl.mail; pendingEpisode = ""; return id; });
  const [attempt, setAttempt] = useState(0);
  // הנתונים העדכניים בלי להרכיב את העורך מחדש בכל הקלדה בניהול
  const latest = useRef({ data, origin, onMessage });
  useEffect(() => { latest.current = { data, origin, onMessage }; });

  useEffect(() => {
    const pick = () => { if (pendingEpisode) { setEpisodeId(pendingEpisode); pendingEpisode = ""; } };
    window.addEventListener("mail-tool-episode", pick);
    return () => window.removeEventListener("mail-tool-episode", pick);
  }, []);

  useEffect(() => {
    let cancelled = false, ctl: { flush?(): void } | undefined;
    const root = host.current;
    (async () => {
      try {
        type Me = { user?: { email?: string; name?: string } | null };
        const [me, config] = await Promise.all([
          fetch("/api/auth/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() as Promise<Me> : {})).catch((): Me => ({})) as Promise<Me>,
          fetch("/api/auth/config").then((r) => r.json() as Promise<{ clientId?: string }>).catch(() => ({} as { clientId?: string })),
          loadTool(),
        ]);
        const bridge = window.RoshMailBridge, composer = window.RoshMailComposer;
        if (!bridge || !composer) throw new Error("עורך המייל לא נטען. רעננו את הדף ונסו שוב.");
        bridge.configure({
          user: me?.user ? { email: me.user.email || "", name: me.user.name || "" } : null,
          siteUrl: PROGRAM_SITE, siteName: "ראש בראש", clientId: config?.clientId || "",
          contacts: latest.current.data.settings.contacts,
          notify: (text: string) => latest.current.onMessage(text),
        });
        await bridge.loadPrefs();
        if (cancelled || !root) return;
        const live = () => new Set(latest.current.origin.episodes.filter((e) => e.visible && !(e.publishAt && new Date(e.publishAt) > new Date())).map((e) => e.id));
        ctl = composer.mount(root, {
          episodes: () => latest.current.data.episodes,
          // קישור ישן יכול להביא את הכתובת של התוכנית (slug) במקום המזהה
          episodeId: latest.current.data.episodes.find((e) => e.id === episodeId || e.slug === episodeId)?.id || undefined,
          kind: fromUrl.kind === "digest" || fromUrl.kind === "note" ? fromUrl.kind : "",
          isLive: (e: { id: string }) => live().has(e.id),
          contacts: () => latest.current.data.settings.contacts,
        });
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : "עורך המייל לא נטען."); }
    })();
    return () => {
      cancelled = true;
      try { ctl?.flush?.(); } catch { /* */ }
      void window.RoshMailBridge?.flush();
      if (root) root.innerHTML = "";
    };
  }, [episodeId, attempt, fromUrl.kind]);

  return <section className="admin-panel prog-panel prog-mail">
    <header className="prog-panel-head"><h2>מייל למאזינים</h2></header>
    <p className="panel-help">טיוטת מייל מעוצבת לרשימת התפוצה — על תוכנית חדשה, סיכום של כמה תוכניות או הודעה חופשית. הטיוטה נוצרת ישירות בג׳ימייל שלכם, עם כל הרשימה בעותק מוסתר; שולחים משם. העיצוב, התבניות וההיסטוריה נשמרים בחשבון.</p>
    {error && <p className="prog-error">{error} <button type="button" onClick={() => { setError(""); setAttempt((n) => n + 1); }}>ניסיון חוזר</button></p>}
    <div ref={host} className="mail-tool prog-mail-host" />
  </section>;
}

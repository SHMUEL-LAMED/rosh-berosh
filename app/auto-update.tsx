"use client";

import { useEffect } from "react";
import { updateHeld } from "./update-hold";

/* עדכון בכוח: כשעולה גרסה חדשה של האתר, דף פתוח נטען מחדש לבד — בלי הודעה.
   מזהה הבנייה (__BUILD_ID__, vite.config.ts) נאפה גם בדף וגם בשרת; הדף שואל את /api/version
   כל שתי דקות, וכשחוזרים ללשונית, לחלון או לרשת. כשהשרת עונה מזהה אחר — מחכים לרגע בטוח
   ורק אז טוענים: לא באמצע הקלדה, ניגון, חלון פתוח, העלאה או שמירה (update-hold.ts), ובניהול
   גם לא כשיש שדה שנערך ולא נשמר. אם אחרי הטעינה השרת עדיין עונה אחרת (מטמון בדרך), לא
   טוענים שוב לאותה גרסה במשך עשר דקות — כדי שלא ייווצר מעגל טעינות. */

declare const __BUILD_ID__: string;
export const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "";

const CHECK_EVERY_MS = 2 * 60 * 1000;
const MIN_GAP_MS = 30 * 1000;
const SAFE_RETRY_MS = 3000;
const SAME_VERSION_PAUSE_MS = 10 * 60 * 1000;
const RELOADED_KEY = "rosh-berosh-reloaded-for";
const TEXT_INPUT = /^(text|search|email|url|tel|number|password|date|time|datetime-local|month|week)$/;

function typing() {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && TEXT_INPUT.test((el as HTMLInputElement).type);
}

const mediaPlaying = () => Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video")).some((media) => !media.paused && !media.ended);

/** שדה שהשתנה מאז שנטען ולא נשמר (טופס רגיל; שדה בשליטת React מסונכרן לערך שלו ולכן אינו נספר) */
function unsavedFields() {
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))) {
    if (el instanceof HTMLSelectElement) {
      if (Array.from(el.options).some((option) => option.selected !== option.defaultSelected)) return true;
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      if (el.checked !== el.defaultChecked) return true;
    } else if (el instanceof HTMLInputElement && el.type === "file") {
      if (el.files?.length) return true;
    } else if (el.type !== "hidden" && el.value !== el.defaultValue) return true;
  }
  return false;
}

function busy() {
  return updateHeld() || typing() || mediaPlaying() || !!document.querySelector("dialog[open]") || (window.location.pathname.startsWith("/admin") && unsavedFields());
}

/** מונע מעגל: טעינה אחת לכל גרסה בעשר דקות */
function mayReload(version: string) {
  try {
    const last = JSON.parse(window.sessionStorage.getItem(RELOADED_KEY) || "null") as { v?: string; at?: number } | null;
    if (last?.v === version && Date.now() - (last.at || 0) < SAME_VERSION_PAUSE_MS) return false;
    window.sessionStorage.setItem(RELOADED_KEY, JSON.stringify({ v: version, at: Date.now() }));
  } catch { /* בלי sessionStorage — טוענים בכל זאת */ }
  return true;
}

export function AutoUpdate() {
  useEffect(() => {
    if (!BUILD_ID) return;
    let waiting = 0, done = false, lastCheck = 0;
    const reloadWhenSafe = (version: string) => {
      if (waiting || done) return;
      const attempt = () => {
        if (busy()) return;
        window.clearInterval(waiting);
        done = true;
        if (mayReload(version)) window.location.reload();
      };
      waiting = window.setInterval(attempt, SAFE_RETRY_MS);
      attempt();
    };
    const check = (force = false) => {
      if (waiting || done || (!force && Date.now() - lastCheck < MIN_GAP_MS)) return;
      lastCheck = Date.now();
      fetch("/api/version", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() as Promise<{ version?: unknown }> : null))
        .then((body) => {
          const version = typeof body?.version === "string" ? body.version : "";
          if (version && version !== BUILD_ID) reloadWhenSafe(version);
        })
        .catch(() => { /* בלי רשת — ננסה בפעם הבאה */ });
    };
    const soon = () => { if (document.visibilityState === "visible") check(); };
    const timer = window.setInterval(() => check(true), CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", soon);
    window.addEventListener("focus", soon);
    window.addEventListener("online", soon);
    window.addEventListener("pageshow", soon);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(waiting);
      document.removeEventListener("visibilitychange", soon);
      window.removeEventListener("focus", soon);
      window.removeEventListener("online", soon);
      window.removeEventListener("pageshow", soon);
    };
  }, []);
  return null;
}

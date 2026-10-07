"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AccountChooser, type ChooserMode, type KnownAccount } from "./account-chooser";
import { readKnownAccounts, rememberAccount, writeKnownAccounts } from "./known-accounts.js";

export type User = { email: string; name: string; picture?: string; isAdmin: boolean };

declare global {
  interface Window {
    google?: { accounts: { id: {
      initialize(options: {
        client_id: string;
        callback(response: { credential: string }): void;
        auto_select?: boolean;
        cancel_on_tap_outside?: boolean;
        context?: "signin" | "signup" | "use";
        use_fedcm_for_prompt?: boolean;
        login_hint?: string;
      }): void;
      renderButton(element: HTMLElement, options: Record<string, unknown>): void;
      prompt(): void;
    } } };
  }
}

export function useCurrentUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" }).then(async (response) => response.ok ? (await response.json()).user as User : null).then((user) => {
      // מי שמחובר נזכר במכשיר (כתובת, שם ותמונה) — לחלון בחירת החשבון בכניסה הבאה
      if (user) writeKnownAccounts(localStorage, rememberAccount(readKnownAccounts(localStorage), user));
      setUser(user);
    }).catch(() => setUser(null));
  }, []);
  return [user, setUser] as const;
}

const GOOGLE_BUTTON = { theme: "filled_blue", size: "large", shape: "pill", text: "continue_with", locale: "he", width: 280 };

/**
 * מסך הכניסה. למי שכבר נכנס מהמכשיר הזה נפתח מעל הכרטיס חלון בחירת החשבון (app/account-chooser.tsx):
 * בחירת חשבון מעבירה אותו ל־Google כ־login_hint וקוראת ל־prompt() — בדפדפן עם FedCM נפתח מיד
 * האישור של הדפדפן לאותו חשבון, ובאחרים כפתור Google שבחלון (גם הוא עם הרמז) הוא ההמשך.
 * בלי חשבונות זכורים ההצעה של Google נפתחת מיד, כמו קודם.
 */
export function LoginScreen() {
  const button = useRef<HTMLDivElement>(null);
  const chooserSlot = useRef<HTMLDivElement>(null);
  const clientId = useRef("");
  const hint = useRef<string | undefined>(undefined);
  const [error, setError] = useState("");
  // המסך מצויר רק בדפדפן (הדף מחכה לתשובת /api/auth/me), ולכן אפשר לקרוא את האחסון כבר בהתחלה
  const [host] = useState(() => typeof window === "undefined" ? "" : window.location.host);
  const [accounts] = useState<KnownAccount[]>(() => typeof window === "undefined" ? [] : readKnownAccounts(localStorage));
  const [chooser, setChooser] = useState<ChooserMode | "closed">(() => accounts.length ? "list" : "closed");
  const [picked, setPicked] = useState<KnownAccount | null>(null);
  const [ready, setReady] = useState(false);

  // מגדיר את ספריית Google (ההגדרה האחרונה קובעת): עם login_hint לחשבון שנבחר, או בלי
  const configure = useCallback((loginHint?: string) => {
    if (!window.google || !clientId.current) return;
    window.google.accounts.id.initialize({
      client_id: clientId.current,
      auto_select: false,
      cancel_on_tap_outside: false,
      context: "signin",
      use_fedcm_for_prompt: true,
      ...(loginHint ? { login_hint: loginHint } : {}),
      callback: async ({ credential }) => {
        setError("");
        const response = await fetch("/api/auth/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) });
        if (!response.ok) { setError("ההתחברות נכשלה. נסו שוב."); return; }
        // The offer belongs inside the site, after the account was chosen.
        sessionStorage.setItem("rosh-berosh-show-subscribe", "1");
        window.location.reload();
      },
    });
    hint.current = loginHint;
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/config").then((response) => response.json()).then(({ clientId: id }) => {
      if (!id) throw new Error("Google login is not configured");
      clientId.current = id;
      const start = () => {
        if (!active || !button.current || !window.google) return;
        configure(undefined);
        window.google.accounts.id.renderButton(button.current, GOOGLE_BUTTON);
        // Show Google's account chooser immediately when the browser permits it.
        // The rendered button stays available as a fallback when One Tap/FedCM is
        // unavailable, was dismissed, or is blocked by the browser.
        // עם חשבונות זכורים החלון שלנו הוא בחירת החשבון, וההצעה נפתחת רק לחשבון שנבחר בו.
        if (!accounts.length) window.google.accounts.id.prompt();
        setReady(true);
      };
      if (window.google) return start();
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = start;
      document.head.appendChild(script);
    }).catch(() => setError("ההתחברות עדיין אינה מוגדרת. מנהל המערכת מטפל בכך."));
    return () => { active = false; };
  }, [configure, accounts]);

  // בחרו חשבון (או "שימוש בחשבון אחר"): כפתור Google נכנס לחלון, ולחשבון שנבחר נפתחת מיד ההצעה
  useEffect(() => {
    if (!ready || (chooser !== "picked" && chooser !== "other") || !chooserSlot.current || !window.google) return;
    const loginHint = chooser === "picked" ? picked?.email : undefined;
    if (hint.current !== loginHint) configure(loginHint);
    chooserSlot.current.innerHTML = "";
    window.google.accounts.id.renderButton(chooserSlot.current, GOOGLE_BUTTON);
    if (chooser === "picked") window.google.accounts.id.prompt();
  }, [ready, chooser, picked, configure]);

  const pick = useCallback((account: KnownAccount) => { setError(""); setPicked(account); setChooser("picked"); }, []);
  const other = useCallback(() => { setError(""); setPicked(null); setChooser("other"); }, []);
  const back = useCallback(() => { setError(""); setChooser("list"); }, []);
  const cancel = useCallback(() => { setChooser("closed"); if (hint.current) configure(undefined); }, [configure]);

  return <main className="login-shell" dir="rtl">
    <section className="login-card" inert={chooser !== "closed"}><img className="login-logo" src="/badge.jpg" alt="מצעד האלבומים · 25 שנות מוזיקה" /><p className="kicker">ראש בראש</p><h1>מתחברים ומצביעים</h1><p>מצעד 25 שנות מוזיקה יהודית: בוחרים את האלבומים, השירים והזמרים האהובים עליכם. התוצאות וההצבעה נשמרות לפי כללי המצעד.</p><p>כדי לשמור על הצבעה הוגנת, הכניסה מתבצעת באמצעות חשבון Google.</p><div ref={button} className="google-button" />{error && <p className="vote-error">{error}</p>}<small>לא נפרסם דבר בחשבון שלכם ולא נקבל את הסיסמה שלכם.</small></section>
    {chooser !== "closed" && <AccountChooser host={host} accounts={accounts} mode={chooser} picked={picked} slotRef={chooserSlot} error={error} onPick={pick} onOther={other} onBack={back} onCancel={cancel} />}
  </main>;
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/";
}

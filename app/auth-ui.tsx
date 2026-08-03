"use client";

import { useEffect, useRef, useState } from "react";

export type User = { email: string; name: string; picture?: string; isAdmin: boolean };

declare global {
  interface Window {
    google?: { accounts: { id: {
      initialize(options: { client_id: string; callback(response: { credential: string }): void; auto_select?: boolean }): void;
      renderButton(element: HTMLElement, options: Record<string, unknown>): void;
      prompt(): void;
    } } };
  }
}

export function useCurrentUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" }).then(async (response) => response.ok ? (await response.json()).user as User : null).then(setUser).catch(() => setUser(null));
  }, []);
  return [user, setUser] as const;
}

export function LoginScreen() {
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/auth/config").then((response) => response.json()).then(({ clientId }) => {
      if (!clientId) throw new Error("Google login is not configured");
      const start = () => {
        if (!active || !button.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async ({ credential }) => {
            setError("");
            const response = await fetch("/api/auth/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) });
            if (!response.ok) { setError("ההתחברות נכשלה. נסו שוב."); return; }
            window.location.reload();
          },
        });
        window.google.accounts.id.renderButton(button.current, { theme: "filled_blue", size: "large", shape: "pill", text: "continue_with", locale: "he", width: 280 });
      };
      if (window.google) return start();
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = start;
      document.head.appendChild(script);
    }).catch(() => setError("ההתחברות עדיין אינה מוגדרת. מנהל המערכת מטפל בכך."));
    return () => { active = false; };
  }, []);
  return <main className="login-shell" dir="rtl"><section className="login-card"><div className="logo-mark">ר</div><p className="kicker">ראש בראש</p><h1>מתחברים ומצביעים</h1><p>כדי לשמור על הצבעה הוגנת, הכניסה מתבצעת באמצעות חשבון Google.</p><div ref={button} className="google-button" />{error && <p className="vote-error">{error}</p>}<small>לא נפרסם דבר בחשבון שלכם ולא נקבל את הסיסמה שלכם.</small></section></main>;
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/";
}

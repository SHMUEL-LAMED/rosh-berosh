export const GOOGLE_CLIENT_ID = "601586229891-tv0i3h3m526m9l0clffqghkspjptt2s2.apps.googleusercontent.com";

export type SessionUser = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  isAdmin: boolean;
  exp: number;
};

type AuthEnv = { DB?: D1Database; MEDIA?: R2Bucket; ADMIN_EMAILS?: string };
const ADMIN_LIST_KEY = "settings/admin-emails.json";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function configuredAdminEmails(env?: AuthEnv): string[] {
  return String(env?.ADMIN_EMAILS || "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export async function readAdminEmails(env?: AuthEnv): Promise<string[]> {
  const emails = new Set(configuredAdminEmails(env));
  if (env?.MEDIA) {
    try {
      const object = await env.MEDIA.get(ADMIN_LIST_KEY);
      if (object) {
        const saved = await object.json<string[]>();
        saved.forEach((email) => emails.add(String(email).trim().toLowerCase()));
      }
    } catch (error) {
      console.error("admin list read error", error);
    }
  }
  return [...emails].sort();
}

export async function saveAdminEmails(env: AuthEnv, emails: string[]): Promise<string[]> {
  if (!env.MEDIA) throw new Error("media storage unavailable");
  const normalized = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  await env.MEDIA.put(ADMIN_LIST_KEY, JSON.stringify(normalized), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
  return readAdminEmails(env);
}

const encoder = new TextEncoder();

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function decodePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as T;
}

export async function verifyGoogleCredential(credential: string, env?: AuthEnv): Promise<SessionUser> {
  const parts = credential.split(".");
  if (parts.length !== 3) throw new Error("invalid credential");
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0]);
  const payload = decodePart<{ sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string; aud?: string; iss?: string; exp?: number }>(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("invalid algorithm");

  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) throw new Error("google keys unavailable");
  const jwks = await response.json<{ keys: Array<JsonWebKey & { kid?: string }> }>();
  const jwk = jwks.keys.find((item) => item.kid === header.kid);
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  const now = Math.floor(Date.now() / 1000);
  if (!valid || payload.aud !== GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(payload.iss ?? "") || !payload.exp || payload.exp <= now || !payload.email_verified || !payload.email || !payload.sub) {
    throw new Error("invalid google identity");
  }
  const email = payload.email.toLowerCase();
  const admins = await readAdminEmails(env);
  return { sub: payload.sub, email, name: payload.name || email, picture: payload.picture, isAdmin: admins.includes(email), exp: payload.exp };
}

export async function readSession(request: Request, env?: AuthEnv): Promise<SessionUser | null> {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith("rosh_session="));
  const token = cookie?.slice("rosh_session=".length);
  if (!token) return null;
  if (env?.DB && !token.includes(".")) {
    try {
      const tokenHash = await hashToken(token);
      const row = await env.DB.prepare("SELECT user_sub AS sub,email,name,picture,expires_at AS exp FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()")
        .bind(tokenHash).first<Omit<SessionUser, "isAdmin">>();
      if (!row) return null;
      const admins = await readAdminEmails(env);
      return { ...row, isAdmin: admins.includes(row.email.toLowerCase()) };
    } catch (error) {
      console.error("session read error", error);
      return null;
    }
  }
  // Accept the old one-hour Google-token cookie during the rollout window.
  try {
    return await verifyGoogleCredential(token, env);
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function createSession(env: AuthEnv, user: SessionUser): Promise<string> {
  if (!env.DB) throw new Error("session database unavailable");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64Url(bytes);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at<=unixepoch()"),
    env.DB.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(await hashToken(token), user.sub, user.email, user.name, user.picture || null, expiresAt),
  ]);
  return token;
}

export async function destroySession(request: Request, env: AuthEnv): Promise<void> {
  if (!env.DB) return;
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith("rosh_session="));
  const token = cookie?.slice("rosh_session=".length);
  if (!token || token.includes(".")) return;
  await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await hashToken(token)).run();
}

export const sessionCookie = (token: string) => `rosh_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
export const clearSessionCookie = "rosh_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

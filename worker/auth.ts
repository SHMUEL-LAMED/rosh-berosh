export const GOOGLE_CLIENT_ID = "601586229891-tv0i3h3m526m9l0clffqghkspjptt2s2.apps.googleusercontent.com";

export type SessionUser = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  isAdmin: boolean;
  exp: number;
};

const ADMIN_EMAILS = new Set([
  "o0534169095@gmail.com",
  "0534169095@xn--4dbjbascrao3i.com",
]);

const encoder = new TextEncoder();

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function decodePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as T;
}

export async function verifyGoogleCredential(credential: string): Promise<SessionUser> {
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
  return { sub: payload.sub, email, name: payload.name || email, picture: payload.picture, isAdmin: ADMIN_EMAILS.has(email), exp: payload.exp };
}

export async function readSession(request: Request): Promise<SessionUser | null> {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith("rosh_session="));
  const token = cookie?.slice("rosh_session=".length);
  if (!token) return null;
  try {
    return await verifyGoogleCredential(token);
  } catch {
    return null;
  }
}

export const sessionCookie = (token: string) => `rosh_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`;
export const clearSessionCookie = "rosh_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

/* Web Push בלי ספריות, רק WebCrypto:
   - VAPID (RFC 8292): אסימון JWT חתום ב־ES256 ונשלח בכותרת
     `Authorization: vapid t=<jwt>, k=<המפתח הציבורי>`.
   - הצפנת התוכן ב־aes128gcm (RFC 8291 על גבי RFC 8188): מפתח ECDH חד־פעמי
     מול מפתח הדפדפן (p256dh), סוד האימות (auth), ורשומה אחת מוצפנת.
   המודול עצמאי (בלי ייבוא) כדי שהבדיקות יוכלו לטעון אותו ישירות. */

export type VapidKeys = { publicKey: JsonWebKey; privateKey: JsonWebKey };
type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };
export type PushSubscription = { endpoint: string; p256dh: string; auth: string };

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** זוג מפתחות VAPID חדש (ECDSA P-256) כ־JWK. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as KeyPair;
  return {
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey,
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey,
  };
}

/** המפתח הציבורי כנקודה לא דחוסה (0x04 || x || y) ב־base64url — מה שהדפדפן מקבל כ־applicationServerKey. */
export function publicKeyFromJwk(jwk: JsonWebKey): string {
  return b64urlEncode(concat(new Uint8Array([4]), b64urlDecode(String(jwk.x)), b64urlDecode(String(jwk.y))));
}

/** אסימון VAPID: JWT ב־ES256 שקהל היעד שלו הוא ה־origin של שרת הדחיפה. */
export async function vapidJwt(endpoint: string, privateKey: JsonWebKey, subject: string, expiresAt = Math.floor(Date.now() / 1000) + 12 * 3600): Promise<string> {
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: expiresAt, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", { ...privateKey, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto מחזיר חתימה בפורמט r||s (64 בתים) — בדיוק מה ש־JWS דורש
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64urlEncode(signature)}`;
}

export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  return `vapid t=${await vapidJwt(endpoint, keys.privateKey, subject)}, k=${publicKeyFromJwk(keys.publicKey)}`;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}

/** HKDF עם בלוק פלט אחד (עד 32 בתים), כפי ש־RFC 8291 מתאר אותו. */
export async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/**
 * מצפין תוכן להודעת דחיפה (Content-Encoding: aes128gcm). `options` קיים
 * לבדיקות בלבד: מלח ומפתח שולח קבועים.
 */
export async function encryptPayload(plaintext: Uint8Array, subscription: { p256dh: string; auth: string }, options: { salt?: Uint8Array; senderKeys?: KeyPair } = {}): Promise<Uint8Array> {
  const receiverPublic = b64urlDecode(subscription.p256dh);
  const authSecret = b64urlDecode(subscription.auth);
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 4 || authSecret.length < 16) throw new Error("invalid subscription keys");
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error("payload too large");
  const sender = options.senderKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as KeyPair;
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey) as ArrayBuffer);
  const receiverKey = await crypto.subtle.importKey("raw", receiverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, sender.privateKey, 256));
  const keyInfo = concat(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = options.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // רשומה אחת ואחרונה: התוכן ואחריו בית המפריד 0x02
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + senderPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  header.set(senderPublic, 21);
  return concat(header, ciphertext);
}

/** שולח הודעת דחיפה אחת; מחזיר את קוד התשובה של שרת הדחיפה (0 בכשל רשת). */
export async function sendWebPush(subscription: PushSubscription, payload: unknown, keys: VapidKeys, subject: string, options: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high" } = {}): Promise<number> {
  const body = await encryptPayload(encoder.encode(JSON.stringify(payload)), subscription);
  try {
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization(subscription.endpoint, keys, subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(options.ttl ?? 86400),
        urgency: options.urgency || "normal",
      },
      body,
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch (error) {
    console.error("web push send error", error);
    return 0;
  }
}

import assert from "node:assert/strict";
import { b64urlEncode } from "../worker/web-push.ts";

/* צד הדפדפן של Web Push, לבדיקות בלבד: זוג מפתחות של מנוי ופענוח aes128gcm
   לפי RFC 8291, עם HKDF המובנה של WebCrypto ולא עם זה של המודול הנבדק. */
const subtle = crypto.subtle;
const text = new TextEncoder();

export async function receiverKeys() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, publicRaw, auth, subscription: { p256dh: b64urlEncode(publicRaw), auth: b64urlEncode(auth) } };
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** צד המקבל של RFC 8291: פענוח גוף aes128gcm עם המפתח הפרטי של הדפדפן. */
export async function decryptPush(body, receiver) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const senderPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  assert.ok(ciphertext.length <= rs, "a single record");
  const senderKey = await subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: senderKey }, receiver.pair.privateKey, 256));
  const info = new Uint8Array([...text.encode("WebPush: info\0"), ...receiver.publicRaw, ...senderPublic]);
  const ikm = await hkdf(receiver.auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  assert.equal(padded[end], 2, "the last record ends with the 0x02 delimiter");
  return new TextDecoder().decode(padded.slice(0, end));
}


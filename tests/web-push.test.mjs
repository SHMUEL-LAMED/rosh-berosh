import assert from "node:assert/strict";
import test from "node:test";
import { decryptPush, receiverKeys } from "./push-receiver.mjs";
import { b64urlDecode, b64urlEncode, encryptPayload, generateVapidKeys, publicKeyFromJwk, vapidAuthorization, vapidJwt } from "../worker/web-push.ts";

/**
 * Web Push בלי ספריות: אסימון VAPID (RFC 8292) נבדק מול המפתח הציבורי, והצפנת
 * aes128gcm (RFC 8291/8188) נבדקת בפענוח עצמאי — מימוש של צד הדפדפן כאן בבדיקה,
 * עם HKDF המובנה של WebCrypto ולא עם זה של המודול.
 */

const subtle = crypto.subtle;
const text = new TextEncoder();

test("the VAPID public key is an uncompressed P-256 point", async () => {
  const keys = await generateVapidKeys();
  const point = b64urlDecode(publicKeyFromJwk(keys.publicKey));
  assert.equal(point.length, 65);
  assert.equal(point[0], 4);
  assert.deepEqual(point.slice(1, 33), b64urlDecode(keys.publicKey.x));
});

test("the VAPID JWT is ES256, aimed at the push service origin, and verifies with the public key", async () => {
  const keys = await generateVapidKeys();
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
  const jwt = await vapidJwt(endpoint, keys.privateKey, "mailto:rbr17011701@gmail.com");
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(header))), { typ: "JWT", alg: "ES256" });
  const body = JSON.parse(new TextDecoder().decode(b64urlDecode(claims)));
  assert.equal(body.aud, "https://fcm.googleapis.com");
  assert.equal(body.sub, "mailto:rbr17011701@gmail.com");
  assert.ok(body.exp > Date.now() / 1000 && body.exp <= Date.now() / 1000 + 24 * 3600, "expires within 24 hours");
  const sig = b64urlDecode(signature);
  assert.equal(sig.length, 64, "raw r||s signature");
  const publicKey = await subtle.importKey("raw", b64urlDecode(publicKeyFromJwk(keys.publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig, text.encode(`${header}.${claims}`)), true);
  assert.equal(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig, text.encode(`${header}.x${claims}`)), false);

  const authorization = await vapidAuthorization(endpoint, keys, "mailto:rbr17011701@gmail.com");
  assert.match(authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(authorization.split(", k=")[1], publicKeyFromJwk(keys.publicKey));
});

test("an aes128gcm payload decrypts on the receiving side to the original JSON", async () => {
  const receiver = await receiverKeys();
  const message = JSON.stringify({ title: "תוכנית חדשה", body: "ראש בראש", url: "https://example.com/?a=1", icon: "https://example.com/i.png" });
  const body = await encryptPayload(text.encode(message), receiver.subscription);
  assert.equal(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), 4096, "record size 4096");
  assert.equal(body[20], 65, "the key id is the sender's uncompressed public key");
  assert.equal(await decryptPush(body, receiver), message);

  const again = await encryptPayload(text.encode(message), receiver.subscription);
  assert.notDeepEqual(again.slice(0, 16), body.slice(0, 16), "a fresh salt every time");
});

test("bad subscription keys and oversized payloads are refused", async () => {
  const receiver = await receiverKeys();
  await assert.rejects(encryptPayload(text.encode("x"), { p256dh: b64urlEncode(new Uint8Array(10)), auth: receiver.subscription.auth }));
  await assert.rejects(encryptPayload(new Uint8Array(5000), receiver.subscription));
});

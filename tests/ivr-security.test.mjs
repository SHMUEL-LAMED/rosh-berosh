import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { normalizePhone as normalizeWorkerPhone } from "../worker/phone.js";

const require = createRequire(import.meta.url);
const { normalizePhone: normalizeIvrPhone, phone } = require("../ivr-service/src/phone.js");

const phoneCases = [
  ["0501234567", "0501234567"],
  ["501234567", "0501234567"],
  ["972501234567", "0501234567"],
  ["+972-50-123-4567", "0501234567"],
  ["00972-50-123-4567", "0501234567"],
  ["02-1234567", "021234567"],
  ["unknown", ""],
  ["private", ""],
  ["", ""],
];

test("phone numbers are canonical in both the Worker and IVR service", () => {
  for (const [input, expected] of phoneCases) {
    assert.equal(normalizeWorkerPhone(input), expected, `Worker: ${input}`);
    assert.equal(normalizeIvrPhone(input), expected, `IVR: ${input}`);
  }
});

test("the IVR never falls back to a call id when caller id is missing", () => {
  assert.equal(phone({ callId: "shared-call-id" }), "");
  assert.equal(phone({ ApiPhone: "972501234567", callId: "ignored" }), "0501234567");
});

test("private IVR configuration is never served as public media", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("security-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const requested = [];
  const env = {
    MEDIA: {
      async get(key) {
        requested.push(key);
        return {
          body: "audio",
          httpEtag: "test-etag",
          size: 5,
          writeHttpMetadata(headers) { headers.set("content-type", "audio/wav"); },
        };
      },
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  for (const key of ["config.json", "recorders.json", "nested/private.json"]) {
    const response = await worker.fetch(new Request(`http://localhost/media/ivr-prompts/${key}`), env, ctx);
    assert.equal(response.status, 404, key);
  }
  assert.deepEqual(requested, []);

  const audio = await worker.fetch(new Request("http://localhost/media/ivr-prompts/system-main-test.wav"), env, ctx);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/wav");
});

test("an IVR object with a fake audio extension is still private", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("content-type-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/media/ivr-prompts/secret.wav"),
    {
      MEDIA: {
        async get() {
          return {
            body: '{"secret":true}',
            httpEtag: "test-etag",
            size: 15,
            writeHttpMetadata(headers) { headers.set("content-type", "application/json"); },
          };
        },
      },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 404);
});

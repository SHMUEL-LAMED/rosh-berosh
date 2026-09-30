import assert from "node:assert/strict";
import test from "node:test";

test("server-renders the Hebrew voting page", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );

  const html = await response.text();
  assert.match(html, /<html[^>]*\blang=["']he["']/i);
  assert.match(html, /<html[^>]*\bdir=["']rtl["']/i);
  assert.match(html, /<title>[^<]*ראש בראש[^<]*<\/title>/);
});

test("a closed survey sends home-page visitors straight to the program site", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-closed`);
  const { default: worker } = await import(workerUrl.href);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const envWith = (votingOpen) => ({
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    DB: { prepare: () => ({ bind() { return this; }, first: async () => ({ votingOpen }) }) },
  });
  const visit = (path, env, accept = "text/html") => worker.fetch(new Request(`http://localhost${path}`, { headers: { accept } }), env, ctx);

  const closed = await visit("/", envWith(0));
  assert.equal(closed.status, 302);
  assert.equal(closed.headers.get("location"), "https://shmuel-lamed.github.io/rosh-berosh-2/");
  assert.equal(closed.headers.get("cache-control"), "no-store");
  assert.equal((await visit("/?utm_source=x", envWith(0))).status, 302);

  // ההצבעה פתוחה, תצוגה מקדימה של מנהל, ובקשה שאינה ניווט של דף — לא מועברים
  assert.equal((await visit("/", envWith(1))).status, 200);
  assert.equal((await visit("/?preview=site", envWith(0))).status, 200);
  assert.notEqual((await visit("/", envWith(0), "text/x-component")).status, 302);
});

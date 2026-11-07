import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { describe, it } from "node:test";
import { join } from "node:path";
import { createOwnerServer } from "../packages/owner/src/server.js";
import { ownerFixture, signChallenge } from "./fixtures/owner-support.js";
import type { OwnerChallenge, OwnerOperation, OwnerView } from "../packages/owner/src/types.js";

async function httpFixture() {
  const f = await ownerFixture();
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await writeFile(join(f.directory, "index.html"), '<html><head><meta name="csp-nonce" content="__CSP_NONCE__"></head><body><script type="module" src="/assets/app.js"></script></body></html>');
  const { server, origin } = createOwnerServer({ port, staticDirectory: f.directory, service: f.service() });
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  const post = (path: string, value: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  async function login() {
    const response = await post("challenge", {}); assert.equal(response.status, 200);
    const c = await response.json() as OwnerChallenge;
    const challengeCookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const result = await post("session", await signChallenge(f.owner, c), { cookie: challengeCookie });
    assert.equal(result.status, 200);
    assert.match(result.headers.getSetCookie().find((cookie) => cookie.startsWith("persistara_session="))!, /HttpOnly; SameSite=Strict/);
    const sessionCookie = result.headers.getSetCookie().find((cookie) => cookie.startsWith("persistara_session="))!.split(";")[0]!;
    const session = await result.json() as { csrf: string };
    return { cookie: sessionCookie, "x-persistara-csrf": session.csrf };
  }
  return { ...f, origin, server, post, login, closeHttp: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.close();
  } };
}

describe("loopback owner console HTTP boundary", () => {
  it("serves a nonce-protected page and only public information before authentication", async () => {
    const f = await httpFixture();
    try {
      const page = await fetch(f.origin); const html = await page.text();
      assert.equal(page.status, 200); assert.equal(html.includes("__CSP_NONCE__"), false);
      assert.match(html, /<script nonce="[A-Za-z0-9+/=]+"/); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
      assert.equal(page.headers.get("cache-control"), "no-store");
      const info = await (await fetch(`${f.origin}/api/info`)).json() as { fixture: boolean };
      assert.equal(info.fixture, false); assert.equal(JSON.stringify(info).includes(f.owner.toString()), false);
      assert.equal((await fetch(`${f.origin}/api/state`)).status, 403);
      assert.equal((await fetch(`${f.origin}/api/session`)).status, 403);
    } finally { await f.closeHttp(); }
  });
  it("rejects Host rebinding, foreign/missing Origin and non-JSON requests", async () => {
    const f = await httpFixture();
    try {
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${f.origin}/api/info`, { headers: { host: "evil.invalid" } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
        request.on("error", reject); request.end();
      });
      assert.equal(wrongHost, 421);
      assert.equal((await f.post("challenge", {}, { origin: "https://evil.invalid" })).status, 403);
      assert.equal((await fetch(`${f.origin}/api/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
      assert.equal((await f.post("challenge", {}, { "content-type": "text/plain" })).status, 400);
      assert.equal((await f.post("challenge", { extra: "field" })).status, 400);
      assert.equal(f.journal().pending(), null);
    } finally { await f.closeHttp(); }
  });
  it("requires matching owner proof, HttpOnly SameSite session and CSRF before preparing an action", async () => {
    const f = await httpFixture();
    try {
      const headers = await f.login();
      const session = await fetch(`${f.origin}/api/session`, { headers: { cookie: headers.cookie } }); assert.equal(session.status, 200);
      assert.equal((await f.post("prepare", { paused: true }, { cookie: headers.cookie })).status, 403);
      assert.equal((await f.post("prepare", { paused: true }, { ...headers, "x-persistara-csrf": "wrong" })).status, 403);
      const prepared = await f.post("prepare", { paused: true }, headers); assert.equal(prepared.status, 200);
      const data = await prepared.json() as { operation: OwnerOperation }; assert.equal(data.operation.state, "prepared");
      const serialized = JSON.stringify(data);
      assert.equal(serialized.includes(f.owner.toString()), false); assert.equal(serialized.includes(f.directory), false);
      const state = await (await fetch(`${f.origin}/api/state`, { headers: { cookie: headers.cookie } })).json() as { view: OwnerView; pending: OwnerOperation };
      assert.equal(state.view.backup.offDeviceVerified, false); assert.equal(state.pending.request.id, data.operation.request.id);
      assert.equal((await f.post("logout", {}, headers)).status, 200);
      assert.equal((await fetch(`${f.origin}/api/state`, { headers: { cookie: headers.cookie } })).status, 403);
      assert.equal(f.journal().pending()?.state, "prepared");
    } finally { await f.closeHttp(); }
  });
  it("persists handoff before returning a wallet request and refuses repeat dispatch or cancellation", async () => {
    const f = await httpFixture();
    try {
      const headers = await f.login();
      const prepared = await (await f.post("prepare", { paused: true }, headers)).json() as { operation: OwnerOperation };
      const payload = { id: prepared.operation.request.id, digest: prepared.operation.digest };
      const first = await f.post("dispatch", payload, headers); assert.equal(first.status, 200);
      assert.equal(f.journal().pending()?.state, "dispatched"); assert.equal(f.transport.calls, 0);
      assert.equal((await f.post("dispatch", payload, headers)).status, 409);
      assert.equal((await f.post("cancel", { id: payload.id }, headers)).status, 409);
      assert.equal((await f.post("prepare", { paused: true }, headers)).status, 409);
      assert.equal((await f.post("reconcile", { id: payload.id }, headers)).status, 200);
      assert.equal(f.journal().pending()?.state, "dispatched");
    } finally { await f.closeHttp(); }
  });
  it("never serves private files, arbitrary paths, signing routes or raw errors", async () => {
    const f = await httpFixture();
    try {
      await writeFile(join(f.directory, ".env"), "DO_NOT_EXPOSE=fixture");
      for (const path of ["/.env", "/.persistara/keys/near-runtime.key", "/assets/../.env", "/assets/%2e%2e/.env", "/index.html", "/api/sign", "/api/broadcast"]) {
        const response = await fetch(`${f.origin}${path}`); assert.notEqual(response.status, 200); assert.equal((await response.text()).includes("DO_NOT_EXPOSE"), false);
      }
      const headers = await f.login();
      const result = await f.post("prepare", { paused: true, privateKey: "fixture-not-a-key" }, headers);
      assert.equal(result.status, 400); assert.deepEqual(await result.json(), { status: "failed", code: "INVALID_INPUT" });
    } finally { await f.closeHttp(); }
  });
});

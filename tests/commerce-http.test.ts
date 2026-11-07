import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createOwnerServer } from "../packages/owner/src/server.js";
import { MissionService } from "../packages/runtime/src/service.js";
import { captureSource } from "../packages/runtime/src/sources.js";
import { commerceFixture } from "./fixtures/commerce-support.js";
import { signChallenge } from "./fixtures/owner-support.js";
import type { OwnerChallenge } from "../packages/owner/src/types.js";
import type { CommissionView } from "../packages/commerce/src/types.js";
import type { MissionDetail } from "../packages/runtime/src/types.js";

async function setup() {
  const f = await commerceFixture(); const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const address = probe.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const missions = new MissionService(f.missions(), { read: async url => captureSource(url, Buffer.from("Explicit HTTP source fixture, no live requests."), "text/plain", Date.now()) }, f.read);
  const { server, origin } = createOwnerServer({ port: address.port, staticDirectory: f.directory, service: f.ownerService(), missions, commerce: f.service() }); server.listen(address.port, "127.0.0.1"); await once(server, "listening");
  const post = (path: string, value: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  const challengeResponse = await post("challenge", {}), challenge = await challengeResponse.json() as OwnerChallenge;
  const login = await post("session", await signChallenge(f.owner, challenge), { cookie: challengeResponse.headers.get("set-cookie")!.split(";")[0]! });
  const session = await login.json() as { csrf: string }, headers = { cookie: login.headers.getSetCookie().find(c => c.startsWith("persistara_session="))!.split(";")[0]!, "x-persistara-csrf": session.csrf };
  return { ...f, post, origin, headers, closeHttp: async () => { server.closeAllConnections(); await missions.close(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); } };
}
describe("owner-authenticated commission API", () => {
  it("requires the owner session, CSRF, scoped signed files and explicit cost/delivery acknowledgements", async () => {
    const f = await setup();
    try {
      const m = await (await f.post("missions", { requestId: randomUUID(), title: "A commissioned dossier", objective: "Collect primary docs.", criteria: "Inspect captured sources.", sources: ["https://docs.near.org/"] }, f.headers)).json() as MissionDetail;
      const payload = { version: m.mission.version, maximumYoctoNear: "10000000000000000000000" };
      assert.equal((await f.post(`missions/${m.mission.id}/commission`, payload, { cookie: f.headers.cookie })).status, 403);
      assert.equal((await f.post(`missions/${m.mission.id}/commission`, { ...payload, worker: "attacker.testnet" }, f.headers)).status, 400);
      const created = await (await f.post(`missions/${m.mission.id}/commission`, payload, f.headers)).json() as CommissionView;
      assert.equal((await fetch(`${f.origin}/api/commissions/${created.id}/request`)).status, 403);
      const task = f.service().request(created.id), signed = await f.quote(task);
      const quoted = await (await f.post(`commissions/${created.id}/quote`, { signed }, f.headers)).json() as CommissionView;
      assert.equal((await f.post(`commissions/${created.id}/reserve`, { version: quoted.version, quoteDigest: quoted.quoteDigest, acknowledgeStorage: false }, f.headers)).status, 400); assert.equal(f.data.uploads, 0);
      const funded = await (await f.post(`commissions/${created.id}/reserve`, { version: quoted.version, quoteDigest: quoted.quoteDigest, acknowledgeStorage: true }, f.headers)).json() as CommissionView; assert.equal(funded.state, "funded");
      const delivery = await (await f.post(`commissions/${created.id}/delivery`, { signed: await f.delivery(created.id) }, f.headers)).json() as CommissionView;
      const settle = { version: delivery.version, artifactDigest: delivery.artifactDigest, quoteDigest: delivery.quoteDigest, acknowledged: true };
      assert.equal((await f.post(`commissions/${created.id}/settle`, { ...settle, acknowledged: false }, f.headers)).status, 400); assert.equal(f.data.submissions, 1);
      const paid = await (await f.post(`commissions/${created.id}/settle`, settle, f.headers)).json() as CommissionView; assert.equal(paid.state, "paid"); assert.equal(f.data.submissions, 2);
      const detail = await (await fetch(`${f.origin}/api/missions/${m.mission.id}`, { headers: { cookie: f.headers.cookie } })).json() as MissionDetail;
      assert.equal(detail.mission.budget.spent, "10000000000000000000000"); assert.equal(detail.mission.state, "completed");
      const text = JSON.stringify(detail); assert.equal(text.includes(f.directory), false); assert.equal(text.includes(f.owner.toString()), false); assert.equal(text.includes('"privateKey"'), false);
    } finally { await f.closeHttp(); }
  });
  it("fails closed on another agent's resource, expired sessions and unknown commission actions", async () => {
    const f = await setup();
    try {
      const id = `commission:${randomUUID()}`;
      assert.equal((await fetch(`${f.origin}/api/commissions/${id}`, { headers: { cookie: f.headers.cookie } })).status, 400);
      assert.equal((await f.post(`commissions/${id}/sign`, {}, f.headers)).status, 404);
      await f.post("logout", {}, f.headers);
      assert.equal((await f.post(`commissions/${id}/reconcile`, {}, f.headers)).status, 403); assert.equal(f.data.submissions, 0);
    } finally { await f.closeHttp(); }
  });
});

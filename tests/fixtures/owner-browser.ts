/** Explicit browser-test process ONLY: simulated chain + disposable external test wallet. */
import { once } from "node:events";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { KeyPairSigner } from "near-api-js";
import { resolve } from "node:path";
import { canonical } from "../../packages/near/src/protocol.js";
import { createOwnerServer } from "../../packages/owner/src/server.js";
import { ownerFixture, ownerReceipt } from "./owner-support.js";

const f = await ownerFixture();
let mode: "success" | "lost-response" | "reject" | "wrong-owner" = "success", sends = 0, lastHash: string | null = null;
const token = process.env.PERSISTARA_FIXTURE_CONTROL_TOKEN;
if (token !== "owner-browser-fixture-only") throw new Error("Explicit fixture launch required");
const { server } = createOwnerServer({ port: 4387, staticDirectory: resolve("apps/console/dist"), service: f.service(), fixture: true });
const control = createServer((request, response) => {
  void (async () => {
    if (request.headers["x-fixture-control"] !== token || request.method !== "POST") { response.writeHead(403); response.end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of request) { size += part.length; if (size > 32_768) throw new Error("Fixture input limit"); chunks.push(Buffer.from(part)); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); let result: unknown;
    if (request.url === "/reset") {
      const db = new DatabaseSync(f.journalFile); db.exec("DELETE FROM owner_observations; DELETE FROM owner_operations;"); db.close();
      f.view.paused = false; f.view.generation = "3"; f.view.ownerNonce = 30; f.transport.transactions.clear(); mode = "success"; sends = 0; lastHash = null;
      result = { reset: true };
    } else if (request.url === "/mode") { mode = input.mode; result = { mode }; }
    else if (request.url === "/state") result = { owner: f.view.owner, publicKey: f.view.ownerKey, mode, sends, lastHash };
    else if (request.url === "/sign-message") {
      const signer = KeyPairSigner.fromSecretKey((mode === "wrong-owner" ? f.runtime : f.owner).toString());
      const signed = await signer.signNep413Message(f.view.owner, { message: input.message, recipient: input.recipient, nonce: Buffer.from(input.nonce) });
      result = { accountId: signed.accountId, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString("base64") };
    } else if (request.url === "/send") {
      const pending = f.journal().pending();
      if (!pending || pending.state !== "dispatched") throw new Error("Fixture wallet received an unjournaled handoff");
      if (input.network !== "testnet" || input.signerId !== f.config.signerId || input.receiverId !== f.config.contractId || canonical(input.actions) !== canonical(pending.request.actions)) throw new Error("Fixture wallet request mismatch");
      sends++;
      if (mode === "reject") throw new Error("Fixture user rejection without a provable transaction hash");
      const receipt = ownerReceipt(pending); lastHash = receipt.transaction.hash;
      f.transport.transactions.set(lastHash, receipt); f.view.paused = pending.request.paused; f.view.generation = String(BigInt(f.view.generation) + 1n); f.view.ownerNonce++;
      if (mode === "lost-response") throw new Error("Fixture response lost after effect");
      result = { transaction: { hash: lastHash } };
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  })().catch(() => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ fixtureError: true })); });
});
server.listen(4387, "127.0.0.1"); control.listen(4388, "127.0.0.1"); await Promise.all([once(server, "listening"), once(control, "listening")]);
console.log("Explicit owner browser fixture listening on 127.0.0.1:4387");
async function close() { server.closeAllConnections(); control.closeAllConnections(); await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => control.close(() => resolve()))]); await f.close(); process.exit(0); }
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());

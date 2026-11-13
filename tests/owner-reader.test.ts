import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NearRpc } from "../packages/near/src/rpc.js";
import { OwnerReader } from "../packages/owner/src/reader.js";
import { ownerFixture } from "./fixtures/owner-support.js";

describe("owner readiness from pinned finalized chain observations", () => {
  it("bounds a stalled read without authorizing any owner operation", async () => {
    const f = await ownerFixture();
    try {
      const rpc = new NearRpc(f.config, async () => new Promise<never>(() => {}));
      const reader = new OwnerReader(rpc, f.config, f.codeHash, async () => { throw new Error("Must not reach local readiness"); }, 10);
      await assert.rejects(reader.read(), { code: "UPSTREAM_ERROR" });
      assert.equal(f.journal().pending(), null);
    } finally { await f.close(); }
  });
  it("checks the contract code, exact owner key, runtime restrictions, accounting and local backup independently", async () => {
    const f = await ownerFixture();
    try {
      const raw = { id: f.view.agentId, owner: f.view.owner, ownerKey: f.view.ownerKey, paused: false, generation: "3", keyEpoch: "1", head: null,
        delegates: [{ publicKey: f.config.publicKey, expiresAtNs: "1794750000000000000", canCheckpoint: true, canSpend: true }],
        deposited: "100", available: "90", reserved: "0", pending: "0", paid: "10", withdrawn: "0", policyVersion: "1", policy: { maxJobAmount: "20", dailyLimit: "50", approvedWorkers: ["worker.testnet"] } };
      const permission = { FunctionCall: { receiver_id: f.config.contractId, method_names: ["checkpoint_memory", "create_job", "accept_job"], allowance: "250000000000000000000000" } };
      let codeHash = f.codeHash, ownerPermission: unknown = "FullAccess", backup: "verified" | "unavailable" = "verified", held: boolean | null = false;
      let keyBlock = f.view.blockHash, lastKey: string | null = null, duplicateKey = false;
      const rpc = new NearRpc(f.config, async (method, params) => {
        const p = params as Record<string, unknown>;
        if (method === "status") return { chain_id: "testnet", sync_info: { syncing: false } };
        if (method === "block") return { header: { hash: f.view.blockHash, timestamp_nanosec: f.view.timestampNs } };
        assert.equal(p.block_id, f.view.blockHash);
        if (p.request_type === "view_access_key_list") {
          const entries = [{ public_key: f.view.ownerKey, access_key: { nonce: 30, permission: ownerPermission } }, { public_key: f.config.publicKey, access_key: { nonce: 31, permission } }];
          if (duplicateKey) entries.push(entries[0]!);
          return { block_hash: keyBlock, last_key: lastKey, keys: entries };
        }
        if (p.request_type === "view_account") return { block_hash: f.view.blockHash, code_hash: codeHash };
        return { block_hash: f.view.blockHash, result: [...Buffer.from(JSON.stringify(p.method_name === "get_agent" ? raw : null))] };
      });
      const reader = new OwnerReader(rpc, f.config, f.codeHash, async () => ({ backup: { status: backup, offDeviceVerified: false }, localRotationHold: held }));
      assert.equal((await reader.read()).canResume, true);
      ownerPermission = { FunctionCall: permission.FunctionCall }; assert.equal((await reader.read()).ownerKeyFullAccess, false); ownerPermission = "FullAccess";
      permission.FunctionCall.method_names.push("set_paused"); assert.equal((await reader.read()).canResume, false); permission.FunctionCall.method_names.pop();
      permission.FunctionCall.receiver_id = "wrong.testnet"; assert.equal((await reader.read()).canResume, false); permission.FunctionCall.receiver_id = f.config.contractId;
      permission.FunctionCall.allowance = "0"; assert.equal((await reader.read()).canResume, false); permission.FunctionCall.allowance = "250000000000000000000000";
      backup = "unavailable"; assert.equal((await reader.read()).canResume, false); backup = "verified";
      held = true; assert.equal((await reader.read()).canResume, false); held = null; assert.equal((await reader.read()).canResume, false); held = false;
      lastKey = "more-keys"; await assert.rejects(reader.read(), { code: "INTEGRITY_FAILED" }); lastKey = null;
      keyBlock = "another-block"; await assert.rejects(reader.read(), { code: "INTEGRITY_FAILED" }); keyBlock = f.view.blockHash;
      duplicateKey = true; await assert.rejects(reader.read(), { code: "PROTOCOL_ERROR" }); duplicateKey = false;
      raw.available = "91"; await assert.rejects(reader.read(), { code: "INTEGRITY_FAILED" }); raw.available = "90";
      codeHash = "wrong-code"; await assert.rejects(reader.read(), { code: "INTEGRITY_FAILED" });
    } finally { await f.close(); }
  });
  it("reads the runtime key from the agent's own account when it lives there, and never trusts a key left on the owner account", async () => {
    const f = await ownerFixture();
    try {
      const agentId = "research.owner.testnet", config = { ...f.config, agentId, runtimeAccountId: agentId };
      const raw = { id: agentId, owner: f.view.owner, ownerKey: f.view.ownerKey, paused: false, generation: "3", keyEpoch: "1", head: null,
        delegates: [{ publicKey: config.publicKey, expiresAtNs: "1794750000000000000", canCheckpoint: true, canSpend: true }],
        deposited: "100", available: "90", reserved: "0", pending: "0", paid: "10", withdrawn: "0", policyVersion: "1", policy: { maxJobAmount: "20", dailyLimit: "50", approvedWorkers: ["worker.testnet"] } };
      const permission = { FunctionCall: { receiver_id: config.contractId, method_names: ["checkpoint_memory", "create_job", "accept_job"], allowance: "250000000000000000000000" } };
      let keyOn: "agent" | "owner" = "agent", queried: string[] = [];
      const rpc = new NearRpc(config, async (method, params) => {
        const p = params as Record<string, unknown>;
        if (method === "status") return { chain_id: "testnet", sync_info: { syncing: false } };
        if (method === "block") return { header: { hash: f.view.blockHash, timestamp_nanosec: f.view.timestampNs } };
        if (p.request_type === "view_access_key_list") {
          queried.push(String(p.account_id));
          const entries = p.account_id === agentId
            ? [{ public_key: f.view.ownerKey, access_key: { nonce: 1, permission: "FullAccess" } }, ...(keyOn === "agent" ? [{ public_key: config.publicKey, access_key: { nonce: 2, permission } }] : [])]
            : [{ public_key: f.view.ownerKey, access_key: { nonce: 30, permission: "FullAccess" } }, ...(keyOn === "owner" ? [{ public_key: config.publicKey, access_key: { nonce: 31, permission } }] : [])];
          return { block_hash: f.view.blockHash, last_key: null, keys: entries };
        }
        if (p.request_type === "view_account") return { block_hash: f.view.blockHash, code_hash: f.codeHash };
        return { block_hash: f.view.blockHash, result: [...Buffer.from(JSON.stringify(p.method_name === "get_agent" ? raw : null))] };
      });
      const reader = new OwnerReader(rpc, config, f.codeHash, async () => ({ backup: { status: "verified", offDeviceVerified: false }, localRotationHold: false }));
      assert.equal((await reader.read()).canResume, true);
      assert.ok(queried.includes(agentId) && queried.includes(config.signerId), "both accounts' keys were read at the pinned block");
      keyOn = "owner"; assert.equal((await reader.read()).canResume, false, "a runtime key on the owner account does not count in agent-account mode");
    } finally { await f.close(); }
  });
});

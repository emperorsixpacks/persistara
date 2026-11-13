import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nearConfig } from "../packages/near/src/config.js";
import { runtimeAccountOf, validateIdentity } from "../packages/near/src/protocol.js";
import { NearRotationReader } from "../packages/near/src/rotation.js";
import { NearRpc } from "../packages/near/src/rpc.js";

const KEY = "ed25519:E72DSesVRjDkTagRzfsU9HwuQ97gGdf9PaeZk1xdFy2";
const identity = { signerId: "owner.testnet", publicKey: KEY, agentId: "research.owner.testnet" };

describe("runtime key on the agent's own account", () => {
  it("defaults to the owner account and accepts only the agent ID as an alternative", () => {
    assert.equal(runtimeAccountOf(identity), "owner.testnet");
    validateIdentity({ ...identity, runtimeAccountId: "research.owner.testnet" });
    assert.equal(runtimeAccountOf({ ...identity, runtimeAccountId: "research.owner.testnet" }), "research.owner.testnet");
    for (const other of ["other.testnet", "owner.testnet", "evil.owner.testnet", "RESEARCH.owner.testnet"]) assert.throws(() => validateIdentity({ ...identity, runtimeAccountId: other }), { code: "INVALID_INPUT" });
    // The legacy owner:name ID is not an account, so it can never be a runtime account.
    assert.throws(() => validateIdentity({ signerId: "owner.testnet", publicKey: KEY, agentId: "owner.testnet:research", runtimeAccountId: "owner.testnet:research" }), { code: "INVALID_INPUT" });
  });
  it("is read from NEAR_RUNTIME_ACCOUNT, and absent by default", () => {
    const env = { NEAR_AUTHORITY_CONTRACT: "authority.owner.testnet", NEAR_OWNER_ACCOUNT: "owner.testnet", NEAR_RUNTIME_PUBLIC_KEY: KEY, NEAR_AGENT_ID: "research.owner.testnet", NEAR_JOURNAL_FILE: "/tmp/x.sqlite" };
    assert.equal(nearConfig(env).runtimeAccountId, undefined);
    assert.equal(nearConfig({ ...env, NEAR_RUNTIME_ACCOUNT: "research.owner.testnet" }).runtimeAccountId, "research.owner.testnet");
    assert.throws(() => nearConfig({ ...env, NEAR_RUNTIME_ACCOUNT: "somebody.else.testnet" }), { code: "INVALID_INPUT" });
  });
  it("refuses runtime key rotation in this mode instead of editing the wrong account", () => {
    const config = { kind: "testnet" as const, chainId: "testnet", rpcUrl: "https://rpc.testnet.near.org", contractId: "authority.owner.testnet" };
    assert.throws(() => new NearRotationReader(new NearRpc(config), { ...identity, runtimeAccountId: "research.owner.testnet" }), { code: "NOT_CONFIGURED" });
    new NearRotationReader(new NearRpc(config), identity);
  });
});

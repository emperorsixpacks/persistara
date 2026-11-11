import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyPair } from "near-api-js";
import { agentIdMatchesSigner, validateIdentity } from "../packages/near/src/protocol.js";

const publicKey = KeyPair.fromRandom("ed25519").getPublicKey().toString();
const identity = (agentId: string, signerId = "owner.testnet") => ({ signerId, publicKey, agentId, contractId: "authority.testnet" }) as unknown as Parameters<typeof validateIdentity>[0];

describe("agent ID formats accepted by the NEAR client (must mirror the contract)", () => {
  it("accepts the current name.owner subaccount form and the legacy owner:name form of the existing deployment", () => {
    for (const id of ["research.owner.testnet", "re-search.owner.testnet", "a1.owner.testnet", `${"a".repeat(32)}.owner.testnet`, "owner.testnet:research", "owner.testnet:Mixed_Case-1"]) {
      assert.doesNotThrow(() => validateIdentity(identity(id)), id);
    }
  });
  it("rejects names the contract would refuse, another owner's namespace and anything ambiguous", () => {
    for (const id of ["Research.owner.testnet", "a.owner.testnet", "x.y.owner.testnet", "-lead.owner.testnet", "trail-.owner.testnet", "dou--ble.owner.testnet", ".owner.testnet", "research.other.testnet",
      "research", "owner.testnet", "owner.testnet:", "owner.testnet:a:b", "owner.testnet:has space", `${"a".repeat(33)}.owner.testnet`, "research.owner.testnet:extra", ""]) {
      assert.throws(() => validateIdentity(identity(id)), { code: "INVALID_INPUT" }, id);
    }
    assert.equal(agentIdMatchesSigner(undefined, "owner.testnet"), false);
    assert.equal(agentIdMatchesSigner(`${"a".repeat(32)}.${"o".repeat(40)}.testnet`, `${"o".repeat(40)}.testnet`), false, "over NEAR's 64-character limit");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyPair } from "near-api-js";
import { parseOwnerKeyFile } from "../packages/near/src/keyfile.js";

describe("owner key file parsing (generated throwaway keys only)", () => {
  const pair = KeyPair.fromRandom("ed25519"), secret = pair.toString(), pub = pair.getPublicKey().toString(), other = KeyPair.fromRandom("ed25519");
  it("accepts a bare ed25519 secret and a NEAR credentials JSON for the expected account", () => {
    assert.equal(parseOwnerKeyFile(`${secret}\n`, "owner.testnet"), secret);
    assert.equal(parseOwnerKeyFile(JSON.stringify({ account_id: "owner.testnet", public_key: pub, private_key: secret }), "owner.testnet"), secret);
    assert.equal(parseOwnerKeyFile(JSON.stringify({ private_key: secret }), "owner.testnet"), secret, "account and public key are optional");
  });
  it("refuses another account's file, a mismatched public key and malformed input, without echoing key material", () => {
    const failures: [string, RegExp][] = [
      [JSON.stringify({ account_id: "someone.testnet", public_key: pub, private_key: secret }), /belongs to someone\.testnet/],
      [JSON.stringify({ account_id: "owner.testnet", public_key: other.getPublicKey().toString(), private_key: secret }), /does not match/],
      ["not a key", /must contain/], ["{broken", /not valid JSON/], [JSON.stringify({ private_key: "ed25519:short" }), /no usable/], [JSON.stringify([1]), /must contain/], ["", /must contain/],
    ];
    for (const [text, expected] of failures) assert.throws(() => parseOwnerKeyFile(text, "owner.testnet"), (error: Error) => { assert.match(error.message, expected); assert.ok(!error.message.includes(secret.slice(8)) && !error.message.includes(other.toString().slice(8))); return true; });
  });
});

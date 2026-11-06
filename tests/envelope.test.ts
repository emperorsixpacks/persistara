import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { open, seal, type EnvelopeContext } from "../packages/crypto/src/envelope.js";

const context: EnvelopeContext = { agentId: "agent:alice", recordId: "memory:one", keyEpoch: 1, purpose: "memory" };
const plaintext = Buffer.from("A private preference that must survive a runtime restart.");

describe("authenticated memory envelopes", () => {
  it("roundtrips without exposing the plaintext and uses a fresh nonce", () => {
    const key = randomBytes(32);
    const first = seal(plaintext, key, context);
    const second = seal(plaintext, key, context);
    assert.deepEqual(open(first, key, context), plaintext);
    assert.notDeepEqual(first, second);
    assert.equal(Buffer.from(first).includes(plaintext), false);
  });

  it("rejects the wrong key without returning ciphertext as plaintext", () => {
    const encrypted = seal(plaintext, randomBytes(32), context);
    assert.throws(() => open(encrypted, randomBytes(32), context), { code: "AUTHENTICATION_FAILED" });
  });

  it("binds agent, record, epoch, and purpose independently", () => {
    const key = randomBytes(32);
    const encrypted = seal(plaintext, key, context);
    const alternatives: EnvelopeContext[] = [
      { ...context, agentId: "agent:bob" },
      { ...context, recordId: "memory:two" },
      { ...context, keyEpoch: 2 },
      { ...context, purpose: "manifest" },
    ];
    for (const expected of alternatives) {
      assert.throws(() => open(encrypted, key, expected), { code: "AUTHENTICATION_FAILED" });
    }
  });

  it("authenticates context even if an attacker edits the cleartext header", () => {
    const key = randomBytes(32);
    const envelope = JSON.parse(Buffer.from(seal(plaintext, key, context)).toString());
    envelope.context.agentId = "agent:bob";
    assert.throws(() => open(Buffer.from(JSON.stringify(envelope)), key, { ...context, agentId: "agent:bob" }), { code: "AUTHENTICATION_FAILED" });
  });

  it("rejects altered ciphertext and authentication tags", () => {
    const key = randomBytes(32);
    for (const field of ["ciphertext", "tag"] as const) {
      const envelope = JSON.parse(Buffer.from(seal(plaintext, key, context)).toString());
      const bytes = Buffer.from(envelope[field], "base64url");
      bytes[0] = bytes[0]! ^ 1;
      envelope[field] = bytes.toString("base64url");
      assert.throws(() => open(Buffer.from(JSON.stringify(envelope)), key, context), { code: "AUTHENTICATION_FAILED" });
    }
  });

  it("rejects malformed encodings, unsupported versions, and plaintext", () => {
    const key = randomBytes(32);
    const original = JSON.parse(Buffer.from(seal(plaintext, key, context)).toString());
    const invalid: unknown[] = [
      { ...original, version: 2 },
      { ...original, nonce: "!!invalid!!" },
      { ...original, tag: "AA" },
      { ...original, ciphertext: `${original.ciphertext}=` },
      { ...original, extra: true },
      { ...original, context: { ...context, extra: true } },
      { text: plaintext.toString() },
    ];
    for (const value of invalid) {
      assert.throws(() => open(Buffer.from(JSON.stringify(value)), key, context), { code: "INVALID_ENVELOPE" });
    }
    assert.throws(() => open(plaintext, key, context), { code: "INVALID_ENVELOPE" });
    assert.throws(() => open(Buffer.from([0xff]), key, context), { code: "INVALID_ENVELOPE" });
  });

  it("bounds key and payload lengths", () => {
    assert.throws(() => seal(plaintext, randomBytes(31), context), { code: "INVALID_INPUT" });
    assert.throws(() => seal(new Uint8Array(0), randomBytes(32), context), { code: "INVALID_INPUT" });
    assert.throws(() => seal(new Uint8Array(1_000_001), randomBytes(32), context), { code: "INVALID_INPUT" });
    assert.throws(() => open(new Uint8Array(1_500_001), randomBytes(32), context), { code: "INVALID_ENVELOPE" });
  });
});

# 002 — Prove live storage and inference boundaries

Priority P0 · risk medium/high · effort one to two days, contingent on credentials and provider access. Depends on 001. Baseline: Sofer `542813f`, 2026-11-06; review the new repo's current foundation before editing.

## Intent and current state

The pinned 0G and strict NEAR AI adapters are implemented. On 2026-11-07, real Turbo storage acceptance passed upload, finalization, proof-enabled retrieval, authenticated decryption and fresh-process retrieval without uploader credentials. See `docs/evidence/0g-testnet-2026-11-07.json`. Verified inference/tool calling remains deferred at the user's request until AI credits are available. Never silently substitute fixtures when credentials or providers fail.

0G roots and ciphertext SHA-256 are different identifiers. The TS SDK uses a separate EVM uploader and proof-enabled downloads. The project now pins Node 24.22.2, compatible with NEAR AI SDK's documented minimum. Real storage proof does not establish private inference, NEAR checkpoint recovery or long-term availability.

## Scope

Create `packages/storage/src/zero-g.ts`, `packages/inference/src/{provider,near-ai,evidence}.ts`, `scripts/{storage-roundtrip,inference-verify,provider-doctor}.ts`, provider-specific tests, configuration schema, and toolchain documentation. Update package scripts and lockfile. Leave NEAR contract logic to 003. Never modify `/Users/ram/Desktop/sofer`.

## Steps

1. Read current primary docs: 0G SDK at `https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk`; official SDK source at `https://github.com/0gfoundation/0g-storage-ts-sdk`; NEAR AI verified JS SDK at `https://docs.near.ai/cloud/inference-sdk/javascript`. Pin available package versions after inspecting real exports. Record versions and network endpoints in `docs/REFERENCES.md`.
2. Add scripts `provider:doctor`, `spike:storage`, and `spike:inference`. They must report missing prerequisites explicitly and exit nonzero when live requirements are absent. Fake mode is an explicit separate option, never the default fallback.
3. Implement 0G byte upload/download behind `BlobStore`. Require network identity and known storage mode; preserve native root, bytes digest, length, and transaction evidence. Verify retrieved ciphertext and the provider proof path. Bound input, memory, retries, and request duration. Maintain uploader keys outside model-visible tools.
4. Keep application `seal/open` as the authoritative encryption boundary. Avoid double encryption unless explicitly tested. The provider cannot downgrade a failed envelope to plaintext.
5. Verify a compatible isolated Node runtime before adding the NEAR AI verifier. Discover a currently available TEE model with tool support. Implement inference adapter, per-call usage, cancellation, bounded retries, and exact evidence status: `verified`, `unverified`, `failed`, or `unsupported`. No verification status is inferred from an HTTP 200.
6. Run real small-data roundtrips and one inference-verification request. Store a sanitized machine-readable report containing versions, networks, roots, transaction references, sizes, timing, and actual checks. Do not store keys, prompts containing private information, or chain-of-thought.

## Verification

Existing gates: `pnpm check` must continue passing. New gates, created by this plan: `pnpm provider:doctor`, `pnpm spike:storage`, `pnpm spike:inference`. Document which require credentials and cost tokens/credits before invoking them.

Tests must cover corrupt returned bytes, incorrect root/length/digest, failed upload finality, unavailable read, request timeout, cancellation, unsupported model evidence, invalid signature, and malformed streaming tool output. A live run must prove the actual configured 0G network, not just a local roundtrip.

## Done criteria

Both adapters exist with passing offline failure tests; sanitized live reports exist for storage and inference. Fresh processes can retrieve the stored ciphertext and verify it. No published performance claim precedes measurement. If the verified inference path is unavailable, label that subtask blocked and keep 004 recovery work moving; do not mark this plan complete.

## Stop conditions

Provider documentation conflicts with installed SDK behavior; SDK/toolchain version is unavailable; faucet/credentials cannot be obtained; verification evidence does not bind the response as required. Report the exact mismatch and preserve the provider boundary instead of inventing an API.

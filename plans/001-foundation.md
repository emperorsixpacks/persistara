# 001 — Establish an independent, tested foundation

Priority P0 · risk medium · effort one focused implementation pass. Source baseline: Sofer `542813f`, reviewed 2026-11-06. New project: Persistara, NEAR authority + 0G storage + NEAR AI inference. No dependencies.

## Intent and current state

The original Sofer tree at `/Users/ram/Desktop/sofer` remains intact. Its tool declaration is small enough to adapt; its runtime, messaging crypto, wallets, and memory authorization must be rewritten. The new repository must contain real implemented primitives, not placeholder implementations advertising future features.

Existing foundation scope: `packages/protocol/src/{tools,memory}.ts`, `packages/crypto/src/envelope.ts`, `packages/storage/src/local.ts`, `packages/memory/src/service.ts`, and `tests/{envelope,memory}.test.ts`. Tool interface attribution belongs in `NOTICE` and `migration/provenance.json`.

## Steps

1. Create an independent Git repository and private remote; preserve the source working tree. Add product, architecture, security, migration, and reference documents. Do not copy the old dependency lockfile, secrets, deployments, caches, or web work.
2. Define `BlobRef` with provider/network, native object ID, ciphertext digest and length. Define `BlobStore` and finalized-CAS `MemoryHeadStore` ports. The local adapter is development-only; the registry fixture is test-only.
3. Implement bounded AES-256-GCM envelopes with authenticated agent/record/epoch/purpose context. Reject invalid encodings, wrong keys, unsupported versions, and modified bytes without returning plaintext.
4. Implement encrypted manifests, payload-bound operation deduplication, bounded CAS retry, read-after-write before checkpoint, and recovery without the original service instance. Preserve revisions as lineage, not overwrites.
5. Record source hashes and Apache-2.0 provenance. Keep runtime claims aligned with actual implementation.
6. Run `pnpm install --ignore-scripts`, `pnpm check`, and `git diff --check`. Commit only after reviewing the tracked file list for secrets and unrelated imports.

## Done criteria

- `pnpm check` exits zero with encryption, corruption, context substitution, duplicate operations, concurrent writes, lost checkpoint responses, and fresh-service recovery tests passing.
- Wrong-key and tampered content tests produce typed failures.
- Provider upload/read failures never advance the authoritative head.
- Source-provenance hashes match the reviewed source files.
- Repository contains no old `.env`, state, signer keys, deployment IDs, or copied Git metadata.
- README explicitly states that NEAR, 0G, inference, missions, API, and console are not yet implemented.
- New remote is private during development, with no secrets in tracked files. Publishing for the hackathon is a separate release step.

## Stop and investigate

If source content differs from its recorded hash, review it before importing. If key/authentication checks fail, fix before any live storage integration. If GitHub creation fails, retain the complete local project and report the exact remote-creation blocker; do not change accounts or publish to a guessed organization.

## Maintenance

The current encrypted manifest is bounded to 1,000 entries. Live key custody, per-agent index isolation, revocation, and recovery-key wrapping belong to subsequent milestones. The foundation test fixtures do not prove live NEAR authorization or 0G availability.

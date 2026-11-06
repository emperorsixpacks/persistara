# Provider setup and live acceptance

Implemented adapters: 0G Storage SDK **1.2.13**, ethers **6.13.1** (0G's declared peer), NEAR AI inference SDK **0.2.1**. Runtime: **Node 24.22.2**, downloaded and pinned by pnpm's `devEngines.runtime`; the global Node installation is unchanged. Install with pnpm 10.26.0 or the package-manager pin.

## Start

```sh
pnpm install
pnpm check
cp .env.example .env
pnpm provider:doctor
```

Environment loading is explicit at the CLI boundary. `.env`, private-key files and `.persistara/` are ignored by Git. The doctor does not print secret values. Exit 2 means prerequisites are missing; it is not a successful live-provider check. `--online` adds read-only RPC identity/balance checks; it never submits a storage transaction or inference completion.

## Dedicated storage uploader

```sh
pnpm storage:wallet
```

This creates a new **Galileo testnet** wallet in `.persistara/keys/0g-uploader.key` with restricted permissions, or reports the existing wallet's public address without replacing its key. Keep `ZG_UPLOADER_KEY_FILE` in `.env` pointing at that file. Fund its public address from `https://faucet.0g.ai`. This wallet is separate from the NEAR owner, runtime permissions, and memory keys. The command never prints the private key. Do not paste keys into chat.

The adapter is testnet-only (chain ID 16602). The default mode is Turbo with the documented Turbo indexer. Standard requires an explicitly configured indexer; network/mode are part of every blob reference and cannot be silently interchanged.

```sh
pnpm provider:doctor --online
pnpm spike:storage
```

The upload spike spends testnet gas/storage fees. It writes a local intent and ciphertext before dispatch, uploads an application-encrypted fictional record, requires a successful transaction when one was submitted, checks storage finalization, reads with proof verification, checks ciphertext digest/length, and decrypts the specimen. It writes a sanitized success report under `.persistara/evidence` only after all those checks pass. There is no automatic retry of a potentially charged upload. Reused finalized bytes may have no new transaction hash; reports distinguish that case.

Verify retrieval in a fresh process without the uploader key:

```sh
pnpm spike:storage --read .persistara/evidence/storage-<timestamp>.json
```

This validates the stored ciphertext and proof. The specimen key is intentionally not retained, so this command does not claim owner memory-key recovery; that is plan 004.

## Verified inference

Create an account/API key and add credits at `https://cloud.near.ai`. Put `NEARAI_API_KEY` in the ignored `.env` file locally. Discover the actual catalog:

```sh
pnpm inference:models
```

Set `NEARAI_MODEL` to a current model. A catalog entry is not proof of private inference or tool support. The spike requires model attestation, E2EE, a model-bound response signature, and the strict `UpToDate` TCB policy before returning usable text/tools:

```sh
pnpm spike:inference
```

This consumes inference credits. The fictional request asks the model to invoke a harmless `report_ready` tool. The success report records whether tool calling was actually demonstrated, usage, model/completion ID, and exact evidence checks. It does not retain prompts, raw responses, chain-of-thought, API keys or complete attestation contents. Gateway-only or unsupported models fail the strict spike; they are never labeled as verified model inference.

## Interrupted or failed operations

Read failures may be retried after diagnosis. An interrupted paid call produces `OUTCOME_UNKNOWN` and the latest observed root, transaction hash or completion ID. Inspect `.persistara/spikes/<operation-id>/intent.json` and reconcile before another paid request. Killing the local SDK process cannot retract a transaction already broadcast or an inference request already accepted.

The process boundary prevents an SDK call from continuing in the background after the application's deadline. It strips inherited environment and suppresses third-party logs. It is not a general untrusted-code sandbox or a guarantee of OS-level memory isolation. Input and response sizes are bounded; large-storage throughput is outside this spike's scope.

## Compatibility fixes and remaining gates

- 0G's published declarations resolve ethers through CommonJS. The uploader uses the same ethers entry point to avoid mixing incompatible ESM/CJS private types.
- `@freedomofpress/crypto-browser@0.1.8` redundantly declares curves as a dependency and peer, while its parent requires another major version. `.pnpmfile.cjs` removes only that redundant peer, preserving the module's declared curves 1 dependency. The lockfile resolves its own curves 1.9.7 separately from its parent's curves 2.4.0. No cryptographic source code is patched.
- Offline tests validate adapters, process cancellation, evidence contracts and SDK loading/Merkle construction. They do **not** prove a live storage roundtrip or real TEE attestation.
- Plan 002 remains in progress until real storage, fresh-process retrieval, and strict inference/tool-call reports pass. NEAR contracts remain plan 003.

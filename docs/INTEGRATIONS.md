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
pnpm provider:doctor --storage-only --online
pnpm storage:acceptance prepare
pnpm storage:acceptance upload
pnpm storage:acceptance verify
```

`--storage-only` skips inference configuration/import checks; no AI credentials or credits are needed. The doctor checks RPC identity/balance, rather than claiming storage proof acceptance.

The acceptance workflow spends testnet gas/storage fees only at `upload`. `prepare` saves an immutable encrypted fictional specimen, its real SDK Merkle root and a separate random recovery key under `.persistara/acceptance/storage` (directory 0700; files 0600). The exclusive dispatch marker is fsynced **before** invoking the SDK. Repeating `upload` after that marker only probes the recorded root; it never resubmits. Concurrent invocations cannot both dispatch. The command writes a sanitized private `report-<uuid>.json` after proof verification and authenticated decryption succeed.

The Galileo adapter checks selected-node chain/flow identity, pins the official Turbo flow address, and permits at most one transaction submission attempt per worker. Before sending, it populates the transaction and enforces a **0.01 testnet 0G** ceiling on value plus maximum gas cost. Excess cost fails closed. This is a per-upload ceiling, not a total account spending policy. Standard mode still requires an explicit indexer and has not passed live acceptance.

Verify retrieval in a fresh process without the uploader key:

```sh
pnpm storage:acceptance verify
```

`verify` removes the uploader key path from the adapter configuration and freshly downloads, checks proof/digest/length, and authenticates decryption using the saved specimen key. It needs only this acceptance directory and provider access. The report's transaction hash is an observed submission reference; a fresh retrieval does not recheck its transaction receipt. The initial upload adapter checks receipt success when it submits a transaction. This test specimen is separate from NEAR checkpointed memory and owner backup recovery.

Live evidence on 2026-11-07: a real 328-byte encrypted Turbo object was finalized and decrypted; a separate process repeated proof-enabled retrieval/decryption without uploader credentials. Its successful transaction cost **1,266,369,469,505,963 wei** (0.001266369469505963 testnet 0G), leaving 0.498733630530494037 testnet 0G at that observation. [Sanitized evidence](evidence/0g-testnet-2026-11-07.json) records the exact root, transaction, block and measured retrieval times. This is one sample; the five-trial benchmark, long-term availability and combined NEAR memory recovery remain separate gates.

`spike:storage` remains a legacy diagnostic. It discards its specimen key and does not provide this durable dispatch fence; use `storage:acceptance` for new live acceptance. Existing legacy intents must still be reconciled before any replacement operation.

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

For `storage:acceptance`, retain the entire acceptance directory and use `verify` to probe the fixed root. An unavailable dispatched root remains unknown even if no transaction hash was observed. Do not delete its marker or choose another directory to force a replacement. A partial `prepare` fails closed and does not overwrite key material; inspect it before any manual recovery. Reports exclude keys and plaintext, but `recovery.key` is secret. This specimen key is not a wallet key or an owner backup.

The process boundary prevents an SDK call from continuing in the background after the application's deadline. It strips inherited environment and suppresses third-party logs. It is not a general untrusted-code sandbox or a guarantee of OS-level memory isolation. Input and response sizes are bounded; large-storage throughput is outside this spike's scope.

## Compatibility fixes and remaining gates

- 0G's published declarations resolve ethers through CommonJS. The uploader uses the same ethers entry point to avoid mixing incompatible ESM/CJS private types.
- `@freedomofpress/crypto-browser@0.1.8` redundantly declares curves as a dependency and peer, while its parent requires another major version. `.pnpmfile.cjs` removes only that redundant peer, preserving the module's declared curves 1 dependency. The lockfile resolves its own curves 1.9.7 separately from its parent's curves 2.4.0. No cryptographic source code is patched.
- Offline tests validate adapters, process cancellation, durable acceptance/reconciliation, evidence contracts, transaction ceilings and SDK loading/Merkle construction. The separate real Turbo evidence proves the recorded storage roundtrip; it does not prove real TEE attestation.
- Plan 002 has passed its first real storage/fresh-process retrieval gate. Strict inference/tool-call verification remains deferred for AI credits. Public NEAR contract acceptance remains plan 003.

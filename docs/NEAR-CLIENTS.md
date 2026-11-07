# Finalized NEAR clients and restricted signing

`packages/near/src` connects the encrypted memory port and job workflow to the authority contract. AI credentials are not required. A fresh public testnet deployment now exists at `authority.persistara-owner.testnet`, owned by a separate CLI-managed deployment key. The research agent belongs to `persistara-owner.testnet`; the specialist is `worker.persistara-owner.testnet`. Owner/deployer/worker signing stays in the official external NEAR CLI keychain. Application configuration contains public identities and a separate restricted runtime-key path. The [local owner console](OWNER-CONSOLE.md) now implements external-wallet authentication and reviewed pause/resume for this existing agent; actual browser-provider approval remains unverified.

## Components

| Component | Responsibility |
| --- | --- |
| `NearRpc` | HTTPS testnet / explicit loopback sandbox, chain identity check, bounded replies, final views, no automatic request retries |
| `NearAuthorityReader` | Validate agent identity, integer balances/conservation, checkpoints and finalized job state |
| `NearMemoryHeadStore` | Implement `MemoryHeadStore` with generation/epoch checks, CAS and typed unknown outcomes |
| `NearTreasuryClient` | Reserve a job and accept a reviewed artifact; read actual settlement from finalized job storage |
| `IsolatedNearSigner` | Send only checkpoint, reservation and acceptance requests to a separate child process |
| `DurableNearSigner` | Validate a distinct restricted runtime key; serialize/sign through pinned `near-api-js` 7.4.0; persist before broadcasting |
| `NearJournal` | Private SQLite WAL journal with full synchronization, immutable request binding, nonce allocation and outcome reconciliation |

The signer never uses the SDK's automatic transaction/nonce retries. SDK use is limited to standard transaction construction, Borsh encoding and Ed25519 signing. New transactions attach zero NEAR and use 100 Tgas. The prefunded authority contract enforces purchasing budgets. Owner administration and deposits are absent from this runtime interface.

## Configure public testnet

Add the `NEAR_*` settings from `.env.example` to your local ignored environment file after a testnet deployment exists. Contract/account/agent/public-key fields have no placeholder defaults. The runtime key file is separate from the owner key, 0G uploader key and memory encryption material.

The runtime public key must be installed on the owner's account as a function-call key, restricted to the authority receiver and the required subset of:

```text
checkpoint_memory
create_job
accept_job
```

Record a matching delegate grant on the agent. Use a finite gas allowance. The signer rejects full-access keys, unrestricted method lists, extra methods, wrong receivers, zero/unbounded allowances, mismatched key files, the registration owner key, paused agents and absent/expired/insufficient grants. It checks the chain's finalized timestamp for expiry. Contract checks remain authoritative if state changes after this preflight.

Wait for finality on owner setup transactions before starting a runtime session: registration, funding, policy and delegate grants must be finalized. The sandbox scenario explicitly waits for this boundary because its Rust setup API returns optimistic outcomes while the application reads finalized state.

Use **one dedicated runtime key per agent and one journal per key**. Do not use that key through another SDK, process with an independent journal, account/contract configuration, or manual CLI. The default journal path is derived from account/public-key scope, and its stored binding also includes network, contract and agent, so accidental default-path reuse is rejected. Overriding the path does not make sharing a key safe.

Key and journal files require private permissions. Journal directories require mode 0700, files 0600. The worker refuses a symlink key/file through `O_NOFOLLOW`. The journal contains signed transactions, which are capabilities while valid; keep it private and include it in trusted operational backups. It does not contain private keys or decrypted memory. OS/process isolation and the trusted owner machine remain part of the threat model; a child process is not a filesystem/network sandbox.

The journal now records a persistent random instance identity. Durable memory checkpoint plans bind that identity with chain/contract/account/key/agent scope. A replacement or missing journal blocks those plans; the RPC URL is not part of the binding, permitting endpoint failover. The isolated worker checks the expected identity before submission and can replay submitted/terminal outcomes without loading a key. [Durable memory commands](MEMORY-WRITES.md) retain the exact generation/request instead of recalculating a new attempt when an outcome is unknown.

Owner rotation adds an idempotent local signer barrier. It requires all allocated/prepared/submitted/unknown operations to be reconciled first and blocks new nonce allocation afterward. Existing terminal outcomes remain readable. The coordinator uses only key-free journal identity/barrier methods; owner contract/account actions are unsigned review requests for an external wallet. The replacement receives a new dedicated journal. See [rotation controls and limits](OWNER-ROTATION.md).

```sh
pnpm near:doctor
pnpm near:reconcile 'checkpoint:YOUR_RECORDED_OPERATION_HASH'
```

The doctor reads finalized state and key metadata; it never submits a transaction or reads the private key. It prints pause state and delegate expiry for review. Reconciliation requires an existing journal and public configuration but does **not** load the runtime private key. It prints operation ID, transaction hash, status and a sanitized failure code. Exit codes: 0 confirmed, 3 unknown, 1 failed; missing environment settings exit 2. Neither command creates a public account or deploys a contract.

## Durable submission and recovery

```text
allocated -> prepared -> submitted -> confirmed | failed | unknown
                                          unknown -> confirmed | failed
```

Allocation binds a stable operation ID, canonical request digest, exact arguments, nonce and block hash in one short SQLite transaction. Another pending operation blocks new allocation on that key. Signing is outside the database transaction; the resulting signed bytes and client-computed transaction hash become immutable before submission. A conditional state update lets only one caller initiate the broadcast, even when callers race.

Recovery cases:

- **Interrupted before signing:** resubmit the identical operation ID and arguments; signing resumes using the allocated nonce/block hash.
- **Prepared but never marked submitted:** the identical request can resume the first broadcast using the same signed bytes. A status query does not consume this prepared state.
- **Marked submitted, response lost, worker killed or journal update failed:** report unknown, retain the hash, query that transaction, and fence new operations. Never sign a replacement nonce or new logical operation to bypass it.
- **Final success/failure recorded:** replay returns that stored outcome without rebroadcasting. Changed arguments under the same ID fail, including generation changes.

RPC submission and status queries request `wait_until: FINAL`. Confirmation also checks the returned hash, account, key, receiver, nonce, single method/action, arguments, gas and zero deposit against the journal. Optimistic, incomplete or mismatched responses stay unknown. Monetary values remain decimal-string yoctoNEAR; nonce values beyond exact JSON integer capacity are rejected instead of rounded.

The clients trust the configured RPC for chain state/finality; they are not light clients. Automatic expiry proofs, replacement transactions, journal pruning and multi-host key coordination are not implemented. In particular, a crash after the submitted marker but before the request reaches a node can remain unknown. Do not delete a pending journal or move the same key to a new journal to force progress. Expired/unseen transaction resolution is a required operational follow-up before production.

## Memory and settlement semantics

`NearMemoryHeadStore` scopes access to one agent, reads its finalized head, and encodes `U64` fields as strings. A stale CAS returns false; an uncertain transaction throws `OUTCOME_UNKNOWN` with its reference. The memory service can subsequently recover a committed manifest and deduplicate the original memory operation even if the response was lost. Authorized checkpoint references still require storage retrieval/integrity checks before submission.

`NearTreasuryClient` binds reservation to `reserve:<job operation ID>` and acceptance to `accept:<job operation ID>`. Generations/quote arguments are explicit. After a generation change, reconcile the prior operation and read the existing job before deciding on another authorization. A confirmed acceptance receipt is separate from job settlement; the returned job status is read from finalized storage and may be `payout_pending`, `payout_failed` or `paid`.

Acceptance first requires the finalized delivered artifact and expected digest. It does not sign for an absent delivery, disputed job or different artifact. A conclusively failed acceptance transaction can be corrected through an **explicit** numbered attempt: `treasury.accept(jobId, generation, digest, 1)` uses `accept:<jobId>:retry:1`. Attempts are bounded to 1–8 and require the immediately preceding attempt to be recorded and finally failed. An unknown or confirmed transaction never authorizes a replacement. Repeating the same attempt replays the same journal transaction. A successful acceptance followed by a failed payout must follow the contract's payout recovery path, rather than creating another acceptance attempt. Error extraction reads decoded RPC string leaves so a newline before an `ERR_*` code is preserved; old stored outcomes are not rewritten.

## Mechanical public-testnet acceptance

`near:acceptance` requires an explicitly configured, fresh funded agent, exactly the documented 0.02 NEAR job / 0.05 NEAR daily policy, one approved worker, a committed memory checkpoint, and a successful `storage:acceptance` directory. All amounts are testnet-only. It verifies the real storage specimen before each phase and persists one immutable job request before reserving **0.01 testnet NEAR**.

```sh
pnpm near:acceptance prepare
pnpm near:acceptance reserve
# External specialist signer submits delivery-args.json through `deliver`.
pnpm near:acceptance accept
pnpm near:acceptance accept  # replay the same successful request
pnpm near:acceptance reject
pnpm near:acceptance verify
```

Do not rerun `prepare` to replace a pending plan. The phase commands use the same private state directory (`.persistara/acceptance/near` by default), bind deployment/account/runtime identities, and retain sanitized reports. Specialist delivery uses the generated `delivery-args.json`, zero deposit and 30 Tgas through its external CLI keychain. For an already confirmed failed initial acceptance, `pnpm near:acceptance retry-accept` selects explicit attempt 1; repeat that same command to test its replay. `verify` only reads/reconciles receipts and finalized job/accounting state. `reject` submits a stale checkpoint and a 0.03 NEAR over-limit request; it requires a false CAS result and `ERR_JOB_LIMIT` with no created job. These negative transactions consume testnet gas.

The live specimen is deliberately fictional and reused as brief/result to test storage bindings and native settlement. This does **not** demonstrate a research mission, signed specialist quote protocol, autonomous worker, model output or output quality. Those remain plan 005 and the deferred inference gate. See [public evidence](evidence/near-0g-testnet-2026-11-07.json) and [remaining release work](../plans/README.md).

Create matching clients in the trusted host with `createNearClients(config)`. Pass its `heads` to `MemoryService` together with the authorized memory key and blob adapter. Model tools receive narrow capabilities, not this configuration, key files or a generic signing endpoint.

## Verification evidence

The application sandbox scenario runs the TypeScript client in separate processes and uses the real compiled authority WASM and real restricted access keys. The durable memory writer commits a checkpoint with an injected lost response and leaves its local intent pending. A new process reconciles that intent through the existing signer journal before appending two more records. It then reserves a job, delivers through the worker account, settles exactly one native payment, repeats acceptance without another payment, reconciles after removing the signing key, then removes the original keyring, journals and index. A fresh process restores three sourced records, including a revision, from an encrypted owner backup and rebuilds recall. Balance checks allow gas refund receipts to settle first.

Storage in this scenario is explicitly **synthetic local ciphertext storage**, with placeholder 0G-shaped roots. Memory keys and the separate backup secret are random. The scenario is not 0G availability evidence, public testnet deployment or live provider acceptance. A fourth sandbox scenario executes the owner rotation workflow, rejects a reinstalled revoked key, commits under epoch 2, then recovers four records after removing both runtimes. Plan 004 remains in progress for public/live-provider rotation/recovery acceptance and embeddings.

The client milestone passed 58 TypeScript tests, 25 contract unit tests and three deployed-WASM scenarios; the current recovery milestone extends that inventory in `plans/README.md`. The absent-deployment `near:doctor` path exits 2 with `NOT_CONFIGURED`.

Primary references: [NEAR transaction finality/RPC](https://docs.near.org/api/rpc/transactions), [NEAR API libraries](https://docs.near.org/tools/near-api), [official JavaScript SDK](https://github.com/near/near-api-js), [Node SQLite API](https://nodejs.org/api/sqlite.html).

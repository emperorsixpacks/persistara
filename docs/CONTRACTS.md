# NEAR authority contract

The first contract milestone implements agent authority, public encrypted-memory checkpoints, native NEAR budgets, and job escrow in `contracts/authority`. Registry and treasury are Rust modules in **one deployed contract**: permission, generation, pause, and reservation checks execute atomically. Worker transfers are asynchronous.

This is a development implementation. Public testnet deployment and independent review remain release gates. [Application clients and a restricted durable signer](NEAR-CLIENTS.md) are implemented and tested against deployed sandbox WASM. Sandbox references are synthetic ciphertext identifiers; sandbox success does not demonstrate 0G availability or private inference.

## Build and local verification

Pinned toolchain: Rust 1.96.0, `wasm32-unknown-unknown`, near-sdk 5.30.1, near-workspaces 0.24.0, cargo-near 0.22.0. `rust-toolchain.toml` selects Rust and `Cargo.lock` pins dependencies. Install the pinned cargo-near release using the [official release instructions](https://github.com/near/cargo-near/releases/tag/cargo-near-v0.22.0).

```sh
pnpm contract:build
pnpm contract:test
pnpm contract:sandbox
pnpm contract:check
```

`contract:check` runs formatting, Clippy with warnings denied, unit tests, an optimized WASM build, and deployed-WASM sandbox tests. Initial installation needs network access for toolchains, crates and the sandbox binary. The tests then use disposable local accounts; no API key, AI credit, faucet balance or public NEAR account is required. near-workspaces uses sandbox 2.14.0 through its pinned dependency. Rust/SDK require protocol 85 support; verify the target public network before deployment.

The build outputs `target/near/persistara_authority/persistara_authority.wasm`. It uses cargo-near's WASM optimization. The command explicitly says `non-reproducible-wasm`: a local binary checksum is evidence of that artifact, not a reproducible build claim.

Local evidence (2026-11-07): `pnpm contract:check` exits zero. 34 Rust unit tests and four deployed-WASM sandbox scenarios pass, including real function-call key restrictions, revoked-key rejection, stale checkpoint CAS, budget/storage rollback, native payouts, duplicate payment prevention, failed-transfer retry, owner withdrawal, and application settlement/recovery. The new owner-rotation flow verifies idempotent atomic authority changes, account-key replacement, rejected stale spending/checkpoints, new-epoch memory and recovery after removing both runtimes. The optimized macOS build is 288,692 bytes, SHA-256 `e1ca18486c58e92b46cb6920ef66a3517cd4a2132355e91dc6c6168f4e138375`. This checksum is local build evidence; no public deployment hash or transaction is claimed.

This pre-public-deployment revision adds a rotation-record map to the authority root state. Deploy a fresh contract for acceptance. An in-place migration from earlier authority state is not implemented; replacing WASM on a funded existing deployment is not a supported upgrade procedure.

## Authority and keys

Registration creates `owner.account:name`, where `name` has 1–32 ASCII alphanumeric, underscore or hyphen characters. The registration transaction binds **both the owner account and its signing public key**. Direct calls are required for owner and runtime actions; a proxy contract cannot reuse the original signer identity. There is no global application administrator in contract state.

V1 owner authorization requires retaining that registration key. Owner-key rotation, cross-owner transfer, state migration and recovery after losing the registration key are not implemented. The application must disclose this before funding. Deployer access keys still control code replacement at the NEAR account level; deployment key custody and upgrade policy need review before public release.

The owner can grant at most eight delegates, with checkpoint/spending permissions and expiry within 30 days. A delegate is a distinct NEAR function-call access key on the owner's account. Installing that access key and recording its contract grant are separate actions. Scope the key to this receiver and the necessary methods from `checkpoint_memory`, `create_job`, `accept_job`; keep administrative methods excluded. Function-call keys cannot attach a deposit, and their allowance limits gas rather than treasury spending.

Delegate updates, revocation, pause changes, policy changes and memory epoch changes increment the agent's generation. Runtime calls include the expected generation. A revoked key cannot act even if its NEAR access key has not yet been removed. Revoke the contract grant first, then remove the account access key. A key granted for one agent gains no authority over another agent under the same owner.

Pausing stops new reservations and checkpoints. Existing delivery, review, dispute, payment and refund obligations can still progress. Owner acceptance can honor a delivered obligation while paused. Permissionless retries only target an already approved, immutable payment.

## API conventions

Top-level method arguments use Rust `snake_case`; nested structs and views use `camelCase`. Native amounts are **decimal-string yoctoNEAR** (`U128`); versions, generations, attempts and nanosecond timestamps are decimal strings (`U64`). No floating point is used in accounting. Operation IDs contain 1–64 ASCII alphanumeric or `_.:-` characters.

| Methods | Authority and purpose |
| --- | --- |
| `new` | One-time initialization; deployment must initialize immediately |
| `register_agent(name)` | Direct owner key; attached deposit funds storage credit, minimum 0.1 NEAR |
| `set_delegate`, `revoke_delegate`, `set_paused` | Registration owner key; update authority generation |
| `rotate_memory_epoch(agent_id, next_epoch)` | Legacy owner control; next epoch only, does not itself rotate encryption keys |
| `begin_runtime_rotation(request)` | Owner key; immutable operation ID and generation/epoch/head guards; atomically pause, revoke old single-runtime grant, install replacement grant and advance one epoch |
| `finish_runtime_rotation(agent_id, operation_id)` | Owner key; idempotent, verifies pending authority/generation/expiry and applies the explicit resume policy |
| `get_runtime_rotation(agent_id, operation_id)` | Public immutable request and completion-state evidence |
| `configure_policy(agent_id, policy)` | Owner key; per-job cap, UTC daily cap, 1–16 distinct approved workers |
| `add_storage_credit`, `fund` | Owner key; payable, separate storage credit and purchasing balance |
| `checkpoint_memory(agent_id, generation, expected_version, next)` | Authorized checkpoint key; returns false only for a stale current version |
| `get_agent`, `get_memory_head` | Public views; read at finality for canonical application state |
| `create_job(request)` | Authorized spending key; reserves funds and delivery storage atomically |
| `deliver(agent_id, operation_id, result)` | Direct worker account; immutable artifact reference before deadline |
| `accept_job(agent_id, operation_id, generation, expected_result_digest)` | Owner or active spending delegate; binds reviewed artifact and starts payment |
| `cancel_job` | Owner key; funded/undelivered job only, internal refund |
| `dispute_job`, `resolve_dispute` | Owner key; bounded owner-mediated resolution |
| `advance_timeout` | Permissionless progress after a deadline |
| `retry_payout` | Permissionless retry of an approved failed transfer to the original worker |
| `withdraw_funds`, `retry_withdrawal` | Owner key; transfer available purchasing balance to the fixed owner account |
| `get_job`, `get_withdrawal` | Public reconciliation views |
| `on_payout`, `on_withdrawal` | Private callbacks; one promise result, matching pending state and attempt |

Example checkpoint arguments:

```json
{
  "agent_id": "owner.testnet:research",
  "generation": "3",
  "expected_version": "0",
  "next": {
    "version": "1",
    "keyEpoch": "1",
    "manifest": {
      "provider": "0g",
      "network": "0g:16602:turbo",
      "objectId": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "ciphertextSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "byteLength": 400
    }
  }
}
```

This example contains placeholder digests. The contract validates bounded reference structure, version increments and key epochs. The storage client must prove retrieval and authenticate ciphertext **before** calling it. Supported reference networks are `0g:16602:turbo` and `0g:16602:standard`; blob length is 1–1,500,000 bytes.

## Funds, storage and idempotency

Every saved agent enforces:

```text
deposited = available + reserved + pending + paid + withdrawn
```

Storage credit is separate from this equation and never becomes purchasing balance. Actual storage growth consumes owner-prepaid credit at the chain's storage byte price; released bytes restore credit. Each funded job earmarks another 4,096 bytes for its later bounded delivery, so free-credit exhaustion cannot block an existing worker from delivering. Unused delivery reserve returns to free storage credit at delivery or refund. A failed transaction rolls back its record and all economic mutations.

V1 does not withdraw unused storage credit or prune terminal records. The bond remains available for future writes. Deployment also needs native operating funds: outgoing transfers preserve storage stake, all outstanding free/reserved storage credit, pending transfers, and a 0.01 NEAR operating reserve. This conservative reserve may delay concurrent payouts until earlier callbacks settle. There is no v1 platform fee.

Reservations count against the UTC day on which they are created. A refund restores available funds but does **not** replenish that day's allocation. A new UTC window resets only its allocation counter; previous reservations remain reserved. Reconfiguring policy does not clear allocations.

Job IDs combine agent ID and operation ID. Replaying identical creation arguments returns the existing job; different arguments under the same ID fail. Generation checks still apply to runtime replays. After a generation change, reconcile with `get_job` rather than resubmitting old authorization. Withdrawal IDs similarly bind immutable amounts. Pending or completed payments cannot be started twice; callback attempt numbers fence stale outcomes.

## Deadlines and settlement

- A quote must be unexpired when reserved. Delivery must be due within seven days; review windows are one hour to seven days.
- Undelivered jobs return their reservation to the agent treasury after the delivery deadline, or on owner cancellation before delivery.
- Delivered jobs can be accepted immediately. After an unchallenged review window, anyone can trigger payment to the fixed worker.
- During review, the owner can dispute. The owner can resolve by paying the entire amount or refunding it; after seven days without resolution, anyone can trigger a refund to the treasury.
- This is **buyer-controlled dispute resolution**, not impartial arbitration. A malicious buyer can dispute/refund valid work. Use a curated, consenting specialist for this release; an independent arbitrator is a future design change.
- Refunds stay in the treasury. The owner separately withdraws available funds to the owner account.

An acceptance/withdrawal receipt returns a **pending** view. It does not prove payment. The transfer runs in a separate receipt; a private callback records `paid` on success or restores a retryable reservation/balance on failure. Read finalized `get_job`/`get_withdrawal` state before displaying settlement. A missing callback remains pending; never assume failure or create a replacement payment. Callback reconciliation beyond observed final chain state is an operational follow-up.

The mission journal and signer integration must persist operation ID, exact arguments, transaction reference and outcome. On a timeout, reconcile the existing transaction and finalized record. A timeout is not permission to submit a new operation. Contract deduplication complements this journal; it does not replace it.

## Remaining release gates

1. Validate the implemented finalized readers, memory/job clients and restricted signer against a public testnet deployment; complete mission-runner integration in plan 005.
2. Run a small public NEAR testnet workflow, recording network, code hash, transaction references and final states.
3. Connect real 0G encrypted artifacts; keep synthetic sandbox references visibly separate.
4. Complete owner recovery, upgrade/key custody policy, independent review and operating monitoring before mainnet.

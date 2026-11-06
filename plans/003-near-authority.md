# 003 — Enforce ownership, revocation, and economic limits on NEAR

Priority P0 · risk high · effort two to three days. Depends on 001, independent of 002. Project: Persistara, with 0G ciphertext referenced by a NEAR-owned agent record. Source baseline Sofer `542813f` is not a contract template for NEAR.

## Current state and scope

The Rust NEAR authority contract is implemented in `contracts/authority`, split into registry and treasury modules. `packages/near/src` implements finalized readers, `MemoryHeadStore`, job reservation/acceptance, an isolated restricted signer and a durable transaction journal. The application workflow runs against real deployed WASM in sandbox with synthetic storage. Public NEAR testnet smoke evidence remains. Native NEAR is the only purchasing asset in v1. Do not add Intents, NFTs, stablecoins, or cross-owner agent sales to this milestone.

The narrow transaction journal is implemented here because this plan requires persisted intent and unknown-outcome reconciliation. It is not the mission journal or a claim that plan 005 is complete. See `docs/NEAR-CLIENTS.md` for dropped-transaction/expiry recovery limits.

Implementation decision: co-locate registry and treasury in one deployed contract so delegate generations, pause state, and budgets are checked atomically when funds are reserved. Independent contracts would add an asynchronous authorization race without adding first-release product value. Payments to workers still require asynchronous transfer/callback accounting.

## Contract requirements

Registry record: stable agent ID, owner, active/paused state, runtime signer public key/expiry/permissions/generation, checkpoint version, provider/network/blob reference, key epoch, policy version. Never store private keys or plaintext memories. Use owner-funded storage accounting and enforce bounded record sizes.

Runtime authorization is checked against real signer account/key and delegate generation. A caller-supplied agent ID is not authentication. Function-call access keys restrict receiver/methods and gas; they do not enforce job budgets and cannot attach NEAR. Owner-only administrative methods must not be callable by runtime keys.

Treasury: available funds, reservations, pending payouts/refunds, completed amounts, storage stakes, and deterministic policy counters. Reserve funds atomically before creating a funded job. Pending allocations count against the UTC budget window; refunded jobs restore balance but do not reset that window's allocation counter. Keep the conservative accounting definition visible to users.

Every job creation and payment request binds an operation ID to a canonical request digest. Same ID/different payload fails. Payout recipient, asset/network, amount, and accepted artifact cannot be replaced after authorization. Pause/revocation blocks new effects, but does not retroactively cancel already submitted promises.

## Steps

1. Follow current NEAR Rust quickstart and sandbox docs. Pin compatible Rust/near-sdk/near-workspaces versions; add `contract:build` and `contract:test` scripts. Verify toolchain before selecting package versions.
2. Implement registry owner/delegate management and compare-and-swap checkpoints. Check expected version, generation, status, epoch, reference bounds, and signer authority. Events include versions and operation IDs, not sensitive memory.
3. Implement native-NEAR funding and reservations with checked integer arithmetic and explicit storage/gas reserves. Reject over-budget, overspend-across-two-jobs, expired quote, unknown provider, and replay cases.
4. Finalize job deadlines before live funding: worker delivery deadline, buyer review deadline, owner-mediated dispute authority, and an escalation/expiry path that does not leave unbounded unresolved states. Encode transitions in a testable state machine; document what happens if the owner never responds.
5. Implement pending transfer/callback outcome processing. A failed payout remains claimable; duplicate callbacks/claims cannot pay twice. Refunds move reservations back to the internal treasury; owner withdrawals use their own pending transfer/callback. Cross-contract calls are asynchronous and may fail independently.
6. Implement clients that wait for the documented final outcome and return `unknown` on unresolved submission status. Do not turn a timeout into a new operation with a new job ID.
7. Run sandbox integration tests and then a small native-NEAR testnet smoke flow with user-owned development accounts. Record exact network, deployed code hash, transactions, and final states.

## Verification and done criteria

`pnpm check`, new `pnpm contract:build`, and new `pnpm contract:test` all exit zero. Sandbox tests prove unauthorized owner/delegate rejection, expiry, revocation, pause, cross-agent misuse, stale CAS, simultaneous reservations, replay, storage-stake insufficiency, integer bounds, failed promises, and duplicate payout/refund attempts. Assert accounting conservation after every transition.

Live testnet evidence includes register -> delegate -> fund -> reserve -> deliver -> accept -> final payout, plus rejected stale checkpoint and over-budget calls. No fake events or dry quotes count as settlement evidence.

## Stop conditions and maintenance

If a request can bypass limits through another method, stop live testing until fixed. If a deadline policy lacks a terminal path, specify it before funding. Independent contract review is required before mainnet. Registry reference integrity does not imply 0G availability; clients verify content separately.

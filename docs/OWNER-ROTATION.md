# Owner-controlled runtime and memory-key rotation

This workflow replaces a dedicated NEAR runtime key and advances memory encryption by one epoch while retaining historical keys. It needs no NEAR AI credits. The complete workflow passes offline tests and deployed-WASM sandbox tests; public testnet/real 0G rotation acceptance and execution through a browser wallet remain pending. The [local owner console](OWNER-CONSOLE.md) currently supports existing-agent login and pause/resume, with actual browser-provider approval still unverified; it does not execute these rotation stages.

The owner wallet remains external. The coordinator never loads an owner private key, signs an owner transaction, uploads data or broadcasts a transaction. It prepares private runtime material and reviewable unsigned wallet requests, then verifies finalized authority/account state. The sandbox owner harness signs those requests outside the application. Runtime signers still cannot call administrative methods.

## Ordered workflow

1. Validate agent/network/contract ownership, the registered owner key's full-access account permission, the old dedicated runtime and current memory-key epoch. V1 requires exactly one contract delegate; it never silently discards other grants.
2. Generate a distinct Ed25519 runtime key and the next random memory key. Preserve every retained historical key. Save the new private files exclusively, create the encrypted owner backup and separate random recovery secret, then verify the saved backup reproduces the prepared keyring.
3. Persist an immutable preparation intent and plan. Acquire durable barriers on the canonical memory and old signer journals. Pending memory operations or unfinished signer transactions block planned rotation. Preparation retries reuse existing key/secret files; partial exports can finish before a final plan exists. A completed plan never regenerates a missing key.
4. The owner signs `begin_runtime_rotation`. This atomically pauses the agent, revokes the old contract grant, installs the planned replacement grant, advances the memory epoch by exactly one and increments authorization generation. It preserves the existing memory head and purchasing balances.
5. After observing that contract state at a finalized block, the coordinator requests deletion of the old account access key. It then requests installation of the replacement as a function-call key with this contract, the required runtime methods and a finite gas allowance.
6. Verify the old account key is absent and the replacement has the exact planned method scope and full planned allowance. The owner signs `finish_runtime_rotation`, which resumes only if that was the explicit owner intent. Intervening authority changes or an expired replacement grant stop completion.
7. Observe completed authority state, then release the memory barrier with a monotonic minimum epoch. The old signer journal stays held. Provision the new runtime using the prepared files and a separate new signer journal. Old memory-key epochs cannot create new work in the canonical write journal.
8. Commit a sourced memory with the replacement runtime. `owner:rotation:verify` authenticates the new checkpoint, recovers all historical records unchanged and rereads authority/head state before saving a metadata-only verification receipt. Authority completion alone is not evidence that new-epoch memory recovery works.

Contract begin/finish operations bind an immutable operation ID. Identical retries do not advance the epoch/generation twice. A changed request under the same ID fails. Replaying an old completed finish cannot reopen an agent paused afterward. These properties do not mean repeated wallet transactions have no gas cost.

## Owner commands

First configure a deployed authority and the old public/runtime settings from `.env.example`. Keep the canonical memory and signer journals. Their persistent instance identities are part of this plan; replacing or deleting them blocks the workflow. Stop other software using the dedicated runtime key. Do not run a second journal or a manual signer with that key to bypass a barrier.

```sh
pnpm owner:rotation:prepare \
  --operation-id rotation:research:002 \
  --state-dir .persistara/owner-rotation-002 \
  --memory-state-dir .persistara/runtime \
  --keyring .persistara/keys/memory-keyring.json \
  --bundle /path/to/private-owner-backup/epoch2.bundle \
  --secret-file /path/to/separate-private-secret/epoch2.key \
  --resume true

pnpm owner:rotation:next --state-dir .persistara/owner-rotation-002
```

Preparation prints public metadata only. New private files are `next-runtime.key` and `next-memory.json` inside the private owner state directory. The backup and secret must have separate parent directories. Existing material is never overwritten. Directories/files require 0700/0600 permissions on supported macOS/Linux owner machines. Keep the new runtime material away from the old runtime and model-visible tools. Copy and verify the backup pair in separately protected off-device locations before relying on portability; a local authentication check cannot prove off-device custody.

`--resume true` explicitly authorizes resuming after replacement. `--resume false` leaves the agent paused after authority completion; a new write/proof cannot run while paused. The replacement grant expires after 24 hours from initial preparation. The default gas allowance is `1000000000000000000000000` yoctoNEAR (1 NEAR), with an optional `--gas-allowance` integer capped at 5 NEAR. This is an access-key gas allowance, not a purchasing budget. Contract grants cannot gain spending permission beyond the old grant, and the coordinator also avoids expanding the old key's effective method scope.

Each `next` result is either an `OWNER_WALLET_REQUEST` or an authority-completion status. The request is Persistara's review envelope: network, signer/registered owner public key, receiver, bounded actions and a stable request ID. It is not a signed transaction or an automatic wallet connection. A reviewed owner wallet adapter must validate and sign the concrete request. Browser signing integration belongs to the operational console. The tested sandbox adapter is external to the application and accepts only the expected contract calls/key actions.

After signing in the owner wallet, retain that wallet's transaction hash and reconcile its outcome there. Poll `owner:rotation:next` for finalized postconditions before proceeding. Seeing the same request again is **not** permission to sign a replacement transaction: the earlier wallet transaction may still be pending. The application does not automatically retry wallet sends, allocate owner nonces or claim a complete gas-payment receipt. On-chain idempotency protects begin/finish state changes; duplicate account-key actions can still fail and consume gas.

Issuance is recorded atomically with the journal barrier/fencing checks, then unsigned requests are saved as `wallet-<stage>.json` before they are returned. If the process exits before that file is saved, the issuance marker still prevents an unsafe abort; `next` recreates the identical request. Positive finalized observations are recorded separately as `observed-<stage>.json`. These receipts verify authority/account state, not wallet signing, fee finality or off-device backup storage. All agent, rotation and access-key queries use the same finalized block hash; incomplete/paginated lists, wrong blocks, wrong scopes and unsupported key types fail closed. V1 bounds the account listing at 128 keys.

Once authority completes, `next` prints the replacement's **public configuration and private file paths**, never key bytes. Activate those settings for the new runtime:

- `NEAR_RUNTIME_PUBLIC_KEY`: returned replacement public key.
- `NEAR_RUNTIME_KEY_FILE`: prepared `next-runtime.key`.
- `NEAR_JOURNAL_FILE`: returned new signer-journal path, distinct from the old one.
- Memory write `--keyring`: prepared `next-memory.json`; keep the same canonical `--state-dir` for memory writes.

The coordinator does not silently rewrite `.env`. Its later commands recover the old journal's public identity/paths from the private intent, so they still work after the runtime environment is switched. Do not point the replacement at the old signer journal or delete that journal to reuse a nonce history.

Use `memory:write` to save a new sourced fact through the new runtime, then:

```sh
pnpm owner:rotation:verify --state-dir .persistara/owner-rotation-002
```

The verification receipt records the checkpoint fingerprint, version, epochs and record counts. Memory text/source and private keys never enter plans, wallet requests, observations or receipts. Rebuild recall through [owner recovery](RECOVERY.md) after commitment; a stale cache remains `INDEX_STALE` until refreshed.

## Interruption, abort and emergency controls

Before any wallet request has been issued, `owner:rotation:abort --state-dir ...` can release this plan's local barriers. It preserves prepared files and historical keys and never reuses the operation ID. The journal atomically excludes later issuance before asynchronous marker/signer cleanup, making cleanup resumable after interruption. If an owner request was issued or authority changed, abort refuses: first reconcile the wallet/chain outcome. Stop concurrent owner preparation commands; repeat abort if an interrupted/late local command left a signer hold. Neither abort nor preparation erases an uploaded object or refunds gas.

Pending memory writes must be reconciled or safely canceled using the durable writer. Unknown signer transactions retain their original nonce history. This workflow does not add expiry proofs, replacement nonces, a force-unlock mechanism or automatic repair of missing journals. Expired grants, superseded rotations, manual owner policy/pause changes and missing/replaced key/backup files stop the planned flow for owner review. Existing owner administration remains available for manual recovery; the coordinator does not guess new authority or roll back encryption epochs.

**Emergency revocation must not wait for a graceful drain.** Use the existing registered-owner `set_paused`/`revoke_delegate` controls and remove the compromised access key. The planned coordinator is for reviewed replacement with intact journals. Already submitted obligations/outcomes still need reconciliation. Revocation cannot retract old plaintext or historical keys that a runtime already obtained; the new memory key protects future envelopes.

This rotates runtime and memory keys, not the registration owner's wallet key. Cross-owner transfer, owner-wallet-key replacement, multi-runtime rotation and automatic journal pruning remain unsupported. The contract currently cannot inspect account access keys: the coordinator checks deletion and restriction through finalized RPC state. The owner wallet is trusted and can bypass the coordinator, so do not attribute those off-chain checks to contract enforcement.

New access-key nonces can be initialized from block height; zero is not a valid universal freshness check. The workflow instead checks key absence before preparation, restrictive scope, and the full planned allowance before activation. See the [NEAR access-key implementation](https://github.com/near/nearcore/blob/master/core/primitives-core/src/account.rs).

## Evidence and deployment boundary

`pnpm check` covers preparation restarts, partial backup exports, pending-work barriers, journal replacement, scope/finality errors, v1-to-v2 memory-journal migration, secret redaction, expired/changed authority and historical recovery. `pnpm contract:check` covers owner-only atomic rotation and replay semantics plus the deployed-WASM workflow.

The new sandbox scenario prepares a replacement, executes the four reviewed owner stages in separate application processes, retries contract requests without repeating epoch changes, proves a reinstalled revoked key cannot checkpoint or reserve funds, writes with the new key, and deletes both runtimes/journals. Another process recovers four records across epochs 1 and 2 using only the updated owner backup and public identifiers. Storage is explicitly synthetic local ciphertext, not real 0G proof evidence.

Memory journal schema 2 adds persistent instance identity, rotation hold and minimum-epoch controls while retaining schema-1 encrypted operations. The authority contract's root state also gains a rotation-record map. This is a **pre-public-deployment state-layout change**: deploy a fresh contract for acceptance. An in-place migration of previously deployed authority state has not been implemented; do not overwrite a funded existing deployment with this WASM.

Public NEAR deployment, real 0G write/recovery measurements, reviewed wallet integration and independent review remain release gates. No NEAR AI key/credit, paid inference, real upload or public owner transaction is used by these development tests.

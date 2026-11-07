# Durable memory writes and interruption recovery

`DurableMemoryWriter` persists encrypted intents and fixed storage/checkpoint identities before effects. It is wired to the 0G adapter and NEAR restricted signer. Local and deployed-WASM sandbox tests verify restart behavior; public NEAR/real 0G acceptance remains pending. No AI credits are required.

## Commit sequence

1. Validate and snapshot the request. Bind its operation ID to the text/source/revision digest, a random memory ID, creation time, encryption epoch and sealed record bytes. Persist this encrypted intent in the private SQLite journal with full synchronization.
2. Authenticate the current finalized memory snapshot and look for a matching committed operation. A matching duplicate is adopted; a different payload under that ID is a conflict. Check checkpoint permission/expiry, function-call-key scope and upload readiness before dispatching new storage work.
3. Compute the provider-native root without uploading. Persist the root, network, ciphertext digest/length and exact ciphertext. Mark the upload `dispatched` in a separate committed SQL transaction **before** invoking the provider.
4. Verify the uploaded bytes by reading the prepared reference. Mark availability only after digest/length checks. Encrypt and persist the next manifest, then follow the same preparation/dispatch/read sequence for it. Validate the entire proposed snapshot before publishing its head.
5. Persist the checkpoint's exact expected version, next head, authorization generation, operation ID and signer-journal binding. Mark it dispatched before calling the signer. The signer separately journals the exact signed transaction and nonce before broadcast.
6. Reconcile that attempt before replacing it. A confirmed CAS rejection permits a new manifest merged with the newer head, retaining the original record ciphertext. A transaction failure is recorded; a matching operation in the authenticated finalized manifest can still establish canonical completion. Unknown is never treated as a CAS rejection.
7. After the operation is present with the expected payload in finalized, authenticated memory, mark it committed locally. Refresh recall separately. An unavailable index cannot undo committed source data.

The generic `MemoryService.remember` remains a non-durable protocol foundation used by some invariant tests. Live callers must use `DurableMemoryWriter`; it is not safe to bypass the journal through the foundation writer.

## What interruption means

| Persisted boundary | Read-only reconciliation | Explicit resume |
| --- | --- | --- |
| Intent or prepared upload, never dispatched | Report pending; check canonical memory | Use the persisted ciphertext and prepared reference |
| Upload dispatched, result missing | Probe that exact root with authenticated reads | Probe only; never dispatch the upload again |
| Root unavailable, incomplete or unverifiable | Remain unknown or report integrity failure | Stop; missing data does not prove no charge occurred |
| Checkpoint dispatched | Query its existing signer-journal transaction | Resume the exact request through the same signer journal; submitted transactions are queried, not replaced |
| Accepted checkpoint, local completion missing | Verify finalized manifest/record and mark committed | Same; do not create another memory |
| Confirmed CAS rejection | Keep the observed rejection | Rebase against authenticated committed memory with a new manifest attempt |

A storage object becoming available proves the ciphertext can be retrieved; it does not establish the final fee or the absence of another in-flight provider transaction. Submitted 0G transaction hashes are recorded when observed, but hash observation is not a complete payment receipt. No exactly-once external execution or automatic fee reconciliation is claimed.

0G root preparation runs inside the pinned SDK worker without an uploader key path or network access. Upload preflight reads the configured chain, key file and balance in an isolated worker without submitting. A failure before dispatch stays safely resumable. Failures after the dispatch marker remain conservative, including the small window where a process dies before the provider receives anything.

The NEAR signer journal has a persistent random instance identity. Durable checkpoint attempts bind that identity alongside chain, contract, account, runtime public key and agent. A missing, replaced or differently bound journal blocks submission instead of silently recreating transaction history. Changing the RPC endpoint preserves this binding. Terminal/submitted NEAR outcomes can be reconciled without loading a runtime private key; unfinished allocation/preparation may still need it during explicit resume.

Unseen/expired NEAR transactions can remain unknown because automatic expiry proofs and nonce replacement are not implemented. Unavailable 0G roots can also remain unknown indefinitely. These are deliberate safety limits: there is no force-retry command. Do not bypass them with another operation ID, another state directory, a new signer journal, or manual transaction submission.

## Owner commands

Configure the public NEAR fields and separate runtime/uploader key paths from `.env.example`. Prepare and verify the owner memory backup first; see [recovery](RECOVERY.md). Use a protected JSON input file, mode 0600 in an owner-private directory, to keep memory content out of shell history and process arguments:

```json
{
  "operationId": "memory:research-preference:001",
  "text": "Research reports must cite dated primary sources.",
  "source": { "kind": "owner", "reference": "conversation:research-brief" }
}
```

```sh
pnpm memory:write \
  --keyring .persistara/keys/memory-keyring.json \
  --state-dir .persistara/runtime \
  --input-file /path/to/private-input/memory.json

pnpm memory:writes:reconcile \
  --keyring .persistara/keys/memory-keyring.json \
  --state-dir .persistara/runtime \
  --operation-id memory:research-preference:001

pnpm memory:resume \
  --keyring .persistara/keys/memory-keyring.json \
  --state-dir .persistara/runtime \
  --operation-id memory:research-preference:001
```

`write` and `resume` can spend testnet storage fees and NEAR gas. `reconcile` reads providers/chain and updates the local journal; it cannot upload, sign, broadcast or prepare a new checkpoint. Its storage adapter receives no uploader key path. The required memory keyring stays inside the trusted owner runtime. All commands print receipt metadata, never memory text, source text, encryption keys or signing keys. Missing public configuration exits 2 with `NOT_CONFIGURED`; no live command falls back to fixtures. A pending/unknown receipt exits 3; failed/conflicting receipts and validation errors exit 1; committed or canceled receipts exit 0.

After commitment, run the read-only `memory:recover` command with the verified owner backup and the desired state directory, then `memory:recall`. A stale recall index reports `INDEX_STALE` until rebuilt. The write receipt includes `recallRefreshRequired`; index publication is not represented as part of chain finality.

To abandon local work with **no unresolved dispatched effect**, use `memory:writes:cancel` with the same keyring/state-directory/operation-ID flags. It does not retract canonical memory, cancel another authorized process, delete ciphertext, refund storage, or permit reusing that operation ID. It refuses unknown uploads, outstanding checkpoints and accepted checkpoints awaiting local reconciliation. A known uploaded orphan may remain a sunk cost. Cancellation is not an escape hatch for uncertain effects.

## Journal custody and concurrency

Keep one canonical memory write journal per agent, at `<state-dir>/writes.sqlite`, and one dedicated NEAR signer journal per runtime key. They have separate network/authority bindings and responsibilities. Do not fork or roll back either journal to bypass pending operations. Preserve both for unfinished writes. The owner key backup recovers committed memory; it does not reconstruct unfinished local intents or missing nonce history.

The memory journal uses schema version 1, SQLite WAL, `synchronous=FULL`, parameterized statements and short SQL transactions. It stores sealed record/manifest bytes and private operational metadata: IDs, epochs, payload hashes, roots, signer binding, observed transaction hashes and outcomes. It stores no raw memory text/source, memory keys, uploader key or NEAR private key. Treat operational metadata and the signer's signed transactions as sensitive. Use a consistent SQLite backup or stop the writer cleanly before operational copying; copying a live main database without its WAL is not a valid backup procedure.

Directories must be mode 0700 and database files 0600 on the supported macOS/Linux owner machine. Unknown files, symlink database paths, foreign scopes and unsupported schemas are rejected. These controls assume a trusted operator machine and a local filesystem with correct SQLite locking/durability. They do not provide multi-host coordination or protection against a compromised owner account.

One pending operation per agent journal fences new work. A 30-second writer lease renews every 10 seconds; another process reports `WRITE_BUSY` until release or expiry. Expired leases are replaced with a higher fencing token. Every journal mutation checks that token and expiry, and renewal failure invalidates the old holder locally. An already dispatched external request may still complete late; its dispatch marker prevents a replacement upload, and a newer holder reconciles its root/outcome. No SQL transaction spans asynchronous provider work.

Current caps are 1,000 total journal operations and 16 checkpoint attempts per operation, in addition to the existing 1,000-record/16-MiB recovered-memory limits. Failed/canceled entries and orphaned manifests are retained; pruning/garbage collection is not implemented. These are conservative bounds, not a measured throughput or disk-usage claim. Live latency, cost and availability measurements remain required.

## Evidence and remaining gates

```sh
pnpm check
pnpm memory:writes:fixture
pnpm memory:recover:fixture
pnpm contract:check
```

The write fixture deliberately exits one process after a local upload completes and another after an emulated checkpoint commits. Fresh processes reconcile each interruption, rebuild sourced recall, and observe one record upload, one manifest upload and one checkpoint effect. It is explicitly `LOCAL_FIXTURE_ONLY`; the authority emulator and local ciphertext are not public blockchain or 0G proof evidence.

The deployed-WASM sandbox scenario additionally uses the real TypeScript durable writer, restricted signer, real NEAR checkpoints, a lost checkpoint response and fresh-process reconciliation before writing more records. It settles a native job once and recovers committed memory from an owner backup after removing original runtime state. Storage remains explicitly synthetic.

Public NEAR deployment, real 0G upload/recovery and measurements, full owner rotation, embeddings, mission integration, safe resolution of indefinitely unknown outcomes and independent review remain release gates. AI credits remain deferred.

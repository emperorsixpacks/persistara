# Signed specialist commissions

Persistara can attach one curated, self-operated source specialist to a queued mission. The workflow is **signed quote → encrypted brief upload → bounded NEAR reservation → source collection → encrypted delivery → exact owner review → finalized payout**. It uses no inference or NEAR AI credits. Captured source material remains untrusted; signatures and storage proofs do not establish research correctness.

The initial transport is explicit signed-file exchange. There is no deployed specialist HTTP service or multi-tenant marketplace. The existing authority WASM is unchanged.

## Configure separate roles

Use the existing testnet deployment, local authority WASM, restricted runtime signer/journal, approved worker policy and funded 0G Turbo uploader described in [integration setup](INTEGRATIONS.md). The specialist account must differ from the owner and have its own pinned full-access signing key in the **external official NEAR CLI keychain**. The owner and specialist wallet secrets never enter Persistara configuration or application input.

Add public configuration to the private local `.env`:

```dotenv
PERSISTARA_SPECIALIST_ACCOUNT=worker.persistara-owner.testnet
PERSISTARA_SPECIALIST_SIGNING_KEY=ed25519:REPLACE_WITH_WORKER_PUBLIC_KEY
PERSISTARA_SPECIALIST_STATE_DIR=.persistara/specialist
PERSISTARA_SPECIALIST_PROFILE=.persistara/specialist/profile.json
PERSISTARA_SPECIALIST_PRICE_YOCTO=10000000000000000000000
NEAR_CLI_BIN=near
```

`NEAR_CLI_BIN` may be an absolute path. Commands use the CLI's `testnet` network configuration and existing keychain. Configure its RPC endpoint independently if necessary. The application reader uses `NEAR_RPC_URL`; a tested alternative is `https://rpc.testnet.fastnear.com`.

```sh
pnpm specialist init
pnpm owner:console
```

`init` creates a separate 3072-bit RSA recipient key and an expiring, domain-bound NEP-413 profile signed externally by the worker. It submits no transaction. The profile binds the owner, agent, contract, chain, deployed code hash, worker account/public key, recipient public key and price. A missing or expired profile prevents new commissions; existing funded obligations retain their recorded profile. Do not delete existing recipient keys to renew a profile. Profile renewal with key migration is not automated.

The owner host's new `--commerce-state-dir` defaults to `.persistara/commerce/research`. Its private SQLite commission journal, buyer recipient key and canonical restricted-signer journal must survive restarts. The existing mission journal migrates from schema 1 to 2 while retaining source missions. One commission is linked to each mission; a linked mission cannot also run or approve the local zero-spend path.

## Complete a commission

1. Connect the original owner, create a source mission and choose **Commission specialist**. The configured specialist must be approved by finalized policy. Choose a positive integer-base-unit maximum within current treasury and policy limits.
2. Download the encrypted task request. It contains public scope/recipient keys, fixed operation IDs and a JWE-encrypted brief, without private keys. Transfer the file to the specialist operator.
3. From the specialist's configured checkout, sign a quote using a stable private job directory:

   ```sh
   pnpm specialist quote /absolute/path/request.json .persistara/specialist/jobs/JOB
   ```

4. Import `JOB/quote.json` in the owner console. Review the verified worker, exact price, network, quote expiry, delivery deadline, review window and upload ceiling. Explicit approval uploads the fixed encrypted brief and reserves the purchase amount from the existing treasury. Reservation does not pay the specialist. No attached deposit is required from the restricted runtime.
5. Run the specialist against that same job directory:

   ```sh
   pnpm specialist fulfill .persistara/specialist/jobs/JOB
   pnpm specialist deliver .persistara/specialist/jobs/JOB
   ```

   `fulfill` verifies the funded job, captures the approved public HTTPS sources using the narrow bounded reader, preserves completed captures and uploads a fixed dossier encrypted to the buyer's separate recipient key. `deliver` asks the external worker wallet to submit the fixed result reference, then signs `JOB/delivery.json` after finalized observation. Gas and upload costs require testnet funds. There is no model, general shell tool or interpretation of source text as executable instructions.
6. Import `JOB/delivery.json`. The host checks its NEP-413 signature and exact task/quote scope, finalized immutable job result, 0G Merkle proof, ciphertext digest/length, JWE authentication, original brief/source ordering and dossier fingerprint. Inspect the actual source excerpts and dates. Explicit review binds **both the delivery digest and quote digest** before one acceptance is dispatched through the restricted signer's existing journal.
7. Reconcile until the contract's payout callback records `paid`. Acceptance confirmation and `payout_pending` are not payment completion. Mission completion and spent-budget projection require verified delivery, exact owner review and finalized paid state. Repeated observation does not submit another acceptance.

The default quote expires after 30 minutes, requires delivery within 24 hours, and gives a one-hour review window after delivery. Once that window passes, anyone may trigger an unchallenged payout under the contract rules. Disputes are buyer-controlled; independent arbitration is not implemented. The console displays the signed terms before reservation and finalized review/dispute deadlines in receipt details. See [contract deadlines](CONTRACTS.md#deadlines-and-settlement).

## Costs and custody

The configured default price is **0.01 testnet NEAR** (`10000000000000000000000` yoctoNEAR). Runtime gas allowance is distinct from purchasing funds. Each encrypted brief/result upload permits one submission attempt capped at **0.01 testnet 0G including maximum gas**; this is a ceiling, not a measured charge. This self-operated integration uses the configured separate uploader wallet for both uploads. A remote specialist deployment should provide its own uploader credentials and isolated runtime.

JWE Compact uses `RSA-OAEP-256` and `A256GCM` through pinned `jose`, with recipient thumbprint and full mission/commission/purpose context authenticated. Buyer and worker recipient private keys are separate from wallet, memory and uploader keys. Wrong keys, context swaps or modified envelopes fail closed without plaintext fallback.

Buyer recipient material lives at `COMMERCE_STATE/keys/recipient.key`; specialist material lives at `SPECIALIST_STATE/keys/recipient.key`. Losing the buyer key loses access to its encrypted deliveries. **Memory recovery bundles do not include these recipient keys.** Back them up securely and verify restoration separately. The [portable owner recovery kit](RECOVERY-KIT.md) now includes the buyer recipient key alongside the separate memory keyring and signed delivery descriptors; it does not change the memory-only bundle format. The application does not offer private-key downloads. A same-machine copy/fresh-process test does not establish off-device custody.

Briefs, captured excerpts and decrypted dossiers remain in private local journals/cache; on-chain identifiers, timing, price, worker, criteria hash, roots and ciphertext sizes remain public. Key revocation cannot erase material already obtained by another party.

## Interruptions and recovery

Every upload, reservation, worker delivery and acceptance persists its fixed intent/handoff before dispatch. After an uncertain response, retain the same mission, job directory, roots and journals. **Do not delete markers, replace the signer journal, create a replacement operation or re-encrypt/re-upload to make a retry succeed.**

- The console's **Reconcile existing outcome** only reads fixed blob roots, existing signer receipts and finalized job state. An unknown brief upload can become `brief_ready` when its exact bytes are available. A fresh explicit review of that same quote can then dispatch its first reservation; unknown reservation/acceptance states never authorize replacement submissions.
- `pnpm specialist fulfill JOB` resumes remaining source reads and probes the existing result root after an upload handoff. Completed source captures are retained. Public reads may be repeated explicitly if no capture was committed.
- `pnpm specialist reconcile JOB` is read-only: it neither uploads nor invokes a wallet. If delivery has become finalized, `pnpm specialist deliver JOB` can produce the missing signed receipt without another delivery transaction. An unseen dispatched delivery stays fenced.
- A conclusively failed payout can be explicitly retried with `pnpm specialist retry-payout JOB`. The request remains the same fixed worker/amount; a durable marker binds each observed payout attempt. Pending, paid or unknown outcomes do not authorize another retry. The console can export the corresponding fixed unsigned recovery request.
- A conclusively failed acceptance can expose a fixed original-owner unsigned `accept_job` recovery request. Actual signing remains external. Unknown acceptance outcomes do not expose a replacement request. Current UI does not execute dispute/refund/owner-recovery requests.
- Missing or replaced canonical signer journals prevent further signing. A matching finalized job can still be observed. Some pre-dispatch crashes and unseen transactions can remain unknown indefinitely; no force-clear endpoint or nonce-replacement proof is implemented.

Shutdown drains in-flight HTTP handlers before journals close; an aborted browser request is not proof that an effect stopped. Pausing/worker-policy removal blocks new business, while already funded obligations follow the contract lifecycle. Delivery verification still requires the pinned worker's finalized full-access signing key.

## Verification boundaries

`pnpm runtime:test` covers mission, commission, encryption, protocol, HTTP authorization and specialist recovery invariants. `pnpm test:e2e` includes quote review, delivery inspection, payout callback observation, unknown uploads and reloads using an explicitly labeled disposable browser fixture. It does not establish real browser-provider approval.

The sixth deployed-WASM scenario uses externally signed worker messages, an actual restricted runtime, separate process exits after reservation/acceptance, one actual sandbox payout, and fresh-process recipient-key recovery after original runtime state is removed. Its ciphertext store and source text are explicit local fixtures. Public NEAR/0G acceptance evidence is recorded separately. No test or live mechanical source workflow establishes AI output quality, audited production safety or physical cross-machine recovery.


Public acceptance on 2026-11-07 completed the real signed workflow against the existing NEAR testnet authority and 0G Turbo: two actual documentation captures, host restart after funding, verified encrypted delivery, exact review and one finalized 0.01 NEAR payout. Repeated read-only observation retained payout attempt 1 and treasury conservation. Two actual storage transactions cost a combined **0.002601735018573906 testnet 0G**, each below its 0.01 ceiling. Reservation/acceptance gas is measured separately in [sanitized evidence](evidence/specialist-commission-2026-11-07.json); worker delivery gas is additional. A separate empty-environment process decrypted the real result with a copied recipient key, without uploader/runtime/worker keys or original journals. Original live files were retained, and the backup remains on this machine. No browser-provider approval or AI-quality claim is implied.

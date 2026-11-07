# Portable owner recovery kit

The recovery kit combines the historical **memory keyring** and the separate **buyer delivery-recipient key** in one authenticated encrypted export. It also includes the immutable signed task/quote/delivery descriptors needed to verify recorded specialist artifacts. It preserves these two distinct recovery boundaries; it does not turn a memory key into a wallet or delivery key.

It contains no owner/worker wallet key, restricted runtime key, 0G uploader key, API credential, pending-effect journal or plaintext recall database. Restoring it cannot recover wallet ownership or authorize a replacement payment/checkpoint. The existing memory-only backup format remains supported.

## Prepare on the original machine

Use the configured owner-local checkout and current memory backup files. The command authenticates the existing memory backup against its keyring, checks the finalized authority/code/active epoch, verifies the separate recipient key and signed delivery descriptors, and creates a new private export directory. It uses no AI and submits no upload or transaction.

```sh
pnpm recovery:kit prepare \
  --out-dir .persistara/recovery/kits/portable-v1 \
  --secret-file .persistara/keys/portable-v1.secret
```

Defaults match the existing owner console: `.persistara/keys/memory-keyring.json`, `.persistara/recovery/research.bundle`, `.persistara/keys/research-recovery.secret`, and `.persistara/commerce/research`. Override with `--keyring`, `--bundle`, `--memory-secret-file` and `--commerce-state-dir`. These are operator-selected local paths, never HTTP inputs.

The export directory contains:

| File | Purpose |
| --- | --- |
| `owner.kit` | Authenticated encrypted owner recovery material |
| `manifest.json` | Public provider URLs, scope and ciphertext fingerprint |
| `TRANSFER.txt` | Commands and the fingerprint to compare independently |

The random kit secret is written exclusively to the separate `--secret-file`, outside the export directory. It is never printed or passed as a command-line value. Keep that secret in a separately protected backup location; copying both kit and secret into the same exposed location defeats the separation. Wallet backups remain in the external wallet's own custody workflow.

The command prints only metadata, including `kitSha256`, retained memory epochs and delivery count. Record that fingerprint through an independent trusted channel before transferring the kit. The fingerprint is not a secret. A manifest copied beside an untrusted replacement kit is not an independent trust anchor.

Existing files/directories are never overwritten. An interrupted export may leave an incomplete new directory or secret file. Preserve the old working backup and verify a complete pair before using the export. New memory epochs and later delivered commissions require a newly prepared kit; older kits may lack newer keys/descriptors. Current limits are 250 recorded delivered commissions, 450,000 bytes of private payload and 1,000,000 bytes for the encrypted kit. Oversized exports fail; records are never silently omitted. Undelivered local missions and uncertain effects still require their canonical journals.

## Transfer and verify offline

Copy the **export directory** to an external physical drive or trusted second machine. The encrypted kit and public manifest can be stored on non-POSIX removable media; bounded readers reject symlinks/irregular files but do not require private ciphertext permissions. The **secret file** must remain mode 0600 in a private directory on the machine performing recovery. Current supported targets are macOS/Linux.

On a trusted Persistara checkout of this release, install dependencies and build. Restoring needs Node/pnpm and public-provider connectivity; it does not require Rust, a local WASM build, the original `.env`, original journals, original wallet or uploader credentials.

```sh
pnpm install --frozen-lockfile
pnpm build

pnpm recovery:kit verify \
  --kit /path/on/recovery-device/owner.kit \
  --secret-file /separate/private/portable-v1.secret \
  --expect-sha256 YOUR_INDEPENDENTLY_RECORDED_FINGERPRINT
```

`verify` is entirely offline. It checks the exact ciphertext fingerprint, authenticated header/scope, historical memory keys, recipient-key roundtrip and every recorded specialist signature/binding. It never loads `.env` or contacts a provider. Wrong secrets, substituted headers, modified content, changed scope, malformed encodings and missing recipient material fail closed.

## Restore using public reads

```sh
pnpm recovery:kit recover \
  --kit /path/on/recovery-device/owner.kit \
  --secret-file /separate/private/portable-v1.secret \
  --expect-sha256 YOUR_INDEPENDENTLY_RECORDED_FINGERPRINT \
  --manifest /path/on/recovery-device/manifest.json \
  --state-dir /private/new/persistara-recovery
```

The state directory must be new, within a private parent directory. The command never reads `.env`, loads a signing/uploader key, uploads, submits a transaction or replays a pending effect. It pins code/owner/head to finalized NEAR observations, rejects a checkpoint older than the captured kit checkpoint, authenticates the committed memory manifest and every historical record, verifies full fixed job requests and immutable result references, and decrypts each signed delivery with 0G proof/digest/length checks. A changed head during recovery fails instead of publishing a mixed snapshot. A previously valid signature remains usable for historical recovery even if the worker later rotates its account key; no new worker authority or payment is inferred.

Only after all remote content verifies does the command write a private recall cache, `memory-keyring.json`, optional `delivery-recipient.key`, and authenticated artifact files. `recovery-report.json` is the completion receipt. An earlier failure leaves an `INCOMPLETE` marker and no completion receipt; use another fresh directory after fixing the prerequisite. A crash immediately after receipt publication can leave a stale marker—the authenticated completion receipt takes precedence. No existing healthy runtime/index is replaced.

The restored files contain private keys and decrypted material. Keep the entire restored state private. A successfully rebuilt index/delivery is read-only recovery; enabling future writes still requires the appropriate owner-controlled runtime grant, storage funding and new canonical operational setup. Restoring keys does not restore uncertain nonce/payment journals.

## What counts as off-device verification

Offline authentication and real-provider recovery on this Mac are **local preparation**, even with an empty process environment. A real second-machine run should use only a copied kit, the separately protected secret, its independent fingerprint and public settings; keep original runtime state inaccessible to that process. A physical-drive drill must identify the actual external medium and verify a read back from that copy. Installer disk images, another folder or a virtual disk on the same storage do not establish independent-device custody.

The CLI always reports `offDeviceVerified: false` and requires an independent device observation. Hostnames or a caller-supplied flag cannot prove physical separation. A successful second-device observation must be recorded separately with the recovery receipt and kit fingerprint, without any key, secret, plaintext memory, signature proof or session token. It does not automatically change the console's local-backup status.

Automated evidence covers wrong secrets/fingerprints, recipient substitution, tampered headers/requests, unavailable ciphertext, changing checkpoints, original-environment independence and refusal to overwrite an existing state directory. The deployed-WASM scenario recovers two sourced memories and one paid encrypted delivery after removing original buyer state and specialist private material, using an encrypted kit in a fresh process. Its sources/storage are explicit fixtures. Physical browser-wallet approval and off-device custody remain distinct acceptance gates until actually observed.


A real local preparation drill on 2026-11-07 authenticated the kit offline and recovered the existing public-testnet checkpoint (one sourced memory) and paid specialist artifact using proof-checked 0G reads in a fresh empty-environment process. Original memory/recipient key comparisons and private restored permissions passed. No upload, transaction or inference was invoked. The original files were retained and no external device was supplied. [Sanitized evidence](evidence/recovery-kit-local-2026-11-07.json) therefore records local verification only, with physical off-device and browser-provider gates still unverified.

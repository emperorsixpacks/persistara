# Local owner connection and controls

The console connects an external NEAR wallet to the **existing configured agent**, verifies its original registered owner key, displays finalized authority/runtime/treasury state and local backup readiness, and supports reviewed pause/resume transactions. It requires no AI credits. Owner-control transactions stay in the external wallet; the server never loads its owner key. The separately scoped commission service uses the existing isolated restricted runtime signer for bounded reservation/acceptance.

The host now includes the redesigned [source mission desk](MISSIONS.md), alongside these owner controls. [Signed specialist commerce](COMMISSIONS.md) now adds quote review, encrypted delivery and finalized payment. Model-driven research and new-agent enrollment remain pending. Browser registration, key installation/grants, funding and execution of prepared rotation requests remain follow-up work. Their CLI/contract implementations remain separate. Public hosting and multi-tenant API authentication are outside this local host's trust boundary.

## Run

Use Node 24.22.2 and pnpm 10.26.0 in the Persistara checkout. The private `.env` must configure the existing NEAR authority, owner, agent and separate runtime public key. Build the authority WASM if it is absent; the console checks the deployed code hash against this local artifact.

```sh
pnpm install --frozen-lockfile
pnpm contract:build
pnpm owner:console
```

Open the exact printed address: **http://127.0.0.1:3377**. The server binds only loopback and rejects other Host values, including a `localhost` alias. Stop it with Ctrl+C. The command builds the server and browser assets first.

Default owner-local paths:

| Argument | Default |
| --- | --- |
| `--state-dir` | `.persistara/owner-console` |
| `--commerce-state-dir` | `.persistara/commerce/research` |
| `--mission-state-dir` | `.persistara/missions/research` |
| `--memory-state-dir` | `.persistara/runtime/research` |
| `--keyring` | `.persistara/keys/memory-keyring.json` |
| `--bundle` | `.persistara/recovery/research.bundle` |
| `--secret-file` | `.persistara/keys/research-recovery.secret` |
| `--port` | `3377` |

Paths are supplied by the local operator, never by HTTP requests. Use the same canonical owner journal on every restart. The application does not expose key/recovery downloads or arbitrary files. Backup authentication reads the existing memory material locally and returns only readiness status; **off-device backup remains unverified**.

`NEAR_RPC_URL` selects the HTTPS testnet reader. A tested explicit alternative is `https://rpc.testnet.fastnear.com`; changing the endpoint does not change chain/account/contract bindings. Readiness checks have a 20-second aggregate deadline and use one network check followed by parallel authority/code/key queries pinned to one finalized block. An unavailable RPC disables changes rather than substituting a fixture.

## Connect the correct wallet

Choose **Connect NEAR wallet**, select a compatible testnet wallet, and approve the one-time NEP-413 login message. Connecting adds no runtime access key. The connector filters for message signing, sign-in without adding a key, and transaction support. Its public manifest included NEAR CLI support when checked on 2026-11-07, which can preserve the existing CLI keychain custody without importing a key into Persistara. Provider support can change; a wallet must actually implement all required methods.

The existing `persistara-owner.testnet:research` agent is bound to its original public key. Another full-access key on the same account does not satisfy contract owner checks. The login proof must match that exact registered key and a finalized full-access account permission. Private keys and seed phrases have no application input field or API route. Owner-wallet credential backup/export stays in the external wallet; local memory-backup authentication does not back up the wallet key.

The challenge binds origin, network, owner account, contract, agent, random nonce and challenge ID; it expires after five minutes and is consumed before verification awaits. The pinned SDK's standard NEP-413 verifier uses the independently pinned owner-key observation. A successful proof creates a ten-minute server-side session with an HttpOnly, SameSite=Strict cookie. Mutation routes require a separate CSRF token and exact Origin. Logout/restart invalidates sessions without deleting pending operation history. Reconnecting replaces the page's previous session; an expired session cannot enable controls.

## Review and reconcile an owner change

1. Inspect owner authority, restricted runtime methods/allowance/expiry, memory checkpoint, treasury caps and local backup status.
2. Choose **Review pause** or **Review resume**. Resume requires an authenticated current-epoch backup, a ready restricted runtime, and no local rotation hold; emergency pause remains available when recovery readiness is missing.
3. Review the agent, contract, original owner key, pause target, request fingerprint, zero attached NEAR and maximum 100 Tgas. Gas still costs testnet NEAR. A separate acknowledgement enables the wallet button.
4. The server rechecks current owner/generation/nonce/readiness and durably marks the handoff before returning it. The external wallet then reviews, signs and sends the transaction.
5. The console treats the wallet's response only as a candidate transaction hash. It reads the public RPC and requires the exact signer/account/key/receiver/single action/arguments/gas/zero deposit, a nonce newer than the prepared finalized observation, matching return data and **FINAL** execution status before recording success.

The owner journal is private SQLite WAL with full synchronization, immutable request/digest bindings and a unique pending-operation constraint. A prepared review can be canceled before handoff. Once dispatched, it survives restart as unknown and cannot be dispatched or canceled again. Confirmed/failed receipts replay from the same journal. Wallets allocate their actual nonce; this adapter does not precompute signed transaction bytes, allocate owner nonces or claim exactly-once wallet execution. Other owner tools can still act outside this host.

NEAR Connect **0.12.0** exposes `signMessage` and `signAndSendTransaction`. Although its feature metadata contains `signTransaction`, its pinned public wallet interface has no offline transaction-signing method. Persistara does not invent one or silently fall back to importing a key.

When a wallet returns an error, is canceled or loses a response, that alone cannot prove no transaction was broadcast. Use **Transaction hash from your wallet → Check transaction**. Candidate hashes persist as observations; only a matching transaction can become the canonical hash, so a typo or mismatched receipt cannot replace it. An unavailable/non-final result stays unresolved and blocks new owner requests. Chain state coincidentally matching the desired pause target is not sufficient transaction evidence. A handoff without a recoverable hash may remain fenced indefinitely; there is no force-clear/resend endpoint. Sign-only wallet support or reviewed nonce/expiry proofs are production follow-up work.

Pausing blocks new runtime spending/checkpoints; already committed payment obligations continue. Resume uses existing contract policy. This console does not rotate the registration owner's key, erase old memory keys or complete the separate rotation coordinator's gates.

## Validation and limits

```sh
pnpm check
pnpm web:build
pnpm test:e2e
pnpm contract:check
```

At the first owner-console milestone, **167 TypeScript tests in 24 suites** passed, covering standard owner signatures, wrong/runtime keys, replay/expiry/CSRF, Host/Origin restrictions, private-path isolation, exact request/receipt matching, concurrent/restarted handoffs, changed authority, wrong-block/truncated key lists and bounded readiness. The production browser build passes. **Four Chromium tests** exercise reviewed pause/resume, safe review cancellation, lost-response recovery after reload, wrong-key rejection and desktop/mobile/keyboard behavior. These use an explicitly labeled disposable wallet and simulated transport; they are not live-wallet evidence. Screenshots were visually inspected. The browser artifact contains no server/recovery modules or actual application key material.

**34 Rust tests and five deployed-WASM sandbox scenarios** pass. The new scenario hands public unsigned requests to an external Rust owner signer, verifies actual finalized pause/resume receipts across processes, blocks repeated handoff and rejects administrative calls from the restricted runtime key. No owner/runtime secret is supplied to that application fixture. Its backup readiness is explicitly a fixture; actual local backup authentication is independently recorded in the live login report.

The real original owner also signed an origin-bound NEP-413 challenge through the external official NEAR CLI keychain. The local console authenticated it, read finalized authority and locally authenticated backup readiness, then logged out. [Sanitized live evidence](evidence/owner-wallet-login-2026-11-07.json) contains no signature, nonce, cookie, CSRF token, recovery secret or private key. No public transaction or AI call was made in that check. The environment had no connected real browser/wallet surface, so **actual browser-provider approval remains unverified**; neither the external CLI proof nor the fixture browser tests are mislabeled as that gate.

The host trusts the operator's machine, pinned dependencies, selected external wallet and configured RPC. It is not a light client, general untrusted-code sandbox or protection against another process with the owner's filesystem/OS access. Wallet executors use the connector's sandboxed iframes and dynamic manifest. The page applies nonce-based script CSP and blocks framing; provider network access remains necessary. Public hosting, new-agent enrollment, rotation UI, physical off-device recovery, model-driven research and independent review remain release work. The current commissioning milestone passes 199 TypeScript tests and 11 Chromium tests; its real public-source captures remain separate from live browser-wallet approval.

Primary references: [NEAR wallet login](https://docs.near.org/web3-apps/tutorials/wallet-login), [NEP-413 authentication](https://docs.near.org/web3-apps/backend/backend), [connector source](https://github.com/azbang/near-connect), [pinned SDK NEP-413 implementation](https://github.com/near/near-api-js).

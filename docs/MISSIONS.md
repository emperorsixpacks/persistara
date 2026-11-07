# Durable source missions

The no-credit workflow is **brief → collect approved public sources → retain progress → inspect dossier → record owner review**. It uses real HTTPS reads and a private local SQLite journal. It does not invoke inference, sign a transaction, commission a specialist, upload to 0G or advance encrypted memory. Every mission's maximum and actual spending are `"0"` yoctoNEAR on `near:testnet`; requests containing spending/provider/owner override fields are rejected.

## Run and use

```sh
pnpm owner:console
```

Open `http://127.0.0.1:3377`, connect the existing agent's original owner wallet, choose **New mission**, and supply a title, objective, review criteria and one to six source URLs. The brief is saved before execution. **Run mission** starts collection. Inspect each captured excerpt and its original source; **Review dossier** records approval of that exact artifact fingerprint. Download JSON if needed. Activity and the mission timeline read durable events, including interruptions and resumed work.

The existing [owner setup and wallet limits](OWNER-CONSOLE.md) apply. A fresh read verifies the original full-access owner key, configured chain/contract/code and agent. New mission work requires the agent to be active and its local rotation hold to be clear. The collector reads no owner, runtime or uploader key. Before each new source and artifact assembly, it verifies the same owner key, generation and epoch. A changed authority blocks further work; explicit resume obtains a fresh snapshot. A wallet logout ends HTTP access; it does not cancel an already authorized mission. Use **Cancel mission** or owner pause when intervention is intended.

The host runs the source worker independently of a browser tab. It must remain running; this is not a cloud/background-service deployment. Mission state defaults to `.persistara/missions/research/missions.sqlite`; `--mission-state-dir` selects its canonical directory. Do not start with a new journal to bypass a pending operation.

## Approved source reads

Default exact origins:

- `https://docs.near.org`
- `https://docs.0g.ai`
- `https://raw.githubusercontent.com`

The local operator may set `PERSISTARA_SOURCE_ORIGINS` to a comma-separated list of up to 16 exact HTTPS origins. This changes the host allowlist, not the mission's immutable source list. Narrowed lists stop future reads to removed origins while retaining historical captures. URLs with credentials, query strings, fragments or custom ports are rejected. Private repositories/authenticated sources are unsupported; no cookies, bearer tokens or browser credentials are forwarded.

Each read uses certificate-verified HTTPS, an explicitly pinned public IPv4 DNS result, no shared connection agent, no redirects, no proxy configuration, no script execution and no subresource requests. Private, loopback, link-local, shared, documentation, benchmarking, multicast and other conservatively excluded IPv4 ranges are rejected. IPv6-only sources are unsupported. DNS resolution, headers and body share a 20-second deadline. Only HTTP 200 UTF-8 HTML/plain text with identity encoding is accepted, up to 1,000,000 bytes.

The collector removes executable/style/template markup, decodes bounded entities and records at most 6,000 characters per source. It is a source-excerpt collector, not a semantic summarizer, full browser or proof of report truth. Navigation text may remain on complex pages. Excerpts, briefs and retrieved instructions are untrusted data: they never become tools, HTML, payment authority or policy changes. SHA-256 fingerprints cover original response bytes; excerpt truncation is explicit. The original URL, capture date, content type, size and untrusted marker accompany the capture.

Implementation references: [Node HTTPS](https://nodejs.org/docs/latest-v24.x/api/https.html), [Node HTTP request lookup and abort behavior](https://nodejs.org/docs/latest-v24.x/api/http.html), [IANA special-purpose IPv4 registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml). This is application egress restriction, not isolation from a compromised operator machine or network.

## Durable execution and recovery

The SQLite schema uses an explicit version, scope binding to owner/agent/chain/contract/code, WAL and full synchronization, private directory/file permissions, immutable canonical brief/source digests and bounded storage. It supports up to 250 missions, six sources each, three attempts per source and a bounded event history. Unknown schema versions, unsafe files, rebinding and changed record digests fail closed. Monetary values remain integer base-unit strings.

The states are `queued`, `running`, `interrupted`, `blocked`, `awaiting_review`, `completed` and `canceled`. A claim commits the worker holder, monotonically increasing fence, 60-second lease and event before network execution. A heartbeat renews every ten seconds while the claim remains valid. Source operation IDs remain unchanged across attempts; each fetching intent and captured result is persisted. No network call occurs in a database transaction.

- Browser reload: reconnect the session if needed; inspect the saved mission. The running host continues.
- Graceful host stop: abort the worker and record interruption. Start the same host/journal and choose **Resume mission**.
- Abrupt process loss: wait for the remaining lease, at most 60 seconds after its last renewal. A read then records interruption and fences the old worker. Resume explicitly.
- Source/RPC/authority failure: retain captures and a specific failure code. Restore the prerequisite and resume. Completed captures are skipped.
- Cancellation: increment the fence and abort in-flight retrieval. A response arriving afterward cannot commit. Captured data and events remain available.
- Three unsuccessful attempts at one source: no further execution is allowed for that source operation. Inspect the problem and create a new brief if necessary.

An interrupted read without a committed capture can be repeated explicitly under the same operation ID. These are unauthenticated public GETs; the worker has no paid or mutating provider capability. This policy does **not** apply to owner wallet, storage upload, checkpoint, reservation or payout journals. Those retain their separate unknown-outcome reconciliation rules.

Artifact insertion, state transition to `awaiting_review` and the artifact event commit in one transaction. All sources must be captured. Approval checks current mission version and exact artifact digest; replay of the identical approval does not add another event. Owner review does not imply factual correctness. Canceled missions cannot resume, and completed artifacts cannot be overwritten.

## HTTP and local custody

All mission routes use the existing exact Host/Origin, NEP-413 owner session, HttpOnly SameSite cookie and CSRF checks. Resource scope is enforced by the bound server journal, not browser state. The body is bounded and unexpected fields are rejected. Routes include authenticated list/detail/activity, create/run/cancel/approve and replayable event cursors. Event history uses polling; SSE and multi-tenant hosting are not implemented. The browser has no arbitrary file, signing, upload or general host-fetch endpoint.

Mission briefs, excerpts and dossiers are **plaintext in the private local journal**, protected by the trusted machine and file permissions. They are not encrypted memory objects. Existing encrypted memory-backup bundles do not back up this mission journal. Stop the host cleanly before copying the complete mission-state directory to separately protected custody; do not copy a lone live SQLite database while WAL writes are active. Encrypted mission export, remote execution, cross-machine mission recovery and 0G publication remain follow-up work.

## Verification

```sh
pnpm check
pnpm runtime:test
pnpm missions:recover:fixture
pnpm test:e2e
pnpm contract:check
```

The milestone passes 179 TypeScript tests in 26 suites, eight Chromium tests, 34 Rust tests and five deployed-WASM scenarios. The source tests cover duplicate/changed requests, zero-spend boundaries, scope corruption, two workers, lease expiry, stale responses, cancellation, source failures, owner changes, exact artifact review, hostile text, URL/IP bounds and cursor replay. Existing wallet and memory/settlement tests remain intact.

The three-process drill uses explicitly synthetic text, exits abruptly after one durable capture, advances its fixture clock past the lease, resumes in another process, skips the captured source and verifies one artifact/review in a third. Browser tests also use explicit simulated source/wallet transports; screenshots retain the fixture banner.

Separately, a real original-owner CLI-keychain login ran a two-source mission against the public NEAR and 0G documentation roots, inspected the mechanical criteria, recorded review and logged out. [Sanitized evidence](evidence/mission-source-dossier-2026-11-07.json) records actual URLs, dates, response sizes and content/artifact fingerprints. It contains no excerpts, signatures, cookies, nonces or private material. No public transaction, storage upload or inference occurred. Browser-provider approval remains unverified; the external CLI proof is a distinct path.

Model-driven research, signed specialist quotes/deliveries, mission-linked treasury settlement, encrypted artifact publication, memory integration and the full golden demo remain plan 005/release work. This mode deliberately makes no claims about those capabilities.

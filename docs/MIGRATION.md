# Selective migration from Sofer

Source: `/Users/ram/Desktop/sofer`, origin `https://github.com/JemIIahh/sofer.git`, HEAD `542813f` at review. The working tree contains existing web relocation/new web work and a changed lockfile. Preserve those changes. This migration copies approved material; it never removes or resets source files.

## Selection

| Source | Decision | Reason |
| --- | --- | --- |
| `packages/core/src/brain/types.ts` | Adapt generic schema/tool interface with provenance | Small provider-independent tool boundary; upgrade results to structured typed outcomes later |
| `packages/core/src/brain/loop.ts` | Reimplement through a provider interface; preserve test scenarios as design input | Anthropic message types, streaming, compaction, and usage assumptions are coupled |
| `packages/core/src/brain/loop.test.ts` | Use scenarios as regression requirements | Retain tool dispatch, errors, cancellation, round cap, partial history, and concurrency coverage |
| `packages/core/src/agent/runtime.ts` | Rewrite | Holds Sui signer, memory client, chain tools, and provider client in one process |
| `packages/core/src/storage/types.ts` | Redesign, do not copy unchanged | Walrus blob IDs, epoch retention, and deletability are backend-specific |
| `packages/core/src/memory/*` | Replace | MemWal ownership and Seal authorization depend on Sui |
| `packages/core/src/chain/*`, `contracts/*` | Replace with NEAR implementation | Different account, async execution, storage-staking, and callback semantics |
| `packages/core/src/messaging/*` | Replace; never import | Existing HKDF concatenation is not symmetric key agreement; runtime passes address bytes as key material; mailbox permits plaintext fallback |
| `packages/core/src/tools/system.ts` | Replace with capability tools | Lexical path prefix and unrestricted host shell are unsuitable for isolated key-bearing execution |
| `packages/core/src/config-store.ts`, CLI secrets/init/daemon | Rewrite | Secret custody, lifecycle, and Sui-specific identity are entangled |
| `apps/web/*`, `apps/walrus-site/*` | Leave in source; design a new operational console | Existing work is not a mission/treasury/recovery product; don't import uncommitted web changes |
| README, submission claims, deployment IDs | Do not import as product claims | They describe another chain and prior work |

## Evidence for replacement decisions

- `brain/loop.ts:42-45` takes Anthropic client and messages directly; `agent/runtime.ts:58-105` constructs signer, chain clients, memory, system tools, messaging, and inference together.
- `messaging/e2ee.ts:35-37` derives a key from concatenated private/public bytes rather than an actual DH secret; opposite participants cannot generally derive the same key that way.
- `agent/runtime.ts:95-97` supplies encoded public address bytes as mailbox key material. Addresses are public and cannot be secret key material.
- `messaging/mailbox.ts:25-30,40-46` permits plaintext sending and a plaintext parse after decryption failure. These behaviors must not appear in the new encryption protocol.
- `tools/system.ts:13-17` uses string prefix checks and `tools/system.ts:109-116` runs arbitrary host shell commands. The new first-release research tools do not expose those capabilities.

These are migration-risk findings, not a full security audit of Sofer. No source fix has been made in the original repo. Do not publicize vulnerability details as allegations beyond the precise code behavior reviewed.

## Import discipline

1. Copy only the reviewed file allowlist, never the entire directory.
2. Record original source path, source commit, source SHA-256, destination, and whether adapted.
3. Include license/provenance notices. Sofer declares Apache-2.0 in metadata and README; no tracked LICENSE file was found at review.
4. Do not copy `.env`, private keys, local state, deployment records, `node_modules`, build output, Git metadata, or the old dependency lockfile.
5. Test and review each adaptation. A file imported into the repository is not automatically enabled in the runtime.
6. Hackathon README separates baseline from newly built NEAR/0G/inference features. Keep exact commit links when the new repo has them.

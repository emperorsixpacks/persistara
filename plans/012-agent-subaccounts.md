# Plan 012: Agent names as real NEAR subaccounts (`agent.owner.testnet`)

Status: **Contract/source change IMPLEMENTED (2026-11-11); NOT deployed.** Defaults chosen under the owner's delegation: the subaccount is the agent's identity namespace (not a funded worker account), the owner creates any real account externally, names follow NEAR segment rules, and the ID is `name.owner`. `register_agent` now builds `name.owner` and validates it (`pnpm contract:check` passes on 2026-11-11: fmt, Clippy, 35 Rust tests and all six deployed-WASM sandbox scenarios under the new ID format; the first attempt failed four scenarios because the TypeScript client still required `owner:name`, fixed in `agentIdMatchesSigner`); the live testnet deployment still uses `owner:name`. Adopting it needs a fresh authority deployment and the owner's approval. Stage one is shipped: `agentDisplayName()` in `packages/terminal/src/render.ts` shows the registry ID `owner.testnet:research` as `research.owner.testnet` in the status and home views. It is display only; it is not a NEAR account and nothing resolves or authorizes from it.

## Why

Users expect an agent to look like a NEAR account (`research.alice.testnet`). Making it one could let an agent have its own on-chain identity, key and balance, separate from the owner and from the authority contract.

## Open decisions (need the owner's approval before any code)

1. **Role.** Is the subaccount the worker/runtime signer account (today `approved_workers` holds `AccountId`s), a payout/receiving account, or only an identity label?
2. **Contract ID format.** The contract currently derives `agent.id = "{owner}:{name}"` in `contracts/authority/src/registry.rs`. Changing it to a subaccount form changes stored IDs, events, journals and scope bindings. In-place state migration is not implemented, so this means a **fresh authority deployment**; the live funded one (`authority.persistara-owner.testnet`) would not carry over.
3. **Creation path.** The owner creates and funds `name.owner.testnet` through the external NEAR CLI/wallet. No owner key enters the app, and the app never creates accounts on its own. Only the owner can create subaccounts of their account, which also constrains who may register a given name.
4. **Name rules.** NEAR account segments are 2–64 chars of `a-z0-9_-` (no uppercase or dots inside a segment). The contract's current rule allows uppercase and 1 character, so the rule must tighten and existing names may become invalid.

## Scope when approved

- Contract: validate the name as a single NEAR segment, require/verify the subaccount relationship, keep `agent_id` canonical, add Rust tests and sandbox coverage.
- Client/terminal: accept `research` or the full name, show the full name, verify that on-chain and local scope agree.
- Docs/evidence: migration note, fresh-deploy instructions, and no claim that the old deployment is upgraded.

Out of scope until approved: deploying, creating accounts, moving funds, changing existing journals or keys.

## Phase 2 design: the agent as a real NEAR account (2026-11-13, owner asked for it; not started)

Today `research.<owner>` is only an ID inside the authority contract (see "Role" above). The owner wants it to be a real wallet address.

Design:
- The owner creates `name.owner` in one owner-signed transaction: `CreateAccount`, a small `Transfer` (storage and gas), `AddKey` for the owner's key (full access, so funds are never trapped) and `AddKey` for the runtime key as a function-call key limited to the authority contract and the three runtime methods.
- The runtime key therefore leaves the owner account. The agent signs as `name.owner`, so the owner account carries no delegate key at all.
- Contract: `assert_runtime` accepts `signer == agent.id` (the subaccount) in addition to the owner. The delegate key lookup, expiry and permission checks stay unchanged. This changes the code hash, so it needs a rebuilt artifact, a fresh deployment and a new manifest.
- Client: `signerId` is the agent account while the owner account stays the owner. `agentIdMatchesSigner`, `nearConfig`, the isolated signer, runtime rotation (it adds keys on the owner account today), `near:runtime-key`, `near:deploy`, doctor and the owner journal binding all assume signer == owner (about 60 references) and must change together. The six sandbox scenarios need reworking.
- Treasury funds stay inside the contract under the spending policy. The subaccount does not hold the budget; it is the agent's identity, signer and payout address.

Risks: a contract hash change and fresh deployment invalidate the verified live records unless the old deployment is kept for the demo; a half-migrated signer path can break rotation and recovery. Do it after the hackathon submission, on its own branch, with `pnpm contract:check` and a throwaway-account run like `docs/evidence/e2e-testnet-2026-11-13.md` before merging.

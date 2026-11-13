# Deploying a fresh authority with `name.owner` agent IDs (NEAR testnet)

Persistara cannot do this for you: every step below is signed by **your** owner account through the official NEAR CLI, which keeps your key outside Persistara. Nothing here is mainnet (the client is testnet-only) and nothing here touches the existing deployment `authority.persistara-owner.testnet`; that contract and its funds stay as they are.

The command lines below were checked against `near-cli-rs 0.31.1`: the grammar parses, and the call-function tail is the one used in the live acceptance runs. The one-command tool below was run end to end on testnet on 2026-11-13 (evidence: `docs/evidence/e2e-testnet-2026-11-13.md`). The manual NEAR CLI steps further down have **not** been executed end to end by the author, so stop at the first error.

## Fastest: one command with `near-api-js` (no NEAR CLI, no Rust, no cargo)

`near-api-js` is NEAR's equivalent of viem or ethers: with a secret key it signs transactions. `pnpm near:deploy` uses it to do steps 2-5 below in one go. It is **resumable** (it reads chain state first, so after any failure you just run it again) and defaults to a **dry run** that only reads the chain.

0. **Easiest:** if you imported your key with `persistara wallet add`, skip the key file and add `--owner-from-keystore` to the commands below; it asks for your passphrase (hidden) instead.
1. Put your owner **secret** key in a private file (either a bare `ed25519:...` line or the NEAR CLI credentials JSON, such as `~/.near-credentials/testnet/YOU.testnet.json`; the tool checks the file belongs to the owner account) outside the repository, using your editor, never chat: `mkdir -p ~/.persistara-signer && chmod 700 ~/.persistara-signer`, then create `~/.persistara-signer/owner.key` with mode `600` (`chmod 600`). The tool refuses a file that is readable by others or a symlink. The key must be a **full-access** key of the owner account. Delete the file when you are done.
2. Dry run (reads only, signs nothing): `pnpm near:deploy --owner persistara-owner.testnet --owner-key-file ~/.persistara-signer/owner.key --contract authority-v2.persistara-owner.testnet`
3. If the plan looks right, run the same command with `--execute`.

**The agent is a real NEAR account.** By default the tool creates `research.<owner>` as an actual account (0.5 NEAR for storage and gas), gives it your owner key as a full-access key (so nothing is ever trapped) and gives it the agent's runtime key as a restricted function-call key (only this contract, three methods, 0.25 NEAR gas allowance). The agent signs as `research.<owner>`, so your owner account carries no runtime key at all, and the printed `.env` lines include `NEAR_RUNTIME_ACCOUNT`. Its budget still lives inside the authority contract under your spending policy; the account is the agent's identity, signer and payout address. Pass `--runtime-on-owner` for the older layout (runtime key on the owner account). **Limit:** runtime key rotation is not supported in the agent-account mode yet and refuses with a clear message; you can still pause the agent or revoke its delegate.

What it does and checks: the contract file's hash must equal the expected hash (default: the committed artifact's) before anything is signed; the contract name must be a subaccount of the owner; the owner key must really be a full-access key on that account; it then creates the contract account, deploys and runs `new` in one transaction, registers the agent, sets the policy, funds it, creates the runtime key file, creates the agent account with that key (same limits as the live agent) and records the delegate grant. It prints the `.env` lines to use. It needs at least 6.5 testnet NEAR on the owner (about 5.9 is spent).

Notes: this signs inside a short-lived process that you start, not in the chat or agent process, and it never prints or stores the owner key. A network blip shows as `UNEXPECTED_ERROR`; just run it again. The contract and runtime keys it creates are written as private files under `.persistara/keys/`. The whole flow was run on testnet against a throwaway faucet account (see the evidence file); still run the dry run first and watch the first `--execute`. If the public RPC is slow or drops connections (`NETWORK_ERROR`), just run the same command again, or pass another endpoint such as `--rpc https://test.rpc.fastnear.com`. The manual steps below do the same thing with the NEAR CLI.

## Manual alternative: Prerequisites

The manual steps below are the **older layout**: they put the runtime key on the owner account and do not create the agent account. Use `pnpm near:deploy` for the agent-account layout.

- Your owner account on testnet (the examples use `persistara-owner.testnet`) imported with `persistara wallet add` (or into the NEAR CLI keychain), with at least about 8 testnet NEAR. Testnet NEAR is free from a faucet.
- The NEAR CLI as a **prebuilt binary** (no cargo, no Rust): download the file for your system from <https://github.com/near/near-cli-rs/releases/latest>, check it against the `.sha256` next to it, and put `near` on your PATH. (`cargo install near-cli-rs --locked` also works but is slow and needs OpenSSL headers and `pkg-config` on Linux.)
- This repository: `pnpm install --frozen-lockfile`. **No Rust is needed**: the contract is committed prebuilt in `contracts/artifacts/` (step 1).

## Variables (edit the contract name if you like)

```sh
OWNER=persistara-owner.testnet
OWNER_KEY=ed25519:Bb9psi3hsJh7eJd2ukyMvvdc9QTmSRChLzwC5XeTKHTa   # your owner PUBLIC key; list yours with: near account list-keys $OWNER network-config testnet now
CONTRACT=authority-v2.$OWNER
AGENT=research.$OWNER                     # the agent ID the contract will create from name "research"
WORKER=worker.$OWNER                      # an existing approved worker account
SIGN="sign-as $OWNER network-config testnet sign-with-keychain --signer-public-key $OWNER_KEY send"
```

## 1. Use the committed contract artifact (no Rust, no cargo)

```sh
mkdir -p target/near/persistara_authority
cp contracts/artifacts/persistara_authority-agent-account.wasm target/near/persistara_authority/persistara_authority.wasm
```

Its code hash is `4Toz9TFJg38qTg3dnGoBd8uDySRHyfhDyr6n6McXz6vq` (289,212 bytes). That is your deployment record: the client and `pnpm contract:fetch` check against it, and `pnpm check` fails if the file and `contracts/artifacts/authority-manifest.json` ever disagree. It was built from the contract source at commit `c25373c` and passed `pnpm contract:check` (35 Rust tests, six sandbox scenarios) on 2026-11-11.

Builds are not reproducible, so rebuilding it yourself with `pnpm contract:build` produces **different bytes and a different hash**. That is fine only if you then deploy and record your own file instead; do not mix the two. The committed artifact is the one the repository's documentation refers to.

## 2. Create the contract account

```sh
near account create-account fund-myself $CONTRACT '5 NEAR' autogenerate-new-keypair save-to-keychain $SIGN
```

## 3. Deploy and initialize in one transaction

```sh
near contract deploy $CONTRACT use-file target/near/persistara_authority/persistara_authority.wasm with-init-call new json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

## 4. Register the agent, set its policy, fund it

The contract builds the agent ID `research.$OWNER` from the name. It does not create or check that account.

```sh
near contract call-function as-transaction $CONTRACT register_agent json-args '{"name":"research"}' prepaid-gas '100 Tgas' attached-deposit '0.3 NEAR' $SIGN
near contract call-function as-transaction $CONTRACT configure_policy json-args "{\"agent_id\":\"$AGENT\",\"policy\":{\"maxJobAmount\":\"20000000000000000000000\",\"dailyLimit\":\"50000000000000000000000\",\"approvedWorkers\":[\"$WORKER\"]}}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' $SIGN
near contract call-function as-transaction $CONTRACT fund json-args "{\"agent_id\":\"$AGENT\"}" prepaid-gas '100 Tgas' attached-deposit '0.1 NEAR' $SIGN
```

These match the live agent's policy: jobs up to 0.02 NEAR and 0.05 NEAR per day.

## 5. Create the runtime key and authorize it

The runtime key is separate from your owner key. This prints only its public half:

```sh
NEAR_RUNTIME_KEY_FILE=.persistara/keys/near-runtime-v2.key pnpm near:runtime-key
RUNTIME_KEY=ed25519:...    # paste the printed publicKey
EXPIRES=$(( ($(date +%s) + 30*24*3600) * 1000000000 ))   # 30 days, in nanoseconds
near account add-key $OWNER grant-function-call-access --allowance '0.25 NEAR' --contract-account-id $CONTRACT --function-names 'checkpoint_memory,create_job,accept_job' use-manually-provided-public-key $RUNTIME_KEY network-config testnet sign-with-keychain --signer-public-key $OWNER_KEY send
near contract call-function as-transaction $CONTRACT set_delegate json-args "{\"agent_id\":\"$AGENT\",\"delegate\":{\"publicKey\":\"$RUNTIME_KEY\",\"expiresAtNs\":\"$EXPIRES\",\"canCheckpoint\":true,\"canSpend\":true}}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' $SIGN
```

## 6. Point Persistara at it

In `.env` (comment out the old values, do not delete them):

```
NEAR_AUTHORITY_CONTRACT=authority-v2.persistara-owner.testnet
NEAR_AGENT_ID=research.persistara-owner.testnet
NEAR_RUNTIME_PUBLIC_KEY=<the runtime public key from step 5>
NEAR_RUNTIME_KEY_FILE=.persistara/keys/near-runtime-v2.key
```

The WASM at `target/near/persistara_authority/persistara_authority.wasm` must be the file you deployed. Journals are scoped by key and contract, so the old deployment's state is not reused.

## 7. Verify

```sh
pnpm contract:fetch --contract authority-v2.persistara-owner.testnet --expected-hash 4Toz9TFJg38qTg3dnGoBd8uDySRHyfhDyr6n6McXz6vq --out /tmp/check.wasm   # chain code == your build
pnpm near:doctor
pnpm cli --plain status                     # expect research.persistara-owner.testnet, ACTIVE, 0.1 NEAR available
```

Then `pnpm cli`, `/connect` and the chat steps in [INFERENCE-ACCEPTANCE.md](INFERENCE-ACCEPTANCE.md).

## Things to know

- **Memory for this agent is new.** Chat and `status` do not need it. Memory writes and recovery for `research.…` need their own keyring and backup first (`pnpm memory:keys`, `pnpm memory:backup`; see [RECOVERY.md](RECOVERY.md)). The old agent's keyring is bound to the old ID.
- **The contract account's own key can replace the code.** `authority-v2…` holds a full-access key in your keychain from step 2. Anyone with it can redeploy the contract. For a demo that is acceptable; to make the code immutable, delete that key afterwards (this cannot be undone, so only after everything works): `near account delete-keys $CONTRACT public-key <its key> network-config testnet sign-with-keychain send`.
- **`research.persistara-owner.testnet` is not created on chain** unless you also create that subaccount. The contract does not need it; only the owner could ever create it.
- **If you stop midway:** a partly set up contract is harmless; start over with a different `CONTRACT` name. The old deployment is never modified.

# Getting started: from nothing to chatting with your own agent

Persistara is a terminal tool for an AI agent that **you** control through your own NEAR account. This page is the whole first-time path in order. Each step links to the detailed document. The path is on **NEAR testnet** (the client supports nothing else); testnet NEAR is free.

## What you need and what it costs

| You need | Cost | Needed for |
| --- | --- | --- |
| The program (`persistara`) | Free | everything |
| A NEAR **testnet** owner account | Free (faucet) | owning the agent |
| About 7 testnet NEAR on that account | Free (faucet) | deploying your own contract and funding the agent |
| The official NEAR CLI (prebuilt binary) | Free | **optional**: only to create a new account with it, or for owner pause/resume |
| A NEAR AI API key with credits | **Real money** (or the hackathon's $10 claim) | AI chat only |
| A 0G storage wallet | Free testnet funds | memory uploads only (optional) |

Mission work and status need no AI key. Chat stays **off** until you turn it on yourself.

## 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/JemIIahh/persistara/main/install.sh | bash
```

Open a new terminal and run `persistara --help`. Details, what it changes and how to uninstall: [INSTALL.md](INSTALL.md). Your private workspace is `~/.persistara-workspace` (`.env`, keys, journals).

## 2. Use your existing NEAR testnet account (or make one)

Persistara works like the Solana or Stellar CLIs: you **bring the key of an account you already have**. Import it once; it is checked on chain and stored encrypted under a passphrase you choose, in `~/.persistara-signer`:

```sh
persistara wallet add --account YOURNAME.testnet --from-near-credentials   # reuse your existing NEAR CLI credentials file
persistara wallet add --account YOURNAME.testnet --key-file /path/to/key   # a file holding ed25519:... or a NEAR credentials JSON
persistara wallet add --account YOURNAME.testnet                           # paste the key at a hidden prompt
```

Use whichever matches how your key is stored; type the secret only at the hidden prompt or in a file, never in chat. It must be a **full-access** key of that account. `persistara wallet list` shows what is stored and `persistara wallet check` proves your passphrase works. A forgotten passphrase cannot be recovered: keep your own backup of the key. Details and the security design: [SECURITY.md](SECURITY.md).

**No account yet?** Create a testnet account in any NEAR wallet that supports testnet, or with the NEAR CLI (prebuilt binary from <https://github.com/near/near-cli-rs/releases/latest>, checked against its `.sha256`; no cargo or Rust needed):

```sh
near account create-account sponsor-by-faucet-service YOURNAME.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

That asks the testnet faucet service to create the account and saves its key to `~/.near-credentials/testnet/YOURNAME.testnet.json`, which `--from-near-credentials` above reads. The command's grammar was checked against the CLI's `--help`, not run end to end by the author. Prefer to keep your key in the NEAR CLI keychain instead of Persistara's store? `persistara wallet near-cli` is the guided path for that.

## 3. Fund it with testnet NEAR

You need roughly 7 testnet NEAR to deploy and fund an agent. Use a testnet faucet, for example <https://near-faucet.io>. Check your balance with `near account view-account-summary YOURNAME.testnet network-config testnet now`.

## 4. Deploy your own authority contract and agent

One resumable command signs everything with `near-api-js`. It defaults to a dry run and reads your key from the encrypted store (it asks for the passphrase, hidden):

```sh
cd ~/.local/share/persistara/app            # where the installer put the program
pnpm near:deploy --owner YOURNAME.testnet --owner-from-keystore --contract authority.YOURNAME.testnet \
  --contract-key-file ~/.persistara-workspace/.persistara/keys/authority.key --runtime-key-file ~/.persistara-workspace/.persistara/keys/near-runtime.key
```

Review the plan, then add `--execute`. It prints the `.env` lines for the next step. (You can instead pass `--owner-key-file` pointing at a key file.) Full explanation, checks and the manual NEAR CLI alternative: [DEPLOY-TESTNET.md](DEPLOY-TESTNET.md). Your agent's ID will be `research.YOURNAME.testnet`.

Then copy the exact contract file you deployed into the workspace, because the client requires its hash to match the chain:

```sh
mkdir -p ~/.persistara-workspace/target/near/persistara_authority
cp contracts/artifacts/persistara_authority-name-owner.wasm ~/.persistara-workspace/target/near/persistara_authority/persistara_authority.wasm
```

## 5. Configure `~/.persistara-workspace/.env`

Put in the lines `pnpm near:deploy` printed (`NEAR_AUTHORITY_CONTRACT`, `NEAR_OWNER_ACCOUNT`, `NEAR_AGENT_ID`, `NEAR_RUNTIME_PUBLIC_KEY`) and `NEAR_RUNTIME_KEY_FILE=.persistara/keys/near-runtime.key`. Check with:

```sh
persistara status       # expect: research.YOURNAME.testnet | NEAR testnet | ACTIVE
```

Settings reference: [NEAR-CLIENTS.md](NEAR-CLIENTS.md), [INTEGRATIONS.md](INTEGRATIONS.md). Memory writes and recovery also need a memory keyring, a backup and a 0G wallet: [RECOVERY.md](RECOVERY.md), [MEMORY-WRITES.md](MEMORY-WRITES.md). Chat and status do not.

## 6. Sign in as the owner

Run `persistara`. If you stored a key in step 2 it asks for your key-store passphrase first (press Enter to skip), before the full-screen app opens. Then `/connect`: it shows exactly what you are signing, a separate short-lived process signs it, and Persistara checks the key is the registered owner key. The key is never in the chat or agent process. After this you can create source missions with `/new` and `/run` and review them ([TERMINAL.md](TERMINAL.md)).

Owner **pause/resume** transactions are not signed by the key store yet: for those, use the NEAR CLI keychain (`persistara wallet near-cli`).

## 7. Optional: turn on AI chat (this costs money)

1. Get a NEAR AI API key with credits at <https://cloud.near.ai>. (Hackathon participants can claim $10 in credits, with a separate key, at <https://nearbuilders.org/dashboard>.)
2. Put `NEARAI_API_KEY` and `NEARAI_MODEL` in `.env`, using your editor, never chat. `z-ai/glm-5.3-flash` passed Persistara's live check once; a catalog entry alone does not prove a model supports the required attestation.
3. Run the paid acceptance steps first, one request each, and stop at the first failure: [INFERENCE-ACCEPTANCE.md](INFERENCE-ACCEPTANCE.md).
4. Only then add `PERSISTARA_AI_CHAT=enabled`. A key alone never turns chat on. Chat can only use three read-only lookups, and a request whose outcome is lost is never resent ([TERMINAL.md](TERMINAL.md#conversation-sessions-offline-core)).

## If something goes wrong

| You see | Meaning and fix |
| --- | --- |
| `NOT_CONFIGURED` | `.env` is missing a NEAR field from step 5 or the contract file from step 4. |
| `INTEGRITY_FAILED: Authority code, complete keys or finalized state differs` | The local contract file's hash does not match the chain. Copy the exact deployed file, or recover it: `pnpm contract:fetch --expected-hash <your recorded hash>` ([CONTRACTS.md](CONTRACTS.md)). Never run `pnpm contract:build` in a workspace tied to a deployment. |
| `Owner operation journal is invalid or changed` | An earlier run created empty journals bound to the wrong contract file. Remove them only if they hold no operations ([CONTRACTS.md](CONTRACTS.md)). |
| Footer: `○ NEAR readiness not verified (CODE)` | The check failed; the full message is printed in the session, and `/status` retries. |
| HTTP 401 on the first model call | The NEAR AI key was rejected; create a new one at cloud.near.ai. |
| `UNEXPECTED_ERROR` from `pnpm near:deploy` | Usually a network blip; run it again, it resumes. |

Reviewers who only want to verify the project without accounts or keys: see "Verify it yourself" in the [README](../README.md).

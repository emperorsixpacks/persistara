# Getting started: from nothing to chatting with your own agent

Persistara is a terminal tool for an AI agent that **you** control through your own NEAR account. This page is the whole first-time path in order. Each step links to the detailed document. The path is on **NEAR testnet** (the client supports nothing else); testnet NEAR is free.

## What you need and what it costs

| You need | Cost | Needed for |
| --- | --- | --- |
| The program (`persistara`) | Free | everything |
| A NEAR **testnet** owner account | Free (faucet) | owning the agent |
| About 7 testnet NEAR on that account | Free (faucet) | deploying your own contract and funding the agent |
| The official NEAR CLI (prebuilt binary) | Free | owner sign-in with `/connect` |
| A NEAR AI API key with credits | **Real money** (or the hackathon's $10 claim) | AI chat only |
| A 0G storage wallet | Free testnet funds | memory uploads only (optional) |

Mission work and status need no AI key. Chat stays **off** until you turn it on yourself.

## 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/JemIIahh/persistara/main/install.sh | bash
```

Open a new terminal and run `persistara --help`. Details, what it changes and how to uninstall: [INSTALL.md](INSTALL.md). Your private workspace is `~/.persistara-workspace` (`.env`, keys, journals).

## 2. Get the NEAR CLI and a testnet owner account

Download the prebuilt **NEAR CLI** for your system from <https://github.com/near/near-cli-rs/releases/latest>, check it against the `.sha256` beside it, and put `near` on your PATH. No cargo or Rust is needed. Then:

```sh
near account create-account sponsor-by-faucet-service YOURNAME.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

This asks the testnet faucet service to create the account, and stores its key in the CLI's legacy keychain: `~/.near-credentials/testnet/YOURNAME.testnet.json` (mode it `600`, see step 4). Already have an owner account? Skip this and run `persistara wallet` to import it into the NEAR CLI; it never sees what you type ([SECURITY.md](SECURITY.md)). The first command's grammar was checked against the CLI's `--help`, but not run end to end by the author, so stop at the first error.

## 3. Fund it with testnet NEAR

You need roughly 7 testnet NEAR to deploy and fund an agent. Use a testnet faucet, for example <https://near-faucet.io>. Check your balance with `near account view-account-summary YOURNAME.testnet network-config testnet now`.

## 4. Deploy your own authority contract and agent

One resumable command signs everything with `near-api-js`; it defaults to a dry run. Point it at the key file from step 2 (a NEAR credentials JSON or a bare `ed25519:` key; it must be readable only by you: `chmod 600`):

```sh
cd ~/.local/share/persistara/app            # where the installer put the program
pnpm near:deploy --owner YOURNAME.testnet --owner-key-file ~/.near-credentials/testnet/YOURNAME.testnet.json \
  --contract authority.YOURNAME.testnet \
  --contract-key-file ~/.persistara-workspace/.persistara/keys/authority.key --runtime-key-file ~/.persistara-workspace/.persistara/keys/near-runtime.key
```

Review the plan, then add `--execute`. It prints the `.env` lines for the next step. Full explanation, checks and the manual NEAR CLI alternative: [DEPLOY-TESTNET.md](DEPLOY-TESTNET.md). Your agent's ID will be `research.YOURNAME.testnet`.

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

Run `persistara`, then `/connect`. It shows exactly what you are signing; the NEAR CLI signs and Persistara checks the key is the registered owner key. (The key stays in the NEAR CLI keychain; Persistara does not hold it.) After this you can create source missions with `/new` and `/run` and review them ([TERMINAL.md](TERMINAL.md)).

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

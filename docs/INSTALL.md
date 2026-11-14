# Installing Persistara

New to Persistara? [GETTING-STARTED.md](GETTING-STARTED.md) covers the whole first-time path (accounts, funds, deploying your agent, sign-in, AI chat); this page is only about the installer.

## One-line install (macOS, Linux, WSL)

```sh
curl -fsSL https://raw.githubusercontent.com/emperorsixpacks/persistara/main/install.sh | bash
```

No clone is needed. This URL only works for everyone **after the repository is public**. While it is private, collaborators with GitHub access can still skip cloning:

```sh
gh api repos/emperorsixpacks/persistara/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

or clone with their own git access and run the script from the checkout (the script fetches through git, so existing credentials are used):

```sh
git clone https://github.com/emperorsixpacks/persistara.git && bash persistara/install.sh
```

Prefer to read it first: `curl -fsSL <url> -o install.sh && less install.sh && bash install.sh`. Pin a version with `--ref <tag-or-full-commit>` (default `main`), and preview with `--dry-run`.

## What it does

- Requires `git` and either `pnpm` or Node.js (for `corepack`). No `sudo`, no system directories.
- Clones the source into `~/.local/share/persistara/app`, runs `pnpm install --frozen-lockfile` and `pnpm build`. pnpm downloads a project-local Node 24 runtime; your global Node is unchanged.
- Writes a `persistara` command to `~/.local/bin` and, unless you pass `--no-modify-path`, appends one clearly marked block to your shell startup file (`.zshrc`, `.bashrc`, `.profile` or a fish `conf.d` file) so the command is found. Open a new terminal afterwards.
- Creates your private workspace `~/.persistara-workspace` (mode 700) with a `.env` template (mode 600). Your `.env`, keys, journals and contract artifact live **there**, not in the app folder.
- Runs `persistara --help` as a self-check and only reports success if it works.

Re-running the installer updates the app in place. It never overwrites an existing `.env`, key, journal or contract artifact, and it refuses to replace a command or directory it did not create. Override locations with `PERSISTARA_INSTALL_DIR`, `PERSISTARA_BIN_DIR` and `PERSISTARA_HOME`.

## Uninstall

```sh
bash install.sh --uninstall
```

Removes the app, the command and the PATH block. **Your workspace is deliberately kept** because it holds keys and journals; delete it yourself only if you have backups.

## What the installer does not give you

Installing the program does not create anything on chain. To use a real agent you still need:

1. **A deployed authority contract and registered agent**, and your own NEAR account (the owner). Owner sign-in uses either Persistara's encrypted key store or the official NEAR CLI (`near`). Import an existing account's key with `persistara wallet add` (no NEAR CLI needed): from a key file (`--key-file`), your existing NEAR CLI credentials (`--from-near-credentials`, reads `~/.near-credentials/testnet/NAME.json`), or by pasting it at a hidden prompt. The key is checked on chain, then stored encrypted under a passphrase you choose; `persistara` asks for that passphrase at startup and `/connect` signs through a separate short-lived process. Prefer the official NEAR CLI instead? `persistara wallet near-cli` is the guided path for that. `/connect` refuses any signing key that is not the registered owner key either way.
2. **That deployment's exact authority WASM** at `~/.persistara-workspace/target/near/persistara_authority/persistara_authority.wasm`, because the client requires its SHA-256 to match the on-chain code hash. Contract builds are **not reproducible**, so rebuilding will not match an existing deployment (see [CONTRACTS.md](CONTRACTS.md)). Copy it in with `PERSISTARA_WASM=/path/to/file bash install.sh`, or recover the exact bytes from the chain using the hash from your deployment record: `cd ~/.local/share/persistara/app && pnpm contract:fetch --expected-hash <hash> --out ~/.persistara-workspace/target/near/persistara_authority/persistara_authority.wasm`.
3. **Configuration** in `~/.persistara-workspace/.env`: the NEAR authority, owner account, agent ID, runtime public key and runtime key file, plus 0G settings.
4. Optional **AI chat**: a NEAR AI key and model in `.env`, `PERSISTARA_AI_CHAT=enabled`, and a passed [live acceptance](INFERENCE-ACCEPTANCE.md). A key alone never turns chat on.

Until configured, `persistara` exits with `NOT_CONFIGURED` and creates no state.

## Tested

`tests/install-script.test.ts` checks syntax, that `--dry-run` changes nothing, refusal of unsafe paths and foreign files, and that `--uninstall` removes only the installer's own files and never the workspace. A real install, re-install (workspace `.env` kept, no duplicate PATH block) and uninstall were also run against a throwaway home directory on Linux. macOS and fish were not run on real machines.

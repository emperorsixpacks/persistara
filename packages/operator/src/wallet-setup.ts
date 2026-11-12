/**
 * Guided owner-wallet setup. Persistara NEVER receives, stores or forwards an owner key: it only checks prerequisites and then
 * hands the terminal to the official NEAR CLI, where the owner types a seed phrase, picks a Ledger or uses the browser wallet.
 * Verification of the imported key happens later, when `/connect` asks that CLI to sign a challenge and checks the signing key
 * against the on-chain owner key. This module therefore reports "finished" and never claims the key is verified.
 */
export type WalletSetupStatus = "cli-missing" | "account-missing" | "not-interactive" | "import-failed" | "import-finished";
export interface WalletSetupDeps {
  owner: string; binary: string; interactive: boolean;
  has(binary: string): Promise<boolean>;
  /** Runs a program with the user's real terminal attached. Resolves with its exit code. */
  run(binary: string, args: string[]): Promise<number>;
  accountExists(owner: string): Promise<boolean>;
  ask(question: string): Promise<string | null>;
  say(text: string): void;
}
export const INSTALL_HELP = [
  "The official NEAR CLI ('near') is not installed.",
  "Install it from https://github.com/near/near-cli-rs (see its README for the installer for your system),",
  "or with Rust:  cargo install near-cli-rs --locked",
  "Then run this command again. Set NEAR_CLI_BIN in your .env if it lives somewhere unusual.",
].join("\n");

export async function walletSetup(deps: WalletSetupDeps): Promise<{ status: WalletSetupStatus }> {
  const { say } = deps;
  if (!/^[a-z0-9._-]{2,64}$/.test(deps.owner)) { say("NEAR_OWNER_ACCOUNT is not set to a valid account in .env."); return { status: "account-missing" }; }
  say(`Owner wallet setup for ${deps.owner} (NEAR testnet).`);
  say("Persistara never sees your seed phrase or key. The official NEAR CLI asks for it directly in this terminal and keeps it in its own keychain.");
  if (!deps.interactive) { say("This needs an interactive terminal."); return { status: "not-interactive" }; }

  if (!await deps.has(deps.binary)) {
    say(INSTALL_HELP);
    if (deps.binary !== "near" || !await deps.has("cargo")) return { status: "cli-missing" };
    const answer = await deps.ask("Install it now with `cargo install near-cli-rs --locked`? This compiles for several minutes. (yes/no) ");
    if (answer?.trim().toLowerCase() !== "yes") return { status: "cli-missing" };
    if (await deps.run("cargo", ["install", "near-cli-rs", "--locked"]) !== 0 || !await deps.has(deps.binary)) { say("The NEAR CLI install did not complete."); return { status: "cli-missing" }; }
  }
  if (!await deps.accountExists(deps.owner)) { say(`${deps.owner} was not found on NEAR testnet. Check NEAR_OWNER_ACCOUNT in .env; nothing was imported.`); return { status: "account-missing" }; }

  say(`\nNEAR CLI will now ask how to import ${deps.owner}. Choose seed phrase, private key, Ledger or browser wallet inside that tool.\nIf your NEAR CLI version prints a different menu, run \`near\` and choose Account, then Import account.\n`);
  const code = await deps.run(deps.binary, ["account", "import-account"]);
  if (code !== 0) { say("The NEAR CLI did not finish the import. Nothing was verified."); return { status: "import-failed" }; }
  say(`\nThe NEAR CLI finished. Persistara has not verified the key yet: run \`persistara\`, then /connect. It asks the CLI to sign a challenge and refuses any key that is not ${deps.owner}'s registered owner key.`);
  return { status: "import-finished" };
}

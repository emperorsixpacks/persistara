import { unlink } from "node:fs/promises";
import { KeyPair } from "near-api-js";
import { parseOwnerKeyFile } from "../../near/src/keyfile.js";
import { DEFAULT_COST, MIN_PASSPHRASE_CHARS, checkPassphrase, keystorePath, listKeystore, readKeystoreEntry, saveKeystoreEntry, describeKeystoreEntry, type KdfCost, type KeystoreEntry } from "../../owner/src/keystore.js";
import { ProviderError } from "../../protocol/src/providers.js";

/**
 * `persistara wallet add|list|remove|check`: import an existing owner key (from a key file, your existing NEAR credentials
 * file, or a hidden prompt) into the encrypted key store. Nothing here prints or logs a key. Before anything is stored the
 * key must be a full-access key of the account on chain, so a wrong or mixed-up key is caught immediately.
 */
export interface WalletCommandDeps {
  directory: string; interactive: boolean; cost?: KdfCost;
  config: { account?: string; contract?: string; agentId?: string };
  say(text: string): void; warn(text: string): void;
  secret(prompt: string): Promise<string | null>;
  /** Text of a key file. `private` demands owner-only permissions; `credentials` is the user's existing NEAR CLI file. */
  readKeyFile(path: string, kind: "private" | "credentials"): Promise<string>;
  credentialsPath(account: string): string;
  chain: { fullAccessKeys(account: string): Promise<string[]>; ownerKeyOf(contract: string, agentId: string): Promise<string | null> };
  /** Runs the isolated signer on a throwaway message to prove the passphrase unlocks the stored key. */
  unlockCheck(account: string, passphrase: string): Promise<string>;
}
const invalid = (message: string) => new ProviderError("INVALID_INPUT", message);

export async function walletAdd(deps: WalletCommandDeps, options: { account?: string | undefined; keyFile?: string | undefined; fromNearCredentials?: boolean }): Promise<{ account: string; publicKey: string; path: string }> {
  const account = options.account ?? deps.config.account;
  if (!account || !/^[a-z0-9._-]{2,64}$/.test(account)) throw invalid("Say which account: --account NAME.testnet, or set NEAR_OWNER_ACCOUNT in .env");
  if (options.keyFile && options.fromNearCredentials) throw invalid("Choose one key source");
  if (await readKeystoreEntry(account, deps.directory)) throw invalid(`A key for ${account} is already stored. Remove it first with: persistara wallet remove ${account}`);
  let text: string;
  if (options.keyFile) text = await deps.readKeyFile(options.keyFile, "private");
  else if (options.fromNearCredentials) { text = await deps.readKeyFile(deps.credentialsPath(account), "credentials"); deps.say(`Using your existing NEAR credentials file for ${account}.`); }
  else {
    if (!deps.interactive) throw invalid("Run this in an interactive terminal, or use --key-file or --from-near-credentials");
    const typed = await deps.secret(`Paste the secret key for ${account} (ed25519:..., hidden): `);
    if (!typed) throw invalid("Cancelled. Nothing was stored.");
    text = typed;
  }
  const secret = parseOwnerKeyFile(text, account);
  const publicKey = KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString();
  const onChain = await deps.chain.fullAccessKeys(account);
  if (!onChain.includes(publicKey)) throw new ProviderError("AUTHORIZATION_FAILED", `That key (${publicKey}) is not a full-access key of ${account} on NEAR testnet, so it could not own an agent. Nothing was stored.`);
  if (deps.config.contract && deps.config.agentId) {
    const registered = await deps.chain.ownerKeyOf(deps.config.contract, deps.config.agentId);
    if (registered && registered !== publicKey) deps.warn(`WARNING: ${deps.config.agentId} was registered with a different owner key (${registered}). /connect will refuse this key.`);
  }
  if (!deps.interactive) throw invalid("Choosing a passphrase needs an interactive terminal");
  const first = await deps.secret(`Choose a passphrase for the key store (at least ${MIN_PASSPHRASE_CHARS} characters, hidden): `);
  if (!first) throw invalid("Cancelled. Nothing was stored.");
  checkPassphrase(first);
  const again = await deps.secret("Repeat the passphrase: ");
  if (again !== first) throw invalid("The passphrases did not match. Nothing was stored.");
  const saved = await saveKeystoreEntry(account, secret, first, deps.directory, deps.cost ?? DEFAULT_COST);
  deps.say(`Stored an encrypted key for ${account} (public key ${saved.publicKey}) in ${saved.path}.\nThe passphrase cannot be recovered: keep your own backup of the key. Remove the plain key file you imported from once you have that backup.`);
  return saved;
}
export async function walletList(deps: Pick<WalletCommandDeps, "directory" | "say">): Promise<KeystoreEntry[]> {
  const entries = await listKeystore(deps.directory);
  deps.say(entries.length ? entries.map((e) => `${e.account}  ${e.publicKey}`).join("\n") : "No keys stored. Add one with: persistara wallet add");
  return entries;
}
export async function walletRemove(deps: Pick<WalletCommandDeps, "directory" | "say" | "interactive" | "secret">, account: string | undefined): Promise<boolean> {
  if (!account) throw invalid("Say which account: persistara wallet remove NAME.testnet");
  const bytes = await readKeystoreEntry(account, deps.directory);
  if (!bytes) { deps.say(`No stored key for ${account}.`); return false; }
  const entry = describeKeystoreEntry(bytes);
  if (!deps.interactive) throw invalid("Removing a key needs an interactive terminal");
  const typed = await deps.secret(`This deletes the encrypted key for ${account} (${entry.publicKey}). It cannot be undone, and you cannot recover the key without your own backup.\nType the account name to confirm: `);
  if (typed !== account) { deps.say("Not confirmed. Nothing was removed."); return false; }
  await unlink(keystorePath(account, deps.directory)); deps.say(`Removed the key for ${account}.`); return true;
}
export async function walletCheck(deps: WalletCommandDeps, account: string | undefined): Promise<string> {
  const name = account ?? deps.config.account;
  if (!name) throw invalid("Say which account: persistara wallet check --account NAME.testnet");
  if (!await readKeystoreEntry(name, deps.directory)) throw invalid(`No stored key for ${name}`);
  if (!deps.interactive) throw invalid("Checking needs an interactive terminal");
  const passphrase = await deps.secret("Passphrase: "); if (!passphrase) throw invalid("Cancelled.");
  const publicKey = await deps.unlockCheck(name, passphrase);
  deps.say(`The passphrase unlocks the key for ${name} (public key ${publicKey}).`); return publicKey;
}

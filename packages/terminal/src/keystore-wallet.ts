import { randomBytes } from "node:crypto";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError, type WorkerExecutor } from "../../protocol/src/providers.js";
import { executeWorker } from "../../protocol/src/worker.js";
import type { OwnerChallenge, PauseRequest } from "../../owner/src/types.js";
import type { OwnerProof, TerminalWallet } from "./wallet.js";

/** Proves a passphrase unlocks the stored key by signing a throwaway message in the isolated signer. Returns the public key. */
export async function unlockKeystore(account: string, directory: string, passphrase: string, execute: WorkerExecutor = executeWorker): Promise<string> {
  const url = new URL("../../owner/src/keystore-worker.js", import.meta.url);
  const result = await execute(url, { account, directory, passphrase, payload: { message: "persistara key store unlock check (not a transaction)", recipient: "persistara-unlock-check", nonce: randomBytes(32).toString("base64url") } }, { effect: "read", timeoutMs: 30_000 });
  if (!isObject(result) || typeof result.publicKey !== "string") throw new ProviderError("AUTHORIZATION_FAILED", "The key store did not unlock");
  return result.publicKey;
}

/**
 * Owner wallet backed by the encrypted key store. Sign-in runs in a separate short-lived signer process, so the owner key is
 * never in the terminal, chat or agent process; this class only holds the passphrase the user typed. Owner transactions
 * (pause/resume) are NOT signed here yet: they are delegated to a fallback wallet (the NEAR CLI) or refused.
 */
export class KeystoreWallet implements TerminalWallet {
  get signerNote(): string | undefined {
    return this.passphrase() === null && this.fallback ? this.fallback.signerNote : "Persistara's encrypted key store signs, in a separate short-lived process.";
  }
  constructor(private readonly account: string, private readonly directory: string, private readonly passphrase: () => string | null,
    private readonly fallback: TerminalWallet | null = null, private readonly execute: WorkerExecutor = executeWorker) {}
  async signMessage(challenge: OwnerChallenge): Promise<OwnerProof> {
    if (challenge.signerId !== this.account) throw new ProviderError("AUTHORIZATION_FAILED", "The stored key belongs to a different account than this workspace's owner");
    const passphrase = this.passphrase();
    if (!passphrase) throw new ProviderError("AUTHORIZATION_FAILED", "The owner key store is locked. Restart persistara in a terminal and enter your passphrase.");
    const url = new URL("../../owner/src/keystore-worker.js", import.meta.url);
    const result = await this.execute(url, { account: this.account, directory: this.directory, passphrase, payload: { message: challenge.message, recipient: challenge.recipient, nonce: challenge.nonce } }, { effect: "read", timeoutMs: 30_000 });
    if (!isObject(result) || result.accountId !== challenge.signerId || result.publicKey !== challenge.publicKey || typeof result.signature !== "string") throw new ProviderError("AUTHORIZATION_FAILED", "The key store holds a different key than the registered owner key");
    return { challengeId: challenge.id, accountId: challenge.signerId, publicKey: challenge.publicKey, signature: result.signature };
  }
  async send(request: PauseRequest): Promise<string> {
    if (this.fallback) return this.fallback.send(request);
    throw new ProviderError("UNSUPPORTED", "Owner pause/resume is not signed by the key store yet; install the NEAR CLI and run `persistara wallet near-cli` for that");
  }
}

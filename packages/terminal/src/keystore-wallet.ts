import { randomBytes } from "node:crypto";
import { isObject } from "../../protocol/src/memory.js";
import { transactionHash } from "../../near/src/protocol.js";
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
 * never in the terminal, chat or agent process; this class only holds the passphrase the user typed. The owner's pause/resume
 * transaction is signed the same way when an RPC URL is given; otherwise it goes to a fallback wallet (the NEAR CLI) or is refused.
 */
export class KeystoreWallet implements TerminalWallet {
  get signerNote(): string | undefined {
    return this.passphrase() === null && this.fallback ? this.fallback.signerNote : "Persistara's encrypted key store signs, in a separate short-lived process.";
  }
  constructor(private readonly account: string, private readonly directory: string, private readonly passphrase: () => string | null,
    private readonly fallback: TerminalWallet | null = null, private readonly execute: WorkerExecutor = executeWorker, private readonly rpcUrl: string | null = null) {}
  async signMessage(challenge: OwnerChallenge): Promise<OwnerProof> {
    if (challenge.signerId !== this.account) throw new ProviderError("AUTHORIZATION_FAILED", "The stored key belongs to a different account than this workspace's owner");
    const passphrase = this.passphrase();
    if (!passphrase) throw new ProviderError("AUTHORIZATION_FAILED", "The owner key store is locked. Restart persistara in a terminal and enter your passphrase.");
    const url = new URL("../../owner/src/keystore-worker.js", import.meta.url);
    const result = await this.execute(url, { account: this.account, directory: this.directory, passphrase, payload: { message: challenge.message, recipient: challenge.recipient, nonce: challenge.nonce } }, { effect: "read", timeoutMs: 30_000 });
    if (!isObject(result) || result.accountId !== challenge.signerId || result.publicKey !== challenge.publicKey || typeof result.signature !== "string") throw new ProviderError("AUTHORIZATION_FAILED", "The key store holds a different key than the registered owner key");
    return { challengeId: challenge.id, accountId: challenge.signerId, publicKey: challenge.publicKey, signature: result.signature };
  }
  /**
   * Signs and broadcasts the owner's pause/resume transaction in a separate short-lived process, then returns its hash for the
   * owner journal to reconcile. Without a passphrase it falls back to the NEAR CLI wallet if there is one. Anything after the
   * signer started that is not a definite pre-signing refusal is reported as an unknown outcome, never retried automatically.
   */
  async send(request: PauseRequest): Promise<string> {
    const passphrase = this.passphrase();
    if (!passphrase || !this.rpcUrl) {
      if (this.fallback) return this.fallback.send(request);
      throw new ProviderError("AUTHORIZATION_FAILED", "The owner key store is locked. Restart persistara in a terminal and enter your passphrase.");
    }
    const action = request.actions[0];
    if (request.network.kind !== "testnet" || request.network.chainId !== "testnet" || request.signerId !== this.account || request.actions.length !== 1 || !action || action.params.methodName !== "set_paused" ||
        action.params.deposit !== "0" || action.params.gas !== "100000000000000") throw new ProviderError("INVALID_INPUT", "Only the exact owner pause/resume request can be signed");
    const url = new URL("../../owner/src/keystore-tx-worker.js", import.meta.url);
    let result: unknown;
    try {
      result = await this.execute(url, { account: this.account, directory: this.directory, passphrase, rpcUrl: this.rpcUrl, ownerPublicKey: request.ownerPublicKey,
        tx: { receiverId: request.receiverId, methodName: action.params.methodName, args: action.params.args, gas: action.params.gas, deposit: action.params.deposit } }, { effect: "may-charge", timeoutMs: 60_000 });
    } catch (error) {
      if (error instanceof ProviderError && ["AUTHORIZATION_FAILED", "NOT_CONFIGURED", "INVALID_INPUT"].includes(error.code)) throw error;
      throw new ProviderError("OUTCOME_UNKNOWN", "The signer outcome is unknown; reconcile the existing owner request without resending");
    }
    if (!isObject(result) || typeof result.transactionHash !== "string" || !transactionHash(result.transactionHash)) throw new ProviderError("OUTCOME_UNKNOWN", "The signer returned no valid transaction hash; reconcile without resending");
    return result.transactionHash;
  }
}

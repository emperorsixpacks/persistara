import { randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "near-api-js/nep413";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import type { OwnerChallenge, OwnerView } from "./types.js";

const token = () => randomBytes(32).toString("base64url");
const denied = () => new ProviderError("AUTHORIZATION_FAILED", "Owner authentication is absent, expired or does not match");
interface Session { csrf: string; expiresAt: number; owner: string; publicKey: string }
export class OwnerAuth {
  private readonly challenges = new Map<string, OwnerChallenge>();
  private readonly sessions = new Map<string, Session>();
  constructor(readonly origin: string, private readonly read: () => Promise<OwnerView>, private readonly now = Date.now) {}
  private prune() {
    for (const [id, c] of this.challenges) if (c.expiresAt <= this.now()) this.challenges.delete(id);
    for (const [id, s] of this.sessions) if (s.expiresAt <= this.now()) this.sessions.delete(id);
  }
  async challenge(previous?: string): Promise<OwnerChallenge> {
    this.prune();
    if (previous) this.challenges.delete(previous);
    if (this.challenges.size >= 32) throw new ProviderError("OPERATION_CONFLICT", "Too many outstanding wallet challenges");
    const view = await this.read();
    if (!view.ownerKeyFullAccess || !view.ownerKey.startsWith("ed25519:")) throw denied();
    const id = token();
    const result: OwnerChallenge = { id, signerId: view.owner, publicKey: view.ownerKey, network: "testnet", recipient: this.origin,
      nonce: token(), expiresAt: this.now() + 300_000,
      message: `Connect to Persistara owner controls.\nOrigin: ${this.origin}\nNetwork: NEAR ${view.chainId}\nAccount: ${view.owner}\nContract: ${view.contractId}\nAgent: ${view.agentId}\nChallenge: ${id}\nThis signature authenticates a session; it does not authorize a transaction.` };
    // Recheck capacity after the asynchronous read.
    if (this.challenges.size >= 32) throw new ProviderError("OPERATION_CONFLICT", "Too many outstanding wallet challenges");
    this.challenges.set(id, result); return structuredClone(result);
  }
  async login(challengeCookie: string | undefined, proof: unknown): Promise<{ token: string; session: Session }> {
    this.prune();
    if (!challengeCookie || !isObject(proof) || Object.keys(proof).sort().join(",") !== "accountId,challengeId,publicKey,signature" || proof.challengeId !== challengeCookie) throw denied();
    const challenge = this.challenges.get(challengeCookie);
    this.challenges.delete(challengeCookie); // Consumed before await: concurrent/replayed proofs cannot both log in.
    if (!challenge || challenge.expiresAt <= this.now() || proof.accountId !== challenge.signerId || proof.publicKey !== challenge.publicKey ||
        typeof proof.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature)) throw denied();
    const signature = Buffer.from(proof.signature, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== proof.signature) throw denied();
    const view = await this.read();
    if (view.owner !== challenge.signerId || view.ownerKey !== challenge.publicKey || !view.ownerKeyFullAccess) throw denied();
    // SDK verification uses only viewAccessKey. Supply the independently pinned finalized
    // owner-key observation, rather than letting its default provider choose another block.
    const provider = { viewAccessKey: async (query: { accountId: string; publicKey: unknown }) => {
      if (query.accountId !== view.owner || String(query.publicKey) !== view.ownerKey) throw denied();
      return { nonce: view.ownerNonce, permission: "FullAccess" };
    } } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
    try { await verifyMessage({ signerAccountId: view.owner, signerPublicKey: view.ownerKey, signature,
      payload: { message: challenge.message, recipient: challenge.recipient, nonce: Buffer.from(challenge.nonce, "base64url") }, provider }); }
    catch { throw denied(); }
    this.prune();
    if (challenge.expiresAt <= this.now() || this.sessions.size >= 16) throw denied();
    const session: Session = { owner: view.owner, publicKey: view.ownerKey, csrf: token(), expiresAt: this.now() + 600_000 };
    const id = token(); this.sessions.set(id, session);
    return { token: id, session: structuredClone(session) };
  }
  require(id: string | undefined, csrf?: string): Session {
    this.prune(); const s = id ? this.sessions.get(id) : undefined;
    if (!s) throw denied();
    if (csrf !== undefined && (Buffer.byteLength(csrf) !== Buffer.byteLength(s.csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(s.csrf)))) throw denied();
    return structuredClone(s);
  }
  logout(id: string) { this.sessions.delete(id); }
}

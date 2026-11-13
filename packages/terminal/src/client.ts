import { OwnerAuth } from "../../owner/src/auth.js";
import type { OwnerService } from "../../owner/src/service.js";
import type { OwnerView } from "../../owner/src/types.js";
import type { MissionService } from "../../runtime/src/service.js";
import type { CommissionService } from "../../commerce/src/service.js";
import type { CommissionView } from "../../commerce/src/types.js";
import { canonical, hash } from "../../near/src/protocol.js";
import { ProviderError } from "../../protocol/src/providers.js";
import type { TerminalWallet } from "./wallet.js";

export interface TerminalReview { kind: "connect" | "reserve" | "settle" | "pause" | "resume" | "review"; digest: string; title: string; details: Record<string, string>; costs: boolean }
export interface TerminalServices { service: OwnerService; missions: MissionService; commerce: CommissionService; close(): Promise<void> }
export type ConfirmReview = (review: TerminalReview) => Promise<boolean>;
export function commissionReviews(c: CommissionView) {
  return {
    reservation: c.task && c.quoteDigest ? hash(canonical({ kind: "reserve", scope: c.task.scope, id: c.id, quoteDigest: c.quoteDigest, amountYoctoNear: c.amountYoctoNear, brief: c.task.brief })) : null,
    settlement: c.task && c.quoteDigest && c.artifactDigest ? hash(canonical({ kind: "settle", scope: c.task.scope, id: c.id, quoteDigest: c.quoteDigest, artifactDigest: c.artifactDigest, amountYoctoNear: c.amountYoctoNear })) : null,
  };
}
const canceled = () => new ProviderError("ABORTED", "Review canceled; no new effect was dispatched");
export class TerminalClient {
  readonly auth: OwnerAuth;
  #token: string | null = null;
  #csrf: string | null = null;
  #challenge: string | undefined;
  constructor(readonly services: TerminalServices, private readonly wallet: TerminalWallet, private readonly confirm: ConfirmReview, now = Date.now) {
    const c = services.service.config;
    this.auth = new OwnerAuth(`persistara-cli:v1:${c.chainId}:${c.contractId}:${c.agentId}`, async () => { const view = await services.service.read(); this.scope(view); return view; }, now);
  }
  async connect() {
    this.disconnect();
    const challenge = await this.auth.challenge(this.#challenge); this.#challenge = challenge.id;
    const c = this.services.service.config;
    if (!await this.confirm({ kind: "connect", title: "Connect owner wallet", digest: hash(challenge.message), costs: false, details: { account: challenge.signerId, agent: c.agentId, contract: c.contractId, network: "NEAR testnet", signer: this.wallet.signerNote ?? "", publicKey: challenge.publicKey, recipient: challenge.recipient, message: challenge.message, effect: "Sign a message for a 10-minute session. No transaction, payment or added key." } })) throw canceled();
    const result = await this.auth.login(challenge.id, await this.wallet.signMessage(challenge));
    this.#challenge = undefined; this.#token = result.token; this.#csrf = result.session.csrf;
    return { authenticated: true, owner: result.session.owner, expiresAt: result.session.expiresAt };
  }
  disconnect() { if (this.#token) this.auth.logout(this.#token); this.#token = null; this.#csrf = null; }
  authenticated() { try { this.auth.require(this.#token ?? undefined, this.#csrf ?? ""); return true; } catch { return false; } }
  private scope(view: OwnerView) {
    const c = this.services.service.config, scope = this.services.missions.journal.scope;
    if (view.owner !== c.signerId || view.agentId !== c.agentId || view.contractId !== c.contractId || view.chainId !== c.chainId || view.codeHash !== scope.codeHash) throw new ProviderError("AUTHORIZATION_FAILED", "Terminal authority belongs to another configured workspace");
  }
  authorize = (view: OwnerView) => {
    const session = this.auth.require(this.#token ?? undefined, this.#csrf ?? "");
    this.scope(view);
    if (view.owner !== session.owner || view.ownerKey !== session.publicKey || !view.ownerKeyFullAccess) throw new ProviderError("AUTHORIZATION_FAILED", "Reconnect the original owner before continuing");
  };
  async current() { const view = await this.services.service.read(); this.authorize(view); return view; }
  async status() {
    const view = await this.services.service.read();
    let authenticated = false; try { this.authorize(view); authenticated = true; } catch { /* Public status never implies an owner session. */ }
    return { view, authenticated, pendingOwner: this.services.service.journal.pending(), inference: "not_configured_or_invoked", terminalMode: "durable-source-missions" };
  }
  async list() { await this.current(); return this.services.missions.journal.list().map(m => this.services.commerce.project(m)); }
  async detail(id: string) { await this.current(); return this.services.commerce.detail(this.services.missions.journal.get(id)); }
  async create(input: unknown) { return this.services.missions.create(input, await this.current()); }
  async run(id: string, wait = true) {
    const detail = await this.detail(id); this.services.missions.start(id, detail.mission.version, await this.current());
    if (wait) await this.services.missions.wait(id); return this.detail(id);
  }
  async cancel(id: string) { const detail = await this.detail(id); return this.services.missions.cancel(id, detail.mission.version); }
  async review(id: string) {
    const detail = await this.detail(id); if (!detail.artifact || detail.commission) throw new ProviderError("OPERATION_CONFLICT", "Open a completed local dossier, or use commission settlement for a specialist delivery");
    if (detail.mission.state === "completed") return detail;
    if (!await this.confirm({ kind: "review", title: "Record review of this exact dossier", digest: detail.artifact.digest, costs: false, details: { missionId: id, artifactDigest: detail.artifact.digest, sources: String(detail.artifact.value.sources.length), effect: "Local review only; no payment or research-quality proof" } })) throw canceled();
    await this.current(); return this.services.missions.approve(id, detail.mission.version, detail.artifact.digest);
  }
  async activity() { await this.current(); return this.services.missions.journal.activity(); }
  async commission(id: string, maximumYoctoNear: string) { const detail = await this.detail(id); return this.services.commerce.create(id, detail.mission.version, maximumYoctoNear, await this.current(), this.authorize); }
  async commissionView(id: string) { await this.current(); const value = this.services.commerce.options.journal.view(id); return { ...value, reviews: commissionReviews(value) }; }
  async request(id: string) { await this.current(); return this.services.commerce.request(id); }
  async importQuote(id: string, signed: unknown) { await this.current(); return this.services.commerce.importQuote(id, signed, this.authorize); }
  async importDelivery(id: string, signed: unknown) { await this.current(); return this.services.commerce.importDelivery(id, signed, this.authorize); }
  async reconcile(id: string) { await this.current(); return this.services.commerce.reconcile(id); }
  async reserve(id: string) {
    const c = await this.commissionView(id);
    if (["preparing", "awaiting_quote", "canceled", "failed"].includes(c.state)) throw new ProviderError("OPERATION_CONFLICT", "Import a valid signed quote before reserving this commission");
    if (!["quoted", "brief_ready"].includes(c.state)) return this.reconcile(id);
    if (!c.quote || !c.quoteDigest || !c.reviews.reservation) throw new ProviderError("OPERATION_CONFLICT", "Import a valid signed quote before reserving");
    const q = c.quote;
    if (!await this.confirm({ kind: "reserve", title: "Reserve this exact specialist quote", digest: c.reviews.reservation, costs: true, details: { commissionId: id, worker: c.worker, asset: "NEAR / near:testnet", amountYoctoNear: c.amountYoctoNear, quoteDigest: c.quoteDigest, uploadCeiling: "0.01 testnet 0G including maximum gas", deliveryDeadlineNs: q.deliveryDeadlineNs, reviewWindowNs: q.reviewWindowNs, recipientCustody: "Separate local delivery key; memory-only backups do not contain it. Verify its portable-kit backup.", disputeTerms: "Anyone may trigger unchallenged payout after review expiry; disputes are buyer-controlled", effect: "Upload encrypted brief and reserve treasury amount; separate NEAR gas applies" } })) throw canceled();
    await this.current(); return this.services.commerce.reserve(id, c.version, c.quoteDigest, this.authorize);
  }
  async settle(id: string) {
    const c = await this.commissionView(id);
    if (c.reviewed || ["payout_pending", "payout_failed"].includes(c.state)) return this.reconcile(id);
    if (!["delivery_ready", "paid"].includes(c.state)) throw new ProviderError("OPERATION_CONFLICT", "Import and inspect the signed encrypted delivery before settlement");
    if (!c.deliveryVerified || !c.artifactDigest || !c.quoteDigest || !c.reviews.settlement) throw new ProviderError("OPERATION_CONFLICT", "Verify and inspect the exact delivery first");
    if (!await this.confirm({ kind: "settle", title: "Review and settle this exact delivery", digest: c.reviews.settlement, costs: c.state !== "paid", details: { commissionId: id, worker: c.worker, amountYoctoNear: c.amountYoctoNear, quoteDigest: c.quoteDigest, artifactDigest: c.artifactDigest, effect: c.state === "paid" ? "Record local delivery review; payment already finalized" : "Accept this immutable result; payout completes only after its finalized callback", quality: "Inspect actual sources; signatures do not establish correctness" } })) throw canceled();
    await this.current(); return this.services.commerce.settle(id, c.version, c.artifactDigest, c.quoteDigest, this.authorize);
  }
  async ownerChange(paused: boolean) {
    await this.current(); const result = await this.services.service.prepare(paused, this.authorize), operation = result.operation;
    if (!operation) return result;
    if (!await this.confirm({ kind: paused ? "pause" : "resume", title: paused ? "Pause new agent activity" : "Resume agent activity", digest: operation.digest, costs: true, details: { operationId: operation.request.id, account: operation.request.signerId, originalKey: operation.request.ownerPublicKey, contract: operation.request.receiverId, method: "set_paused", paused: String(paused), deposit: "0 NEAR", maximumGas: "100 Tgas", effect: "Existing payout obligations continue" } })) { this.services.service.journal.cancel(operation.request.id); throw canceled(); }
    await this.current(); const dispatched = await this.services.service.dispatch(operation.request.id, operation.digest, this.authorize);
    try { return await this.services.service.reconcile(dispatched.request.id, await this.wallet.send(dispatched.request)); }
    catch { return this.services.service.reconcile(dispatched.request.id); }
  }
  async prepareOwner(paused: boolean) { await this.current(); return this.services.service.prepare(paused, this.authorize); }
  async reconcileOwner(id: string, transactionHash?: string) { await this.current(); return this.services.service.reconcile(id, transactionHash); }
  async cancelOwner(id: string) { await this.current(); return this.services.service.journal.cancel(id); }
  async close() { this.disconnect(); await this.services.close(); }
}

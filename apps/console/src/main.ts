import { NearConnector, type NearWalletBase } from "@hot-labs/near-connect";
import type { OwnerChallenge, OwnerOperation, OwnerView } from "../../../packages/owner/src/types.js";
import "./style.css";

const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `
  <header class="topbar"><a class="brand" href="/" aria-label="Persistara home"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M28 10H15a10 10 0 0 0 0 20h10a10 10 0 0 0 0-20M12 30h13M12 10v20m16-20v20"/></svg>Persistara<span class="brand-note">OWNER WORKSPACE</span></a><span class="network"><i></i>NEAR testnet</span></header>
  <div id="fixture-banner" class="fixture" hidden>LOCAL TEST FIXTURE · Wallet and chain transport are simulated. No live verification is claimed.</div>
  <main>
    <section class="intro"><div><p class="eyebrow">01 / OWNER CONNECTION</p><h1>Your agent.<br><em>Your authority.</em></h1><p class="lede">Connect the wallet that owns your agent.<br>Review every change before it reaches the chain.</p></div><div class="intro-note"><span class="orbit" aria-hidden="true">↗</span><p>Memory carries forward.<br>Control stays with you.</p></div></section>
    <div class="workspace">
      <aside class="journey" aria-label="Connection progress"><p class="eyebrow">GET CONNECTED</p><ol><li id="step-connect" class="current"><span>01</span><div>Connect wallet<small>Choose your owner wallet</small></div></li><li id="step-verify"><span>02</span><div>Verify ownership<small>Sign a one-time message</small></div></li><li id="step-control"><span>03</span><div>Review controls<small>Check permissions and recovery</small></div></li></ol><div class="aside-note"><span class="small-mark">↳</span><p>Your wallet keeps its private key. Connecting does not grant runtime permissions.</p></div></aside>
      <div class="content">
        <section class="panel connect-panel" aria-labelledby="connect-title"><div class="panel-heading"><div><p class="eyebrow">OWNER WALLET</p><h2 id="connect-title">A connection you control.</h2></div><span id="session-status" class="pill">Disconnected</span></div><p id="connect-copy" class="muted">Use the original owner key registered for this agent. Another key on the same account cannot enable these controls.</p><dl class="identity"><div><dt>Expected owner</dt><dd id="expected-owner">Loading…</dd></div><div><dt>Agent</dt><dd id="expected-agent">Loading…</dd></div></dl><div class="button-row"><button id="connect" class="primary" disabled>Connect NEAR wallet <span aria-hidden="true">↗</span></button><button id="disconnect" class="quiet" hidden>Disconnect</button><span id="session-expiry" class="tiny"></span></div></section>
        <div id="notice" class="notice" role="status" aria-live="polite">Loading the local owner workspace…</div>
        <section class="panel" aria-labelledby="readiness-title"><div class="panel-heading"><div><p class="eyebrow">BEFORE YOU CONTINUE</p><h2 id="readiness-title">Know where things stand.</h2></div><button id="refresh" class="quiet" hidden>Refresh state ↻</button></div><div class="readiness"><div><span class="readiness-icon">↗</span><h3>Owner authority</h3><p id="authority-status">Connect to verify</p><small id="authority-detail">The registered key must have full access.</small></div><div><span class="readiness-icon">⌁</span><h3>Runtime permissions</h3><p id="runtime-status">Not checked</p><small id="runtime-detail">Restricted calls and a bounded gas allowance.</small></div><div><span class="readiness-icon">◇</span><h3>Memory recovery</h3><p id="backup-status">Not checked</p><small id="backup-detail">Local backup authentication is checked separately from off-device custody.</small></div></div><p class="footnote" id="offdevice">Off-device backup has not been verified.</p></section>
        <section class="panel" aria-labelledby="controls-title"><div class="panel-heading"><div><p class="eyebrow">AGENT CONTROLS</p><h2 id="controls-title">Stay in the driver's seat.</h2></div><span id="agent-status" class="pill">Not checked</span></div><p class="muted">Pausing stops new runtime authorizations and memory checkpoints. Existing payment obligations continue.</p><div class="metrics"><div><span>Available treasury</span><strong id="balance">—</strong></div><div><span>Memory checkpoint</span><strong id="checkpoint">—</strong></div><div><span>Key epoch</span><strong id="epoch">—</strong></div><div><span>Per-job limit</span><strong id="job-limit">—</strong></div><div><span>Daily limit</span><strong id="daily-limit">—</strong></div></div><div class="button-row"><button id="pause" class="secondary" disabled>Review pause</button><button id="resume" class="secondary" disabled>Review resume</button><span id="resume-reason" class="tiny">Verify your owner connection to continue.</span></div></section>
        <section id="pending-panel" class="panel pending-panel" hidden aria-labelledby="pending-title"><p class="eyebrow">PENDING WALLET OUTCOME</p><h2 id="pending-title">Resolve the existing request.</h2><p id="pending-copy" class="muted"></p><p id="pending-id" class="mono"></p><label for="transaction-hash">Transaction hash from your wallet</label><div class="hash-row"><input id="transaction-hash" type="text" autocomplete="off" spellcheck="false" placeholder="Paste the NEAR transaction hash"/><button id="reconcile" class="secondary">Check transaction</button></div><button id="reopen" class="quiet" hidden>Open prepared review</button></section>
        <details id="evidence" class="panel"><summary>Inspect authority & transaction evidence <span aria-hidden="true">＋</span></summary><div class="evidence-body"><p id="block" class="mono">Finalized state has not been checked.</p><p id="contract" class="mono"></p><p id="owner-key" class="mono"></p><div id="history"></div><p class="footnote">A confirmed owner transaction proves the requested chain action. It does not verify storage availability, AI inference or research quality.</p></div></details>
      </div>
    </div><footer><span>PERSISTARA</span><p>Owner-controlled agents. Recoverable memory. Reviewable work.</p><span>LOCAL WORKSPACE / TESTNET</span></footer>
  </main>
  <dialog id="review"><div class="review-inner"><p class="eyebrow">REVIEW OWNER ACTION</p><h2 id="review-title">Review this change.</h2><p id="review-copy" class="muted"></p><dl class="review-details"><div><dt>Agent</dt><dd id="review-agent"></dd></div><div><dt>Contract</dt><dd id="review-contract"></dd></div><div><dt>Owner key</dt><dd id="review-key" class="mono"></dd></div><div><dt>Action</dt><dd id="review-method"></dd></div><div><dt>Attached NEAR</dt><dd>0 NEAR · network gas applies, maximum 100 Tgas</dd></div><div><dt>Request fingerprint</dt><dd id="review-digest" class="mono"></dd></div></dl><label class="ack"><input id="ack" type="checkbox"/>I have reviewed this owner action.</label><div class="button-row"><button id="sign" class="primary" disabled>Sign in wallet ↗</button><button id="cancel-review" class="quiet">Cancel review</button></div></div></dialog>`;

function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const button = (id: string) => element<HTMLButtonElement>(id);
const text = (id: string, value: string) => { element(id).textContent = value; };
const show = (id: string, visible: boolean) => { element(id).hidden = !visible; };
const status = (message: string, failure = false) => { text("notice", message); element("notice").classList.toggle("error", failure); };
let csrf = "", busy = false, wallet: NearWalletBase | undefined, view: OwnerView | null = null, pending: OwnerOperation | null = null;
let reviewed: OwnerOperation | null = null;
const dialog = element<HTMLDialogElement>("review");
const ack = element<HTMLInputElement>("ack");
const connector = new NearConnector({ network: "testnet", autoConnect: false,
  features: { signMessage: true, signInWithoutAddKey: true, signAndSendTransaction: true },
  cspNonce: document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "",
  logger: { log: () => {} } });
const messages: Record<string, string> = {
  AUTHORIZATION_FAILED: "Owner verification is required. Connect the original owner wallet and sign a new message.",
  OPERATION_CONFLICT: "The request or agent state changed. Refresh and resolve the existing request before continuing.",
  OUTCOME_UNKNOWN: "A wallet outcome is unresolved. Use its transaction hash to reconcile; this request will not be resent.",
  INTEGRITY_FAILED: "The observed transaction or authority differs from the reviewed request. Controls remain blocked.",
  INVALID_INPUT: "Check the request or transaction hash and try again.",
  UPSTREAM_ERROR: "The local workspace or NEAR RPC is unavailable. Refresh to check the recorded state.",
  NETWORK_MISMATCH: "The configured RPC is not NEAR testnet. Restore the expected testnet endpoint before continuing.",
  PROTOCOL_ERROR: "The chain response could not be verified. Controls stay unavailable until a valid finalized read.",
};
class ApiError extends Error { constructor(readonly code: string) { super(messages[code] ?? "The request could not be completed. Refresh the recorded state."); } }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", signal: AbortSignal.timeout(120_000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json", "x-persistara-csrf": csrf }, body: JSON.stringify(body) }) });
  const data = await response.json() as T & { code?: string };
  if (!response.ok) throw new ApiError(data.code ?? "UPSTREAM_ERROR");
  return data;
}
function money(value: string): string {
  const amount = BigInt(value), whole = amount / 10n ** 24n, fraction = (amount % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} NEAR`;
}
function controls() {
  button("connect").disabled = busy;
  button("disconnect").disabled = busy;
  button("refresh").disabled = busy;
  button("pause").disabled = busy || !wallet || !csrf || !view || view.paused || Boolean(pending);
  button("resume").disabled = busy || !wallet || !csrf || !view?.paused || !view.canResume || Boolean(pending);
  button("reconcile").disabled = busy || !csrf;
  button("sign").disabled = busy || !ack.checked || !wallet;
  button("cancel-review").disabled = busy;
}
async function work(action: () => Promise<void>) {
  if (busy) return;
  busy = true; controls();
  try { await action(); }
  catch (error) {
    if (error instanceof ApiError && ["AUTHORIZATION_FAILED", "UPSTREAM_ERROR", "INTEGRITY_FAILED", "NETWORK_MISMATCH", "PROTOCOL_ERROR"].includes(error.code)) {
      view = null; text("agent-status", "Refresh required");
      if (error.code === "AUTHORIZATION_FAILED") { csrf = ""; text("session-status", "Verify owner again"); element("session-status").classList.remove("good"); }
    }
    status(error instanceof ApiError ? error.message : "The wallet or connection returned no confirmed outcome. Refresh the recorded state before another action.", true);
  }
  finally { busy = false; controls(); }
}
function renderOperation(operation: OwnerOperation) {
  pending = operation;
  show("pending-panel", true); text("pending-id", operation.request.id);
  text("pending-copy", operation.state === "prepared" ? "This request is prepared and has not been handed to a wallet. You can review or cancel it safely."
    : "A wallet handoff was recorded. Keep this request pending until a matching transaction is finalized. A wallet cancellation or lost response does not prove it was never broadcast.");
  show("reopen", operation.state === "prepared");
  element<HTMLInputElement>("transaction-hash").value = operation.transactionHash ?? operation.candidateHashes.at(-1) ?? "";
}
async function refresh() {
  const result = await api<{ view: OwnerView; pending: OwnerOperation | null; recent: OwnerOperation[] }>("state");
  view = result.view; pending = result.pending;
  text("authority-status", "Owner key verified"); text("authority-detail", `Registered full-access key · generation ${view.generation}`);
  const runtime = view.runtimeKeys.filter((key) => key.ready);
  text("runtime-status", runtime.length ? "Restricted runtime ready" : "Runtime needs attention");
  text("runtime-detail", runtime.length ? `${runtime[0]!.methods.join(", ")} · gas allowance ${money(runtime[0]!.allowance!)} · expires ${new Date(Number(BigInt(runtime[0]!.expiresAtNs) / 1_000_000n)).toLocaleString()}` : "Check key scope, allowance and delegate expiry.");
  text("backup-status", view.backup.status === "verified" ? "Local backup authenticated" : view.backup.status === "epoch_mismatch" ? "Backup epoch differs" : "Backup unavailable");
  text("backup-detail", "Recovery material stays on this machine. No key or recovery secret is sent to this page.");
  text("agent-status", view.paused ? "Paused" : "Active"); element("agent-status").classList.toggle("good", !view.paused);
  text("balance", money(view.balances.available)); text("checkpoint", `Version ${view.checkpointVersion}`); text("epoch", String(view.keyEpoch));
  text("job-limit", view.policy ? money(view.policy.maxJobAmount) : "Unset"); text("daily-limit", view.policy ? money(view.policy.dailyLimit) : "Unset");
  text("resume-reason", view.localRotationHold !== false ? "Resume is held until the local rotation journal is ready." : !view.canResume ? "Resume needs an authenticated backup and a ready runtime." : "Every owner change opens a wallet review.");
  text("block", `Finalized block · ${view.blockHash}`); text("contract", `Authority · ${view.contractId} / code ${view.codeHash}`); text("owner-key", `Registered owner key · ${view.ownerKey}`);
  if (pending) renderOperation(pending); else show("pending-panel", false);
  const history = element("history"); history.replaceChildren();
  for (const row of result.recent) {
    const item = document.createElement("p"); item.className = "history-row";
    const label = document.createElement("span"); label.textContent = `${row.request.paused ? "Pause" : "Resume"} · ${row.state}`; item.append(label);
    if (row.transactionHash) {
      const link = document.createElement("a"); link.textContent = `${row.transactionHash.slice(0, 10)}… ↗`; link.href = `https://testnet.nearblocks.io/txns/${encodeURIComponent(row.transactionHash)}`; link.target = "_blank"; link.rel = "noreferrer"; item.append(link);
    }
    history.append(item);
  }
  element("step-connect").classList.add("done"); element("step-verify").classList.add("done"); element("step-control").classList.add("current");
  show("refresh", true); controls();
}
function openReview(operation: OwnerOperation) {
  reviewed = operation; ack.checked = false;
  text("review-title", operation.request.paused ? "Pause new agent activity?" : "Resume agent activity?");
  text("review-copy", operation.request.paused ? "New runtime spending and memory checkpoints will stop. Existing payout obligations continue." : "The restricted runtime can authorize work again within the contract's existing policy.");
  text("review-agent", operation.request.agentId); text("review-contract", operation.request.receiverId); text("review-key", operation.request.ownerPublicKey);
  text("review-method", `set_paused(${operation.request.paused})`); text("review-digest", operation.digest);
  if (!dialog.open) dialog.showModal(); controls();
}
async function assertWallet() {
  if (!wallet || !view) throw new ApiError("AUTHORIZATION_FAILED");
  const accounts = await wallet.getAccounts({ network: "testnet" });
  if (!accounts.some((account) => account.accountId === view!.owner && (!account.publicKey || account.publicKey === view!.ownerKey))) throw new ApiError("AUTHORIZATION_FAILED");
}
button("connect").onclick = () => void work(async () => {
  if (csrf) await api("logout", {});
  csrf = ""; view = null; wallet = undefined;
  text("session-status", "Disconnected"); element("session-status").classList.remove("good");
  text("authority-status", "Connect to verify"); text("runtime-status", "Not checked"); text("backup-status", "Not checked");
  text("agent-status", "Not checked"); text("balance", "—"); text("checkpoint", "—"); text("epoch", "—"); text("job-limit", "—"); text("daily-limit", "—"); text("session-expiry", "");
  status("Choose your owner wallet, then sign the one-time connection message.");
  wallet = await connector.connect();
  const challenge = await api<OwnerChallenge>("challenge", {});
  const proof = await wallet.signMessage({ network: "testnet", signerId: challenge.signerId, message: challenge.message, recipient: challenge.recipient,
    nonce: Uint8Array.from(atob(challenge.nonce.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - challenge.nonce.length % 4) % 4)), (c) => c.charCodeAt(0)) });
  const session = await api<{ csrf: string; expiresAt: number }>("session", { challengeId: challenge.id, accountId: proof.accountId, publicKey: proof.publicKey, signature: proof.signature });
  csrf = session.csrf; text("session-status", "Owner verified"); element("session-status").classList.add("good");
  text("session-expiry", `Session expires ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  button("connect").textContent = "Reconnect wallet ↗"; show("disconnect", true);
  await refresh(); status("Owner connection verified against finalized NEAR state. Review an action when you are ready.");
});
button("disconnect").onclick = () => void work(async () => {
  if (csrf) await api("logout", {});
  if (wallet) await connector.disconnect(wallet);
  wallet = undefined; csrf = ""; view = null; pending = null; location.reload();
});
button("refresh").onclick = () => void work(async () => { await refresh(); status("Finalized authority and local readiness refreshed."); });
for (const [id, paused] of [["pause", true], ["resume", false]] as const) button(id).onclick = () => void work(async () => {
  await assertWallet();
  const result = await api<{ operation: OwnerOperation | null; view: OwnerView }>("prepare", { paused });
  view = result.view;
  if (result.operation) openReview(result.operation); else { await refresh(); status("The agent is already in the requested state."); }
});
ack.onchange = controls;
dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!busy) button("cancel-review").click(); });
button("cancel-review").onclick = () => void work(async () => {
  if (!reviewed) return;
  await api("cancel", { id: reviewed.request.id }); dialog.close(); reviewed = null; await refresh(); status("Unsubmitted review canceled. No wallet transaction was requested.");
});
button("sign").onclick = () => void work(async () => {
  if (!reviewed || !ack.checked) return;
  await assertWallet();
  const approved = reviewed;
  const dispatched = await api<{ operation: OwnerOperation }>("dispatch", { id: approved.request.id, digest: approved.digest });
  if (dispatched.operation.digest !== approved.digest || dispatched.operation.state !== "dispatched") throw new ApiError("INTEGRITY_FAILED");
  dialog.close(); reviewed = null; renderOperation(dispatched.operation);
  status("Request recorded. Approve this exact owner action in your wallet.");
  let observedHash: string | undefined;
  try {
    await assertWallet();
    const result = await wallet!.signAndSendTransaction({ network: "testnet", signerId: approved.request.signerId, receiverId: approved.request.receiverId, actions: approved.request.actions });
    const resultHash = result?.transaction?.hash;
    if (typeof resultHash !== "string") throw new ApiError("OUTCOME_UNKNOWN");
    observedHash = resultHash;
    const observed = await api<{ operation: OwnerOperation }>("reconcile", { id: approved.request.id, transactionHash: resultHash });
    await refresh(); status(observed.operation.state === "confirmed" ? "Owner transaction finalized and verified." : observed.operation.state === "failed" ? "The owner transaction failed on-chain. Its receipt is retained." : "The matching transaction is still unresolved. Check its recorded hash again.", observed.operation.state !== "confirmed");
  } catch (error) {
    try { await refresh(); } catch { /* The durable handoff remains pending across reload/re-authentication. */ }
    if (observedHash) element<HTMLInputElement>("transaction-hash").value = observedHash;
    status(error instanceof ApiError && error.code === "INTEGRITY_FAILED" ? error.message : "The wallet returned no confirmed outcome. Check wallet activity and reconcile its transaction hash. This request will not be resent.", true);
  }
});
button("reopen").onclick = () => { if (pending?.state === "prepared") openReview(pending); };
button("reconcile").onclick = () => void work(async () => {
  if (!pending) return;
  const transactionHash = element<HTMLInputElement>("transaction-hash").value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(transactionHash)) throw new ApiError("INVALID_INPUT");
  const result = await api<{ operation: OwnerOperation }>("reconcile", { id: pending.request.id, transactionHash });
  await refresh(); status(result.operation.state === "confirmed" ? "Owner transaction finalized and verified." : result.operation.state === "failed" ? "The transaction failed on-chain; its receipt is retained." : "Outcome remains unresolved. No replacement request has been created.", result.operation.state !== "confirmed");
});
connector.on("wallet:signOut", () => { wallet = undefined; controls(); });
void work(async () => {
  const info = await api<{ owner: string; agentId: string; contractId: string; fixture: boolean }>("info");
  text("expected-owner", info.owner); text("expected-agent", info.agentId); show("fixture-banner", info.fixture);
  try {
    const session = await api<{ csrf: string }>("session"); csrf = session.csrf;
    await refresh(); text("session-status", "Session restored"); status("Owner session restored. Reconnect your wallet before signing another action.");
  } catch { status("Connect the registered owner wallet to verify authority and local readiness."); }
});

import { createHash } from "node:crypto";
import { baseEncode } from "near-api-js";
import { ProviderError } from "../../protocol/src/providers.js";
import { subaccountAgentName } from "./protocol.js";

/**
 * Owner-run testnet deployment of the authority contract. Pure orchestration over a `DeployChain` port so every guard, the step
 * order and resume-after-failure behavior can be tested with a fake chain. Each step first reads current chain state and only
 * acts when needed, so re-running after any failure continues instead of repeating. Without `execute` it only reads and plans.
 * It deploys exactly one audited file: the code hash must equal the expected hash before anything is signed.
 */
export const NEAR = 10n ** 24n;
export const COSTS = { contractAccount: 5n * NEAR, registerAgent: 3n * NEAR / 10n, fund: NEAR / 10n, runtimeAllowance: NEAR / 4n, ownerMinimum: 13n * NEAR / 2n, gasMargin: NEAR / 2n };
export const POLICY = { maxJobAmount: (NEAR / 50n).toString(), dailyLimit: (NEAR / 20n).toString() };
export const RUNTIME_METHODS = ["checkpoint_memory", "create_job", "accept_job"];
const DELEGATE_DAYS = 30;

export interface AgentSnapshot { id: string; policy: { maxJobAmount: string; dailyLimit: string; approvedWorkers: string[] } | null; deposited: string; delegates: { publicKey: string; canCheckpoint: boolean; canSpend: boolean; expiresAtNs: string }[] }
export interface DeployChain {
  nowMs(): number;
  balance(account: string): Promise<bigint>;
  accountExists(account: string): Promise<boolean>;
  codeHash(account: string): Promise<string | null>;
  fullAccessKeys(account: string): Promise<string[]>;
  functionCallKeys(account: string): Promise<{ publicKey: string; receiver: string; methods: string[] }[]>;
  agent(contract: string, agentId: string): Promise<AgentSnapshot | null>;
  /** Signed by the owner. */
  createContractAccount(contract: string, contractPublicKey: string, amount: bigint): Promise<void>;
  /** One atomic transaction signed by the contract account: deploy the code and call `new`. */
  deployAndInit(contract: string, wasm: Uint8Array): Promise<void>;
  /** Signed by the owner. */
  ownerCall(contract: string, method: string, args: Record<string, unknown>, deposit: bigint): Promise<void>;
  addRuntimeKey(owner: string, publicKey: string, contract: string, methods: string[], allowance: bigint): Promise<void>;
}
export interface DeployOptions {
  owner: string; ownerPublicKey: string; contract: string; agentName: string; worker: string;
  wasm: Uint8Array; expectedHash: string;
  /** Null when the runtime key does not exist yet (dry run only); the script creates it before executing. */
  runtimePublicKey: string | null; contractPublicKey: string | null; contractKeyAvailable: boolean; execute: boolean;
}
export interface DeployStep { id: string; action: "done" | "will-do" | "did"; detail: string }
export interface DeployResult { steps: DeployStep[]; agentId: string; env: Record<string, string> }
const invalid = (message: string) => new ProviderError("INVALID_INPUT", message);
const conflict = (message: string) => new ProviderError("OPERATION_CONFLICT", message);

export function wasmCodeHash(wasm: Uint8Array) { return baseEncode(createHash("sha256").update(wasm).digest()); }

export async function deployTestnet(options: DeployOptions, chain: DeployChain, say: (line: string) => void = () => {}): Promise<DeployResult> {
  const { owner, contract, execute } = options, agentId = `${options.agentName}.${owner}`, steps: DeployStep[] = [];
  const record = (id: string, action: DeployStep["action"], detail: string) => { steps.push({ id, action, detail }); say(`${action === "done" ? "✓ already" : execute ? "→" : "·  would"} ${id}: ${detail}`); };
  // ---- guards: nothing is signed until all of these pass ----
  if (!/^[a-z0-9._-]{2,64}$/.test(owner) || !owner.endsWith(".testnet")) throw invalid("The owner must be a NEAR testnet account");
  if (!contract.endsWith(`.${owner}`) || !/^[a-z0-9._-]{2,64}$/.test(contract)) throw invalid(`The contract account must be a subaccount of the owner, such as authority-v2.${owner}`);
  if (!subaccountAgentName(options.agentName) || agentId.length > 64) throw invalid("Agent name must be one lowercase NEAR segment (2-32 characters) and fit with the owner in 64 characters");
  if (!/^[a-z0-9._-]{2,64}$/.test(options.worker)) throw invalid("Invalid approved worker account");
  if (wasmCodeHash(options.wasm) !== options.expectedHash) throw new ProviderError("INTEGRITY_FAILED", `The contract file hashes to ${wasmCodeHash(options.wasm)}, not the expected ${options.expectedHash}. Nothing was signed.`);
  if (options.runtimePublicKey !== null && options.runtimePublicKey === options.ownerPublicKey) throw invalid("The runtime key must differ from the owner key");
  if (!await chain.accountExists(owner)) throw invalid(`${owner} does not exist on testnet`);
  if (!(await chain.fullAccessKeys(owner)).includes(options.ownerPublicKey)) throw new ProviderError("AUTHORIZATION_FAILED", `The owner key is not a full-access key of ${owner}; nothing was signed`);

  // ---- 1. contract account ----
  let exists = await chain.accountExists(contract), hash = exists ? await chain.codeHash(contract) : null;
  if (hash !== null && hash !== options.expectedHash) throw conflict(`${contract} already runs different code (${hash}). Choose another contract name; nothing was changed.`);
  const needsDeploy = hash === null;
  if ((!exists || needsDeploy) && !options.contractKeyAvailable && exists) throw conflict(`${contract} exists without code but its key file is missing, so this tool cannot deploy to it`);
  const balance = await chain.balance(owner);
  const need = (exists ? 0n : COSTS.contractAccount) + COSTS.registerAgent + COSTS.fund + COSTS.runtimeAllowance;
  // A resumed run (contract account already created) only needs what is still to be spent, plus a margin for gas.
  const required = exists ? need + COSTS.gasMargin : COSTS.ownerMinimum;
  if (balance < required && execute) throw invalid(`${owner} has ${balance} yoctoNEAR; at least ${exists ? `${required} yocto (about ${need} yocto plus gas)` : "6.5 NEAR"} is needed. Get testnet NEAR from a faucet first.`);
  if (!exists) {
    record("contract-account", execute ? "did" : "will-do", `create ${contract} with 5 NEAR`);
    if (execute) { if (!options.contractPublicKey) throw invalid("Missing contract account key"); await chain.createContractAccount(contract, options.contractPublicKey, COSTS.contractAccount); }
    exists = true;
  } else record("contract-account", "done", `${contract} exists`);

  // ---- 2. deploy + init (atomic) ----
  if (needsDeploy) {
    record("deploy", execute ? "did" : "will-do", `deploy ${options.wasm.byteLength} bytes (hash ${options.expectedHash}) and call new, in one transaction`);
    if (execute) { await chain.deployAndInit(contract, options.wasm); if (await chain.codeHash(contract) !== options.expectedHash) throw new ProviderError("INTEGRITY_FAILED", "After deploying, the chain's code hash does not match; stop and investigate"); }
  } else record("deploy", "done", `${contract} already runs the expected code`);

  const call = async (id: string, detail: string, method: string, args: Record<string, unknown>, deposit: bigint) => { record(id, execute ? "did" : "will-do", detail); if (execute) await chain.ownerCall(contract, method, args, deposit); };
  // ---- 3. agent ----
  let agent = needsDeploy && !execute ? null : await chain.agent(contract, agentId);
  if (!agent) { await call("register-agent", `register "${options.agentName}" (agent ID ${agentId}) with 0.3 NEAR storage credit`, "register_agent", { name: options.agentName }, COSTS.registerAgent); agent = execute ? await chain.agent(contract, agentId) : null; if (execute && !agent) throw conflict("The agent was not found after registering"); }
  else record("register-agent", "done", `${agentId} is registered`);
  const policyOk = agent && agent.policy && agent.policy.maxJobAmount === POLICY.maxJobAmount && agent.policy.dailyLimit === POLICY.dailyLimit && agent.policy.approvedWorkers.length === 1 && agent.policy.approvedWorkers[0] === options.worker;
  if (!policyOk) { await call("policy", `limit jobs to 0.02 NEAR and 0.05 NEAR per day, approved worker ${options.worker}`, "configure_policy", { agent_id: agentId, policy: { maxJobAmount: POLICY.maxJobAmount, dailyLimit: POLICY.dailyLimit, approvedWorkers: [options.worker] } }, 0n); } else record("policy", "done", "policy already set");
  if (!agent || BigInt(agent.deposited) === 0n) await call("fund", "fund the agent treasury with 0.1 NEAR", "fund", { agent_id: agentId }, COSTS.fund); else record("fund", "done", `treasury already holds ${agent.deposited} yoctoNEAR`);

  // ---- 4. runtime key: access key on the owner, then delegate grant ----
  const key = options.runtimePublicKey;
  if (key === null) { record("runtime-key", "will-do", "create the runtime key file (run with --execute)"); record("runtime-access-key", "will-do", "authorize it on the owner account, limited to this contract and three methods with a 0.25 NEAR allowance"); record("delegate", "will-do", "record the delegate grant on the agent (30 days)"); }
  else {
    const keys = await chain.functionCallKeys(owner);
    const authorized = keys.some((k) => k.publicKey === key && k.receiver === contract && k.methods.length === RUNTIME_METHODS.length && RUNTIME_METHODS.every((m) => k.methods.includes(m)));
    if (keys.some((k) => k.publicKey === key) && !authorized) throw conflict("That runtime key already exists on the owner account with different restrictions; remove or change it yourself first");
    if (!authorized) { record("runtime-access-key", execute ? "did" : "will-do", "authorize the runtime key on the owner account, limited to this contract and three methods with a 0.25 NEAR allowance"); if (execute) await chain.addRuntimeKey(owner, key, contract, RUNTIME_METHODS, COSTS.runtimeAllowance); } else record("runtime-access-key", "done", "runtime key already authorized with the right limits");
    const delegated = agent?.delegates.some((d) => d.publicKey === key && d.canCheckpoint && d.canSpend && BigInt(d.expiresAtNs) > BigInt(chain.nowMs()) * 1_000_000n);
    if (!delegated) await call("delegate", "record the delegate grant on the agent (30 days)", "set_delegate", { agent_id: agentId, delegate: { publicKey: key, expiresAtNs: ((BigInt(chain.nowMs()) + BigInt(DELEGATE_DAYS) * 86_400_000n) * 1_000_000n).toString(), canCheckpoint: true, canSpend: true } }, 0n); else record("delegate", "done", "delegate grant is current");
  }
  return { steps, agentId, env: { NEAR_AUTHORITY_CONTRACT: contract, NEAR_OWNER_ACCOUNT: owner, NEAR_AGENT_ID: agentId, ...(key ? { NEAR_RUNTIME_PUBLIC_KEY: key } : {}) } };
}

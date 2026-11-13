import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COSTS, NEAR, POLICY, deployTestnet, wasmCodeHash, type AgentSnapshot, type DeployChain, type DeployOptions } from "../packages/near/src/deploy.js";

/** Fake in-memory chain: no network, no keys. It records every mutating call so order, amounts and idempotency can be asserted. */
const wasm = new Uint8Array(Array.from({ length: 2048 }, (_, i) => (i * 7) % 251)), HASH = wasmCodeHash(wasm);
const OWNER = "owner.testnet", CONTRACT = "authority-v2.owner.testnet", OWNER_KEY = "ed25519:OwnerKeyPublicAAAA", RUNTIME_KEY = "ed25519:RuntimeKeyPublicBBBB";
function chain(init: { accounts?: string[]; code?: Record<string, string>; agent?: AgentSnapshot | null; balance?: bigint; keys?: { publicKey: string; receiver: string; methods: string[] }[]; agentKeys?: [string, { publicKey: string; receiver: string; methods: string[] }[]][]; fullAccess?: string[] } = {}) {
  const calls: string[] = [], accounts = new Set(init.accounts ?? [OWNER]), code = { ...(init.code ?? {}) }; let agent = init.agent ?? null;
  const fc = [...(init.keys ?? [])], agentKeys = new Map<string, { publicKey: string; receiver: string; methods: string[] }[]>(init.agentKeys ?? []);
  const port: DeployChain = {
    nowMs: () => 1_700_000_000_000, balance: async () => init.balance ?? 20n * NEAR, accountExists: async (a) => accounts.has(a), codeHash: async (a) => code[a] ?? null,
    fullAccessKeys: async (a) => a === OWNER ? (init.fullAccess ?? [OWNER_KEY]) : agentKeys.has(a) ? [OWNER_KEY] : [], functionCallKeys: async (a) => a === OWNER ? fc : agentKeys.get(a) ?? [], agent: async () => agent,
    createContractAccount: async (c, pk, amount) => { calls.push(`create ${c} ${amount === COSTS.contractAccount ? "5NEAR" : amount} ${pk}`); accounts.add(c); },
    deployAndInit: async (c, w) => { calls.push(`deploy+new ${c} ${w.byteLength}`); code[c] = wasmCodeHash(w); },
    ownerCall: async (_c, method, args, deposit) => {
      calls.push(`${method} deposit=${deposit}`);
      if (method === "register_agent") agent = { id: `${String(args.name)}.${OWNER}`, policy: null, deposited: "0", delegates: [] }; // the live contract returns policy: null until one is configured
      if (method === "configure_policy" && agent) agent.policy = (args.policy as AgentSnapshot["policy"]);
      if (method === "fund" && agent) agent.deposited = deposit.toString();
      if (method === "set_delegate" && agent) agent.delegates.push({ ...(args.delegate as AgentSnapshot["delegates"][0]) });
    },
    createAgentAccount: async (agentAccount, ownerPk, pk, amount, c, methods, allowance) => { calls.push(`agent-account ${agentAccount} ${amount} ${ownerPk} ${pk} ${c} ${methods.join(",")} ${allowance}`); accounts.add(agentAccount); agentKeys.set(agentAccount, [{ publicKey: pk, receiver: c, methods: [...methods] }]); },
    addRuntimeKey: async (_o, pk, c, methods, allowance) => { calls.push(`addkey ${pk} ${c} ${methods.join(",")} ${allowance}`); fc.push({ publicKey: pk, receiver: c, methods }); },
  };
  return { port, calls };
}
const base = (over: Partial<DeployOptions> = {}): DeployOptions => ({ owner: OWNER, ownerPublicKey: OWNER_KEY, contract: CONTRACT, agentName: "research", worker: "worker.owner.testnet", wasm, expectedHash: HASH,
  runtimePublicKey: RUNTIME_KEY, contractPublicKey: "ed25519:ContractKeyPublicCCCC", contractKeyAvailable: true, execute: true, ...over });

describe("owner testnet deployment orchestration (fake chain)", () => {
  it("executes every step in the right order with the exact amounts, one atomic deploy+init, and matching limits", async () => {
    const c = chain(); const result = await deployTestnet(base(), c.port);
    assert.deepEqual(c.calls.map((x) => x.split(" ")[0]), ["create", "deploy+new", "register_agent", "configure_policy", "fund", "addkey", "set_delegate"]);
    assert.ok(c.calls[0]!.startsWith(`create ${CONTRACT} 5NEAR ed25519:ContractKey`)); assert.equal(c.calls[2], `register_agent deposit=${COSTS.registerAgent}`); assert.equal(c.calls[4], `fund deposit=${COSTS.fund}`);
    assert.equal(c.calls[5], `addkey ${RUNTIME_KEY} ${CONTRACT} checkpoint_memory,create_job,accept_job ${COSTS.runtimeAllowance}`);
    assert.equal(POLICY.maxJobAmount, "20000000000000000000000"); assert.equal(POLICY.dailyLimit, "50000000000000000000000");
    assert.equal(result.agentId, "research.owner.testnet"); assert.deepEqual(result.env, { NEAR_AUTHORITY_CONTRACT: CONTRACT, NEAR_OWNER_ACCOUNT: OWNER, NEAR_AGENT_ID: "research.owner.testnet", NEAR_RUNTIME_PUBLIC_KEY: RUNTIME_KEY });
  });
  it("a dry run reads state and plans every step but makes no mutating call, even with the runtime key not created yet", async () => {
    const c = chain(); const result = await deployTestnet(base({ execute: false, runtimePublicKey: null, contractPublicKey: null, contractKeyAvailable: false }), c.port);
    assert.deepEqual(c.calls, []); assert.ok(result.steps.every((s) => s.action !== "did")); assert.ok(result.steps.length >= 7);
    assert.equal(result.env.NEAR_RUNTIME_PUBLIC_KEY, undefined);
  });
  it("is idempotent: running again after success does nothing, and resuming after a partial run only does what is missing", async () => {
    const first = chain(); await deployTestnet(base(), first.port);
    const done = chain({ accounts: [OWNER, CONTRACT], code: { [CONTRACT]: HASH }, keys: [{ publicKey: RUNTIME_KEY, receiver: CONTRACT, methods: ["checkpoint_memory", "create_job", "accept_job"] }],
      agent: { id: "research.owner.testnet", policy: { maxJobAmount: POLICY.maxJobAmount, dailyLimit: POLICY.dailyLimit, approvedWorkers: ["worker.owner.testnet"] }, deposited: COSTS.fund.toString(),
        delegates: [{ publicKey: RUNTIME_KEY, canCheckpoint: true, canSpend: true, expiresAtNs: ((1_700_000_000_000n + 86_400_000n) * 1_000_000n).toString() }] } });
    const again = await deployTestnet(base(), done.port); assert.deepEqual(done.calls, []); assert.ok(again.steps.every((s) => s.action === "done"));
    const partial = chain({ accounts: [OWNER, CONTRACT], code: { [CONTRACT]: HASH }, agent: { id: "research.owner.testnet", policy: null, deposited: "0", delegates: [] } });
    await deployTestnet(base(), partial.port); assert.deepEqual(partial.calls.map((x) => x.split(" ")[0]), ["configure_policy", "fund", "addkey", "set_delegate"], "no second account, deploy or registration");
  });
  it("resumes with only what is still to be spent: the 5 NEAR account cost is not demanded twice (found on live testnet)", async () => {
    // A faucet account holds 10 NEAR; after creating the contract account about 5 NEAR remain, which is plenty for the rest.
    const resumed = chain({ accounts: [OWNER, CONTRACT], balance: 5n * NEAR - 1n });
    await deployTestnet(base(), resumed.port);
    assert.deepEqual(resumed.calls.map((x) => x.split(" ")[0]), ["deploy+new", "register_agent", "configure_policy", "fund", "addkey", "set_delegate"]);
    const tooLow = chain({ accounts: [OWNER, CONTRACT], balance: NEAR / 2n });
    await assert.rejects(deployTestnet(base(), tooLow.port), { code: "INVALID_INPUT" }); assert.deepEqual(tooLow.calls, []);
  });
  it("agent account mode: creates research.owner with the owner key and a restricted runtime key, never adds a key to the owner, and resumes safely", async () => {
    const c = chain(); const result = await deployTestnet(base({ agentAccount: true }), c.port);
    const names = c.calls.map((x) => x.split(" ")[0]);
    assert.deepEqual(names, ["create", "deploy+new", "register_agent", "configure_policy", "fund", "agent-account", "set_delegate"]);
    assert.ok(!names.includes("addkey"), "the owner account gets no runtime key");
    const made = c.calls.find((x) => x.startsWith("agent-account"))!.split(" ");
    assert.deepEqual(made.slice(1), ["research.owner.testnet", String(COSTS.agentAccount), OWNER_KEY, RUNTIME_KEY, CONTRACT, "checkpoint_memory,create_job,accept_job", String(COSTS.runtimeAllowance)]);
    assert.equal(result.env.NEAR_RUNTIME_ACCOUNT, "research.owner.testnet");
    // A second run does nothing; a legacy run does not set NEAR_RUNTIME_ACCOUNT.
    const again = chain({ accounts: [OWNER, CONTRACT, "research.owner.testnet"], code: { [CONTRACT]: HASH }, agentKeys: [["research.owner.testnet", [{ publicKey: RUNTIME_KEY, receiver: CONTRACT, methods: ["checkpoint_memory", "create_job", "accept_job"] }]]],
      agent: { id: "research.owner.testnet", policy: { maxJobAmount: POLICY.maxJobAmount, dailyLimit: POLICY.dailyLimit, approvedWorkers: ["worker.owner.testnet"] }, deposited: COSTS.fund.toString(),
        delegates: [{ publicKey: RUNTIME_KEY, canCheckpoint: true, canSpend: true, expiresAtNs: ((1_700_000_000_000n + 86_400_000n) * 1_000_000n).toString() }] } });
    const second = await deployTestnet(base({ agentAccount: true }), again.port); assert.deepEqual(again.calls, []); assert.ok(second.steps.every((s) => s.action === "done"));
    assert.equal((await deployTestnet(base(), chain().port)).env.NEAR_RUNTIME_ACCOUNT, undefined);
    // An account that already exists without the expected key is a conflict, not something to overwrite.
    const squatted = chain({ accounts: [OWNER, CONTRACT, "research.owner.testnet"], code: { [CONTRACT]: HASH }, agent: { id: "research.owner.testnet", policy: null, deposited: "0", delegates: [] } });
    await assert.rejects(deployTestnet(base({ agentAccount: true }), squatted.port), { code: "OPERATION_CONFLICT" });
    assert.ok(!squatted.calls.some((x) => x.startsWith("agent-account")));
  });
  it("re-checking a finished deployment never needs funds, and a nearly finished one needs only the remaining step", async () => {
    const done = { accounts: [OWNER, CONTRACT], code: { [CONTRACT]: HASH }, keys: [{ publicKey: RUNTIME_KEY, receiver: CONTRACT, methods: ["checkpoint_memory", "create_job", "accept_job"] }],
      agent: { id: "research.owner.testnet", policy: { maxJobAmount: POLICY.maxJobAmount, dailyLimit: POLICY.dailyLimit, approvedWorkers: ["worker.owner.testnet"] }, deposited: COSTS.fund.toString(),
        delegates: [{ publicKey: RUNTIME_KEY, canCheckpoint: true, canSpend: true, expiresAtNs: ((1_700_000_000_000n + 86_400_000n) * 1_000_000n).toString() }] } } as NonNullable<Parameters<typeof chain>[0]>;
    const broke = chain({ ...done, balance: 1n }); const result = await deployTestnet(base(), broke.port);
    assert.deepEqual(broke.calls, []); assert.ok(result.steps.every((s) => s.action === "done"));
    // Only set_delegate remains (no spend): still allowed with almost no funds.
    const last = chain({ ...done, balance: 1n, agent: { ...done.agent!, delegates: [] } }); await deployTestnet(base(), last.port);
    assert.deepEqual(last.calls.map((x) => x.split(" ")[0]), ["set_delegate"]);
  });
  it("sets a delegate that expires 30 days out, in nanoseconds", async () => {
    let seen: Record<string, unknown> | null = null; const c = chain(); const original = c.port.ownerCall;
    c.port.ownerCall = async (cc, method, args, deposit) => { if (method === "set_delegate") seen = args; await original(cc, method, args, deposit); };
    await deployTestnet(base(), c.port);
    assert.equal((seen as unknown as { delegate: { expiresAtNs: string } }).delegate.expiresAtNs, ((1_700_000_000_000n + 30n * 86_400_000n) * 1_000_000n).toString());
  });
  it("signs nothing when a guard fails: wrong file hash, foreign owner key, bad names, other code, same key or low balance", async () => {
    const refuse = async (over: Partial<DeployOptions>, init: Parameters<typeof chain>[0], code: string) => { const c = chain(init); await assert.rejects(deployTestnet(base(over), c.port), { code }); assert.deepEqual(c.calls, []); };
    await refuse({ expectedHash: "11111111111111111111111111111111" }, {}, "INTEGRITY_FAILED");
    await refuse({ ownerPublicKey: "ed25519:SomeoneElse" }, {}, "AUTHORIZATION_FAILED");
    await refuse({ contract: "authority-v2.other.testnet" }, {}, "INVALID_INPUT");
    await refuse({ agentName: "Bad_Name" }, {}, "INVALID_INPUT");
    await refuse({ agentName: "a" }, {}, "INVALID_INPUT");
    await refuse({ runtimePublicKey: OWNER_KEY }, {}, "INVALID_INPUT");
    await refuse({ owner: "owner.near", contract: "authority.owner.near" }, {}, "INVALID_INPUT");
    await refuse({}, { accounts: [OWNER, CONTRACT], code: { [CONTRACT]: "SomeOtherCodeHash1111111111111111" } }, "OPERATION_CONFLICT");
    await refuse({}, { balance: 2n * NEAR }, "INVALID_INPUT");
    await refuse({}, { accounts: [] }, "INVALID_INPUT");
    await refuse({}, { accounts: [OWNER, CONTRACT], keys: [{ publicKey: RUNTIME_KEY, receiver: "elsewhere.testnet", methods: ["checkpoint_memory"] }], code: { [CONTRACT]: HASH }, agent: { id: "research.owner.testnet", policy: { maxJobAmount: POLICY.maxJobAmount, dailyLimit: POLICY.dailyLimit, approvedWorkers: ["worker.owner.testnet"] }, deposited: "1", delegates: [] } }, "OPERATION_CONFLICT");
  });
});

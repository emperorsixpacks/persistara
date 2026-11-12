import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { walletSetup, type WalletSetupDeps } from "../packages/operator/src/wallet-setup.js";

/** Fake runners only: no real NEAR CLI, wallet, key or network is touched. */
function deps(over: Partial<WalletSetupDeps> = {}) {
  const calls: [string, string[]][] = [], said: string[] = [];
  const base: WalletSetupDeps = {
    owner: "owner.testnet", binary: "near", interactive: true, has: async () => true,
    run: async (binary, args) => { calls.push([binary, args]); return 0; }, accountExists: async () => true, ask: async () => "no", say: (text) => { said.push(text); },
  };
  return { calls, said, d: { ...base, ...over } };
}

describe("owner wallet setup hands the terminal to the NEAR CLI and never handles a key", () => {
  it("runs only the CLI's own import command, passes no secret argument and does not claim the key is verified", async () => {
    const { calls, said, d } = deps();
    assert.deepEqual(await walletSetup(d), { status: "import-finished" });
    assert.deepEqual(calls, [["near", ["account", "import-account"]]]);
    const text = said.join("\n");
    assert.ok(text.includes("never sees your seed phrase")); assert.ok(text.includes("has not verified the key yet")); assert.ok(!/verified the key\./.test(text.replace("has not verified the key yet", "")));
  });
  it("reports a failed import honestly and stops for a missing account, a missing CLI and a non-interactive shell", async () => {
    assert.deepEqual(await walletSetup(deps({ run: async () => 1 }).d), { status: "import-failed" });
    const missingAccount = deps({ accountExists: async () => false }); assert.deepEqual(await walletSetup(missingAccount.d), { status: "account-missing" }); assert.deepEqual(missingAccount.calls, []);
    assert.deepEqual(await walletSetup(deps({ owner: "NOT VALID" }).d), { status: "account-missing" });
    const noTty = deps({ interactive: false }); assert.deepEqual(await walletSetup(noTty.d), { status: "not-interactive" }); assert.deepEqual(noTty.calls, []);
    const noCli = deps({ has: async () => false }); assert.deepEqual(await walletSetup(noCli.d), { status: "cli-missing" }); assert.deepEqual(noCli.calls, [], "no install without an explicit yes");
  });
  it("installs the CLI only after an explicit yes and only through cargo with the lockfile", async () => {
    let installed = false;
    const yes = deps({ ask: async () => "yes", has: async (binary) => binary === "cargo" || (binary === "near" && installed), run: async (binary, args) => { if (binary === "cargo") installed = true; yes.calls.push([binary, args]); return 0; } });
    assert.deepEqual(await walletSetup(yes.d), { status: "import-finished" });
    assert.deepEqual(yes.calls[0], ["cargo", ["install", "near-cli-rs", "--locked"]]);
    assert.deepEqual(yes.calls[1], ["near", ["account", "import-account"]]);
    const custom = deps({ binary: "/opt/near", has: async (b) => b === "cargo", ask: async () => "yes" });
    assert.deepEqual(await walletSetup(custom.d), { status: "cli-missing" }); assert.deepEqual(custom.calls, [], "never installs when a custom binary path is configured");
  });
});

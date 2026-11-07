import { expect, test, type Page } from "@playwright/test";

async function control(path: string, data: unknown = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:4388/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": "owner-browser-fixture-only" }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error("Explicit fixture wallet failure");
  return await response.json() as Record<string, unknown>;
}
async function injectWallet(page: Page) {
  const state = await control("state");
  await page.route("**/repository/manifest.json", (route) => route.fulfill({ json: { version: "1.0.0", wallets: [] } }));
  await page.exposeFunction("fixtureSignMessage", (params: unknown) => control("sign-message", params));
  await page.exposeFunction("fixtureSend", (params: unknown) => control("send", params));
  await page.addInitScript(({ owner, publicKey }) => {
    const api = window as unknown as { fixtureSignMessage: (params: unknown) => Promise<unknown>; fixtureSend: (params: unknown) => Promise<unknown> };
    const fixtureWallet = {
      manifest: { id: "persistara-test-wallet", name: "Persistara test wallet", description: "Disposable test wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", website: "http://127.0.0.1:4387", version: "1.0.0", type: "injected", platform: [], permissions: {}, features: { testnet: true, mainnet: false, signMessage: true, signTransaction: false, signInWithoutAddKey: true, signAndSendTransaction: true, signAndSendTransactions: false, signInAndSignMessage: false, signInWithFunctionCallKey: false, signDelegateActions: false } },
      signIn: async () => [{ accountId: owner, publicKey }], signOut: async () => {}, getAccounts: async () => [{ accountId: owner, publicKey }],
      signMessage: (params: { nonce: Uint8Array }) => api.fixtureSignMessage({ ...params, nonce: Array.from(params.nonce) }),
      signAndSendTransaction: (params: unknown) => api.fixtureSend(params),
    };
    window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: fixtureWallet })));
  }, { owner: String(state.owner), publicKey: String(state.publicKey) });
}
async function connect(page: Page) {
  await page.getByRole("button", { name: /Connect NEAR wallet|Reconnect wallet/ }).click();
  await page.getByText("Persistara test wallet", { exact: true }).click();
  await expect(page.locator("#session-status")).toHaveText("Owner verified");
  await expect(page.locator("#authority-status")).toHaveText("Owner key verified");
}
async function reviewAndSign(page: Page, action: "pause" | "resume") {
  await page.getByRole("button", { name: `Review ${action}` }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#review-method")).toHaveText(`set_paused(${action === "pause"})`);
  await expect(page.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
  await page.getByLabel("I have reviewed this owner action.").check();
  await page.getByRole("button", { name: "Sign in wallet" }).click();
}
test.beforeEach(async ({ page }) => { await control("reset"); await injectWallet(page); await page.goto("/"); });

test("connects, reviews, cancels safely, pauses and resumes with distinct verified receipts", async ({ page }) => {
  await expect(page.locator("#fixture-banner")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review pause" })).toBeDisabled();
  await connect(page);
  await expect(page.locator("#job-limit")).toHaveText("0.02 NEAR"); await expect(page.locator("#daily-limit")).toHaveText("0.05 NEAR");
  await expect(page.locator("#offdevice")).toHaveText("Off-device backup has not been verified.");
  await page.getByRole("button", { name: "Review pause" }).click();
  await page.getByRole("button", { name: "Cancel review" }).click();
  expect((await control("state")).sends).toBe(0);
  await reviewAndSign(page, "pause");
  await expect(page.locator("#agent-status")).toHaveText("Paused");
  await expect(page.locator("#notice")).toContainText("finalized and verified");
  await reviewAndSign(page, "resume");
  await expect(page.locator("#agent-status")).toHaveText("Active");
  await page.getByText("Inspect authority & transaction evidence").click();
  await expect(page.locator("#history")).toContainText("Pause · confirmed"); await expect(page.locator("#history")).toContainText("Resume · confirmed");
  expect((await control("state")).sends).toBe(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/owner-desktop.png", fullPage: true });
});
test("retains a lost wallet response across reload and reconciles without another send", async ({ page }) => {
  await connect(page); await control("mode", { mode: "lost-response" });
  await reviewAndSign(page, "pause");
  await expect(page.locator("#notice")).toContainText("no confirmed outcome");
  expect((await control("state")).sends).toBe(1);
  await page.reload(); await expect(page.locator("#pending-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review pause" })).toBeDisabled(); await expect(page.getByRole("button", { name: "Review resume" })).toBeDisabled();
  const state = await control("state");
  await page.getByLabel("Transaction hash from your wallet").fill(String(state.lastHash));
  await page.getByRole("button", { name: "Check transaction" }).click();
  await expect(page.locator("#notice")).toContainText("finalized and verified");
  await expect(page.locator("#pending-panel")).toBeHidden(); expect((await control("state")).sends).toBe(1);
});
test("rejects another signing key and renders the owner workflow on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await control("mode", { mode: "wrong-owner" });
  await page.getByRole("button", { name: "Connect NEAR wallet" }).click(); await page.getByText("Persistara test wallet", { exact: true }).click();
  await expect(page.locator("#notice")).toContainText("original owner wallet");
  await expect(page.getByRole("button", { name: "Review pause" })).toBeDisabled(); expect((await control("state")).sends).toBe(0);
  await control("mode", { mode: "success" }); await connect(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/owner-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Review pause" }).focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeHidden(); expect((await control("state")).sends).toBe(0);
});
test("reauthenticates after the session ends without reusing stale CSRF", async ({ page }) => {
  await connect(page);
  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json() as { csrf: string };
    await fetch("/api/logout", { method: "POST", headers: { "content-type": "application/json", "x-persistara-csrf": session.csrf }, body: "{}" });
  });
  await page.getByRole("button", { name: "Refresh state" }).click();
  await expect(page.locator("#session-status")).toHaveText("Verify owner again");
  await expect(page.getByRole("button", { name: "Review pause" })).toBeDisabled();
  await connect(page);
  await expect(page.getByRole("button", { name: "Review pause" })).toBeEnabled();
  expect((await control("state")).sends).toBe(0);
});

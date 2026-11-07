import { expect, type Page } from "@playwright/test";

export async function control(path: string, data: unknown = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:4388/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": "owner-browser-fixture-only" }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error("Explicit fixture wallet failure");
  return await response.json() as Record<string, unknown>;
}
export async function injectWallet(page: Page) {
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
export async function connect(page: Page) {
  await page.getByRole("button", { name: /Connect NEAR wallet|Reconnect wallet/ }).click();
  await page.getByText("Persistara test wallet", { exact: true }).click();
  await expect(page.locator("#session-status")).toHaveText("Owner verified");
  await expect(page.locator("#authority-status")).toHaveText("Owner key verified");
  await expect(page.getByText("Select wallet", { exact: true })).toBeHidden();
}

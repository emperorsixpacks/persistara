import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { connect, control, injectWallet } from "./support.js";

async function requestCommission(page: Page) {
  await connect(page); await page.getByRole("button", { name: "New mission", exact: true }).click();
  await page.getByLabel("Mission title").fill("Commission a recoverable source dossier");
  await page.getByLabel("What do you want to investigate?").fill("Collect primary NEAR and storage documentation.");
  await page.getByLabel("What will you review?").fill("Inspect each requested source, capture date and content fingerprint before payment.");
  await page.getByLabel(/Source URLs/).fill("https://docs.near.org/\nhttps://docs.0g.ai/");
  await page.getByRole("button", { name: "Create mission", exact: false }).click();
  await page.getByRole("button", { name: "Commission specialist", exact: false }).click();
  await expect(page.locator("#commission-confirm")).toBeDisabled();
  await page.locator("#commission-ack").check(); await page.locator("#commission-confirm").click();
  await expect(page.getByRole("button", { name: "Download quote request", exact: false })).toBeVisible();
  const id = page.url().split("#mission/")[1]!.replace("mission:", "commission:"); return id;
}
async function importSigned(page: Page, kind: "quote" | "delivery", value: unknown) {
  await page.getByRole("button", { name: `Import signed ${kind}`, exact: true }).click();
  await page.getByLabel("Or paste the signed JSON").fill(JSON.stringify(value));
  await page.getByRole("button", { name: "Verify signed file", exact: true }).click();
  await expect(page.locator("#commission-import")).toBeHidden();
}
async function reserve(page: Page) {
  await page.getByRole("button", { name: "Review 0.01 NEAR reservation", exact: false }).click();
  await expect(page.locator("#commission-review-body")).toContainText("0.01 testnet 0G");
  await expect(page.locator("#commission-confirm")).toBeDisabled();
  await page.locator("#commission-ack").check(); await page.locator("#commission-confirm").click();
  await expect(page.locator("#commission-review")).toBeHidden();
}
test.beforeEach(async ({ page }) => { await control("reset"); await injectWallet(page); await page.goto("/"); });

test("reviews a signed quote and encrypted delivery, then observes finalized payment without duplicate acceptance", async ({ page }) => {
  const id = await requestCommission(page);
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Download quote request", exact: false }).click();
  const download = await downloadPromise, task = JSON.parse(await readFile((await download.path())!, "utf8")) as { encryptedBrief: string; id: string };
  expect(task.id).toBe(id); expect(task.encryptedBrief).not.toContain("primary NEAR"); expect(JSON.stringify(task)).not.toContain('"privateKey"');
  await importSigned(page, "quote", await control("commission-quote", { id }));
  expect((await control("commerce-state")).submissions).toBe(0);
  await page.getByRole("button", { name: "Review 0.01 NEAR reservation", exact: false }).click();
  await page.screenshot({ path: "test-results/commerce-quote-review.png" });
  await page.getByRole("button", { name: "Keep reviewing", exact: true }).click();
  await reserve(page); await expect(page.locator(".commission-panel")).toContainText("Specialist commissioned");
  expect((await control("commerce-state")).submissions).toBe(1);
  await importSigned(page, "delivery", await control("commission-delivery", { id }));
  await expect(page.locator(".commission-panel")).toContainText("Delivery decrypted and authenticated");
  await page.locator(".source-card summary").first().click();
  await expect(page.locator(".source-excerpt").first()).toContainText("untrusted data");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/commerce-delivery-desktop.png", fullPage: true });
  await control("commerce-mode", { autoPay: false, loseAcceptance: true });
  await page.getByRole("button", { name: "Review delivery & settle", exact: false }).click();
  await expect(page.locator("#commission-review-body")).toContainText("Artifact digest"); await expect(page.locator("#commission-confirm")).toBeDisabled();
  await page.locator("#commission-ack").check(); await page.locator("#commission-confirm").click();
  await expect(page.locator(".commission-panel .state-payout_pending")).toBeVisible();
  await page.reload(); await expect(page.locator(".commission-panel .state-payout_pending")).toBeVisible();
  expect((await control("commerce-state")).submissions).toBe(2);
  await control("payout-final"); await page.getByRole("button", { name: "Reconcile existing outcome", exact: false }).click();
  await expect(page.locator(".commission-panel .state-paid")).toBeVisible();
  expect((await control("commerce-state")).submissions).toBe(2); expect((await control("state")).sends).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/commerce-settled-mobile.png", fullPage: true });
});

test("rejects an altered signed quote and never reserves without explicit price/cost acknowledgement", async ({ page }) => {
  const id = await requestCommission(page), signed = await control("commission-quote", { id }) as { payload: { amountYoctoNear: string } };
  signed.payload.amountYoctoNear = "20000000000000000000000";
  await page.getByRole("button", { name: "Import signed quote", exact: true }).click(); await page.getByLabel("Or paste the signed JSON").fill(JSON.stringify(signed));
  await page.getByRole("button", { name: "Verify signed file", exact: true }).click(); await expect(page.locator("#commission-import-error")).not.toBeEmpty();
  expect((await control("commerce-state")).submissions).toBe(0); expect((await control("commerce-state")).uploads).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await importSigned(page, "quote", await control("commission-quote", { id }));
  await page.getByRole("button", { name: "Review 0.01 NEAR reservation", exact: false }).click();
  await page.keyboard.press("Escape"); expect((await control("commerce-state")).submissions).toBe(0); expect((await control("commerce-state")).uploads).toBe(0);
});

test("retains an unknown upload across reload and reconciles its fixed root without another upload", async ({ page }) => {
  const id = await requestCommission(page); await importSigned(page, "quote", await control("commission-quote", { id }));
  await control("commerce-mode", { loseUpload: true, unavailable: true }); await reserve(page);
  await expect(page.locator(".commission-panel .state-uploading_brief")).toBeVisible(); await page.reload(); await expect(page.locator(".commission-panel .state-uploading_brief")).toBeVisible();
  expect((await control("commerce-state")).uploads).toBe(1); expect((await control("commerce-state")).submissions).toBe(0);
  await control("commerce-mode", { loseUpload: false, unavailable: false }); await page.getByRole("button", { name: "Reconcile existing outcome", exact: false }).click();
  await expect(page.locator(".commission-panel .state-brief_ready")).toBeVisible(); await reserve(page);
  await expect(page.locator(".commission-panel")).toContainText("Specialist commissioned"); expect((await control("commerce-state")).uploads).toBe(1); expect((await control("commerce-state")).submissions).toBe(1);
});

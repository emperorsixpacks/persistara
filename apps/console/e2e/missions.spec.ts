import { expect, test, type Page } from "@playwright/test";
import { connect, control, injectWallet } from "./support.js";
import { readFile } from "node:fs/promises";

async function create(page: Page, title = "Compare storage and memory") {
  await page.getByRole("button", { name: "New mission", exact: true }).click();
  await page.getByLabel("Mission title").fill(title);
  await page.getByLabel("What do you want to investigate?").fill("Collect primary documentation for a recoverable research agent.");
  await page.getByLabel("What will you review?").fill("Each requested source has a captured excerpt, date and content fingerprint. Inspect the documentation directly.");
  await page.getByLabel(/Source URLs/).fill("https://docs.near.org/\nhttps://docs.0g.ai/");
  await page.getByRole("button", { name: "Create mission", exact: false }).click();
  await expect(page.locator("#mission-detail h1")).toHaveText(title);
  await expect(page.getByRole("button", { name: "Run mission", exact: false })).toBeEnabled();
}
test.beforeEach(async ({ page }) => { await control("reset"); await injectWallet(page); await page.goto("/"); });

test("creates, runs, reloads and reviews an exact local dossier without inference or wallet sends", async ({ page }) => {
  await expect(page.locator("#mission-empty")).toBeVisible();
  await connect(page); await create(page);
  await page.getByRole("button", { name: "Run mission", exact: false }).click();
  await expect(page.getByRole("button", { name: "Review dossier", exact: false })).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Review dossier", exact: false })).toBeVisible();
  await page.locator(".source-card summary").first().click();
  await expect(page.locator(".source-excerpt").first()).toContainText("no execution capability");
  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON", exact: false }).click();
  const download = await pendingDownload;
  const artifact = JSON.parse(await readFile((await download.path())!, "utf8")) as { value: { inference: string; sources: unknown[] } };
  expect(artifact.value.inference).toBe("not_used"); expect(artifact.value.sources).toHaveLength(2);
  await page.getByRole("button", { name: "Review dossier", exact: false }).click();
  await expect(page.getByRole("button", { name: "Mark reviewed", exact: true })).toBeDisabled();
  await page.getByLabel("I have inspected the dossier and review criteria.").check();
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect(page.locator("#mission-detail")).toContainText("Review recorded.");
  expect((await control("state")).sends).toBe(0);
  const state = await control("mission-state") as { sourceReads: Record<string, number> };
  expect(Object.values(state.sourceReads)).toEqual([1, 1]);
  await page.getByRole("link", { name: "All missions", exact: false }).click();
  await expect(page.locator(".mission-card")).toHaveCount(1); await expect(page.locator(".mission-card")).toContainText("Reviewed");
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.locator("#activity-list")).toContainText("Owner marked dossier reviewed");
});

test("resumes a failed source after reload without fetching an already captured source again", async ({ page }) => {
  await connect(page); await create(page, "A mission that can continue");
  await control("mission-mode", { mode: "fail-second" });
  await page.getByRole("button", { name: "Run mission", exact: false }).click();
  await expect(page.getByRole("button", { name: "Resume mission", exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#mission-detail")).toContainText("Captured sources are saved.");
  await page.reload(); await expect(page.getByRole("button", { name: "Resume mission", exact: false })).toBeVisible();
  await control("mission-mode", { mode: "success" });
  await page.getByRole("button", { name: "Resume mission", exact: false }).click();
  await expect(page.getByRole("button", { name: "Review dossier", exact: false })).toBeVisible({ timeout: 15_000 });
  const state = await control("mission-state") as { sourceReads: Record<string, number> };
  expect(state.sourceReads["https://docs.near.org/"]).toBe(1); expect(state.sourceReads["https://docs.0g.ai/"]).toBe(2);
  expect((await control("state")).sends).toBe(0);
});

test("cancels running work and keeps form and untrusted content within the browser boundary", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "New mission", exact: true }).click();
  await page.getByLabel("Mission title").fill("<img src=x onerror=alert(1)>");
  await page.getByLabel("What do you want to investigate?").fill("A literal title must never become HTML.");
  await page.getByLabel("What will you review?").fill("No injected elements.");
  await page.getByLabel(/Source URLs/).fill("https://docs.near.org/");
  await page.getByRole("button", { name: "Create mission", exact: false }).click();
  await expect(page.locator("#mission-detail h1")).toHaveText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#mission-detail h1 img")).toHaveCount(0);
  await control("mission-mode", { mode: "hold" }); await page.getByRole("button", { name: "Run mission", exact: false }).click();
  await page.getByRole("button", { name: "Cancel mission", exact: true }).click();
  await expect(page.locator("#mission-detail .state-canceled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run mission", exact: false })).toHaveCount(0);
  expect((await control("state")).sends).toBe(0);
});

test("renders the mission desk, detail and mobile navigation with keyboard access", async ({ page }) => {
  await connect(page); await create(page, "How recoverable memory works");
  await page.getByRole("button", { name: "Run mission", exact: false }).click();
  await expect(page.getByRole("button", { name: "Review dossier", exact: false })).toBeVisible({ timeout: 15_000 });
  await page.locator(".source-card summary").first().click();
  await page.screenshot({ path: "test-results/mission-detail-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "All missions", exact: false }).click();
  await create(page, "A source dossier for the team");
  await page.getByRole("link", { name: "All missions", exact: false }).click();
  await create(page, "Storage availability and recovery");
  await control("mission-mode", { mode: "fail-second" }); await page.getByRole("button", { name: "Run mission", exact: false }).click();
  await expect(page.getByRole("button", { name: "Resume mission", exact: false })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: "All missions", exact: false }).click();
  await page.screenshot({ path: "test-results/mission-desk-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Needs review", exact: true }).click(); await expect(page.locator(".mission-card")).toHaveCount(1);
  await page.getByRole("button", { name: "All missions", exact: true }).click();
  await page.getByLabel("Search missions").fill("does not exist"); await expect(page.locator("#mission-empty")).toBeVisible();
  await page.getByLabel("Search missions").clear();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/mission-desk-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Toggle navigation" }).click(); await expect(page.getByRole("link", { name: "Agent controls", exact: true })).toBeVisible();
  await expect(page.locator("#main")).toHaveAttribute("inert", "");
  await page.keyboard.press("Shift+Tab"); await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("link", { name: /^Missions(?: \d+)?$/ })).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab"); await expect(page.getByRole("link", { name: "Evidence", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeFocused();
  await page.getByRole("button", { name: "New mission", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(page.locator("#mission-compose")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.locator("#mission-compose")).toBeHidden();
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { baseEncode } from "near-api-js";

const root = process.cwd().endsWith("/dist") ? join(process.cwd(), "..") : process.cwd();
describe("committed authority contract artifact", () => {
  it("matches its manifest exactly, so a deployment record cannot silently drift from the file", async () => {
    const manifest = JSON.parse(await readFile(join(root, "contracts/artifacts/authority-manifest.json"), "utf8")) as Record<string, unknown>;
    const wasm = await readFile(join(root, "contracts/artifacts", String(manifest.file)));
    assert.deepEqual([...wasm.subarray(0, 4)], [0, 0x61, 0x73, 0x6d], "WebAssembly magic header");
    assert.equal(wasm.byteLength, manifest.bytes);
    assert.equal(createHash("sha256").update(wasm).digest("hex"), manifest.sha256Hex);
    assert.equal(baseEncode(createHash("sha256").update(wasm).digest()), manifest.codeHashBase58);
    assert.equal(manifest.deployed, false, "update this field and add evidence when it is actually deployed");
    assert.ok(String(manifest.notes).includes("NOT reproducible"));
  });
});

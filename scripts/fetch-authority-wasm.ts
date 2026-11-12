#!/usr/bin/env node
/**
 * Downloads the deployed authority contract's code from NEAR so a workspace can match its code hash, because local rebuilds are
 * not reproducible. The expected hash is REQUIRED and must come from a source you trust independently of the chain (for
 * example the hash recorded in docs/CONTRACTS.md when the owner deployed). Trusting whatever is deployed would make the
 * client's code-hash check meaningless, so this never fetches-and-trusts.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { baseEncode } from "near-api-js";
import { isObject } from "../packages/protocol/src/memory.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { loadEnvironment, printFailure } from "./common.js";

const DEFAULT_OUT = "target/near/persistara_authority/persistara_authority.wasm";
const MAX_CODE_BYTES = 4_000_000;

function args(argv: string[]) {
  const result = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!name || !["--contract", "--expected-hash", "--rpc", "--out"].includes(name) || !value || value.startsWith("--") || result.has(name)) throw new ProviderError("INVALID_INPUT", "Use: fetch-authority-wasm --expected-hash <base58> [--contract <account>] [--rpc <https url>] [--out <file>]");
    result.set(name, value);
  }
  return result;
}
async function main() {
  loadEnvironment();
  const options = args(process.argv.slice(2));
  const expected = options.get("--expected-hash");
  if (!expected || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(expected)) throw new ProviderError("INVALID_INPUT", "--expected-hash <base58 code hash> is required: take it from your deployment record (docs/CONTRACTS.md), not from the chain");
  const contract = options.get("--contract") ?? process.env.NEAR_AUTHORITY_CONTRACT;
  if (!contract || !/^[a-z0-9._-]{2,64}$/.test(contract)) throw new ProviderError("INVALID_INPUT", "Provide --contract or set NEAR_AUTHORITY_CONTRACT");
  const rpc = options.get("--rpc") ?? process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  const url = new URL(rpc);
  if (url.protocol !== "https:" || url.username || url.password) throw new ProviderError("INVALID_INPUT", "RPC URL must be https without credentials");
  const out = resolve(options.get("--out") ?? DEFAULT_OUT);

  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "persistara", method: "query", params: { request_type: "view_code", finality: "final", account_id: contract } }) });
  if (!response.ok) throw new ProviderError("UPSTREAM_ERROR", `RPC returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_CODE_BYTES * 2) throw new ProviderError("PROTOCOL_ERROR", "RPC response is too large");
  const payload = JSON.parse(text) as unknown;
  if (!isObject(payload) || !isObject(payload.result) || typeof payload.result.code_base64 !== "string" || typeof payload.result.hash !== "string") throw new ProviderError("PROTOCOL_ERROR", "RPC did not return contract code");
  const code = Buffer.from(payload.result.code_base64, "base64");
  if (code.byteLength < 1_000 || code.byteLength > MAX_CODE_BYTES) throw new ProviderError("PROTOCOL_ERROR", "Contract code has an implausible size");
  const hash = baseEncode(createHash("sha256").update(code).digest());
  if (hash !== payload.result.hash) throw new ProviderError("INTEGRITY_FAILED", "Downloaded code does not match the hash the RPC reported");
  if (hash !== expected) throw new ProviderError("INTEGRITY_FAILED", `The deployed code hash is ${hash}, not the expected ${expected}. Nothing was written. Either the contract changed or the expected hash is wrong; do not proceed until you know which.`);

  let existing: Buffer | null = null;
  try { existing = await readFile(out); } catch (error) { if (!(isObject(error) && error.code === "ENOENT")) throw error; }
  if (existing && !existing.equals(code)) throw new ProviderError("OPERATION_CONFLICT", `${out} already exists with different content. Move it aside yourself (a locally rebuilt WASM can never match an existing deployment), then run this again.`);
  if (!existing) { await mkdir(dirname(out), { recursive: true }); await writeFile(out, code, { flag: "wx", mode: 0o644 }); }
  console.log(JSON.stringify({ status: existing ? "already-present-and-identical" : "written", contract, codeHash: hash, bytes: code.byteLength, path: out, note: "Verified against the expected hash you supplied, and against the RPC-reported hash." }));
}
main().catch(printFailure);

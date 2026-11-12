#!/usr/bin/env node
/**
 * Creates the restricted RUNTIME key for an agent (never the owner key). The secret goes to a private file that is never
 * replaced; only the public key is printed. The owner then authorizes that public key on their own account with the NEAR CLI.
 */
import { resolve } from "node:path";
import { KeyPair } from "near-api-js";
import { readPrivateFile, writePrivateFile } from "../packages/memory/src/files.js";
import { ProviderError } from "../packages/protocol/src/providers.js";
import { loadEnvironment, printFailure } from "./common.js";

const FORMAT = /^ed25519:[1-9A-HJ-NP-Za-km-z]{64,100}$/;
async function main() {
  loadEnvironment();
  const extra = process.argv.slice(2);
  if (extra.length) throw new ProviderError("INVALID_INPUT", "Use: near:runtime-key (set NEAR_RUNTIME_KEY_FILE to choose the file)");
  const file = resolve(process.env.NEAR_RUNTIME_KEY_FILE || ".persistara/keys/near-runtime.key");
  let created = false, text: string;
  try { text = Buffer.from(await readPrivateFile(file, 512)).toString("utf8").trim(); }
  catch (error) {
    if (!(error instanceof Error) || (error as { code?: string }).code !== "ENOENT") throw error;
    text = KeyPair.fromRandom("ed25519").toString(); await writePrivateFile(file, Buffer.from(`${text}\n`)); created = true;
  }
  if (!FORMAT.test(text)) throw new ProviderError("INVALID_INPUT", "The existing runtime key file is not a valid ed25519 key; it was not changed");
  const publicKey = KeyPair.fromString(text as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString();
  console.log(JSON.stringify({ status: created ? "created" : "already-exists-unchanged", file, publicKey, next: "Put this public key in .env as NEAR_RUNTIME_PUBLIC_KEY, then authorize it on the owner account (docs/DEPLOY-TESTNET.md). The secret never leaves the file." }, null, 2));
}
main().catch(printFailure);

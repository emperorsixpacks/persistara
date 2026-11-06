import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Wallet } from "ethers";
import { storageConfig } from "../packages/protocol/src/config.js";
import { loadEnvironment, printFailure } from "./common.js";

try {
  loadEnvironment();
  const config = storageConfig(process.env);
  const path = resolve(config.uploaderKeyFile ?? ".persistara/keys/0g-uploader.key");
  let wallet: Wallet;
  if (existsSync(path)) wallet = new Wallet(readFileSync(path, "utf8").trim());
  else {
    wallet = new Wallet(Wallet.createRandom().privateKey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${wallet.privateKey}\n`, { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ status: "testnet_wallet_ready", address: wallet.address, keyFile: path, chainId: config.chainId, faucet: "https://faucet.0g.ai", note: "Keep the private key in this file; never paste it into chat or commit it." }, null, 2));
} catch (error) { printFailure(error); }

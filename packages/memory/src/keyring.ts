import { randomBytes } from "node:crypto";
import { MemoryError } from "../../protocol/src/memory.js";

export const MAX_KEY_EPOCHS = 64;
export interface EpochKey { epoch: number; key: Uint8Array }

/** Owner/runtime custody object. Never pass it to model-visible tools or receipts. */
export class MemoryKeyring {
  readonly #keys = new Map<number, Uint8Array>();
  constructor(readonly activeEpoch: number, entries: EpochKey[]) {
    if (!Number.isSafeInteger(activeEpoch) || activeEpoch < 1 || entries.length < 1 || entries.length > MAX_KEY_EPOCHS) throw new MemoryError("INVALID_INPUT", "Invalid memory keyring");
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.epoch) || entry.epoch < 1 || entry.epoch > activeEpoch || this.#keys.has(entry.epoch) || !(entry.key instanceof Uint8Array) || entry.key.byteLength !== 32) {
        throw new MemoryError("INVALID_INPUT", "Invalid or duplicate memory key epoch");
      }
      this.#keys.set(entry.epoch, Uint8Array.from(entry.key));
    }
    if (!this.#keys.has(activeEpoch)) throw new MemoryError("KEY_EPOCH_MISMATCH", "Active memory key is missing");
  }
  static create(): MemoryKeyring { return new MemoryKeyring(1, [{ epoch: 1, key: randomBytes(32) }]); }
  key(epoch: number): Uint8Array {
    const value = this.#keys.get(epoch);
    if (!value) throw new MemoryError("KEY_EPOCH_MISMATCH", "Recovery material is missing a required historical key");
    return Uint8Array.from(value);
  }
  epochs(): number[] { return [...this.#keys.keys()].sort((a, b) => a - b); }
  /** Prepares a new owner-held keyring; it does not change NEAR authority or revoke keys. */
  nextEpoch(): MemoryKeyring {
    if (this.#keys.size >= MAX_KEY_EPOCHS || this.activeEpoch >= Number.MAX_SAFE_INTEGER) throw new MemoryError("MEMORY_LIMIT", "Memory keyring capacity reached");
    const next = this.activeEpoch + 1;
    return new MemoryKeyring(next, [...this.epochs().map((epoch) => ({ epoch, key: this.key(epoch) })), { epoch: next, key: randomBytes(32) }]);
  }
  toJSON() { return { activeEpoch: this.activeEpoch, epochs: this.epochs(), privateKeys: "redacted" }; }
}

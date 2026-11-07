import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { MemoryError } from "../../protocol/src/memory.js";

/** Ciphertext/public descriptors may live on non-POSIX external media. Secrets still use readPrivateFile. */
export async function readRecoveryPublicFile(path: string, maximum: number): Promise<Uint8Array> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximum) throw new MemoryError("INVALID_BACKUP", "Recovery export file exceeds its bound or is not a regular file");
    const buffer = Buffer.alloc(maximum + 1); let size = 0;
    while (size <= maximum) { const part = await file.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size > maximum) throw new MemoryError("INVALID_BACKUP", "Recovery export grew beyond its bound");
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}

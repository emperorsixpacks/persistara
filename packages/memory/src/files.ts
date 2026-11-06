import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MemoryError } from "../../protocol/src/memory.js";

/** Owner-controlled macOS/Linux files. Callers choose paths; model tools never do. */
export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new MemoryError("INVALID_INPUT", "Memory state directory must be private and must not be a symlink");
  return absolute;
}
export async function readPrivateFile(path: string, maximum = 32_768): Promise<Uint8Array> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > maximum) throw new MemoryError("INVALID_INPUT", "Memory key/backup file is not private or exceeds its size limit");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size <= maximum) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum) throw new MemoryError("INVALID_INPUT", "Memory file grew beyond its size limit");
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}
export async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const absolute = resolve(path);
  await privateDirectory(dirname(absolute));
  const file = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(dirname(absolute), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

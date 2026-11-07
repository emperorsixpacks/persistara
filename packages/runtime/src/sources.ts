import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { ProviderError } from "../../protocol/src/providers.js";
import type { SourceCapture } from "./types.js";

export const DEFAULT_SOURCE_ORIGINS = ["https://docs.near.org", "https://docs.0g.ai", "https://raw.githubusercontent.com"];
const invalid = () => new ProviderError("INVALID_INPUT", "Use an allowed public HTTPS source without credentials, query, fragment or custom port");
export function sourceUrl(input: unknown, origins: readonly string[]): string {
  if (typeof input !== "string" || input.length > 2048 || /[\u0000-\u0020\u007f]/u.test(input)) throw invalid();
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || isIP(url.hostname) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname) || !origins.includes(url.origin)) throw invalid();
  return url.href;
}
export function sourceOrigins(value?: string): string[] {
  const origins = value === undefined ? DEFAULT_SOURCE_ORIGINS : value.split(",").map((v) => v.trim());
  if (origins.length < 1 || origins.length > 16 || new Set(origins).size !== origins.length) throw invalid();
  for (const origin of origins) if (sourceUrl(`${origin}/`, origins) !== `${origin}/`) throw invalid();
  return [...origins];
}
/** Conservative IPv4-only egress. All special-purpose ranges below are rejected, even public exceptions. */
export function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99) || (b === 31 && c === 196) || (b === 52 && c === 193) || (b === 175 && c === 48))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
function plain(input: string): string {
  return input.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    const code = entity.toLowerCase().startsWith("&#x") ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
  }).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim();
}
export function captureSource(url: string, bytes: Uint8Array, contentType: "text/html" | "text/plain", capturedAt: number): SourceCapture {
  if (bytes.length < 1 || bytes.length > 1_000_000) throw new ProviderError("PROTOCOL_ERROR", "Source exceeds its byte bound");
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ProviderError("PROTOCOL_ERROR", "Source must be UTF-8 text"); }
  const title = (contentType === "text/html" ? plain(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, " ") ?? "") : new URL(url).pathname.split("/").at(-1)) || new URL(url).hostname;
  const cleaned = contentType === "text/html" ? html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ") : html;
  const text = plain(cleaned);
  if (text.length < 20) throw new ProviderError("PROTOCOL_ERROR", "Source did not contain enough readable text");
  return { url, title: title.slice(0, 240), excerpt: text.slice(0, 6000), contentSha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length,
    capturedAt, contentType, truncated: text.length > 6000, untrusted: true };
}
export interface SourceReader { read(url: string, signal: AbortSignal): Promise<SourceCapture> }
/** No cookies, redirects, proxy environment, private addresses, ports, credentials, POST or scripts. */
export class PublicSourceReader implements SourceReader {
  readonly allowedOrigins: readonly string[];
  constructor(origins = sourceOrigins()) { this.allowedOrigins = Object.freeze([...origins]); }
  async read(input: string, outer: AbortSignal): Promise<SourceCapture> {
    const url = new URL(sourceUrl(input, this.allowedOrigins));
    const signal = AbortSignal.any([outer, AbortSignal.timeout(20_000)]);
    try {
      signal.throwIfAborted();
      const addresses = await Promise.race([lookup(url.hostname, { all: true, family: 4 }), new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new ProviderError("ABORTED", "Source lookup interrupted")), { once: true });
      })]);
      signal.throwIfAborted();
      if (!addresses.length || addresses.some((record) => !publicIpv4(record.address))) throw new ProviderError("AUTHORIZATION_FAILED", "Source DNS resolved outside permitted public IPv4 space");
      const address = addresses[0]!.address;
      return await new Promise<SourceCapture>((resolve, reject) => {
        const req = request(url, { method: "GET", agent: false, family: 4, signal, rejectUnauthorized: true,
          lookup: (_host, _options, callback) => callback(null, address, 4),
          headers: { accept: "text/html, text/plain;q=0.9", "accept-encoding": "identity", "user-agent": "PersistaraSourceCollector/0.1" } }, (res) => {
          void (async () => {
            const type = res.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
            if (res.statusCode !== 200 || !["text/html", "text/plain"].includes(type ?? "") || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") ||
              (res.headers["content-length"] !== undefined && (!/^\d+$/.test(res.headers["content-length"]) || Number(res.headers["content-length"]) > 1_000_000))) {
              throw new ProviderError("UPSTREAM_ERROR", "Source status, encoding or content type is unsupported");
            }
            const chunks: Buffer[] = []; let size = 0;
            for await (const part of res) { size += part.length; if (size > 1_000_000) throw new ProviderError("PROTOCOL_ERROR", "Source exceeds its byte bound"); chunks.push(Buffer.from(part)); }
            resolve(captureSource(url.href, Buffer.concat(chunks), type as "text/html" | "text/plain", Date.now()));
          })().catch((error: unknown) => { res.destroy(); reject(error); });
        });
        req.on("error", reject); req.end();
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(outer.aborted ? "ABORTED" : "UPSTREAM_ERROR", "Public source retrieval did not complete", true);
    }
  }
}

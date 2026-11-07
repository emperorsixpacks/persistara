import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { isObject } from "../../protocol/src/memory.js";
import { ProviderError } from "../../protocol/src/providers.js";
import { OwnerAuth } from "./auth.js";
import { OwnerService } from "./service.js";
import { missionId } from "../../runtime/src/journal.js";
import type { MissionService } from "../../runtime/src/service.js";
import type { CommissionService } from "../../commerce/src/service.js";
import { commissionId } from "../../commerce/src/protocol.js";

export interface OwnerServerOptions { port: number; staticDirectory: string; service: OwnerService; missions?: MissionService; commerce?: CommissionService; fixture?: boolean; now?: () => number }
const cookieValue = (request: IncomingMessage, name: string) => {
  const parts = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (parts.length !== 1) return undefined;
  const value = parts[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
};
const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}`;
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) throw new ProviderError("INVALID_INPUT", "Invalid console request fields");
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new ProviderError("INVALID_INPUT", "JSON content type required");
  let size = 0; const chunks: Buffer[] = [];
  for await (const part of request) {
    const bytes = Buffer.from(part); size += bytes.length;
    if (size > 32_768) throw new ProviderError("INVALID_INPUT", "Console body exceeds its size limit");
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ProviderError("INVALID_INPUT", "Invalid JSON body"); }
  if (!isObject(value)) throw new ProviderError("INVALID_INPUT", "Expected a JSON object");
  return value;
}

/** Loopback control plane. No generic signing/broadcast, secret-download or arbitrary-file route. */
export function createOwnerServer(options: OwnerServerOptions) {
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) throw new ProviderError("INVALID_INPUT", "Invalid loopback port");
  const origin = `http://127.0.0.1:${options.port}`;
  const authority = `127.0.0.1:${options.port}`;
  const service = options.service;
  const auth = new OwnerAuth(origin, service.read, options.now);
  const send = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value));
  };
  const requests = new Set<Promise<unknown>>();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    const task = (async () => {
      if (request.headers.host !== authority) return send(response, { status: "failed", code: "INVALID_HOST" }, 421);
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin || url.search || url.hash) throw new ProviderError("INVALID_INPUT", "Unexpected console URL");
      if (request.method !== "GET" && request.method !== "POST") return send(response, { status: "failed", code: "METHOD_NOT_ALLOWED" }, 405);
      if (request.method === "POST" && (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site")) throw new ProviderError("AUTHORIZATION_FAILED", "Same-origin console requests required");
      const sessionToken = cookieValue(request, "persistara_session");
      if (url.pathname === "/api/info" && request.method === "GET") return send(response, { network: "testnet", owner: service.config.signerId, agentId: service.config.agentId, contractId: service.config.contractId, fixture: options.fixture === true });
      if (url.pathname === "/api/challenge" && request.method === "POST") {
        exact(await body(request), []);
        const challenge = await auth.challenge(cookieValue(request, "persistara_challenge"));
        response.setHeader("Set-Cookie", cookie("persistara_challenge", challenge.id, 300));
        return send(response, challenge);
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        const proof = await body(request);
        const result = await auth.login(cookieValue(request, "persistara_challenge"), proof);
        response.setHeader("Set-Cookie", [cookie("persistara_session", result.token, 600), cookie("persistara_challenge", "", 0)]);
        return send(response, { authenticated: true, csrf: result.session.csrf, expiresAt: result.session.expiresAt });
      }
      if (url.pathname.startsWith("/api/")) {
        const csrf = request.method === "POST" ? request.headers["x-persistara-csrf"] : undefined;
        if (csrf !== undefined && typeof csrf !== "string") throw new ProviderError("AUTHORIZATION_FAILED", "Invalid CSRF header");
        const session = auth.require(sessionToken, request.method === "POST" ? csrf ?? "" : undefined);
        if (url.pathname === "/api/logout" && request.method === "POST") {
          exact(await body(request), []); auth.logout(sessionToken!);
          response.setHeader("Set-Cookie", cookie("persistara_session", "", 0)); return send(response, { authenticated: false });
        }
        const authorize = (view: Awaited<ReturnType<OwnerService["read"]>>) => {
          const current = auth.require(sessionToken, request.method === "POST" ? csrf ?? "" : undefined);
          if (view.owner !== current.owner || view.ownerKey !== current.publicKey || !view.ownerKeyFullAccess) throw new ProviderError("AUTHORIZATION_FAILED", "Registered owner access changed");
        };
        if (request.method === "POST" && ["/api/prepare", "/api/dispatch"].includes(url.pathname)) {
          const input = await body(request);
          if (url.pathname === "/api/prepare") { exact(input, ["paused"]); return send(response, await service.prepare(input.paused as boolean, authorize)); }
          exact(input, ["id", "digest"]);
          if (typeof input.id !== "string" || typeof input.digest !== "string") throw new ProviderError("INVALID_INPUT", "Missing reviewed operation ID or digest");
          return send(response, { operation: await service.dispatch(input.id, input.digest, authorize) });
        }
        const view = await service.read();
        authorize(view);
        if (url.pathname.startsWith("/api/commissions/")) {
          const commerce = options.commerce; if (!commerce) throw new ProviderError("NOT_CONFIGURED", "Specialist commissioning is not configured");
          const parts = url.pathname.slice("/api/commissions/".length).split("/"), id = parts[0];
          if (!commissionId(id) || parts.length > 2) throw new ProviderError("INVALID_INPUT", "Invalid commission route");
          if (request.method === "GET" && parts.length === 1) return send(response, commerce.options.journal.view(id));
          if (request.method === "GET" && parts[1] === "request") return send(response, commerce.request(id));
          if (request.method === "GET" && parts[1] === "recovery-request") return send(response, await commerce.recoveryRequest(id));
          if (request.method !== "POST" || parts.length !== 2) return send(response, { status: "failed", code: "NOT_FOUND" }, 404);
          const input = await body(request); authorize(view);
          if (["quote", "delivery"].includes(parts[1]!)) {
            exact(input, ["signed"]); return send(response, parts[1] === "quote" ? await commerce.importQuote(id, input.signed, authorize) : await commerce.importDelivery(id, input.signed, authorize));
          }
          if (parts[1] === "reconcile") { exact(input, []); return send(response, await commerce.reconcile(id)); }
          if (parts[1] === "reserve") {
            exact(input, ["version", "quoteDigest", "acknowledgeStorage"]);
            if (!Number.isSafeInteger(input.version) || typeof input.quoteDigest !== "string" || input.acknowledgeStorage !== true) throw new ProviderError("INVALID_INPUT", "Acknowledge the exact quote and testnet upload cost before reservation");
            return send(response, await commerce.reserve(id, Number(input.version), input.quoteDigest, authorize));
          }
          if (parts[1] === "settle") {
            exact(input, ["version", "artifactDigest", "quoteDigest", "acknowledged"]);
            if (!Number.isSafeInteger(input.version) || typeof input.artifactDigest !== "string" || typeof input.quoteDigest !== "string" || input.acknowledged !== true) throw new ProviderError("INVALID_INPUT", "Acknowledge the exact delivery and quote before settlement");
            return send(response, await commerce.settle(id, Number(input.version), input.artifactDigest, input.quoteDigest, authorize));
          }
          if (parts[1] === "cancel") { exact(input, ["version"]); return send(response, commerce.cancel(id, Number(input.version))); }
          return send(response, { status: "failed", code: "NOT_FOUND" }, 404);
        }
        if (url.pathname === "/api/missions" || url.pathname.startsWith("/api/missions/")) {
          const missions = options.missions;
          if (!missions) throw new ProviderError("NOT_CONFIGURED", "Mission journal is not configured");
          if (url.pathname === "/api/missions/activity" && request.method === "GET") return send(response, { events: missions.journal.activity() });
          if (url.pathname === "/api/missions") {
            if (request.method === "GET") return send(response, { missions: missions.journal.list().map((m) => options.commerce?.project(m) ?? m), capabilities: missions.capabilities(), commissioning: options.commerce?.capabilities() ?? { configured: false } });
            const input = await body(request);
            // Body parsing can await; recheck the session before each local mutation too.
            authorize(view);
            return send(response, missions.create(input, view));
          }
          const parts = url.pathname.slice("/api/missions/".length).split("/");
          const id = parts[0];
          if (!missionId(id) || parts.length > 2) throw new ProviderError("INVALID_INPUT", "Invalid mission route");
          if (request.method === "GET" && parts.length === 1) { const detail = missions.journal.get(id); return send(response, options.commerce?.detail(detail) ?? detail); }
          if (request.method !== "POST" || parts.length !== 2) return send(response, { status: "failed", code: "NOT_FOUND" }, 404);
          const input = await body(request); authorize(view);
          if (parts[1] === "commission") {
            exact(input, ["version", "maximumYoctoNear"]);
            if (!options.commerce) throw new ProviderError("NOT_CONFIGURED", "Specialist commissioning is not configured");
            if (!Number.isSafeInteger(input.version) || typeof input.maximumYoctoNear !== "string") throw new ProviderError("INVALID_INPUT", "Choose the reviewed commission budget");
            return send(response, await options.commerce.create(id, Number(input.version), input.maximumYoctoNear, view, authorize));
          }
          if (parts[1] === "events") { exact(input, ["after"]); return send(response, { events: missions.journal.events(id, input.after as number) }); }
          exact(input, parts[1] === "approve" ? ["version", "artifactDigest"] : ["version"]);
          if (!Number.isSafeInteger(input.version) || Number(input.version) < 1) throw new ProviderError("INVALID_INPUT", "Invalid mission version");
          if (parts[1] === "run") return send(response, missions.start(id, Number(input.version), view));
          if (parts[1] === "cancel") return send(response, missions.cancel(id, Number(input.version)));
          if (parts[1] === "approve") {
            if (typeof input.artifactDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactDigest)) throw new ProviderError("INVALID_INPUT", "Missing reviewed artifact digest");
            return send(response, missions.approve(id, Number(input.version), input.artifactDigest));
          }
          return send(response, { status: "failed", code: "NOT_FOUND" }, 404);
        }
        if (url.pathname === "/api/session" && request.method === "GET") return send(response, { authenticated: true, csrf: session.csrf, expiresAt: session.expiresAt });
        if (url.pathname === "/api/state" && request.method === "GET") return send(response, { view, pending: service.journal.pending(), recent: service.journal.recent() });
        if (request.method !== "POST") return send(response, { status: "failed", code: "NOT_FOUND" }, 404);
        const input = await body(request);
        if (typeof input.id !== "string") throw new ProviderError("INVALID_INPUT", "Missing owner operation ID");
        if (url.pathname === "/api/cancel") { exact(input, ["id"]); return send(response, { operation: service.journal.cancel(input.id) }); }
        if (url.pathname === "/api/reconcile") {
          exact(input, Object.hasOwn(input, "transactionHash") ? ["id", "transactionHash"] : ["id"]);
          if (input.transactionHash !== undefined && typeof input.transactionHash !== "string") throw new ProviderError("INVALID_INPUT", "Invalid transaction hash");
          return send(response, { operation: await service.reconcile(input.id, input.transactionHash as string | undefined) });
        }
        return send(response, { status: "failed", code: "NOT_FOUND" }, 404);
      }
      if (request.method !== "GET") return send(response, { status: "failed", code: "NOT_FOUND" }, 404);
      if (url.pathname === "/") {
        const nonce = randomBytes(24).toString("base64");
        const csp = `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data: https:; frame-src 'self' https: data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
        response.setHeader("Content-Security-Policy", csp);
        const html = await readFile(resolve(options.staticDirectory, "index.html"), "utf8");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(html.replaceAll("__CSP_NONCE__", nonce).replaceAll("<script ", `<script nonce="${nonce}" `));
      }
      if (/^\/assets\/[A-Za-z0-9_-]+\.(js|css|svg)$/.test(url.pathname)) {
        const extension = url.pathname.split(".").at(-1);
        const file = await readFile(resolve(options.staticDirectory, url.pathname.slice(1)));
        if (file.length > 2_000_000) throw new ProviderError("INVALID_INPUT", "Asset exceeds size limit");
        response.writeHead(200, { "content-type": extension === "js" ? "text/javascript; charset=utf-8" : extension === "css" ? "text/css; charset=utf-8" : "image/svg+xml" }); return response.end(file);
      }
      return send(response, { status: "failed", code: "NOT_FOUND" }, 404);
    })().catch((error: unknown) => {
      const code = error instanceof ProviderError ? error.code : "UPSTREAM_ERROR";
      if (!response.headersSent) send(response, { status: "failed", code }, code === "AUTHORIZATION_FAILED" ? 403 : code === "INVALID_INPUT" ? 400 : ["OPERATION_CONFLICT", "OUTCOME_UNKNOWN", "INTEGRITY_FAILED", "MISSION_BLOCKED"].includes(code) ? 409 : 503);
      else response.end();
    }).finally(() => { requests.delete(task); });
    requests.add(task);
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 2_000; server.maxRequestsPerSocket = 50;
  return { server, origin, auth, drain: async () => { await Promise.allSettled([...requests]); } };
}

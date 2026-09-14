import { lookup } from "node:dns/promises";

/**
 * Fetch for URLs a stranger supplied.
 *
 * URL ingestion is a server-side fetch of an attacker-controlled address whose
 * response body is then stored and read back through the chat API. That is a
 * complete SSRF read primitive: without these checks, someone can point the
 * ingester at the cloud metadata endpoint, at localhost, or at anything inside
 * the VPC, then ask a question and get the contents back in the citation
 * panel.
 *
 * Three things have to be true together, and each is load-bearing:
 *
 *  - Only http and https. Everything else (file:, gopher:, data:) is refused.
 *  - Every hop is resolved and checked against private ranges. Checking only
 *    the URL the caller typed is useless, because a public host can redirect
 *    to 169.254.169.254 — so redirects are followed manually, one hop at a
 *    time, re-validating each.
 *  - The body is capped while streaming. Content-Length is optional and can
 *    lie, so the limit is enforced on bytes actually read.
 */

const MAX_REDIRECTS = 3;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** Ranges that must never be reachable from a user-supplied URL. */
function isPrivateAddress(ip: string, family: number): boolean {
  if (family === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    // IPv4-mapped IPv6 (::ffff:169.254.169.254) must be unwrapped, not trusted.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1], 4);
    return false;
  }

  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local: cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

async function assertPublic(rawHost: string): Promise<void> {
  // URL.hostname keeps the brackets on an IPv6 literal, and dns.lookup then
  // fails to resolve it — which happens to block the request, but for the
  // wrong reason, and would equally block a legitimate public IPv6 host.
  const hostname = rawHost.replace(/^\[|\]$/g, "");

  // A bare IP needs checking directly; dns.lookup would simply echo it back.
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    ? { address: hostname, family: 4 }
    : hostname.includes(":")
      ? { address: hostname, family: 6 }
      : null;
  if (literal) {
    if (isPrivateAddress(literal.address, literal.family)) {
      throw new Error(`Refusing to fetch a private or link-local address (${hostname})`);
    }
    return;
  }

  let resolved;
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve ${hostname}`);
  }
  if (resolved.length === 0) throw new Error(`Could not resolve ${hostname}`);

  // ALL records must be public: a host resolving to both a public and a
  // private address is a rebinding attempt, not a partially valid target.
  for (const { address, family } of resolved) {
    if (isPrivateAddress(address, family)) {
      throw new Error(`Refusing to fetch a private or link-local address (${hostname})`);
    }
  }
}

export interface SafeResponse {
  body: Buffer;
  contentType: string;
  finalUrl: string;
}

export async function safeFetch(rawUrl: string): Promise<SafeResponse> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error("That is not a valid URL");
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`Only http and https URLs can be ingested (got ${current.protocol})`);
    }
    await assertPublic(current.hostname);

    const res = await fetch(current, {
      headers: { "user-agent": "ColophonRAG/1.0 (+document ingestion)" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect with no destination (${res.status})`);
      current = new URL(location, current); // re-validated at the top of the loop
      continue;
    }

    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

    return {
      body: await readCapped(res),
      contentType: res.headers.get("content-type") ?? "",
      finalUrl: current.toString(),
    };
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
}

/** Reads the body, aborting past the cap rather than trusting Content-Length. */
async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`Document is too large (${Math.round(declared / 1e6)}MB, limit 8MB)`);
  }

  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Document is too large (limit 8MB)");
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

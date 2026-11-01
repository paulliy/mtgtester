/**
 * Who may reach the table server, checked on every request before it is routed (ADR 0031
 * decision 9, plan M5 tasks 1 and 2). Pure: it reads the request's headers and the peer address
 * the Bun glue passes in, so every rule is tested without a socket.
 *
 * - **Development mode.** `Host` and any `Origin` must be loopback (`isLoopbackRequest`).
 * - **Production.** `Host` must be one of `TABLE_ALLOWED_HOSTS` and any `Origin` one of
 *   `TABLE_ALLOWED_ORIGINS`.
 * - **Behind a TLS proxy.** Only the configured proxy may connect, and the client is the
 *   rightmost `X-Forwarded-For` entry: the one the proxy itself added. Entries to its left came
 *   from the client and are never trusted.
 * - **`--insecure-lan`.** The client must be in a private address range. A loopback peer is
 *   accepted only with a loopback `Host`, unless a proxy is configured: a tunnel on the host's
 *   machine connects from loopback while the request names a public host.
 */

import { isIP } from 'node:net';
import { isLoopbackHostname, type TableConfig } from './config';

/** The Vite dev server's port, accepted as a page origin in development mode like the tester's. */
const DEV_WEB_PORT = '5173';
/**
 * Whether a request is loopback by `Host` and `Origin`. The `Host` header decides the target, so
 * a DNS name that resolves to 127.0.0.1 is refused; `Origin`, when present, must be a loopback
 * page on this server's port or the Vite dev server's.
 */
export function isLoopbackRequest(request: Request, port: number): boolean {
  let target: URL;
  try {
    const host = request.headers.get('host');
    target = new URL(`http://${host ?? new URL(request.url).host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(target.hostname)) return false;
  if (port > 0 && target.port !== String(port)) return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    const source = new URL(origin);
    return (
      source.protocol === 'http:' &&
      isLoopbackHostname(source.hostname) &&
      [String(port), DEV_WEB_PORT].includes(source.port)
    );
  } catch {
    return false;
  }
}

export type ExposureCheck =
  { ok: true; address: string } | { ok: false; status: 400 | 403; reason: string };

/** `host[:port]` from the `Host` header, lowercased, or null. */
function hostHeader(request: Request): string | null {
  const host = request.headers.get('host');
  return host === null || host.trim() === '' ? null : host.trim().toLowerCase();
}

function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

/** Strip an IPv4-mapped IPv6 prefix, so `::ffff:10.0.0.4` reads as `10.0.0.4`. */
function plainAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
}

export function isLoopbackAddress(address: string): boolean {
  const plain = plainAddress(address);
  return plain === '::1' || /^127\./.test(plain);
}

/** RFC 1918, carrier-grade NAT excluded; IPv6 unique-local and link-local. Loopback excluded. */
export function isPrivateAddress(address: string): boolean {
  const plain = plainAddress(address);
  const kind = isIP(plain);
  if (kind === 4) {
    const [a, b] = plain.split('.').map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (kind === 6) return /^f[cd][0-9a-f]{2}:/.test(plain) || /^fe[89ab][0-9a-f]:/.test(plain);
  return false;
}

/**
 * The client a trusted proxy names: the rightmost `X-Forwarded-For` entry, the one that proxy
 * appended. Null when it is missing or not an address.
 */
export function forwardedClient(request: Request): string | null {
  const header = request.headers.get('x-forwarded-for');
  if (header === null) return null;
  const entries = header.split(',').map((entry) => entry.trim());
  const last = entries.at(-1);
  if (last === undefined || isIP(last) === 0) return null;
  return plainAddress(last);
}

export function checkExposure(
  config: TableConfig,
  request: Request,
  peer: string,
  boundPort: number,
): ExposureCheck {
  const refuse = (status: 400 | 403, reason: string): ExposureCheck => ({
    ok: false,
    status,
    reason,
  });
  if (config.dev) {
    return isLoopbackRequest(request, boundPort)
      ? { ok: true, address: plainAddress(peer) }
      : refuse(403, 'Forbidden origin or host');
  }

  const host = hostHeader(request);
  if (host === null || !config.allowedHosts.includes(host)) {
    return refuse(403, 'Forbidden host');
  }
  const origin = request.headers.get('origin');
  if (origin !== null && !config.allowedOrigins.includes(origin)) {
    return refuse(403, 'Forbidden origin');
  }

  let address = plainAddress(peer);
  if (config.trustedProxy !== null) {
    if (address !== plainAddress(config.trustedProxy)) {
      return refuse(403, 'Connect through the proxy');
    }
    const client = forwardedClient(request);
    if (client === null) return refuse(400, 'Missing client address');
    address = client;
  }

  if (config.insecureLan) {
    if (isLoopbackAddress(address)) {
      if (config.trustedProxy === null && !isLoopbackHostname(hostnameOf(host))) {
        return refuse(403, 'A loopback peer must name a loopback host');
      }
    } else if (!isPrivateAddress(address)) {
      return refuse(403, 'This LAN table accepts private addresses only');
    }
  }
  return { ok: true, address };
}

export interface SocketLimitOptions {
  /** Sockets one client address may hold open at once. Default 8. */
  maxConcurrent?: number;
  /** Socket opens one client address may make per minute. Default 30. */
  maxOpensPerMinute?: number;
  /** Addresses remembered at once; the stalest idle one is forgotten first. Default 10,000. */
  maxTracked?: number;
  now?: () => number;
}

/**
 * Per-address socket caps (plan M5 task 2): how many sockets an address holds open, and how many
 * it opens per minute. `admit` before the upgrade; `release` when the socket closes.
 */
export class SocketLimiter {
  private readonly open = new Map<string, number>();
  private readonly opens = new Map<string, number[]>();
  private readonly maxConcurrent: number;
  private readonly maxOpens: number;
  private readonly maxTracked: number;
  private readonly now: () => number;

  constructor(options: SocketLimitOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 8;
    this.maxOpens = options.maxOpensPerMinute ?? 30;
    this.maxTracked = options.maxTracked ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** How many addresses are remembered, for tests. */
  get tracked(): number {
    return this.opens.size;
  }

  /** Whether `address` may open one more socket; counts it when it may. */
  admit(address: string): boolean {
    const now = this.now();
    const recent = (this.opens.get(address) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= this.maxOpens || (this.open.get(address) ?? 0) >= this.maxConcurrent) {
      this.opens.set(address, recent);
      return false;
    }
    recent.push(now);
    // Re-inserted so Map order is least recently opened first, for the pruning below.
    this.opens.delete(address);
    this.opens.set(address, recent);
    this.open.set(address, (this.open.get(address) ?? 0) + 1);
    this.prune();
    return true;
  }

  /**
   * Bound the memory one client cycling through addresses (an IPv6 block) can make the server
   * hold: forget addresses with nothing open and no open in the last minute, oldest first, once
   * more than `maxTracked` are remembered. Addresses with sockets open are never forgotten.
   */
  private prune(): void {
    if (this.opens.size <= this.maxTracked) return;
    for (const address of this.opens.keys()) {
      if (this.opens.size <= this.maxTracked) return;
      // Forgetting an idle address's recent opens only lets it open again sooner; a client
      // cycling addresses already has that.
      if ((this.open.get(address) ?? 0) === 0) this.opens.delete(address);
    }
  }

  release(address: string): void {
    const count = (this.open.get(address) ?? 0) - 1;
    if (count <= 0) this.open.delete(address);
    else this.open.set(address, count);
  }
}

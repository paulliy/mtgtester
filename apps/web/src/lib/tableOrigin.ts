/**
 * Where the multiplayer table server lives (ADR 0053, plan section 7). The site and the tables
 * can be served from different hosts: `VITE_TABLE_ORIGIN` names the tables' origin, and without
 * it the page's own origin is used, as the table server's own build always has.
 */

/** The tables' origin, with no trailing slash. */
export function tableOriginFrom(configured: string | undefined, pageOrigin: string): string {
  const origin =
    typeof configured === 'string' && configured.trim() !== '' ? configured : pageOrigin;
  return new URL(origin).origin;
}

export function tableOrigin(): string {
  return tableOriginFrom(import.meta.env.VITE_TABLE_ORIGIN, window.location.origin);
}

/** An HTTP address on the table server, such as `/tables`. */
export function tableHttpUrl(path: string, origin: string = tableOrigin()): string {
  return new URL(path, `${origin}/`).href;
}

/** A socket address on the table server: `ws:` or `wss:` to match its HTTP scheme. */
export function tableSocketUrl(path: string, origin: string = tableOrigin()): string {
  const url = new URL(path, `${origin}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

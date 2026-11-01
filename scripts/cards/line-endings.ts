/**
 * The scaffold editors match and insert text with `\n`. A checkout with CRLF line endings (a
 * Windows clone with `core.autocrlf`) must edit the same way and keep its endings.
 */

/** `edit` applied to `source` read as LF text; a CRLF file comes back with CRLF endings. */
export function withLf(source: string, edit: (lf: string) => string): string {
  if (!source.includes('\r\n')) return edit(source);
  return edit(source.replaceAll('\r\n', '\n')).replaceAll('\n', '\r\n');
}

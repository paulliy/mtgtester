/**
 * The invite code to join with: the table's current one when the server has told us, otherwise
 * the one in the address fragment. The host can rotate the invite, which makes a link's old
 * fragment stale, and a hand-edited fragment (`#%`) must not break the page.
 */
export function inviteCodeFor(hash: string | undefined, stateInvite: string | undefined): string {
  if (stateInvite !== undefined && stateInvite !== '') return stateInvite;
  const raw = (hash ?? '').replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The tactician's card glossary: rules text listed once per card name, in messages that only
 * grow, ahead of the changing observation.
 *
 * Card text is most of the tactician's observation (the battlefield alone is about half of it,
 * and most of that is rules text), yet it barely changes from one decision to the next. Sent
 * inside the observation it is paid for in full on every call. Sent here, each call repeats the
 * previous call's glossary messages byte for byte and adds at most one message for cards it has
 * not listed before, so a prefix cache serves everything but that new message.
 *
 * A glossary belongs to one seat in one game (the provider owns it), so a card in that seat's
 * hand is listed only to that seat. Cards stay listed after they leave view, since removing them
 * rewrites the prefix and loses the cache, until the text of cards out of view outweighs
 * `staleRatio` times the text of cards in view. Then the glossary restarts from the cards in view:
 * one cache write, in exchange for not sending dead text on every later call. 0.5 left the fewest
 * uncached tokens in the hill-climb `table` census (2026-11-27; 0.25, 1 and never were worse).
 */

import type { OpenAiMessage } from './context';

export class CardGlossary {
  private textByName = new Map<string, string>();
  private messages: OpenAiMessage[] = [];
  private pending: Record<string, string> = {};
  /** Names covered since the last flush: the cards the current prompt shows. */
  private readonly inView = new Set<string>();

  constructor(private readonly staleRatio = 0.5) {}

  /**
   * Lists `name` with `text` unless it is already listed. Returns true when the glossary carries
   * exactly this text for the name, so the caller can leave it out of the observation; false when
   * the name is listed with different text (a copy or a changed face), and the caller must keep
   * the text inline.
   */
  cover(name: string, text: string): boolean {
    const listed = this.textByName.get(name);
    if (listed !== undefined) {
      if (listed !== text) return false;
      this.inView.add(name);
      return true;
    }
    this.textByName.set(name, text);
    this.pending[name] = text;
    this.inView.add(name);
    return true;
  }

  /** The glossary messages for the current prompt, oldest first. Call once per prompt. */
  flush(): OpenAiMessage[] {
    let live = 0;
    let stale = 0;
    for (const [name, text] of this.textByName) {
      if (this.inView.has(name)) live += name.length + text.length;
      else stale += name.length + text.length;
    }
    if (stale > live * this.staleRatio) {
      const kept = [...this.textByName].filter(([name]) => this.inView.has(name));
      this.textByName = new Map(kept);
      this.messages = [];
      this.pending = Object.fromEntries(kept);
    }
    if (Object.keys(this.pending).length > 0) {
      this.messages.push({ role: 'user', content: JSON.stringify({ cardText: this.pending }) });
      this.pending = {};
    }
    this.inView.clear();
    return [...this.messages];
  }
}

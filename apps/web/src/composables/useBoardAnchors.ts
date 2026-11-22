/**
 * Tracks the on-screen rect of permanents/seats, keyed by object/seat id, relative to one
 * registered board root — the one piece of geometry CSS classes/composables can't already give:
 * a position to draw a line to. Module-level state, so every component that calls this
 * composable (a permanent tile registering itself, the combat overlay reading anchors) shares
 * the same registry without a Pinia store.
 */
import { reactive } from 'vue';

export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const anchors = reactive(new Map<string, AnchorRect>());
const elements = new Map<string, HTMLElement>();
let root: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;

function measure(id: string): void {
  const el = elements.get(id);
  if (el === undefined || root === null) return;
  const elRect = el.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const next = {
    x: elRect.left - rootRect.left,
    y: elRect.top - rootRect.top,
    width: elRect.width,
    height: elRect.height,
  };
  // Unchanged rects are not written back, so measuring every frame doesn't re-render readers.
  const prev = anchors.get(id);
  if (
    prev !== undefined &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.width === next.width &&
    prev.height === next.height
  )
    return;
  anchors.set(id, next);
}

function measureAll(): void {
  for (const id of elements.keys()) measure(id);
}

function onWindowResize(): void {
  measureAll();
}

export function useBoardAnchors() {
  /** Call once, from the board container that anchor coordinates should be relative to. */
  function setRoot(el: HTMLElement | null): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
    root = el;
    if (el === null) return;
    resizeObserver = new ResizeObserver(() => measureAll());
    resizeObserver.observe(el);
    if (typeof window !== 'undefined') window.addEventListener('resize', onWindowResize);
    measureAll();
  }

  /**
   * With `el`, releases the root only if `el` still holds it: the spectator board and the player
   * board (rendered inside it) each set their own, and one leaving must not clear the other's.
   */
  function disposeRoot(el?: HTMLElement): void {
    if (el !== undefined && root !== el) return;
    resizeObserver?.disconnect();
    resizeObserver = null;
    root = null;
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
  }

  /** `el === null` (element unmounting) unregisters the id. */
  function registerAnchor(id: string, el: Element | null): void {
    if (el === null || !(el instanceof HTMLElement)) {
      elements.delete(id);
      anchors.delete(id);
      return;
    }
    elements.set(id, el);
    measure(id);
  }

  function unregisterAnchor(id: string): void {
    elements.delete(id);
    anchors.delete(id);
  }

  function anchorFor(id: string): AnchorRect | undefined {
    return anchors.get(id);
  }

  /** Re-reads every rect: tiles shift when others enter, leave, tap or step forward. */
  function remeasureAnchors(): void {
    measureAll();
  }

  return {
    anchors,
    setRoot,
    disposeRoot,
    registerAnchor,
    unregisterAnchor,
    anchorFor,
    remeasureAnchors,
  };
}

/**
 * Clears every registered anchor. Mounted permanents/seats re-register themselves the moment
 * their `:ref` next fires — normally unnecessary, since each caller already unregisters on its
 * own unmount — but a new game reuses this module-level registry (there is no per-game instance
 * of it), so this is the explicit belt to that lifecycle's suspenders. Called from
 * `stores/game.ts`'s `gameStarted` handler, alongside the rest of the per-game reset.
 */
export function resetBoardAnchors(): void {
  anchors.clear();
  elements.clear();
}

/**
 * The widest 5:7 card tile that lets `count` tiles fit a zone of `width` × `height`, laid out in
 * as many rows as fill it best (redesign phase 5, Board.dc.html's `fit()`): few cards are large,
 * many shrink, and nothing scrolls until the floor is reached. `extra` is the height a tile adds
 * beyond its 5:7 card (a mana button under it), `gap` the space between tiles.
 */
export function fitTileWidth(
  count: number,
  width: number,
  height: number,
  { min, max, gap = 6, extra = 0 }: { min: number; max: number; gap?: number; extra?: number },
): number {
  if (count <= 0 || width <= 0 || height <= 0) return max;
  let best = 0;
  for (let rows = 1; rows <= count; rows += 1) {
    const perRow = Math.ceil(count / rows);
    const byWidth = (width - (perRow - 1) * gap) / perRow;
    const byHeight = (((height - (rows - 1) * gap) / rows - extra) * 5) / 7;
    best = Math.max(best, Math.min(byWidth, byHeight));
    // More rows only help while the height is what limits the tile.
    if (byHeight < byWidth) break;
  }
  return Math.floor(Math.min(max, Math.max(min, best)));
}

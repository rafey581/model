/**
 * The table's proportions, shared by the renderer and the layout.
 *
 * The world is 1200x640, so this is exactly 2:1 and has to stay that way: both
 * renderers scale the world by a single factor and centre it, and the pointer maths
 * in input.ts maps the canvas rectangle straight onto the table rectangle. A canvas of
 * any other shape puts a gap between where a ball is drawn and where the cue is aimed.
 */
export const TABLE_ASPECT = 1200 / 640

/**
 * The largest table that fits in the space available.
 *
 * Pure, and the only place the choice is made, so it can be tested without a page:
 * the interesting failures here are all about the box coming out too big (the rails
 * off the bottom of the window) or the wrong shape (the aim drifting away from the
 * balls), and neither is visible in a screenshot the way it is in a number.
 *
 * Both dimensions are honoured, whichever one binds first. The result is deliberately
 * not rounded to whole pixels: a table is 2:1, so rounding the two dimensions
 * independently leaves a box that is very slightly the wrong shape, and the aim
 * mapping stretches with it. Fractional CSS pixels are fine, and the integer the
 * canvas backing store needs is taken afterwards, where losing half a pixel cannot
 * change the shape the user is looking at.
 */
export function fitTableBox(availWidth: number, availHeight: number): { width: number; height: number } {
  if (!(availWidth > 0) || !(availHeight > 0)) return { width: 0, height: 0 }
  let width = availWidth
  let height = width / TABLE_ASPECT
  if (height > availHeight) {
    height = availHeight
    width = height * TABLE_ASPECT
  }
  return { width, height }
}

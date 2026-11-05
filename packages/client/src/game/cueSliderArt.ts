/**
 * The power stick in the pull-to-hit slider, drawn as one inline SVG.
 *
 * A polished silver bar, not a wooden cue: a bright streak down the left of the
 * cylinder, a cool mid-tone, and a dark edge, so it reads as metal rather than
 * a flat grey fill. Vector throughout, so it is sharp at every pixel density
 * and there is no image to download. Built once as a string and never touched
 * again: pulling the stick is a transform on the element that holds it.
 *
 * Drawn tip-up in a 30 x 600 box. The box is stretched to the element, which is
 * what lets one drawing serve every groove size.
 */

const W = 30
const L = 600

/** Lengths of each part down the stick, top to bottom, in drawing units. */
const TIP = 10
const CAP = 16
const SHAFT = 404
const COLLAR = 10
const BUTT = 140
const BUMPER = L - TIP - CAP - SHAFT - COLLAR - BUTT

/** Half-widths: a slim tip, then a gentle swell through the grip. */
const HALF_TIP = (W * 0.5) / 2
const HALF_SHAFT = (W * 0.72) / 2
const HALF_BUTT = W / 2

const cx = W / 2

/** A four-sided piece of the stick between two heights, with its own half-widths. */
function slab(y0: number, y1: number, half0: number, half1: number, fill: string): string {
  return `<polygon points="${cx - half0},${y0} ${cx + half0},${y0} ${cx + half1},${y1} ${cx - half1},${y1}" fill="${fill}"/>`
}

/** The SVG markup for the power stick. `id` keeps its gradients apart if two are ever on a page. */
export function cueSliderSvg(id = 'cue-slider'): string {
  const yCap = TIP
  const yShaft = yCap + CAP
  const yCollar = yShaft + SHAFT
  const yButt = yCollar + COLLAR
  const yBumper = yButt + BUTT

  // A bright wire down the highlight, and a darker one in the shade, so the
  // cylinder keeps an edge when the gradient is stretched thin on a phone.
  const wire = (k: number, color: string, opacity: number): string => {
    const x0 = cx + HALF_TIP * k
    const x1 = cx + HALF_BUTT * k
    return `<line x1="${x0}" y1="${yShaft + 4}" x2="${x1}" y2="${yBumper - 4}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="0.7"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${L}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
<defs>
  <linearGradient id="${id}-silver" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#5e6872"/>
    <stop offset="0.16" stop-color="#c5ced6"/>
    <stop offset="0.3" stop-color="#f7fbfe"/>
    <stop offset="0.46" stop-color="#d5dee6"/>
    <stop offset="0.64" stop-color="#8e99a3"/>
    <stop offset="0.8" stop-color="#e8eef3"/>
    <stop offset="1" stop-color="#3e474f"/>
  </linearGradient>
  <linearGradient id="${id}-tip" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#8b98a6"/>
    <stop offset="0.28" stop-color="#ffffff"/>
    <stop offset="0.55" stop-color="#dbe3ea"/>
    <stop offset="1" stop-color="#5c6770"/>
  </linearGradient>
  <linearGradient id="${id}-edge" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/>
    <stop offset="0.22" stop-color="#fff" stop-opacity="0.55"/>
    <stop offset="0.4" stop-color="#fff" stop-opacity="0.05"/>
    <stop offset="0.72" stop-color="#000" stop-opacity="0.08"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.38"/>
  </linearGradient>
</defs>
<path d="M ${cx - HALF_TIP} ${TIP} L ${cx - HALF_TIP} 2.2 Q ${cx} -1.6 ${cx + HALF_TIP} 2.2 L ${cx + HALF_TIP} ${TIP} Z" fill="url(#${id}-tip)"/>
${slab(yCap, yShaft, HALF_TIP, HALF_TIP + 0.35, `url(#${id}-tip)`)}
<line x1="${cx - HALF_TIP}" y1="${yShaft}" x2="${cx + HALF_TIP}" y2="${yShaft}" stroke="#2c343c" stroke-width="0.8"/>
${slab(yShaft, yCollar, HALF_TIP + 0.35, HALF_SHAFT, `url(#${id}-silver)`)}
${wire(-0.42, '#ffffff', 0.55)}
${wire(0.62, '#1c232a', 0.35)}
${slab(yCollar, yButt, HALF_SHAFT + 0.15, HALF_SHAFT + 0.15, `url(#${id}-tip)`)}
${slab(yButt, yBumper, HALF_SHAFT, HALF_BUTT, `url(#${id}-silver)`)}
${slab(yButt + 18, yButt + 23, HALF_BUTT * 0.96, HALF_BUTT * 0.97, `url(#${id}-tip)`)}
<circle cx="${cx}" cy="${yButt + BUTT * 0.58}" r="5.4" fill="none" stroke="#f4f8fb" stroke-width="1.15" stroke-opacity="0.9"/>
<circle cx="${cx}" cy="${yButt + BUTT * 0.58}" r="2.1" fill="#f7fbfe"/>
<path d="M ${cx - HALF_BUTT} ${yBumper} L ${cx + HALF_BUTT} ${yBumper} L ${cx + HALF_BUTT - 1.2} ${L - 1.2} Q ${cx} ${L + 0.8} ${cx - HALF_BUTT + 1.2} ${L - 1.2} Z" fill="#2a3138"/>
${slab(TIP, yBumper, HALF_TIP, HALF_BUTT, `url(#${id}-edge)`)}
</svg>`
}

/**
 * The groove's level marks: one tick at each fifth of the travel.
 *
 * 20 is level 1, 100 is level 5. The labels beside the groove use the same
 * fifths, so a tick and its number sit on one line.
 */
export function cueSliderTicksSvg(): string {
  const marks = [20, 40, 60, 80, 100]
    .map((y) => `<line x1="0" y1="${y}" x2="11" y2="${y}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1 11 102" preserveAspectRatio="none" aria-hidden="true" focusable="false" stroke="rgba(232,238,244,0.72)" stroke-width="1.25" vector-effect="non-scaling-stroke">${marks}</svg>`
}

/**
 * The cue in the power slider, drawn as one inline SVG.
 *
 * Our own cue, not anybody else's: a maple shaft under a chalked tip and an ivory ferrule,
 * a gold ring at the joint, a walnut forearm with four long cream points running up toward
 * the tip, an ebony butt carrying the SnookerX mark — the gold ring with a dot — and a
 * matte bumper. Vector throughout, so it is sharp at every pixel density and there is no
 * image to download. Built once as a string and never touched again: pulling the cue is a
 * transform on the element that holds it.
 *
 * Drawn tip-up in a 30 x 600 box. The box is stretched to the element, which is what lets
 * one drawing serve every groove size.
 */

const W = 30
const L = 600

/** Lengths of each part down the cue, top to bottom, in drawing units. */
const TIP = 9
const FERRULE = 15
const SHAFT = 300
const JOINT = 12
const FOREARM = 108
const BUTT = 150
const BUMPER = L - TIP - FERRULE - SHAFT - JOINT - FOREARM - BUTT

/** Half-widths: a taper from the tip out to the joint, then a gentle swell to the butt. */
const HALF_TIP = (W * 0.55) / 2
const HALF_JOINT = (W * 0.8) / 2
const HALF_BUTT = W / 2

const cx = W / 2

/** A four-sided piece of the cue between two heights, with its own half-widths. */
function slab(y0: number, y1: number, half0: number, half1: number, fill: string): string {
  return `<polygon points="${cx - half0},${y0} ${cx + half0},${y0} ${cx + half1},${y1} ${cx - half1},${y1}" fill="${fill}"/>`
}

/** The SVG markup for the cue. `id` keeps its gradients apart if two are ever on a page. */
export function cueSliderSvg(id = 'cue-slider'): string {
  const yFerrule = TIP
  const yShaft = yFerrule + FERRULE
  const yJoint = yShaft + SHAFT
  const yForearm = yJoint + JOINT
  const yButt = yForearm + FOREARM
  const yBumper = yButt + BUTT

  // Four cream points let into the walnut, rising toward the tip: two full ones on the
  // face and a half at each edge, which is how four points read on a round cue.
  const points: string[] = []
  const pointTop = yForearm + 6
  const pointBase = yButt - 2
  for (const at of [-HALF_JOINT, -HALF_JOINT / 3, HALF_JOINT / 3, HALF_JOINT]) {
    const half = HALF_JOINT / 3
    points.push(
      `<polygon points="${cx + at},${pointTop} ${cx + at + half},${pointBase} ${cx + at - half},${pointBase}" fill="#e8d6b0"/>`,
      `<polygon points="${cx + at},${pointTop + 16} ${cx + at + half * 0.62},${pointBase} ${cx + at - half * 0.62},${pointBase}" fill="#5a3220"/>`
    )
  }

  // Three faint straight grain lines down the maple.
  const grain = [-0.42, 0.08, 0.5]
    .map((k) => {
      const x0 = cx + HALF_TIP * k
      const x1 = cx + HALF_JOINT * k
      return `<line x1="${x0}" y1="${yShaft + 8}" x2="${x1}" y2="${yJoint - 6}" stroke="#a9793f" stroke-opacity="0.22" stroke-width="0.6"/>`
    })
    .join('')

  // Dust on the chalk: a few pale specks.
  const dust = [
    [-1.6, 2.5],
    [1.1, 4.2],
    [-0.4, 6.4],
    [2.2, 6.9],
    [-2.3, 5.2]
  ]
    .map(([dx, dy]) => `<circle cx="${cx + dx!}" cy="${dy}" r="0.45" fill="#cfe2fb" fill-opacity="0.75"/>`)
    .join('')

  const emblemY = yButt + BUTT * 0.56

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${L}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
<defs>
  <linearGradient id="${id}-maple" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#f3dcaa"/><stop offset="0.5" stop-color="#e2bd7c"/><stop offset="1" stop-color="#c99a5a"/>
  </linearGradient>
  <linearGradient id="${id}-ebony" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#16100c"/><stop offset="0.34" stop-color="#3b2c24"/><stop offset="0.52" stop-color="#16100c"/><stop offset="1" stop-color="#0c0806"/>
  </linearGradient>
  <linearGradient id="${id}-gold" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#b98529"/><stop offset="0.35" stop-color="#ffe3a3"/><stop offset="0.6" stop-color="#d9a441"/><stop offset="1" stop-color="#9c6d1c"/>
  </linearGradient>
  <linearGradient id="${id}-round" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.28"/><stop offset="0.48" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.28"/>
  </linearGradient>
  <clipPath id="${id}-forearm">
    <polygon points="${cx - HALF_JOINT},${yForearm} ${cx + HALF_JOINT},${yForearm} ${cx + HALF_BUTT * 0.93},${yButt} ${cx - HALF_BUTT * 0.93},${yButt}"/>
  </clipPath>
</defs>
<path d="M ${cx - HALF_TIP} ${TIP} L ${cx - HALF_TIP} 3.4 Q ${cx} -1.4 ${cx + HALF_TIP} 3.4 L ${cx + HALF_TIP} ${TIP} Z" fill="#3d7fd6"/>
${dust}
${slab(yFerrule, yShaft, HALF_TIP, HALF_TIP + 0.25, '#efe9dc')}
<line x1="${cx - HALF_TIP}" y1="${yFerrule}" x2="${cx + HALF_TIP}" y2="${yFerrule}" stroke="#2b2118" stroke-width="0.7"/>
${slab(yShaft, yJoint, HALF_TIP + 0.25, HALF_JOINT, `url(#${id}-maple)`)}
${grain}
${slab(yJoint, yForearm, HALF_JOINT + 0.4, HALF_JOINT + 0.4, `url(#${id}-gold)`)}
${slab(yForearm, yButt, HALF_JOINT, HALF_BUTT * 0.93, '#5a3220')}
<g clip-path="url(#${id}-forearm)">${points.join('')}</g>
${slab(yButt, yBumper, HALF_BUTT * 0.93, HALF_BUTT, `url(#${id}-ebony)`)}
${slab(yButt + 12, yButt + 17, HALF_BUTT * 0.94, HALF_BUTT * 0.945, `url(#${id}-gold)`)}
<circle cx="${cx}" cy="${emblemY}" r="6.2" fill="none" stroke="#d9a441" stroke-width="2.2"/>
<circle cx="${cx}" cy="${emblemY}" r="1.9" fill="#d9a441"/>
<path d="M ${cx - HALF_BUTT} ${yBumper} L ${cx + HALF_BUTT} ${yBumper} L ${cx + HALF_BUTT - 1.5} ${L - 1.5} Q ${cx} ${L + 1} ${cx - HALF_BUTT + 1.5} ${L - 1.5} Z" fill="#0b0b0b"/>
${slab(TIP, yBumper, HALF_TIP, HALF_BUTT, `url(#${id}-round)`)}
</svg>`
}

/** The groove's tick marks: a short one every tenth, a long one at each quarter and the ends. */
export function cueSliderTicksSvg(): string {
  const marks: string[] = []
  for (let i = 0; i <= 10; i++) {
    const quarter = i === 0 || i === 5 || i === 10
    const y = i * 10
    marks.push(`<line x1="${quarter ? 0 : 5}" y1="${y}" x2="11" y2="${y}"/>`)
  }
  // The other two quarters fall between tenths.
  for (const y of [25, 75]) marks.push(`<line x1="0" y1="${y}" x2="11" y2="${y}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1 11 102" preserveAspectRatio="none" aria-hidden="true" focusable="false" stroke="rgba(255,255,255,0.35)" stroke-width="1" vector-effect="non-scaling-stroke">${marks.join('')}</svg>`
}

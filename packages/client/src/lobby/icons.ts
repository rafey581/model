/** Inline SVG icons for the gaming lobby — no icon library. */

function svg(body: string, size = 24): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  )
}

export const ICONS = {
  arrow:
    svg('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  /* Filled so the teeth read as a cog at 20px instead of a starburst. */
  gear:
    `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">` +
    `<path fill-rule="evenodd" clip-rule="evenodd" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z"/>` +
    `</svg>`,
  note: svg(
    '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="16" r="2.2"/>'
  ),
  noteOff: svg(
    '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="16" r="2.2"/>' +
      '<path d="M4 4l16 16"/>'
  ),
  speaker: svg(
    '<path d="M4 10v4h3l4 3V7L7 10H4Z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18.2 7a6 6 0 0 1 0 10"/>'
  ),
  speakerOff: svg(
    '<path d="M4 10v4h3l4 3V7L7 10H4Z"/><path d="M4 4l16 16"/>'
  ),
  fullscreen: svg(
    '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'
  ),
  /* Four arrows collapsing to the middle: the reverse of the corner brackets. */
  fullscreenExit: svg(
    '<path d="M4 4l5.5 5.5"/><path d="M6.5 9.5h3v-3"/>' +
      '<path d="M20 4l-5.5 5.5"/><path d="M17.5 9.5h-3v-3"/>' +
      '<path d="M4 20l5.5-5.5"/><path d="M6.5 14.5h3v3"/>' +
      '<path d="M20 20l-5.5-5.5"/><path d="M17.5 14.5h-3v3"/>'
  ),
  controls: svg(
    '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>'
  ),
  stats: svg('<path d="M4 20h16"/><path d="M7 16V10"/><path d="M12 16V6"/><path d="M17 16v-4"/>'),
  robot: svg(
    '<rect x="5" y="8" width="14" height="10" rx="2"/><path d="M12 4v4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>'
  ),
  online: svg(
    '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 7a3 3 0 0 1 0 6"/><path d="M17.5 14.5a5.5 5.5 0 0 1 3 4.5"/>'
  ),
  rules: svg(
    '<path d="M6 4h9l3 3v13H6Z"/><path d="M15 4v3h3"/><path d="M9 12h6M9 16h6"/>'
  ),
  /* Championship cup: handles, stem and plinth, one stroke weight with the rest. */
  trophy: svg(
    '<path d="M8 4h8v4a4 4 0 0 1-8 0V4Z"/>' +
      '<path d="M8 5.5H5.2v1.6a3.6 3.6 0 0 0 3.1 3.5"/>' +
      '<path d="M16 5.5h2.8V7a3.6 3.6 0 0 1-3.1 3.5"/>' +
      '<path d="M12 12v3.2"/><path d="M10 15.2h4l1 4.4H9l1-4.4Z"/><path d="M8 20.4h8"/>'
  ),
  check: svg('<path d="M5 12.5l4.2 4.2L19 7"/>', 18),
  back: svg('<path d="M15 6l-6 6 6 6"/>')
} as const

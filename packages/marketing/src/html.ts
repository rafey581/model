/** Escape text that is interpolated into HTML attributes or body copy. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** JSON for a script tag. `<` is escaped so the payload cannot close the script. */
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data).replaceAll('<', '\\u003c')
}

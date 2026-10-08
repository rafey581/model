/** Tiny DOM helpers for lobby views (presentation only). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function clear(node: HTMLElement): void {
  node.replaceChildren()
}

/** Headline with the last `amberWords` words tinted amber. */
export function accentHeadline(text: string, amberWords = 2, className = 'gl-headline'): HTMLElement {
  const h = el('h2', className)
  const parts = text.trim().split(/\s+/)
  if (parts.length <= amberWords) {
    h.appendChild(el('span', 'gl-accent', text))
    return h
  }
  const plain = parts.slice(0, -amberWords).join(' ')
  const accent = parts.slice(-amberWords).join(' ')
  h.append(document.createTextNode(plain + ' '), el('span', 'gl-accent', accent))
  return h
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function isFinePointer(): boolean {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

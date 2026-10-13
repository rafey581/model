/**
 * The player avatar, as one component.
 *
 * Phase H1 built this inside the HUD: a circular frame holding either a profile picture
 * or a generated default — a hue-tinted letter for a human, a drawn robot for the bot.
 * It lives here rather than in `hud.ts` because the same avatar is now wanted in three
 * places that have nothing to do with the match HUD: the home screen's identity chip, the
 * practice setup screen's "you vs bot" pairing, and the HUD itself. Three copies of a
 * generated avatar would drift the moment one of them gained a state, so there is one
 * implementation and the HUD imports it like everything else.
 *
 * Nothing here knows about turns, scores or sockets. The HUD layers its turn highlight on
 * top of the frame this returns; every other caller just wants the picture.
 */

export const ROBOT_AVATAR_SVG =
  '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">' +
  '<path d="M16 2.5a1.4 1.4 0 0 1 1.4 1.4v3.2h-2.8V3.9A1.4 1.4 0 0 1 16 2.5Z" fill="#9fd8f2"/>' +
  '<rect x="3.5" y="7.5" width="25" height="18" rx="5" fill="#9fd8f2"/>' +
  '<circle cx="11" cy="15" r="2.6" fill="#14181f"/><circle cx="21" cy="15" r="2.6" fill="#14181f"/>' +
  '<rect x="10" y="20.5" width="12" height="2.4" rx="1.2" fill="#14181f"/>' +
  '</svg>'

/** What an avatar needs to know about whoever it is drawing. */
export interface AvatarSubject {
  name: string
  isBot: boolean
  avatarUrl?: string | null
}

export interface AvatarSlot {
  frame: HTMLElement
  image: HTMLImageElement
  glyph: HTMLElement
  lastUrl: string | null
  lastMode: '' | 'bot' | 'letter'
  lastInitial: string
  lastHue: number
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/** Hides an element without taking it out of the document, so it can come back. */
function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden
}

/**
 * A stable colour per name, so two players on the same table never look like the
 * same avatar. Derived from the name rather than stored, which keeps this free of
 * any per-user state it would have to keep in step with the server.
 */
export function hueForName(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360
  return hash
}

/**
 * An avatar, built once.
 *
 * The real profile picture is a slot rather than a feature: if a caller ever supplies
 * a URL the image is used and the generated default steps aside. Until then the
 * default is a letter for a human and a robot for the bot, both drawn here so no
 * caller needs an image file.
 */
export function createAvatarSlot(options: { frameId?: string; turnKey?: 'you' | 'opponent' } = {}): AvatarSlot {
  const frame = el('div', 'hud-frame')
  if (options.frameId) frame.id = options.frameId
  if (options.turnKey) frame.dataset.hudTurnFrame = options.turnKey

  const image = document.createElement('img')
  image.className = 'hud-avatar-img'
  image.alt = ''
  image.hidden = true

  const glyph = el('div', 'hud-avatar-glyph')
  frame.append(image, glyph)

  return {
    frame,
    image,
    glyph,
    lastUrl: null,
    lastMode: '',
    lastInitial: '',
    lastHue: -1
  }
}

/**
 * Points an avatar slot at whoever it is drawing.
 *
 * Every write is diffed against what is already there, so an unchanged subject costs
 * nothing: this is called on HUD updates, and a player idling on the same opponent
 * must not rewrite an `<img src>` on every state broadcast.
 */
export function updateAvatarSubject(slot: AvatarSlot, subject: AvatarSubject): void {
  const url = subject.avatarUrl
  setHidden(slot.image, !url)
  setHidden(slot.glyph, Boolean(url))
  if (url) {
    if (slot.lastUrl !== url) {
      slot.image.src = url
      slot.lastUrl = url
    }
  } else {
    if (slot.lastUrl !== null) {
      slot.image.removeAttribute('src')
      slot.lastUrl = null
    }
    const mode = subject.isBot ? 'bot' : 'letter'
    if (slot.lastMode !== mode) {
      if (mode === 'bot') slot.glyph.innerHTML = ROBOT_AVATAR_SVG
      else slot.glyph.textContent = ''
      // Lets the stylesheet tint a letter without also tinting the robot.
      slot.glyph.dataset.mode = mode
      slot.lastMode = mode
    }
    if (mode === 'letter') {
      const initial = (subject.name.trim()[0] ?? '?').toUpperCase()
      if (slot.lastInitial !== initial) {
        slot.glyph.textContent = initial
        slot.lastInitial = initial
      }
      const hue = hueForName(subject.name)
      if (slot.lastHue !== hue) {
        slot.glyph.style.setProperty('--avatar-hue', String(hue))
        slot.lastHue = hue
      }
    }
  }
}

/**
 * A finished avatar for a caller that has no further states to apply.
 *
 * The one-shot form of the slot above: the subject is drawn once and the frame is
 * handed back ready to mount. This is what the home screen and the practice setup
 * screen use, where the person in the avatar is fixed for the life of the screen.
 */
export function createAvatarBadge(subject: AvatarSubject, options: { frameId?: string; turnKey?: 'you' | 'opponent' } = {}): HTMLElement {
  const slot = createAvatarSlot(options)
  updateAvatarSubject(slot, subject)
  return slot.frame
}
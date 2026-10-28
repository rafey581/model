/**
 * Announcements from the staff to every player.
 *
 * Shown as a card the player taps away, one at a time, newest first. A card is shown
 * once per player per device: the ids already seen are remembered in local storage.
 * Never on top of a match: anything that arrives mid-match waits for the lobby.
 */

export interface Announcement {
  id: string
  title: string
  body: string
  createdAt: string
}

const SEEN_KEY = 'snooker_seen_announcements'
const SEEN_LIMIT = 200

let queue: Announcement[] = []
let open: HTMLElement | null = null
let userKey = ''

function seenIds(): string[] {
  try {
    const raw = localStorage.getItem(`${SEEN_KEY}:${userKey}`)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function markSeen(id: string): void {
  try {
    const ids = [id, ...seenIds().filter((x) => x !== id)].slice(0, SEEN_LIMIT)
    localStorage.setItem(`${SEEN_KEY}:${userKey}`, JSON.stringify(ids))
  } catch {
    // Private mode or full storage: it may show again next time, which is harmless.
  }
}

/** Starts a session's announcements: what is on show and not yet seen by this player. */
export function setAnnouncements(userId: string, list: Announcement[]): void {
  userKey = userId
  const seen = new Set(seenIds())
  queue = list.filter((a) => !seen.has(a.id))
}

/** A new one, live from the server. Goes to the front of the queue. */
export function receiveAnnouncement(announcement: Announcement): void {
  if (seenIds().includes(announcement.id) || queue.some((a) => a.id === announcement.id)) return
  queue.unshift(announcement)
}

/** Clears everything when the player signs out. */
export function resetAnnouncements(): void {
  queue = []
  open?.remove()
  open = null
  userKey = ''
}

/** Shows the next unseen announcement, if there is one and none is already open. */
export function showNextAnnouncement(): void {
  if (open || queue.length === 0) return
  const next = queue.shift()!
  const backdrop = document.createElement('div')
  backdrop.className = 'announce-backdrop'
  const card = document.createElement('div')
  card.className = 'announce-card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-labelledby', 'announce-title')
  const tag = document.createElement('div')
  tag.className = 'announce-tag'
  tag.textContent = 'ANNOUNCEMENT'
  const title = document.createElement('h2')
  title.id = 'announce-title'
  title.className = 'announce-title'
  title.textContent = next.title
  const body = document.createElement('p')
  body.className = 'announce-body'
  body.textContent = next.body
  const when = document.createElement('div')
  when.className = 'announce-when'
  const date = new Date(next.createdAt)
  when.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
  const ok = document.createElement('button')
  ok.type = 'button'
  ok.className = 'announce-ok'
  ok.textContent = 'OK'
  const close = (): void => {
    markSeen(next.id)
    backdrop.remove()
    open = null
    showNextAnnouncement()
  }
  ok.addEventListener('click', close)
  card.append(tag, title, body, when, ok)
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)
  open = backdrop
  ok.focus()
}

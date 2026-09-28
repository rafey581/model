import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'

export const API_BASE = '/api'

interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

/** A zod `.flatten()` result, which is a nested object rather than a sentence. */
interface FlattenedValidation {
  formErrors?: string[]
  fieldErrors?: Record<string, string[] | undefined>
}

function isFlattenedValidation(value: unknown): value is FlattenedValidation {
  return typeof value === 'object' && value !== null && ('formErrors' in value || 'fieldErrors' in value)
}

/**
 * Turns a validation payload into one sentence the player can act on. The server
 * hands back `parsed.error.flatten()`, so without this the toast reads
 * "[object Object]".
 */
function describeValidation(error: FlattenedValidation): string {
  const parts: string[] = [...(error.formErrors ?? [])]
  for (const [field, messages] of Object.entries(error.fieldErrors ?? {})) {
    for (const message of messages ?? []) parts.push(`${field}: ${message}`)
  }
  return parts.length > 0 ? parts.join('; ') : 'please check the details you entered'
}

/** Human wording for the status codes the auth and game routes actually return. */
function statusMessage(status: number): string {
  if (status === 409) return 'That email or username is already registered. Try logging in instead.'
  if (status === 401) return 'Your session has expired. Please log in again.'
  if (status === 403) return 'That account is not allowed to do this.'
  if (status === 404) return 'That could not be found.'
  if (status === 429) return 'Too many attempts. Please wait a moment and try again.'
  if (status >= 500) return 'The server had a problem. Please try again.'
  return 'request failed'
}

/**
 * Wording that replaces the server's own message, for the statuses where the server
 * reports a database constraint in words a player can do nothing with.
 *
 * The server checks for a duplicate with a query against the unique email and username
 * columns and answers `email or username already taken`, which reads like a storage
 * error rather than an instruction. This status is safe to speak for unconditionally:
 * it is raised only by registration, and unlike a 401 the right wording does not
 * depend on whether the player was logging in or playing.
 */
const serverErrorWording: Record<number, string> = {
  409: 'That email or username is already registered. Try logging in instead.'
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })

  // A failed request does not always come back as JSON. A proxy or gateway can
  // answer with an HTML error page, and a dropped connection can answer with no
  // body at all, so reading the body defensively keeps the player on a real
  // message instead of a raw "Unexpected end of JSON input" parse error.
  let json: ApiResponse<T> | null = null
  try {
    json = (await response.json()) as ApiResponse<T>
  } catch {
    json = null
  }

  if (!response.ok || !json?.ok) {
    const serverError = json?.error
    // Field-level validation is the most specific thing the server can say, so it is
    // asked first. After that, a status we have better wording for wins over the
    // server's own phrasing, and only then does the server's string get used.
    if (isFlattenedValidation(serverError)) throw new Error(describeValidation(serverError))
    const spoken = serverErrorWording[response.status]
    if (spoken) throw new Error(spoken)
    if (typeof serverError === 'string' && serverError.length > 0) throw new Error(serverError)
    throw new Error(statusMessage(response.status))
  }
  return json.data as T
}

let socket: Socket | null = null

export function connectSocket(token: string): Socket {
  socket?.disconnect()
  socket = io('/', {
    auth: { token },
    transports: ['websocket']
  })
  return socket
}

export function getSocket(): Socket {
  if (!socket) throw new Error('socket not connected')
  return socket
}

export interface ToastFn {
  (message: string, kind?: 'info' | 'error'): void
}

export function makeToast(container: HTMLElement): ToastFn {
  let live = document.getElementById('toast-live')
  if (!live) {
    live = document.createElement('div')
    live.id = 'toast-live'
    live.setAttribute('aria-live', 'polite')
    live.setAttribute('aria-atomic', 'false')
    live.style.position = 'fixed'
    live.style.top = '0'
    live.style.left = '0'
    live.style.width = '1px'
    live.style.height = '1px'
    live.style.overflow = 'hidden'
    live.style.whiteSpace = 'nowrap'
    document.body.appendChild(live)
  }
  return (message: string, kind: 'info' | 'error' = 'info') => {
    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.textContent = message
    if (kind === 'error') toast.style.borderLeftColor = 'var(--danger)'
    container.appendChild(toast)
    const tick = document.createElement('span')
    tick.textContent = message
    live.appendChild(tick)
    setTimeout(() => toast.remove(), 3500)
    setTimeout(() => tick.remove(), 3500)
  }
}

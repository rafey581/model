import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'

export const API_BASE = '/api'

interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })
  const json = (await response.json()) as ApiResponse<T>
  if (!response.ok || !json.ok) {
    throw new Error(json.error ?? 'request failed')
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
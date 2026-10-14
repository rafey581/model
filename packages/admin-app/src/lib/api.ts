import { apiBaseUrl } from './config'

/**
 * The admin API client.
 *
 * Every admin route answers with an envelope - `{ ok, data }` or `{ ok, error }` -
 * and every one of them is gated by the same revocable admin session. The token is
 * injected by the auth provider through `setTokenProvider`, so this module never
 * has to know where the credential is stored, and can be exercised without a
 * device or a store.
 */

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type TokenProvider = () => Promise<string | null>

let tokenProvider: TokenProvider = async () => null

export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider
}

interface Envelope<T> {
  ok?: boolean
  data?: T
  error?: string
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Your admin session has expired. Please sign in again.'
  if (status === 403) return 'This account is not allowed to do that.'
  if (status === 404) return 'Not found.'
  if (status === 429) return 'Too many attempts. Wait a moment and try again.'
  if (status >= 500) return `The server had a problem (${status}).`
  return `Request failed (${status}).`
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = await tokenProvider()
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    })
  } catch {
    throw new ApiError(0, `Cannot reach the server at ${apiBaseUrl()}. Check the connection.`)
  }

  const text = await response.text()
  let envelope: Envelope<T> | null = null
  try {
    envelope = text ? (JSON.parse(text) as Envelope<T>) : null
  } catch {
    envelope = null
  }

  if (!response.ok || (envelope && envelope.ok === false)) {
    throw new ApiError(response.status, envelope?.error ?? defaultMessage(response.status))
  }
  if (envelope && typeof envelope === 'object' && 'data' in envelope) return envelope.data as T
  return undefined as T
}

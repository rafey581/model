/** The signed-in player as the server reports it. */
export interface SessionUser {
  id: string
  username: string
  role: string
  status: string
  authProvider?: string
}

/** True when a request never reached the server. A refused request is not unreachable. */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network request failed') ||
    message.includes('load failed')
  )
}

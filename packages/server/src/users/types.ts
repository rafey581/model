export interface PublicUser {
  id: string
  /**
   * Nullable because a seeded or internal account may predate the signup form and
   * have no email on file. Serialised as `null` rather than omitted so the client
   * shape is stable.
   */
  email: string | null
  username: string
  role: string
  status: string
  /** How this account authenticates. Local accounts are PASSWORD. */
  authProvider?: string
}

export function toPublicUser(user: {
  id: string
  email: string | null
  username: string
  role: string
  status: string
  authProvider?: string
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    status: user.status,
    ...(user.authProvider ? { authProvider: user.authProvider } : {})
  }
}

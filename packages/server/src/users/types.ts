export interface PublicUser {
  id: string
  /**
   * Nullable: a wallet-only provider (Phantom) has no email at all, and Google
   * accounts can in principle arrive without one. Serialised as `null` rather than
   * omitted so the client shape is stable.
   */
  email: string | null
  username: string
  role: string
  status: string
  /** How this account authenticates: PASSWORD | GOOGLE | PHANTOM | BINANCE. */
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

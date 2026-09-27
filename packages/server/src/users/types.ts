export interface PublicUser {
  id: string
  email: string
  username: string
  role: string
  status: string
}

export function toPublicUser(user: { id: string; email: string; username: string; role: string; status: string }): PublicUser {
  return { id: user.id, email: user.email, username: user.username, role: user.role, status: user.status }
}
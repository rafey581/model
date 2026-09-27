import { prisma } from '../db/index.js'

export interface NotificationData {
  id: string
  kind: string
  title: string
  body: string | null
  read: boolean
  createdAt: Date
}

let push: ((userId: string, notification: NotificationData) => void) | null = null

export function setNotificationPusher(fn: ((userId: string, notification: NotificationData) => void) | null): void {
  push = fn
}

export async function notify(userId: string, kind: string, title: string, body?: string): Promise<void> {
  const notification = await prisma.notification.create({
    data: { userId, kind, title, body: body ?? null }
  })
  push?.(userId, notification)
}
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { requireAdminSession } from '../admin/auth.js'
import { isExpoPushToken, pushToAdmins } from './adminPush.js'

const deviceSchema = z.object({
  token: z.string().trim().max(200).refine(isExpoPushToken, 'not an Expo push token'),
  platform: z.enum(['android', 'ios']).default('android')
})
const removeSchema = z.object({ token: z.string().trim().max(200) })

/**
 * Staff phones for push alerts. Same gating as the rest of the admin API: public at
 * the player-auth hook, guarded by the revocable admin session.
 */
export async function registerAdminDeviceRoutes(app: FastifyInstance): Promise<void> {
  const guarded = { config: { public: true, admin: true }, preHandler: requireAdminSession }

  /** Registers (or re-assigns) this phone to the signed-in staff member. Idempotent. */
  app.post('/api/admin/devices', guarded, async (request, reply) => {
    const parsed = deviceSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'invalid device' })
    const { token, platform } = parsed.data
    // A token belongs to one phone; if another staff member signed in on it, it moves.
    await prisma.adminDevice.upsert({
      where: { token },
      create: { token, platform, userId: request.authUser!.id },
      update: { platform, userId: request.authUser!.id, lastSeenAt: new Date() }
    })
    return reply.send({ ok: true, data: { registered: true } })
  })

  /** Forgets this phone (sign-out), so it stops ringing for an account no longer on it. */
  app.delete('/api/admin/devices', guarded, async (request, reply) => {
    const parsed = removeSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid device' })
    await prisma.adminDevice.deleteMany({ where: { token: parsed.data.token, userId: request.authUser!.id } })
    return reply.send({ ok: true, data: { removed: true } })
  })

  /** Rings the caller's own phones once, to check alerts work end to end. */
  app.post('/api/admin/devices/test', guarded, async (request, reply) => {
    const count = await prisma.adminDevice.count({ where: { userId: request.authUser!.id } })
    if (count === 0) return reply.code(400).send({ ok: false, error: 'no phone registered for this account yet' })
    const accepted = await pushToAdmins(
      { title: 'Test alert', body: 'This is how a new deposit or withdrawal will ring.', href: '/', kind: 'TEST', ring: true },
      (msg, err) => request.log.warn({ err }, msg),
      request.authUser!.id
    )
    return reply.send({ ok: true, data: { devices: count, accepted } })
  })
}

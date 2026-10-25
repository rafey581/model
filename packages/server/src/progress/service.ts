import { prisma } from '../db/index.js'

const XP_PER_WIN = 50
const XP_PER_LOSS = 20
const XP_PER_PRACTICE = 10

function xpForLevel(level: number): number {
  // Progressive XP requirement
  return Math.floor(100 * Math.pow(level, 1.5))
}

export async function awardMatchXp(userId: string, won: boolean, isPractice: boolean): Promise<{ levelUp: boolean; newLevel: number; xp: number } | null> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { level: true, xp: true } })
    if (!user) return null

    let gained = 0
    if (isPractice) gained = XP_PER_PRACTICE
    else gained = won ? XP_PER_WIN : XP_PER_LOSS

    let newXp = user.xp + gained
    let newLevel = user.level
    let levelUp = false

    // Level up while enough XP
    while (newXp >= xpForLevel(newLevel)) {
      newXp -= xpForLevel(newLevel)
      newLevel += 1
      levelUp = true
    }

    await prisma.user.update({
      where: { id: userId },
      data: { xp: newXp, level: newLevel }
    })

    return { levelUp, newLevel, xp: newXp }
  } catch {
    return null
  }
}

export async function getUserProgress(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      level: true,
      xp: true,
      badges: {
        include: { badge: true },
        orderBy: { earnedAt: 'desc' }
      }
    }
  })
  if (!user) return null
  const nextXp = xpForLevel(user.level)
  return {
    level: user.level,
    xp: user.xp,
    nextXp,
    progress: Math.min(100, Math.floor((user.xp / nextXp) * 100)),
    badges: user.badges
  }
}

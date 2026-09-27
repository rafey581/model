import { startServer } from './app.js'
import { prisma } from './db/index.js'

async function main(): Promise<void> {
  const { app } = await startServer()
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    const watchdog = setTimeout(() => {
      app.log.warn({ signal }, 'forced exit after timeout')
      process.exit(1)
    }, 10000)
    watchdog.unref()
    await app.close()
    await prisma.$disconnect()
    clearTimeout(watchdog)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('failed to start server', error)
  process.exit(1)
})
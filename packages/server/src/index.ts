import { startServer } from './app.js'

async function main(): Promise<void> {
  const { app } = await startServer()
  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`)
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('failed to start server', error)
  process.exit(1)
})
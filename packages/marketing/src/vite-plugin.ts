import type { Plugin } from 'vite'
import { loadSiteConfig } from './load-config'
import { applyDocument, pageFromFilename, robotsTxt, sitemapXml } from './render'
import { publicConfigJson } from './site-config'

/** Injects crawlable HTML and writes robots, sitemap, and site-config.json. */
export function sitePlugin(): Plugin {
  const config = loadSiteConfig()
  return {
    name: 'snooker-site',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const page = pageFromFilename(ctx.filename, ctx.path)
        return applyDocument(html, page, config)
      }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'site-config.json', source: publicConfigJson(config) })
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt(config) })
      const map = sitemapXml(config)
      if (map) this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: map })
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (path === '/site-config.json') {
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-cache')
          res.end(publicConfigJson(config))
          return
        }
        if (path === '/robots.txt') {
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(robotsTxt(config))
          return
        }
        if (path === '/sitemap.xml') {
          const map = sitemapXml(config)
          if (!map) {
            res.statusCode = 404
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('No sitemap until siteUrl is configured.\n')
            return
          }
          res.setHeader('content-type', 'application/xml; charset=utf-8')
          res.end(map)
          return
        }
        next()
      })
    }
  }
}

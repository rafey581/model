# Snooker Stake marketing site

Static download page for the Android **player** app (`com.snookerx.game`). It does not talk to the game server, does not start matches, and does not offer deposits, withdrawals, or cash prizes. Deploy the `dist/` folder on its own. Do not use it as a reason to restart or change the live API.

## Build

From the monorepo root:

```bash
pnpm install
pnpm --filter @snooker/marketing test
pnpm --filter @snooker/marketing build
```

Output is `packages/marketing/dist/`. Preview it with:

```bash
pnpm --filter @snooker/marketing preview
```

Host those files at the **site root** (the page requests `/site-config.json`, `/og.png`, and the rest by absolute path). Any static host is enough: object storage with a CDN, Cloudflare Pages, Netlify, nginx, or GitHub Pages. Serve `index.html` for `/`. Put HTTPS in front of the domain before you tell anyone the address.

Cache hashed files under `assets/` for a long time. Revalidate `index.html`, `robots.txt`, `sitemap.xml`, and `site-config.json` (or keep a short cache on the JSON if you plan to replace it without a rebuild).

## The two settings

Both live in `packages/marketing/site.config.json`:

| Key | Meaning |
| --- | --- |
| `siteUrl` | Public origin only, `https://your.domain` with no path, query, or hash. |
| `apkUrl` | https URL whose path ends in `.apk`. The player build for `com.snookerx.game`. |

Blank strings are the shipped default. A blank `apkUrl` is the honest “download not published yet” state: there is no file button and no made-up size or version. A blank `siteUrl` builds a page with `noindex`, and **without** a canonical link, Open Graph image URL, or sitemap, so a preview host is not submitted as the real site.

Build-time environment variables override the file when they are set:

- `SNOOKER_SITE_URL`
- `SNOOKER_APK_URL`

An invalid value fails the build. Localhost, IP addresses, and `example.com` / `example.org` / `example.net` are rejected. A URL that looks like the staff app (`snookerarena`, `admin-app`, `snooker-admin`) is rejected so the player page cannot link `com.snookerarena.admin`.

After a successful build, the same two keys are written to `dist/site-config.json`. The page fetches that file and updates the download buttons. Replacing **only** that JSON on the server changes the button for visitors with JavaScript. Crawlers, no-JavaScript visitors, the canonical link, the sitemap, and the structured-data `installUrl` still come from the HTML, so **rebuild and upload `dist/`** after either value changes if the public page should match.

## Publishing the APK

1. Build and sign a **release** APK of `packages/client` (package `com.snookerx.game`). Do not upload the staff / admin app.
2. Put the file on an https host. The path must end in `.apk` (a signed query string after that is fine).
3. Set `apkUrl` to that address and rebuild.
4. This site does not claim a Play Store listing, a file size, a version, or a malware scan. Android will ask the player to allow installs from the browser. That is their setting, not a review by this page.

There is no APK URL in the repo today. Leave `apkUrl` empty until a real file exists.

## Turning search on

Buying a domain does nothing until this build knows the origin.

1. Point DNS at the static host and serve the site over HTTPS.
2. Set `siteUrl` to that origin only, such as `https://play.yourdomain`. `example.com`, `example.org`, `example.net`, localhost, and bare IP addresses are rejected on purpose.
3. Rebuild and upload `dist/`.

That build removes `noindex`, writes `<link rel="canonical">`, absolute Open Graph and Twitter image tags (`/og.png`), `robots.txt` with a `Sitemap:` line, and `sitemap.xml` for the homepage only. Structured data is the app name, Android, a short feature list, and the FAQ text already on the page. It does not include ratings, review counts, install counts, prices, or awards.

Do not point the canonical at a temporary preview host.

## What the 3D view does

The table is drawn in the browser with three.js and is not required to read the page. The HTML already contains the copy. The scene is skipped when WebGL is missing, when the visitor uses data-saver, when `navigator.deviceMemory` is 2 GB or less, or when the URL has `?static=1`. `prefers-reduced-motion` still draws one frame and does not animate it. The loop pauses while the tab is hidden or the table is off screen. The canvas does not receive taps, so the page scrolls normally.

Rails use the birch and pocket-leather textures from the player client (`public/textures/`).

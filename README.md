# Snooker Platform

Online multiplayer snooker gaming platform. Real-time 1v1 matches, 8-player
knockout tournaments and free robot-AI practice, backed by a server-authoritative
deterministic physics + rules engine and a ledger-based wallet.

> All balances are currently **virtual credits**. Real-money / crypto settlement is
> a separate module that stays disabled until legal & licensing setup is complete.

See also:
- `development_plan.md` — full technical specification
- `product_showcase_client_review.md` — client-facing product overview

## Structure

```
packages/
  shared/   deterministic physics + snooker rules engine (shared by server & client)
  server/   Node.js API, Socket.IO game server, wallet/settlement, admin
  client/   Vite browser app (game renderer + UI)
```

## Quick Start

```bash
pnpm install
pnpm db:up            # starts postgres + redis (docker compose)
cp .env.example .env
pnpm db:migrate
pnpm dev              # runs server + client in watch mode
```

- Client: http://localhost:5173
- Server: http://localhost:4000

## Useful Scripts

```bash
pnpm test          # run all tests (physics, rules, services)
pnpm typecheck     # typecheck all packages
pnpm build         # build all packages
```

## Environment Variables

See `.env.example`. Never commit real secrets.

## License / Compliance

Real-money wagering is regulated activity. The crypto/real-money module is
built but disabled (`REAL_MONEY_ENABLED=false`) and must not be enabled without
licensed legal setup in the target jurisdiction.
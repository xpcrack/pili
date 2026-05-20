## Runtime Setup

Use Node `24.11.1` for this repo.

```bash
nvm use
npm install
```

If you see `better-sqlite3` or `NODE_MODULE_VERSION` errors after changing Node versions, switch back to Node `24.11.1` and run:

```bash
npm rebuild better-sqlite3
```

## Runtime Modes

Normal daily usage should stay in pm2-managed production web mode, not `next dev`. `npm run build` and `npm run start` are the underlying local equivalent / fallback when you need to run the production web runtime without pm2.

```bash
npm run build
npm run start
```

This repo also includes pm2-oriented runtime helpers:

```bash
npm run runtime:status
npm run runtime:dev:on
npm run runtime:dev:off
```

`npm run runtime:dev:on` switches the web process into development mode for code changes.

`npm run runtime:dev:off` switches the web process back to production mode and runs a fresh production build first.

Background workers normally stay running during web-mode switches.

Production and development reuse the same `.env.local`, `.data`, and SQLite DB. Do not create a separate dev DB unless you explicitly want one.

If you are actively editing code without pm2, `npm run dev` still works locally at [http://localhost:3005](http://localhost:3005).

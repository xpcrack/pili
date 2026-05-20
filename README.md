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

Normal daily usage should stay in pm2-managed production web steady state.

Core runtime commands:

```bash
npm run runtime:status
npm run runtime:refresh
```

`runtime:refresh` runs `npm run build` first, then refresh only rebuilds and replaces the production web process `pili-web-prod`.

`npm run build` and `npm run start` are the underlying local equivalent / fallback when you need to run production web without pm2.

Background workers are not restarted in the refresh flow; workers are intentionally left running during refresh.

Production and refresh reuse the same `.env.local`, `.data`, and SQLite DB.

If needed, local fallback commands are still available:

```bash
npm run build
npm run start
npm run dev
```

If you are actively editing code without pm2, `npm run dev` still works locally at [http://localhost:3005](http://localhost:3005).

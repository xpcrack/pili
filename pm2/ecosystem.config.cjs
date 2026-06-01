const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'pili-web-prod',
      cwd: repoRoot,
      script: `${process.env.HOME}/.bun/bin/bun`,
      args: ['server/runtime.ts', 'prod'],
      env: {
        NODE_ENV: 'production',
        PORT: '3013',
        PILIPILI_EMBED_TELEGRAM_TASKS: 'false',
        NODE_OPTIONS: '--use-env-proxy',
        HTTP_PROXY: 'http://127.0.0.1:7897',
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        ALL_PROXY: 'http://127.0.0.1:7897',
        NO_PROXY: '127.0.0.1,localhost,::1',
      },
      autorestart: true,
      kill_timeout: 10000,
      max_memory_restart: '1200M',
    },
    {
      name: 'pili-web-dev',
      cwd: repoRoot,
      script: 'bash',
      args: ['-lc', 'npm run dev'],
      env: {
        NODE_ENV: 'development',
        PORT: '3005',
        PILIPILI_EMBED_TELEGRAM_TASKS: 'false',
      },
      autorestart: true,
      kill_timeout: 10000,
    },
  ],
};

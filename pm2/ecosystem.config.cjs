const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'pili-web-prod',
      cwd: repoRoot,
      script: 'bash',
      args: ['-lc', 'npm run start'],
      env: { NODE_ENV: 'production' },
      autorestart: true,
      kill_timeout: 10000,
    },
    {
      name: 'pili-web-dev',
      cwd: repoRoot,
      script: 'bash',
      args: ['-lc', 'npm run dev'],
      env: { NODE_ENV: 'development' },
      autorestart: true,
      kill_timeout: 10000,
    },
    {
      name: 'pili-telegram-channel-worker',
      cwd: repoRoot,
      script: 'bash',
      args: ['-lc', 'npm run telegram:channel:worker'],
      env: { NODE_ENV: 'production' },
      autorestart: true,
      kill_timeout: 10000,
      max_memory_restart: '1200M',
      exp_backoff_restart_delay: 200,
    },
    {
      name: 'pili-completeness-worker',
      cwd: repoRoot,
      script: 'bash',
      args: ['-lc', 'npm run completeness:worker'],
      env: { NODE_ENV: 'production' },
      autorestart: true,
      kill_timeout: 10000,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 200,
    },
  ],
};

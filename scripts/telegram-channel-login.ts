import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

function readTelegramSocksProxy() {
  const raw = (process.env.TELEGRAM_MTPROTO_PROXY || process.env.TELEGRAM_PROXY || '').trim();
  if (!raw) return undefined;
  const fallbackUrl = raw.includes('://') ? raw : `socks5://${raw}`;
  const url = new URL(fallbackUrl);
  const port = Number.parseInt(url.port || '', 10);
  if (!/^socks[45]:$/.test(url.protocol) || !url.hostname || !Number.isSafeInteger(port) || port <= 0) {
    throw new Error('Invalid TELEGRAM_MTPROTO_PROXY/TELEGRAM_PROXY. Use socks5://127.0.0.1:7897');
  }
  const socksType: 4 | 5 = url.protocol === 'socks4:' ? 4 : 5;
  return {
    ip: url.hostname,
    port,
    socksType,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    timeout: 10,
  };
}

async function run() {
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = (process.env.TELEGRAM_API_HASH || '').trim();
  if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
    throw new Error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env.local');
  }

  const rl = readline.createInterface({ input, output });
  try {
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
    });

    await client.start({
      phoneNumber: async () => (await rl.question('Telegram phone number: ')).trim(),
      password: async () => (await rl.question('Two-factor password (leave blank if none): ')).trim(),
      phoneCode: async () => (await rl.question('Login code: ')).trim(),
      onError: (error) => {
        console.error('[telegram-channel-login] auth error:', error);
      },
    });

    console.log('\nTELEGRAM_SESSION_STRING=');
    console.log(client.session.save());
    console.log('\nAdd this to .env.local as TELEGRAM_SESSION_STRING and restart your sync script.');
    await client.disconnect();
  } finally {
    rl.close();
  }
}

void run().catch((error) => {
  console.error('[telegram-channel-login] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

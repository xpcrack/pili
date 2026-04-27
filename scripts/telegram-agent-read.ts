import path from 'node:path';

import { runTelegramAgentRead } from '@/lib/server/telegramAgentReadService';

import { loadEnvFile } from './telegram-bridge-core';

type CliResult = Awaited<ReturnType<typeof runTelegramAgentRead>>;

function readFlag(argv: string[], flag: string) {
  const inlinePrefix = `${flag}=`;
  const inline = argv.find((entry) => entry.startsWith(inlinePrefix));
  if (inline) {
    return inline.slice(inlinePrefix.length);
  }

  const index = argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return typeof value === 'string' ? value : null;
}

function printResult(result: CliResult) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function run() {
  loadEnvFile(path.join(process.cwd(), '.env.local'));

  const argv = process.argv.slice(2);
  const modeArg = (argv[0] || '').trim();
  if (modeArg !== 'tail' && modeArg !== 'search') {
    const result: CliResult = { ok: false, error: 'telegram_chat_unavailable' };
    printResult(result);
    process.exit(1);
    return;
  }

  const chatId = (readFlag(argv, '--chat-id') || '').trim();
  const token = (readFlag(argv, '--token') || '').trim();
  const query = readFlag(argv, '--query');
  const limitText = (readFlag(argv, '--limit') || '').trim();
  const parsedLimit = limitText ? Number.parseInt(limitText, 10) : undefined;

  const result = await runTelegramAgentRead({
    mode: modeArg,
    chatId,
    token,
    query,
    limit: parsedLimit,
  });

  printResult(result);
  process.exit(result.ok ? 0 : 1);
}

void run().catch(() => {
  printResult({ ok: false, error: 'telegram_auth_unavailable' });
  process.exit(1);
});

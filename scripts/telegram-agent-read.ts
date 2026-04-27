import path from 'node:path';

import { runTelegramAgentRead } from '@/lib/server/telegramAgentReadService';

import { loadEnvFile } from './telegram-bridge-core';

type CliLocalError = 'invalid_arguments' | 'internal_error';
type CliResult = Awaited<ReturnType<typeof runTelegramAgentRead>> | { ok: false; error: CliLocalError };

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
  if (typeof value !== 'string') {
    return null;
  }
  if (value.trim().startsWith('--')) {
    return null;
  }
  return value;
}

function printResult(result: CliResult) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function run() {
  loadEnvFile(path.join(process.cwd(), '.env.local'));

  const argv = process.argv.slice(2);
  const modeArg = (argv[0] || '').trim();
  if (modeArg !== 'tail' && modeArg !== 'search') {
    const result: CliResult = { ok: false, error: 'invalid_arguments' };
    printResult(result);
    process.exit(1);
    return;
  }

  const chatId = (readFlag(argv, '--chat-id') || '').trim();
  const token = (readFlag(argv, '--token') || '').trim();
  const query = readFlag(argv, '--query');
  const limitText = (readFlag(argv, '--limit') || '').trim();
  if (limitText && !/^-?\d+$/.test(limitText)) {
    const result: CliResult = { ok: false, error: 'invalid_arguments' };
    printResult(result);
    process.exit(1);
    return;
  }
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
  printResult({ ok: false, error: 'internal_error' });
  process.exit(1);
});

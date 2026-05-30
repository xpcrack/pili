import type { DefaultRuntimeTaskOptions } from './types';

export function resolveDefaultRuntimeTaskOptions(input: {
  mode: 'live' | 'prod';
  env?: Record<string, string | undefined>;
}): DefaultRuntimeTaskOptions {
  const env = input.env ?? process.env;
  const explicit = env.PILIPILI_EMBED_TELEGRAM_TASKS?.trim().toLowerCase();
  if (explicit === 'true') {
    return { embedTelegramTasks: true };
  }
  if (explicit === 'false') {
    return { embedTelegramTasks: false };
  }

  return {
    embedTelegramTasks: input.mode !== 'prod',
  };
}

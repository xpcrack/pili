import 'server-only';

import crypto from 'node:crypto';

export function generateTelegramAgentToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashTelegramAgentToken(token: string) {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

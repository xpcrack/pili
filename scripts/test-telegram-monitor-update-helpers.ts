import assert from 'node:assert/strict';

import type { TelegramUpdateLike } from '../lib/server/telegramMonitorUpdateHelpers';
import {
  collectTelegramMessageLinks,
  extractTelegramMessage,
  extractTelegramMessageText,
} from '../lib/server/telegramMonitorUpdateHelpers';

const update = {
  update_id: 7,
  message: {
    message_id: 9,
    text: 'message text',
    caption: 'caption text',
    entities: [{ type: 'text_link', url: 'https://xxyy.io/message' }],
    reply_markup: { inline_keyboard: [[{ url: 'https://scan.example/tx' }]] },
  },
  channel_post: { message_id: 10, text: 'channel text' },
} satisfies TelegramUpdateLike;

assert.equal(extractTelegramMessage(update)?.message_id, 9);
assert.equal(extractTelegramMessageText(update.message!), 'message text');
assert.deepEqual(collectTelegramMessageLinks(update.message!), [
  'https://xxyy.io/message',
  'https://scan.example/tx',
]);
assert.equal(extractTelegramMessage({ edited_message: { caption: 'caption only' } })?.caption, 'caption only');
assert.equal(extractTelegramMessageText({ text: '   ', caption: 'caption fallback' }), 'caption fallback');

console.log('telegram monitor update helper tests: ok');

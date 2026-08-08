import 'server-only';

export interface TelegramMessageEntityLike {
  type?: string;
  url?: string;
}

export interface TelegramInlineKeyboardButtonLike {
  text?: string;
  url?: string;
}

export interface TelegramMessageLike {
  message_id?: number;
  date?: number;
  chat?: {
    id?: number | string;
  };
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntityLike[];
  caption_entities?: TelegramMessageEntityLike[];
  reply_markup?: {
    inline_keyboard?: TelegramInlineKeyboardButtonLike[][];
  };
}

export interface TelegramUpdateLike {
  update_id?: number;
  message?: TelegramMessageLike;
  channel_post?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  edited_channel_post?: TelegramMessageLike;
}

export function extractTelegramMessage(update: TelegramUpdateLike) {
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
}

export function extractTelegramMessageText(message: TelegramMessageLike) {
  return (
    (typeof message.text === 'string' && message.text.trim()) ||
    (typeof message.caption === 'string' && message.caption.trim()) ||
    ''
  );
}

export function collectTelegramMessageLinks(message: TelegramMessageLike) {
  const links = new Set<string>();
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];

  for (const entity of entities) {
    if (entity.type === 'text_link' && typeof entity.url === 'string' && entity.url.trim()) {
      links.add(entity.url.trim());
    }
  }

  for (const row of message.reply_markup?.inline_keyboard || []) {
    for (const button of row || []) {
      if (typeof button?.url === 'string' && button.url.trim()) {
        links.add(button.url.trim());
      }
    }
  }

  return Array.from(links);
}

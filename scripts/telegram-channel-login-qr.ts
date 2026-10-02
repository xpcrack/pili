/**
 * 用另一台已登录的 Telegram 扫码换新 session。
 * 不需要手机号，也不需要短信。开了两步验证时，扫完再填云密码。
 *
 *   npx tsx scripts/telegram-channel-login-qr.ts
 *
 * 成功后写入 .env.local 的 TELEGRAM_SESSION_STRING，并重启 pili-telegram-channel-worker。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

const QR_PNG = '/tmp/pilipili-tg-login.png';

function readTelegramSocksProxy() {
  const raw = (process.env.TELEGRAM_MTPROTO_PROXY || process.env.TELEGRAM_PROXY || '').trim();
  if (!raw) return undefined;
  const fallbackUrl = raw.includes('://') ? raw : `socks5://${raw}`;
  const url = new URL(fallbackUrl);
  const port = Number.parseInt(url.port || '', 10);
  if (!/^socks[45]:$/.test(url.protocol) || !url.hostname || !Number.isSafeInteger(port) || port <= 0) {
    throw new Error('Invalid TELEGRAM_MTPROTO_PROXY. Use socks5://127.0.0.1:7897');
  }
  return {
    ip: url.hostname,
    port,
    socksType: (url.protocol === 'socks4:' ? 4 : 5) as 4 | 5,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    timeout: 10,
  };
}

const SWIFT_QR = `
import CoreImage
import AppKit
import Foundation

let text = ProcessInfo.processInfo.environment["TG_QR_URL"] ?? ""
guard let data = text.data(using: .utf8), !data.isEmpty else { fputs("empty url\\n", stderr); exit(1) }
guard let filter = CIFilter(name: "CIQRCodeGenerator") else { exit(1) }
filter.setValue(data, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let output = filter.outputImage else { exit(1) }
let scale = 8
let scaled = output.transformed(by: CGAffineTransform(scaleX: CGFloat(scale), y: CGFloat(scale)))
let rep = NSBitmapImageRep(ciImage: scaled)
let modules = rep.pixelsWide / scale
let margin = 2
func dark(_ mx: Int, _ my: Int) -> Bool {
  guard mx >= 0, my >= 0, mx < modules, my < modules else { return false }
  guard let c = rep.colorAt(x: mx * scale + scale / 2, y: my * scale + scale / 2) else { return false }
  return c.redComponent < 0.5
}
for y in -margin..<(modules + margin) {
  var line = ""
  for x in -margin..<(modules + margin) {
    line += dark(x, y) ? "██" : "  "
  }
  print(line)
}
if let png = rep.representation(using: .png, properties: [:]) {
  try? png.write(to: URL(fileURLWithPath: "${QR_PNG}"))
}
`;

let openedPng = false;

function showQr(url: string) {
  const rendered = spawnSync('swift', ['-'], {
    input: SWIFT_QR,
    env: { ...process.env, TG_QR_URL: url },
    encoding: 'utf8',
  });
  process.stdout.write('\x1B[2J\x1B[H');
  console.log('另一台手机：Telegram → 设置 → 设备 → 连接桌面设备，扫下面这个码（30 秒刷新一次）');
  console.log(`打不开终端的话，直接看图片 ${QR_PNG}`);
  if (rendered.stdout) process.stdout.write(rendered.stdout);
  if (rendered.status !== 0) {
    console.log(url);
    if (rendered.stderr) console.error(rendered.stderr);
  }
  if (!openedPng) {
    openedPng = true;
    spawnSync('open', [QR_PNG]);
  }
}

function writeSession(session: string) {
  const envPath = path.join(process.cwd(), '.env.local');
  const raw = readFileSync(envPath, 'utf8');
  if (!/^TELEGRAM_SESSION_STRING=/m.test(raw)) {
    throw new Error('TELEGRAM_SESSION_STRING not found in .env.local');
  }
  const next = raw.replace(/^TELEGRAM_SESSION_STRING=.*$/m, `TELEGRAM_SESSION_STRING=${session}`);
  if (next === raw) {
    throw new Error('failed to replace TELEGRAM_SESSION_STRING');
  }
  writeFileSync(envPath, next);
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
      proxy: readTelegramSocksProxy(),
    });
    await client.connect();

    await client.signInUserWithQrCode(
      { apiId, apiHash },
      {
        qrCode: async (code) => {
          const token = Buffer.from(code.token).toString('base64url');
          showQr(`tg://login?token=${token}`);
        },
        password: async (hint?: string) => {
          const label = hint ? `两步验证密码（提示: ${hint}，不是短信验证码）: ` : '两步验证密码（不是短信验证码）: ';
          return (await rl.question(label)).trim();
        },
        onError: async (error) => {
          console.error('[telegram-channel-login-qr]', error.message);
          return false;
        },
      }
    );

    const saved = String((client.session as unknown as { save: () => string }).save() || '');
    if (saved.length < 20) {
      throw new Error('Telegram 没返回可用的 session');
    }
    writeSession(saved);
    await client.disconnect();
    console.log(`\n新 session 已写入 .env.local（${saved.slice(0, 4)}…${saved.slice(-4)}），旧的不再使用。`);
    const restarted = spawnSync('pm2', ['restart', 'pili-telegram-channel-worker'], { stdio: 'inherit' });
    if (restarted.status !== 0) {
      console.log('session 已写好。手动执行: pm2 restart pili-telegram-channel-worker');
    }
  } finally {
    rl.close();
  }
}

void run().catch((error) => {
  console.error(
    '[telegram-channel-login-qr] failed:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});

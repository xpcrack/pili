import 'server-only';

import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

export interface InternalBidTokenPayload {
  iat: number;
  exp: number;
  svc: 'bid';
  scope: string;
}

type SecretSlot = 'current' | 'previous';

function readSecrets(): Array<{ slot: SecretSlot; value: string }> {
  const out: Array<{ slot: SecretSlot; value: string }> = [];
  const current = (process.env.INTERNAL_BID_HMAC_SECRET || '').trim();
  if (current) {
    out.push({ slot: 'current', value: current });
  }
  const previous = (process.env.INTERNAL_BID_HMAC_SECRET_PREVIOUS || '').trim();
  if (previous) {
    out.push({ slot: 'previous', value: previous });
  }
  return out;
}

function decodeB64Url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function encodeB64Url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return b.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export interface SignOptions {
  scope?: string;
  ttlSeconds?: number;
  now?: number;
  secret?: string;
}

export function signInternalBidToken(options: SignOptions = {}): string {
  const ttl = Math.min(300, Math.max(1, options.ttlSeconds ?? 60));
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const secret =
    options.secret ?? (process.env.INTERNAL_BID_HMAC_SECRET || '').trim();
  if (!secret) {
    throw new Error('INTERNAL_BID_HMAC_SECRET is required to sign');
  }
  const payload: InternalBidTokenPayload = {
    iat: now,
    exp: now + ttl,
    svc: 'bid',
    scope: options.scope ?? 'internal:bid:read',
  };
  const payloadB64 = encodeB64Url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${encodeB64Url(sig)}`;
}

export function verifyInternalBidToken(
  token: string,
  options: { now?: number; clockSkewSeconds?: number } = {}
): { ok: true; payload: InternalBidTokenPayload; slot: SecretSlot } | { ok: false; reason: string } {
  const secrets = readSecrets();
  if (secrets.length === 0) {
    return { ok: false, reason: 'unconfigured' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }
  const [payloadB64, sigB64] = parts;
  let provided: Buffer;
  try {
    provided = decodeB64Url(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  let matchedSlot: SecretSlot | null = null;
  for (const { slot, value } of secrets) {
    const expected = createHmac('sha256', value).update(payloadB64).digest();
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      matchedSlot = slot;
      break;
    }
  }
  if (!matchedSlot) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload: InternalBidTokenPayload;
  try {
    payload = JSON.parse(decodeB64Url(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + skew) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (payload.svc !== 'bid') {
    return { ok: false, reason: 'wrong_svc' };
  }
  return { ok: true, payload, slot: matchedSlot };
}

let cachedAllowList: { signature: string; list: BlockList | null } | null = null;

function loadAllowList(): BlockList | null {
  const raw = (process.env.INTERNAL_BID_ALLOWED_IPS || '').trim();
  if (cachedAllowList && cachedAllowList.signature === raw) {
    return cachedAllowList.list;
  }
  if (!raw) {
    cachedAllowList = { signature: raw, list: null };
    return null;
  }
  const list = new BlockList();
  for (const piece of raw.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    const slashIdx = entry.indexOf('/');
    if (slashIdx === -1) {
      const family = isIPv4(entry) ? 'ipv4' : isIPv6(entry) ? 'ipv6' : null;
      if (!family) {
        throw new Error(`INTERNAL_BID_ALLOWED_IPS: invalid address '${entry}'`);
      }
      list.addAddress(entry, family);
      continue;
    }
    const addr = entry.slice(0, slashIdx);
    const prefix = Number(entry.slice(slashIdx + 1));
    const family = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : null;
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 'ipv4' ? 32 : 128)) {
      throw new Error(`INTERNAL_BID_ALLOWED_IPS: invalid CIDR '${entry}'`);
    }
    list.addSubnet(addr, prefix, family);
  }
  cachedAllowList = { signature: raw, list };
  return list;
}

function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (!candidate) return null;
  if (candidate.startsWith('::ffff:')) {
    const v4 = candidate.slice(7);
    if (isIPv4(v4)) return v4;
  }
  return candidate;
}

export function readSourceIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    const normalized = normalizeIp(first);
    if (normalized) return normalized;
  }
  return normalizeIp(request.headers.get('x-real-ip'));
}

export function checkInternalBidIp(request: NextRequest):
  | { ok: true; ip: string | null; allowListConfigured: boolean }
  | { ok: false; reason: 'misconfigured' | 'no_source_ip' | 'not_in_allowlist'; ip: string | null } {
  let list: BlockList | null;
  try {
    list = loadAllowList();
  } catch {
    return { ok: false, reason: 'misconfigured', ip: null };
  }
  const ip = readSourceIp(request);
  if (!list) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'misconfigured', ip };
    }
    return { ok: true, ip, allowListConfigured: false };
  }
  if (!ip) {
    return { ok: false, reason: 'no_source_ip', ip: null };
  }
  const family = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : null;
  if (!family) {
    return { ok: false, reason: 'not_in_allowlist', ip };
  }
  if (!list.check(ip, family)) {
    return { ok: false, reason: 'not_in_allowlist', ip };
  }
  return { ok: true, ip, allowListConfigured: true };
}

function parseBearerToken(headerValue: string | null) {
  const value = (headerValue || '').trim();
  if (!value.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return value.slice(7).trim();
}

export function requireInternalBidAuth(request: NextRequest): NextResponse | null {
  const ipCheck = checkInternalBidIp(request);
  if (!ipCheck.ok) {
    if (ipCheck.reason === 'misconfigured') {
      return NextResponse.json(
        {
          ok: false,
          error: '服务端未配置 INTERNAL_BID_ALLOWED_IPS,内部 BID 接口已锁定。',
        },
        { status: 503 }
      );
    }
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  if (readSecrets().length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: '服务端未配置 INTERNAL_BID_HMAC_SECRET,内部 BID 接口已锁定。',
      },
      { status: 503 }
    );
  }

  const token = parseBearerToken(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const result = verifyInternalBidToken(token);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

export function _resetInternalBidAuthCacheForTest() {
  cachedAllowList = null;
}

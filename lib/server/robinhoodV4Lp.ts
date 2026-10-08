import 'server-only';

import { request as undiciRequest } from 'undici';

import { keccak256 as jsKeccak256 } from 'js-sha3';

/**
 * Uniswap V4 LP positions on Robinhood chain, read via raw JSON-RPC.
 *
 * Ported from newone packages/adapters/src/uniswap-v4-robinhood.ts (viem-based).
 * pili does not ship viem/ethers — all contract reads below are hand-encoded
 * eth_call payloads with precomputed selectors, and poolId is keccak256 over
 * the ABI-encoded poolKey (via js-sha3, the only keccak in the repo).
 *
 * Why this exists: OKX address asset API does not surface Uniswap V4 LP NFTs,
 * so wallets with active V4 positions show wallet-spot-only holdings in pili.
 * newone freezes LP into VIP snapshots; this module gives pili a live source.
 */

export const ROBINHOOD_V4_RPC_URL =
  process.env.PILI_ROBINHOOD_RPC_URL?.trim() || 'https://rpc.mainnet.chain.robinhood.com';

export const ROBINHOOD_V4_POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
export const ROBINHOOD_V4_STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
export const ROBINHOOD_TENDIES = '0x45242320dbb855eea8fd36804c6487e10e97fcf9';
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

// Precomputed selectors (verified against viem.toFunctionSelector).
const SEL_BALANCE_OF = '0x70a08231';
const SEL_OWNER_OF = '0x6352211e';
const SEL_GET_POOL_AND_POSITION_INFO = '0x7ba03aad';
const SEL_GET_POSITION_LIQUIDITY = '0x1efeed33';
const SEL_GET_SLOT0 = '0xc815641c';
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface RobinhoodV4LpPosition {
  tokenId: number;
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  feePct: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  currentTick: number;
  sqrtPriceX96: string;
  amount0Human: number;
  amount1Human: number;
  token0Symbol: string;
  token1Symbol: string;
  price0Usd: number | null;
  price1Usd: number | null;
  usd0: number | null;
  usd1: number | null;
  totalUsd: number | null;
  name: string;
  fullRange: boolean;
}

export interface RobinhoodV4LpScanResult {
  address: string;
  balance: number;
  positions: RobinhoodV4LpPosition[];
  totalUsd: number;
  warnings: string[];
}

class RpcError extends Error {}

interface RpcCall {
  method: string;
  params: unknown[];
}

async function rpcBatch(calls: RpcCall[], signal?: AbortSignal): Promise<unknown[]> {
  // Robinhood RPC sits behind Cloudflare, which challenges Node's global fetch
  // (default `node` UA + no ALPN fingerprint → "Just a moment..." 403).
  // undici with an explicit UA passes — same trick newone's viem stack relies on.
  const response = await undiciRequest(ROBINHOOD_V4_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'pili-v4-lp/1.0' },
    body: JSON.stringify(calls.map((call, index) => ({ jsonrpc: '2.0', id: index, ...call }))),
    signal: signal ?? undefined,
  });
  if (response.statusCode >= 400) {
    const body = await response.body.text().catch(() => '');
    throw new RpcError(`robinhood rpc HTTP ${response.statusCode}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  const payload = (await response.body.json()) as Array<{ id: number; result?: unknown; error?: { message?: string } }>;
  if (!Array.isArray(payload)) {
    throw new RpcError('robinhood rpc batch payload is not a list');
  }
  const byId = new Map<number, unknown>();
  for (const row of payload) {
    if (row.error) {
      throw new RpcError(`robinhood rpc error: ${row.error.message ?? 'unknown'}`);
    }
    byId.set(row.id, row.result);
  }
  return calls.map((_, index) => byId.get(index));
}

async function rpcCall<T>(call: RpcCall, signal?: AbortSignal): Promise<T> {
  const results = await rpcBatch([call], signal);
  return results[0] as T;
}

function encodeAddress(address: string): string {
  const lower = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) {
    throw new RpcError(`invalid EVM address: ${address}`);
  }
  return lower.replace(/^0x/, '').padStart(64, '0');
}

function encodeUint256(value: bigint | number): string {
  const big = typeof value === 'bigint' ? value : BigInt(Math.round(value));
  if (big < BigInt(0) || big >= BigInt(2) ** BigInt(256)) {
    throw new RpcError(`uint256 out of range: ${value}`);
  }
  return big.toString(16).padStart(64, '0');
}

async function ethCallBigInt(
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<bigint> {
  const result = await rpcCall<string>({ method: 'eth_call', params: [{ to, data }, 'latest'] }, signal);
  if (typeof result !== 'string' || result === '0x') {
    return BigInt(0);
  }
  return BigInt(result);
}

/** keccak256 over ABI-encoded (address, address, uint24, int24, address). */
function poolIdOf(key: {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}): string {
  // head types (address, address, uint24, int24, address) are all static: 5 × 32 bytes
  const encoded =
    encodeAddress(key.currency0) +
    encodeAddress(key.currency1) +
    encodeUint256(BigInt(key.fee)) +
    encodeUint256(BigInt(key.tickSpacing)) +
    encodeAddress(key.hooks);
  return `0x${jsKeccak256(new Uint8Array(Buffer.from(encoded, 'hex')))}`;
}

function toSigned24FromPacked(bits: bigint): number {
  const MASK = BigInt('0xffffff');
  let v = Number(bits & MASK);
  if (v >= 0x800000) v -= 0x1000000;
  return v;
}

/** Uniswap TickMath.getSqrtRatioAtTick — ported verbatim from newone (BigInt() form: repo ts target < ES2020). */
export function tickToSqrtPriceX96(tick: number): bigint {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  const TWO_256 = BigInt(2) ** BigInt(256);
  const SHIFT_128 = BigInt(128);
  const SHIFT_32 = BigInt(32);
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio =
    (absTick & ONE) !== ZERO
      ? BigInt('0xfffcb933bd6fad37aa2d162d1a594001')
      : BigInt('0x100000000000000000000000000000000');
  const steps: Array<[bigint, bigint]> = [
    [BigInt(2), BigInt('0xfff97272373d413259a46990580e213a')],
    [BigInt(4), BigInt('0xfff2e50f5f656932ef12357cf3c7fdcc')],
    [BigInt(8), BigInt('0xffe5caca7e10e4e61c3624eaa0941cd0')],
    [BigInt(16), BigInt('0xffcb9843d60f6159c9db58835c926644')],
    [BigInt(32), BigInt('0xff973b41fa98c081472e6896dfb254c0')],
    [BigInt(64), BigInt('0xff2ea16466c96a3843ec78b326b52861')],
    [BigInt(128), BigInt('0xfe5dee046a99a2a811c461f1969c3053')],
    [BigInt(256), BigInt('0xfcbe86c7900a88aedcffc83b479aa3a4')],
    [BigInt(512), BigInt('0xf987a7253ac413176f2b074cf7815e54')],
    [BigInt(1024), BigInt('0xf3392b0822b70005940c7a398e4b70f3')],
    [BigInt(2048), BigInt('0xe7159475a2c29b7443b29c7fa6e889d9')],
    [BigInt(4096), BigInt('0xd097f3bdfd2022b8845ad8f792aa5825')],
    [BigInt(8192), BigInt('0xa9f746462d870fdf8a65dc1f90e061e5')],
    [BigInt(16384), BigInt('0x70d869a156d2a1b890bb3df62baf32f7')],
    [BigInt(32768), BigInt('0x31be135f97d08fd981231505542fcfa6')],
    [BigInt(65536), BigInt('0x9aa508b5b7a84e1c677de54f3e99bc9')],
    [BigInt(131072), BigInt('0x5d6af8dedb81196699c329225ee604')],
    [BigInt(262144), BigInt('0x2216e584f5fa1ea926041bedfe98')],
    [BigInt(524288), BigInt('0x48a170391f7dc42444e8fa2')],
  ];
  for (const [mask, mul] of steps) {
    if ((absTick & mask) !== ZERO) ratio = (ratio * mul) >> SHIFT_128;
  }
  if (tick > 0) ratio = TWO_256 / ratio;
  return (ratio >> SHIFT_32) + (ratio % (ONE << SHIFT_32) === ZERO ? ZERO : ONE);
}

/** V4 position token amounts from liquidity + current/range ticks. */
export function amountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  tickCurrent: number,
): { amount0: bigint; amount1: bigint } {
  const Q96 = BigInt(2) ** BigInt(96);
  const sqrtA = tickToSqrtPriceX96(tickLower);
  const sqrtB = tickToSqrtPriceX96(tickUpper);
  const sqrtP = sqrtPriceX96;
  const L = liquidity;
  const ZERO = BigInt(0);
  if (tickCurrent < tickLower) {
    return {
      amount0: (L * (sqrtB - sqrtA) * Q96) / (sqrtA * sqrtB),
      amount1: ZERO,
    };
  }
  if (tickCurrent >= tickUpper) {
    return { amount0: ZERO, amount1: (L * (sqrtB - sqrtA)) / Q96 };
  }
  return {
    amount0: (L * (sqrtB - sqrtP) * Q96) / (sqrtP * sqrtB),
    amount1: (L * (sqrtP - sqrtA)) / Q96,
  };
}

/**
 * DexScreener bootstrap prices for Robinhood V4 LP legs (TENDIES + ETH).
 * TENDIES/ETH pools are the standard V4 pairs; other legs need caller-supplied prices.
 */
export async function fetchRobinhoodTendiesEthUsd(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ethUsd: number | null; tendiesUsd: number | null }> {
  try {
    const response = await fetchImpl(
      `https://api.dexscreener.com/latest/dex/tokens/${ROBINHOOD_TENDIES}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return { ethUsd: null, tendiesUsd: null };
    const payload = (await response.json()) as {
      pairs?: Array<{
        chainId?: string;
        priceUsd?: string;
        priceNative?: string;
        liquidity?: { usd?: number };
      }>;
    };
    const pairs = (payload.pairs ?? [])
      .filter((pair) => pair.chainId === 'robinhood')
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = pairs[0];
    if (!best?.priceUsd) return { ethUsd: null, tendiesUsd: null };
    const tendiesUsd = Number(best.priceUsd);
    let ethUsd: number | null = null;
    if (best.priceNative) {
      const priceNative = Number(best.priceNative);
      if (Number.isFinite(priceNative) && priceNative > 0 && Number.isFinite(tendiesUsd) && tendiesUsd > 0) {
        ethUsd = tendiesUsd / priceNative;
      }
    }
    return { ethUsd, tendiesUsd: Number.isFinite(tendiesUsd) ? tendiesUsd : null };
  } catch {
    return { ethUsd: null, tendiesUsd: null };
  }
}

/**
 * Find V4 LP NFT tokenIds owned by `owner` via Transfer-to logs.
 * Chunked getLogs with halving retry, mirroring newone's approach.
 */
async function findTokenIds(owner: string, signal?: AbortSignal): Promise<number[]> {
  const latestHex = await rpcCall<string>({ method: 'eth_blockNumber', params: [] }, signal);
  const latest = Number(BigInt(latestHex ?? '0x0'));
  if (!Number.isFinite(latest) || latest <= 0) return [];
  const pm = ROBINHOOD_V4_POSITION_MANAGER;
  const ownerTopic = `0x${encodeAddress(owner)}`;
  const received = new Set<number>();
  let chunk = 2_000_000;

  for (let start = 0; start <= latest; ) {
    const end = Math.min(latest, start + chunk - 1);
    try {
      const logs = (await rpcCall<Array<{ topics?: string[]; data?: string }>>(
        {
          method: 'eth_getLogs',
          params: [
            {
              address: pm,
              fromBlock: `0x${start.toString(16)}`,
              toBlock: `0x${end.toString(16)}`,
              topics: [TRANSFER_EVENT_TOPIC, null, ownerTopic],
            },
          ],
        },
        signal,
      )) ?? [];
      for (const log of logs) {
        // tokenId is the third indexed topic
        const topic = log.topics?.[3];
        if (typeof topic === 'string' && topic.length >= 66) {
          try {
            received.add(Number(BigInt(topic)));
          } catch {
            // malformed topic — skip
          }
        }
      }
    } catch {
      // 原因：日志分块查询失败缩小分块重试，最小块仍失败则跳过该段
      if (chunk > 50_000) {
        chunk = Math.floor(chunk / 2);
        continue;
      }
    }
    start = end + 1;
  }

  // Parallel ownerOf checks — NFTs may have been transferred out again.
  const owned = (
    await Promise.all(
      Array.from(received).map(async (tokenId) => {
        try {
          const data = SEL_OWNER_OF + encodeUint256(BigInt(tokenId));
          const result = await rpcCall<string>(
            { method: 'eth_call', params: [{ to: pm, data }, 'latest'] },
            signal,
          );
          if (typeof result !== 'string' || result.length < 66) return null;
          return `0x${result.slice(-40)}` === owner.toLowerCase() ? tokenId : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((tokenId): tokenId is number => tokenId != null);
  return owned;
}

function decodePositionInfo(
  result: string,
): { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string; packedInfo: bigint } | null {
  // returns (poolKey, info): poolKey = (address, address, uint24, int24, address) = 5 words,
  // then uint256 info = word 5. info packs poolId(25 bytes) | tickLower(int24) | tickUpper(int24).
  if (typeof result !== 'string' || result.length < 2 + 192 * 2) return null;
  const body = result.slice(2);
  const word = (index: number) => body.slice(index * 64, (index + 1) * 64);
  const addressOf = (index: number) => `0x${word(index).slice(24)}`;
  return {
    currency0: addressOf(0),
    currency1: addressOf(1),
    fee: Number(BigInt(`0x${word(2)}`)),
    tickSpacing: Number(BigInt(`0x${word(3)}`)),
    hooks: addressOf(4),
    packedInfo: BigInt(`0x${word(5)}`),
  };
}

function symbolForCurrency(currency: string): string {
  const lower = currency.toLowerCase();
  if (lower === NATIVE_ADDRESS) return 'ETH';
  if (lower === ROBINHOOD_TENDIES) return 'TENDIES';
  return currency.slice(0, 6);
}

function priceForCurrency(
  currency: string,
  ethUsd: number | null,
  tendiesUsd: number | null,
  tokenPrices: Record<string, number>,
): number | null {
  const lower = currency.toLowerCase();
  if (lower === NATIVE_ADDRESS) return ethUsd;
  if (lower === ROBINHOOD_TENDIES) return tendiesUsd;
  return tokenPrices[lower] ?? null;
}

export async function fetchRobinhoodV4LpPositions(
  owner: string,
  options: {
    ethUsd?: number | null;
    tendiesUsd?: number | null;
    tokenPrices?: Record<string, number>;
    signal?: AbortSignal;
  } = {},
): Promise<RobinhoodV4LpScanResult> {
  const trimmed = owner.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new RpcError(`invalid EVM address: ${owner}`);
  }
  const ownerLower = trimmed.toLowerCase();
  const pm = ROBINHOOD_V4_POSITION_MANAGER;
  const warnings: string[] = [];

  const balance = Number(
    await ethCallBigInt(pm, SEL_BALANCE_OF + encodeAddress(ownerLower), options.signal),
  );
  if (!(balance > 0)) {
    return { address: ownerLower, balance: 0, positions: [], totalUsd: 0, warnings };
  }

  const tokenIds = await findTokenIds(ownerLower, options.signal);
  if (tokenIds.length !== balance) {
    warnings.push(`tokenIds via logs=${tokenIds.length} balanceOf=${balance}`);
  }

  const ethUsd = options.ethUsd ?? null;
  const tendiesUsd = options.tendiesUsd ?? options.tokenPrices?.[ROBINHOOD_TENDIES] ?? null;

  const positions: RobinhoodV4LpPosition[] = [];
  for (const tokenId of tokenIds) {
    try {
      const [infoResult, liquidityResult] = await rpcBatch(
        [
          {
            method: 'eth_call',
            params: [
              { to: pm, data: SEL_GET_POOL_AND_POSITION_INFO + encodeUint256(BigInt(tokenId)) },
              'latest',
            ],
          },
          {
            method: 'eth_call',
            params: [
              { to: pm, data: SEL_GET_POSITION_LIQUIDITY + encodeUint256(BigInt(tokenId)) },
              'latest',
            ],
          },
        ],
        options.signal,
      );
      const decoded = typeof infoResult === 'string' ? decodePositionInfo(infoResult) : null;
      if (!decoded) {
        warnings.push(`token ${tokenId}: malformed getPoolAndPositionInfo`);
        continue;
      }
      const liquidity = typeof liquidityResult === 'string' && liquidityResult !== '0x'
        ? BigInt(liquidityResult)
        : BigInt(0);

      const poolId = poolIdOf({
        currency0: decoded.currency0,
        currency1: decoded.currency1,
        fee: decoded.fee,
        tickSpacing: decoded.tickSpacing,
        hooks: decoded.hooks,
      });
      const slot0 = await rpcCall<string>(
        {
          method: 'eth_call',
          params: [{ to: ROBINHOOD_V4_STATE_VIEW, data: SEL_GET_SLOT0 + poolId.replace(/^0x/, '').padStart(64, '0') }, 'latest'],
        },
        options.signal,
      );
      let sqrtPriceX96 = BigInt(0);
      let currentTick = 0;
      if (typeof slot0 === 'string' && slot0.length >= 130) {
        sqrtPriceX96 = BigInt(`0x${slot0.slice(2, 66)}`);
        currentTick = Number(BigInt(`0x${slot0.slice(66, 130)}`));
      }

      const tickLower = toSigned24FromPacked(decoded.packedInfo >> BigInt(8));
      const tickUpper = toSigned24FromPacked(decoded.packedInfo >> BigInt(32));
      const { amount0, amount1 } = amountsForLiquidity(
        sqrtPriceX96,
        tickLower,
        tickUpper,
        liquidity,
        currentTick,
      );

      const sym0 = symbolForCurrency(decoded.currency0);
      const sym1 = symbolForCurrency(decoded.currency1);
      const px0 = priceForCurrency(decoded.currency0, ethUsd, tendiesUsd, options.tokenPrices ?? {});
      const px1 = priceForCurrency(decoded.currency1, ethUsd, tendiesUsd, options.tokenPrices ?? {});
      const h0 = Number(amount0) / 1e18;
      const h1 = Number(amount1) / 1e18;
      const usd0 = px0 != null && Number.isFinite(px0) ? h0 * px0 : null;
      const usd1 = px1 != null && Number.isFinite(px1) ? h1 * px1 : null;
      const totalUsd = usd0 != null || usd1 != null ? (usd0 ?? 0) + (usd1 ?? 0) : null;
      const feePct = decoded.fee / 10_000;
      const fullRange = tickLower <= -887_000 && tickUpper >= 887_000;

      positions.push({
        tokenId,
        poolId,
        currency0: decoded.currency0,
        currency1: decoded.currency1,
        fee: decoded.fee,
        feePct,
        tickLower,
        tickUpper,
        liquidity: liquidity.toString(),
        currentTick,
        sqrtPriceX96: sqrtPriceX96.toString(),
        amount0Human: h0,
        amount1Human: h1,
        token0Symbol: sym0,
        token1Symbol: sym1,
        price0Usd: px0,
        price1Usd: px1,
        usd0,
        usd1,
        totalUsd,
        name: `Uniswap V4 ${feePct}% ${sym0}/${sym1}`,
        fullRange,
      });
    } catch (error) {
      warnings.push(`token ${tokenId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    address: ownerLower,
    balance,
    positions,
    totalUsd: positions.reduce((sum, position) => sum + (position.totalUsd ?? 0), 0),
    warnings,
  };
}

/** test-only: expose keccak via sha3 for poolId unit checks */
export const _internals = { poolIdOf, keccak256: (data: Uint8Array) => jsKeccak256(data) };

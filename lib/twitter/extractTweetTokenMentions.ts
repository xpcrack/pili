export interface ExtractedTweetTokenMention {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  matchSource: 'ticker' | 'ca' | 'both';
  rankInTweet: number;
}

const EVM_CA_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;
const SOL_CA_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SOL_CA_EXACT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Legacy ASCII $TICKER (2–15 chars). Stops before non-ASCII so `$Sundog带头` → Sundog only. */
const DOLLAR_ASCII_PATTERN = /\$([A-Za-z][A-Za-z0-9]{1,14})(?![A-Za-z0-9])/g;

/** Chinese (CJK) $ticker — pure Han, 2–20 chars. */
const DOLLAR_CJK_PATTERN = /\$([一-鿿]{2,20})/g;

/** ASCII #tag (2–20 chars). */
const HASH_ASCII_PATTERN = /#([A-Za-z][A-Za-z0-9_]{1,19})(?![A-Za-z0-9_])/g;

/** Chinese (CJK) #tag — pure Han, 2–20 chars (e.g. #熊猫头). */
const HASH_CJK_PATTERN = /#([一-鿿]{2,20})/g;

/**
 * Bare TitleCase ticker (CT often omits $): Jimothy, Pepe, Bonk.
 * Min 4 letters to cut common short English (The/And/For).
 */
const BARE_TITLE_PATTERN = /\b([A-Z][a-z]{3,19})\b/g;

/** Bare ALLCAPS ticker: BTC, ETH, SOL — exclude tech abbreviations via stop list. */
const BARE_ALLCAPS_PATTERN = /\b([A-Z]{2,10})\b/g;

/**
 * English / CT words that look like bare tickers but are not.
 * Prefer missing a coin over flooding mentions (PRD: 低误判).
 * Includes sentence-initial verbs/adjectives (Buying/Looking/… TitleCase at start).
 */
const BARE_TICKER_STOPWORDS = new Set(
  [
    // pronouns / determiners / conjunctions / prepositions
    'This', 'That', 'With', 'From', 'Have', 'Will', 'Just', 'Back', 'Only', 'Also',
    'When', 'What', 'Where', 'Which', 'While', 'After', 'Before', 'About', 'Into',
    'Over', 'Under', 'Again', 'There', 'These', 'Those', 'Their', 'They', 'Them',
    'Then', 'Than', 'Some', 'Such', 'Very', 'More', 'Most', 'Much', 'Many', 'Each',
    'Both', 'Other', 'Another', 'Still', 'Even', 'Here', 'Your', 'Yours', 'Ours',
    'Mine', 'Himself', 'Herself', 'Itself', 'Being', 'Been', 'Were', 'Was',
    'Does', 'Did', 'Done', 'Make', 'Made', 'Take', 'Took', 'Come', 'Came', 'Going',
    'Good', 'Best', 'Better', 'Great', 'High', 'Higher', 'Highest', 'Low', 'Lower',
    'Next', 'Last', 'First', 'Second', 'Third', 'Final', 'True', 'False', 'Real',
    'Today', 'Tomorrow', 'Yesterday', 'Week', 'Month', 'Year', 'Years', 'Time', 'Now',
    'Daily', 'Weekly', 'Hourly', 'Minutes', 'Hours', 'Seconds',
    'People', 'Someone', 'Something', 'Nothing', 'Everything', 'Everyone', 'Anyone',
    'Please', 'Thanks', 'Thank', 'Sorry', 'Hello', 'Guys', 'Folks', 'Team', 'Friend',
    'Friends', 'Brother', 'Brothers', 'Sister',
    // sentence-initial verbs / gerunds / common CT verbs
    'Buying', 'Selling', 'Looking', 'Watching', 'Holding', 'Adding', 'Closing',
    'Opening', 'Waiting', 'Thinking', 'Feeling', 'Seeing', 'Getting', 'Taking',
    'Making', 'Going', 'Coming', 'Trying', 'Starting', 'Stopping', 'Leaving',
    'Entering', 'Exiting', 'Scaling', 'Aped', 'Aping', 'Sniping', 'Flipping',
    'Loaded', 'Loading', 'Dumped', 'Dumping', 'Pumped', 'Pumping', 'Minted',
    'Minting', 'Launched', 'Launching', 'Deployed', 'Shipping', 'Building',
    'Bought', 'Sold', 'Held', 'Missed', 'Caught', 'Called', 'Posted', 'Shared',
    'Sent', 'Send', 'Check', 'Checked', 'Watch', 'Read', 'Reading', 'Wrote',
    'Remember', 'Forget', 'Believe', 'Think', 'Know', 'Knew', 'Need', 'Want',
    'Love', 'Hate', 'Like', 'Liked', 'Hope', 'Wish', 'Keep', 'Stay', 'Wait',
    'Let', 'Lets', "Let's", 'Dont', "Don't", 'Cant', "Can't", 'Wont', "Won't",
    'Maybe', 'Probably', 'Definitely', 'Actually', 'Basically', 'Literally',
    'Really', 'Pretty', 'Super', 'Ultra', 'Mega', 'Huge', 'Small', 'Tiny',
    'Strong', 'Weak', 'Soft', 'Hard', 'Easy', 'Tough', 'Crazy', 'Insane',
    'Nice', 'Clean', 'Solid', 'Safe', 'Risky', 'Early', 'Late', 'Fast', 'Slow',
    'Right', 'Wrong', 'Left', 'Above', 'Below', 'Between', 'Around', 'Across',
    'Because', 'However', 'Although', 'Unless', 'Until', 'Since', 'During',
    'Without', 'Within', 'Among', 'Against', 'Toward', 'Towards', 'Through',
    'Never', 'Always', 'Often', 'Sometimes', 'Usually', 'Already', 'Almost',
    'Enough', 'Every', 'Total', 'Full', 'Half', 'Double', 'Triple',
    'Agree', 'Agreed', 'Disagree', 'Disagreed', 'Take', 'Takes', 'Taken',
    'Setup', 'Setups', 'Leg', 'Legs', 'Higher', 'Lower', 'Move', 'Moves',
    'Trend', 'Trends', 'Range', 'Ranges', 'Zone', 'Zones', 'Area', 'Areas',
    'Anyone', 'Somebody', 'Everybody', 'Nobody', 'Wherever', 'Whenever',
    'Project', 'Projects', 'Token', 'Tokens', 'Coin', 'Coins', 'Market', 'Markets',
    'Price', 'Prices', 'Chart', 'Charts', 'Trade', 'Trades', 'Trading', 'Trader',
    'Traders', 'Buy', 'Sell', 'Long', 'Short', 'Entry', 'Entries', 'Exit', 'Exits',
    'Size', 'Risk', 'Play', 'Plays', 'Call', 'Calls', 'Alpha', 'Signal', 'Signals',
    'Bullish', 'Bearish', 'Neutral', 'Patience', 'Patient', 'Conviction',
    'Floor', 'Ceiling', 'Hitting', 'Hit', 'Require', 'Requires', 'Required',
    'Bros', 'Bro', 'Fam', 'Ser', 'Anon', 'Anons', 'King', 'Queen', 'Boss',
    'Gm', 'Gn', 'Wagmi', 'Ngmi', 'Lfg', 'Pump', 'Dump', 'Moon', 'Bag', 'Bags',
    'Update', 'Updates', 'Thread', 'Threads', 'Thoughts', 'Opinion', 'Opinions',
    'Analysis', 'Breakout', 'Breakdown', 'Level', 'Levels',
    'Support', 'Resistance', 'Volume', 'Liquidity', 'Holder', 'Holders',
    'Dev', 'Devs', 'Community', 'Launch', 'Live', 'Soon', 'Later', 'Earlier',
    'Chapter', 'Part', 'Note', 'Notes', 'Summary', 'Context', 'Important',
    'Interesting', 'Obvious', 'Simple', 'Complex', 'Possible', 'Impossible',
    'Honestly', 'Clearly', 'Simply', 'Finally', 'Firstly',
    'Congratulations', 'Welcome', 'Goodbye', 'Morning', 'Evening', 'Night',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'June', 'July', 'August',
    'September', 'October', 'November', 'December',
    'Bitcoin', 'Ethereum', 'Solana', // chain names as bare words are noisy; $BTC still works
    // tech / chart abbreviations / labels (not tickers)
    // "CA:" before an address is a label — bare CA must never be a ticker
    'CA', 'MC', 'Mcap', 'MCap', 'Cap', 'Liq', 'Vol', 'Tx', 'TX', 'Txn',
    'RSI', 'ATH', 'ATL', 'ROI', 'APR', 'APY', 'TVL', 'FDV', 'PNL', 'PnL',
    'API', 'URL', 'USD', 'UTC', 'GMT', 'EST', 'PST', 'CEO', 'CTO', 'CFO',
    'NFT', 'DEX', 'CEX', 'DAO', 'AMM', 'LP', 'TP', 'SL', 'BE', 'EMA', 'SMA',
    'MACD', 'VWAP', 'OHLC', 'OTC', 'KYC', 'AML', 'FAQ', 'DYOR', 'NFA',
    'IMO', 'IMHO', 'TBH', 'BTW', 'FYI', 'ASAP', 'ETL', 'CPU', 'GPU',
    'HTTP', 'HTTPS', 'WWW', 'HTML', 'JSON', 'SQL', 'PDF', 'JPG', 'PNG',
    // common non-ticker ALLCAPS crypto slang
    'HODL', 'FOMO', 'FUD', 'REKT', 'WAGMI', 'NGMI', 'LFG', 'GM', 'GN',
    'IDK', 'IDC', 'IMO', 'TBF', 'TBH', 'SMH', 'LOL', 'LMAO', 'OMG', 'BRB',
    'USA', 'EU', 'UK', 'CN', 'KR', 'JP', 'NYC', 'SF',
  ].map((w) => w.toLowerCase())
);

function normalizeText(text: string) {
  return text || '';
}

/** ASCII tickers stay UPPERCASE (legacy); CJK kept as-is. */
function normalizeTickerSymbol(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) {
    return s.toUpperCase();
  }
  return s;
}

function isLikelySolAddress(value: string) {
  if (value.length < 32 || value.length > 44) {
    return false;
  }
  return SOL_CA_EXACT_PATTERN.test(value);
}

function isBareTickerStopword(raw: string) {
  return BARE_TICKER_STOPWORDS.has(raw.toLowerCase());
}

/** True if this match is already covered by a leading $ or #. */
function isPrefixedTicker(text: string, index: number) {
  if (index <= 0) return false;
  const prev = text[index - 1];
  return prev === '$' || prev === '#';
}

/**
 * Sentence-initial TitleCase is usually English (Agree/Buying/Looking…),
 * not a ticker. Require longer names there (Jimothy=7 ok; Agree=5 drop).
 */
function isSentenceInitial(text: string, index: number) {
  if (index <= 0) return true;
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '"' || text[i] === "'")) {
    i -= 1;
  }
  if (i < 0) return true;
  const ch = text[i];
  return ch === '.' || ch === '!' || ch === '?' || ch === '\n' || ch === '。' || ch === '！' || ch === '？';
}

function isPlausibleBareTitleTicker(raw: string, text: string, index: number) {
  if (!raw || isPrefixedTicker(text, index) || isBareTickerStopword(raw)) return false;
  if (text[index + raw.length] === ':') return false;
  // Sentence-initial needs longer proper-name shape (cuts Agree/Looking/…)
  if (isSentenceInitial(text, index) && raw.length < 6) return false;
  // Mid-sentence still needs ≥4 (pattern already enforces)
  return true;
}

function isPlausibleBareAllcapsTicker(raw: string, text: string, index: number) {
  if (!raw || isPrefixedTicker(text, index) || isBareTickerStopword(raw)) return false;
  if (text[index + raw.length] === ':') return false;
  return true;
}

function findCaCandidates(text: string) {
  const seen = new Set<string>();
  const result: Array<{ tokenAddress: string; index: number }> = [];

  for (const match of text.matchAll(EVM_CA_PATTERN)) {
    const tokenAddress = match[0];
    if (!tokenAddress || seen.has(tokenAddress)) {
      continue;
    }
    seen.add(tokenAddress);
    result.push({ tokenAddress, index: match.index ?? 0 });
  }

  for (const match of text.matchAll(SOL_CA_PATTERN)) {
    const tokenAddress = match[0];
    if (!tokenAddress || seen.has(tokenAddress) || !isLikelySolAddress(tokenAddress)) {
      continue;
    }
    seen.add(tokenAddress);
    result.push({ tokenAddress, index: match.index ?? 0 });
  }

  return result.sort((a, b) => a.index - b.index);
}

function findTickerCandidates(text: string) {
  const result: Array<{ tokenSymbol: string; index: number }> = [];
  const seenAt = new Set<string>();

  const push = (raw: string, index: number) => {
    const tokenSymbol = normalizeTickerSymbol(raw);
    if (!tokenSymbol) return;
    const key = `${tokenSymbol.toLowerCase()}@${index}`;
    if (seenAt.has(key)) return;
    seenAt.add(key);
    result.push({ tokenSymbol, index });
  };

  for (const match of text.matchAll(DOLLAR_ASCII_PATTERN)) {
    push(match[1] || '', match.index ?? 0);
  }
  for (const match of text.matchAll(DOLLAR_CJK_PATTERN)) {
    push(match[1] || '', match.index ?? 0);
  }
  for (const match of text.matchAll(HASH_ASCII_PATTERN)) {
    push(match[1] || '', match.index ?? 0);
  }
  for (const match of text.matchAll(HASH_CJK_PATTERN)) {
    push(match[1] || '', match.index ?? 0);
  }

  // Bare TitleCase / ALLCAPS (PRD: independent tickers under whitelist/rules).
  // Runs after $/# so those keep original positions; symbol dedupe later.
  for (const match of text.matchAll(BARE_TITLE_PATTERN)) {
    const raw = match[1] || '';
    const index = match.index ?? 0;
    if (!isPlausibleBareTitleTicker(raw, text, index)) continue;
    push(raw, index);
  }
  for (const match of text.matchAll(BARE_ALLCAPS_PATTERN)) {
    const raw = match[1] || '';
    const index = match.index ?? 0;
    if (!isPlausibleBareAllcapsTicker(raw, text, index)) continue;
    push(raw, index);
  }

  return result.sort((a, b) => a.index - b.index);
}

/**
 * Symbols that must survive translation unchanged (mentions + bare candidates in text).
 * Used by the enrichment model to mask/unmask before calling the LLM.
 */
export function listPreserveTickerSymbols(text: string, extraSymbols: Array<string | null | undefined> = []): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (raw: string | null | undefined) => {
    const s = (raw || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    // Skip pure CJK extras here only if empty; CJK $/# already in extract path.
    seen.add(key);
    ordered.push(s);
  };

  for (const symbol of extraSymbols) {
    push(symbol);
  }
  for (const match of findTickerCandidates(normalizeText(text))) {
    push(match.tokenSymbol);
  }
  return ordered;
}

export function extractTweetTokenMentions(text: string): ExtractedTweetTokenMention[] {
  const normalized = normalizeText(text);
  const results: ExtractedTweetTokenMention[] = [];
  const bySymbol = new Map<string, ExtractedTweetTokenMention>();
  const tickerMatches = findTickerCandidates(normalized).map((match) => ({
    type: 'ticker' as const,
    index: match.index,
    tokenSymbol: match.tokenSymbol,
  }));
  const caMatches = findCaCandidates(normalized).map((match) => ({
    type: 'ca' as const,
    index: match.index,
    tokenAddress: match.tokenAddress,
  }));
  const orderedMatches = [...tickerMatches, ...caMatches].sort((a, b) => a.index - b.index);
  let rank = 0;

  for (const match of orderedMatches) {
    if (match.type === 'ticker') {
      const symbolKey = match.tokenSymbol.toLowerCase();
      if (bySymbol.has(symbolKey)) {
        continue;
      }
      rank += 1;
      const mention: ExtractedTweetTokenMention = {
        tokenAddress: null,
        tokenSymbol: match.tokenSymbol,
        matchSource: 'ticker',
        rankInTweet: rank,
      };
      bySymbol.set(symbolKey, mention);
      results.push(mention);
      continue;
    }

    rank += 1;
    const latest = results[results.length - 1];
    if (latest && latest.tokenAddress === null) {
      latest.tokenAddress = match.tokenAddress;
      latest.matchSource = latest.tokenSymbol ? 'both' : 'ca';
      continue;
    }

    results.push({
      tokenAddress: match.tokenAddress,
      tokenSymbol: null,
      matchSource: 'ca',
      rankInTweet: rank,
    });
  }

  return results;
}

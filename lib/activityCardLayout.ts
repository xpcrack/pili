export function getActivityCardContentColumnClass(params: {
  isTransfer: boolean;
  isBlockchain: boolean;
  isTwitter: boolean;
  isTelegram: boolean;
}) {
  // 链上交易 / 社媒：整行铺开，头像落在左侧与交易 token 头像列对齐
  if (params.isTransfer || params.isTwitter || params.isTelegram) {
    return 'md:col-start-1 md:col-span-3 md:justify-self-stretch md:pl-1 md:pr-1';
  }

  if (params.isBlockchain) {
    return 'md:col-start-1 md:col-span-2 md:justify-self-stretch md:pl-1 md:pr-1';
  }

  return 'md:col-start-3 md:justify-self-stretch md:pl-1 md:pr-1';
}

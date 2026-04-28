export function getActivityCardContentColumnClass(params: {
  isTransfer: boolean;
  isBlockchain: boolean;
  isTwitter: boolean;
  isTelegram: boolean;
}) {
  if (params.isTransfer) {
    return 'md:col-start-1 md:col-span-3 md:justify-self-stretch md:pl-1 md:pr-1';
  }

  if (params.isBlockchain || params.isTwitter || params.isTelegram) {
    return 'md:col-start-1 md:col-span-2 md:justify-self-stretch md:pl-1 md:pr-1';
  }

  return 'md:col-start-3 md:justify-self-stretch md:pl-1 md:pr-1';
}

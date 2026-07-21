/** DOM-only feed highlight: no React state, no list re-render. */

const FEED_LIST_ID = 'feed-list';

function getFeedList() {
  if (typeof document === 'undefined') return null;
  return document.getElementById(FEED_LIST_ID);
}

export function setFeedTokenHover(tokenCa: string | null) {
  const list = getFeedList();
  if (!list) return;
  const key = (tokenCa || '').trim().toLowerCase();

  list.querySelectorAll('[data-token-ca].feed-ca-active').forEach((el) => {
    el.classList.remove('feed-ca-active');
  });
  list.querySelectorAll('[data-feed-card].feed-card-ca-active').forEach((el) => {
    el.classList.remove('feed-card-ca-active');
  });

  if (!key) {
    list.removeAttribute('data-hover-token');
    return;
  }

  list.setAttribute('data-hover-token', key);
  list.querySelectorAll('[data-token-ca]').forEach((el) => {
    if ((el.getAttribute('data-token-ca') || '') === key) {
      el.classList.add('feed-ca-active');
      el.closest('[data-feed-card]')?.classList.add('feed-card-ca-active');
    }
  });
}

export function setFeedAddressHover(address: string | null) {
  const list = getFeedList();
  if (!list) return;
  const key = (address || '').trim().toLowerCase();

  list.querySelectorAll('[data-address].feed-addr-active').forEach((el) => {
    el.classList.remove('feed-addr-active');
  });

  if (!key) {
    list.removeAttribute('data-hover-address');
    return;
  }

  list.setAttribute('data-hover-address', key);
  list.querySelectorAll('[data-address]').forEach((el) => {
    if ((el.getAttribute('data-address') || '') === key) {
      el.classList.add('feed-addr-active');
    }
  });
}

import { request, showError } from '../../services/api';
import { getNavigationLayout } from '../../utils/navigation';

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (number) => String(number).padStart(2, '0');
const shanghaiParts = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes()
  };
};
const dateKey = (value) => {
  const parts = shanghaiParts(value);
  return parts ? `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` : 'unknown';
};
const dateLabel = (value) => {
  const parts = shanghaiParts(value);
  if (!parts) return '日期未知';
  const key = dateKey(value);
  if (key === dateKey(Date.now())) return '今天';
  if (key === dateKey(Date.now() - DAY_MS)) return '昨天';
  return `${parts.year}年${parts.month}月${parts.day}日`;
};
const decorateTransaction = (item) => {
  const parts = shanghaiParts(item.created_at);
  return {
    ...item,
    date_key: dateKey(item.created_at),
    date_label: dateLabel(item.created_at),
    time_label: parts ? `${pad(parts.hour)}:${pad(parts.minute)}` : ''
  };
};
const appendUnique = (current, incoming) => {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
};
const groupTransactions = (items) => items.reduce((groups, item) => {
  const last = groups[groups.length - 1];
  if (last?.date_key === item.date_key) last.items.push(item);
  else groups.push({ date_key: item.date_key, date_label: item.date_label, items: [item] });
  return groups;
}, []);

Page({
  data: {
    loading: true,
    loadingMore: false,
    loadFailed: false,
    transactions: [],
    groups: [],
    nextCursor: null,
    navShellStyle: '',
    navBarStyle: '',
    navScrolled: false
  },
  onLoad() {
    this.updateNavBar();
    this.loadTransactions(true);
  },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onPageScroll({ scrollTop }) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  onReachBottom() {
    if (this.data.nextCursor && !this.data.loadingMore) this.loadTransactions(false);
  },
  updateNavBar(size) {
    const layout = getNavigationLayout(size);
    this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle });
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  retry() { this.loadTransactions(true); },
  loadMore() {
    if (this.data.nextCursor) this.loadTransactions(false);
  },
  async loadTransactions(reset = false) {
    if (this.data.loadingMore) return;
    if (reset) this.setData({ loading: true, loadFailed: false });
    else this.setData({ loadingMore: true });
    try {
      const cursor = reset ? '' : this.data.nextCursor || '';
      const result = await request(`/points/transactions?limit=20${cursor ? `&cursor=${cursor}` : ''}`);
      const incoming = (result.items || []).map(decorateTransaction);
      const transactions = reset ? incoming : appendUnique(this.data.transactions, incoming);
      this.setData({
        transactions,
        groups: groupTransactions(transactions),
        nextCursor: result.next_cursor || null,
        loadFailed: false
      });
    } catch (error) {
      if (reset) this.setData({ transactions: [], groups: [], nextCursor: null, loadFailed: true });
      showError(error);
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  }
});

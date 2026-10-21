import { request, showError } from '../../services/api';
import { POINTS_TERMS_VERSION } from '../../config/legal';
import { getNavigationLayout } from '../../utils/navigation';
import { loadPointsDashboard, readPointsDashboard } from '../../utils/points-dashboard';

const transactionTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 16).replace('T', ' ');
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} ${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}`;
};

Page({
  data: {
    loading: true,
    refreshing: false,
    refreshFeedback: '',
    activating: false,
    agreed: false,
    summary: null,
    transactions: [],
    navShellStyle: '',
    navBarStyle: '',
    navScrolled: false
  },
  onLoad() {
    this.updateNavBar();
    this.restoreDashboard();
    this.load();
  },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onUnload() { clearTimeout(this._refreshFeedbackTimer); },
  onPageScroll({ scrollTop }) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  onPointsScroll({ detail } = {}) {
    const navScrolled = (detail?.scrollTop || 0) > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  onPointsRefresh() {
    if (this.data.loading || this.data.refreshing || this.data.activating) {
      this.setData({ refreshing: false });
      return;
    }
    this.load({ force: true, refreshing: true });
  },
  updateNavBar(size) {
    const layout = getNavigationLayout(size);
    this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle });
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  decorateSummary(summary) {
    return {
      ...summary,
      rules: (summary.rules || []).map((rule) => ({
        ...rule,
        progress_percent: rule.daily_limit ? Math.min(100, Math.round((rule.progress || 0) / rule.daily_limit * 100)) : 0,
        reward_label: `+${rule.points}/题`
      }))
    };
  },
  decorateTransactions(items = []) {
    return items.map((item) => ({ ...item, time_label: transactionTime(item.created_at) }));
  },
  applyDashboard(dashboard) {
    const summary = this.decorateSummary(dashboard);
    const transactions = summary.status === 'active'
      ? this.decorateTransactions(summary.recent_transactions || [])
      : [];
    this.setData({ summary, transactions, loading: false });
  },
  restoreDashboard() {
    const dashboard = readPointsDashboard({ allowStale: true });
    if (!dashboard) return;
    this.applyDashboard(dashboard);
  },
  async load({ force = false, refreshing = false } = {}) {
    if (refreshing) {
      clearTimeout(this._refreshFeedbackTimer);
      this.setData({ refreshing: true, refreshFeedback: 'loading' });
    } else if (!this.data.summary) {
      this.setData({ loading: true });
    }
    let succeeded = false;
    try {
      this.applyDashboard(await loadPointsDashboard({ force }));
      succeeded = true;
    } catch (error) { showError(error); }
    finally {
      if (refreshing) this.finishRefreshFeedback(succeeded);
      else this.setData({ loading: false });
    }
  },
  finishRefreshFeedback(succeeded) {
    clearTimeout(this._refreshFeedbackTimer);
    this.setData({ refreshing: false, refreshFeedback: succeeded ? 'success' : '' });
    if (!succeeded) return;
    this._refreshFeedbackTimer = setTimeout(() => this.setData({ refreshFeedback: '' }), 1000);
  },
  toggleAgreement() {
    if (this.data.activating) return;
    this.setData({ agreed: !this.data.agreed });
  },
  openLegal(event) {
    const type = event.currentTarget.dataset.type === 'agreement' ? 'agreement' : 'privacy';
    wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  },
  async activate() {
    if (this.data.activating) return;
    if (!this.data.agreed) return wx.showToast({ title: '请先阅读并勾选同意', icon: 'none' });
    this.setData({ activating: true });
    try {
      await request('/points/activate', {
        method: 'POST',
        data: { agreement_consent: true, privacy_consent: true, terms_version: POINTS_TERMS_VERSION }
      });
      wx.showToast({ title: '学习积分已开启', icon: 'success' });
      await this.load({ force: true });
    } catch (error) { showError(error); }
    finally { this.setData({ activating: false }); }
  },
  openTransactions() { wx.navigateTo({ url: '/pages/points-history/index' }); }
});

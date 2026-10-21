import { request, showError } from '../../services/api';
import { subjectName } from '../../utils/format';
import { getNavigationLayout } from '../../utils/navigation';
import { buildCheckinMonth, shiftMonth } from '../../utils/checkin-calendar';

const pad = (value) => String(value).padStart(2, '0');

const historyTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { dateLabel: '--', clockLabel: '--:--' };
  return {
    dateLabel: `${date.getMonth() + 1}月${date.getDate()}日`,
    clockLabel: `${pad(date.getHours())}:${pad(date.getMinutes())}`
  };
};

// 统一 /practice-records 与 /profile/checkin?date= 两种记录形状。
const recordCard = (item) => {
  const total = Number(item.total_count) || 0;
  const graded = Number(item.graded_count) || 0;
  const pending = item.pending_count === undefined ? Math.max(0, total - graded) : Number(item.pending_count);
  const rawAccuracy = item.accuracy === null || item.accuracy === undefined
    ? null
    : Math.max(0, Math.min(100, Number(item.accuracy) || 0));
  return {
    _id: item._id || item.id,
    subject: item.subject,
    type: item.type,
    total_count: total,
    pending_count: pending,
    accuracy: rawAccuracy,
    accuracyPercent: Math.max(0, Math.min(100, Number(rawAccuracy) || 0)),
    accuracyLabel: pending > 0 ? `待自评 ${pending} 道` : (rawAccuracy === null ? '待自评' : `${rawAccuracy}%`),
    subjectLabel: subjectName(item.subject),
    ...historyTime(item.submitted_at),
    typeLabel: item.type === 'recommended' ? '推荐练习' : item.type === 'comprehensive' ? '综合练习' : '复习练习'
  };
};

Page({
  data: {
    loading: true,
    summary: {},
    items: [],
    recordsLoading: false,
    checkinYear: 0,
    checkinMonth: 0,
    checkinMonthLabel: '',
    checkinWeeks: [],
    checkinDays: [],
    checkinSelectedDate: '',
    checkinLoading: false,
    checkinWeekdays: ['一', '二', '三', '四', '五', '六', '日'],
    navShellStyle: '',
    navBarStyle: '',
    navScrolled: false
  },
  onLoad() {
    this.updateNavBar();
    const now = new Date();
    this.loadCheckinMonth(now.getFullYear(), now.getMonth() + 1);
  },
  onShow() {
    this.setData({ checkinSelectedDate: '' });
    this.load();
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onPageScroll({ scrollTop }) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  updateNavBar(size) {
    const layout = getNavigationLayout(size);
    this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle });
  },
  async load() {
    this.setData({ loading: true });
    try {
      const result = await request('/practice-records');
      this.setData({
        summary: result.summary,
        items: result.items.map(recordCard)
      });
    } catch (error) { showError(error); }
    finally { this.setData({ loading: false }); }
  },
  async loadCheckinMonth(year, month) {
    this.setData({
      checkinLoading: true,
      checkinYear: year,
      checkinMonth: month,
      checkinMonthLabel: `${year}年${month}月`
    });
    try {
      const result = await request(`/profile/checkin?month=${year}-${pad(month)}`);
      const days = result.days || [];
      this.setData({ checkinDays: days, checkinWeeks: buildCheckinMonth(year, month, days) });
    } catch (error) { showError(error); }
    finally { this.setData({ checkinLoading: false }); }
  },
  changeCheckinMonth(event) {
    const delta = Number(event.currentTarget.dataset.delta) || 0;
    const next = shiftMonth(this.data.checkinYear, this.data.checkinMonth, delta);
    this.loadCheckinMonth(next.year, next.month);
  },
  selectCheckinDay(event) {
    const date = String(event.currentTarget.dataset.date || '');
    const day = Number(event.currentTarget.dataset.day) || 0;
    if (!date || !day || !this.data.checkinDays.includes(date)) return;
    if (this.data.checkinSelectedDate === date) {
      this.showAllRecords();
      return;
    }
    this.setData({ checkinSelectedDate: date });
    this.loadDayRecords(date);
  },
  showAllRecords() {
    this.setData({ checkinSelectedDate: '' });
    this.load();
  },
  async loadDayRecords(date) {
    this.setData({ recordsLoading: true });
    try {
      const result = await request(`/profile/checkin?date=${date}`);
      this.setData({ items: (result.items || []).map(recordCard) });
    } catch (error) { showError(error); }
    finally { this.setData({ recordsLoading: false }); }
  },
  open(event) {
    wx.navigateTo({ url: `/pages/practice-result/index?id=${event.currentTarget.dataset.id}` });
  }
});

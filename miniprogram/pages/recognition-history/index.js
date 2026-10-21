import { request, showError } from '../../services/api';
import { dateText } from '../../utils/format';
import { getNavigationLayout } from '../../utils/navigation';

Page({
  data: { loading: true, items: [], navShellStyle: '', navBarStyle: '', navScrolled: false },
  onLoad() { this.updateNavBar(); },
  onShow() { this.load(); },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onPageScroll({ scrollTop }) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  updateNavBar(size) {
    const layout = getNavigationLayout(size);
    this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle });
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  async load() {
    this.setData({ loading: true });
    try {
      const result = await request('/questions?source=photo&limit=50');
      this.setData({ items: (result.items || []).map((item) => ({ ...item, dateLabel: dateText(item.created_at) })) });
    } catch (error) { showError(error); }
    finally { this.setData({ loading: false }); }
  },
  openQuestion(event) { wx.navigateTo({ url: `/pages/question-detail/index?id=${event.detail.id}` }); },
  capture() { wx.navigateTo({ url: '/pages/crop/index' }); }
});

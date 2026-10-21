import { APP_INFO } from '../../config/app-info';
import { getNavigationLayout } from '../../utils/navigation';
import { appShareMessage, enableShareMenu, timelineShareMessage } from '../../utils/share';

Page({
  data: {
    app: APP_INFO,
    navShellStyle: '',
    navBarStyle: '',
    navScrolled: false,
    features: [
      { icon: '拍', title: '拍照收录', description: '裁剪错题图片，快速整理进个人题库' },
      { icon: '析', title: 'AI 解析', description: '识别题目内容，生成结构化题目与解析' },
      { icon: '搜', title: '智能检索', description: '按科目、知识点和语义查找个人错题' },
      { icon: '练', title: '巩固练习', description: '从已有错题中推荐练习并复盘掌握情况' }
    ]
  },

  onLoad() { this.updateNavBar(); },
  onShow() { enableShareMenu(); },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onPageScroll({ scrollTop }) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  onShareAppMessage() { return appShareMessage(); },
  onShareTimeline() { return timelineShareMessage(); },
  updateNavBar(size) {
    const layout = getNavigationLayout(size);
    this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle });
  },

  back() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) });
  },

  openLegal(event) {
    const type = event.currentTarget.dataset.type === 'agreement' ? 'agreement' : 'privacy';
    wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  }
});

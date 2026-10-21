import { request, showError } from '../../services/api';
import { getNavigationLayout } from '../../utils/navigation';
import { normalizeVisibleSubjects, subjectItemsForKeys, SUBJECTS } from '../../config/subjects';

const clampRate = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

Page({
  data: {
    subject: 'math',
    visibleSubjects: SUBJECTS,
    loading: true,
    radar: [],
    items: [],
    navShellStyle: '',
    navBarStyle: '',
    navScrolled: false,
    radarCanvasStyle: '',
    radarStageStyle: '',
    radarSize: 280,
    radarTop: 22,
    radarContentWidth: 337
  },
  onLoad(options) {
    const visibleKeys = normalizeVisibleSubjects(wx.getStorageSync('visible_subjects'));
    const requestedSubject = options.subject || getApp().globalData.currentSubject || 'math';
    const subject = visibleKeys.includes(requestedSubject) ? requestedSubject : visibleKeys[0];
    this.setData({ subject, visibleSubjects: subjectItemsForKeys(visibleKeys) });
    this.updateLayout();
  },
  onShow() { this.load(); },
  onResize({ size } = {}) { this.updateLayout(size); },
  onPageScroll({ scrollTop }) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  switchSubject(event) {
    const subject = event.currentTarget.dataset.subject;
    if (!subject || subject === this.data.subject) return;
    getApp().globalData.currentSubject = subject;
    wx.setStorageSync('current_subject', subject);
    this.setData({ subject });
    this.load();
  },
  updateLayout(size) {
    const runtimeWindowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const windowInfo = { ...runtimeWindowInfo, ...(size || {}) };
    const navigation = getNavigationLayout(size);
    const windowWidth = windowInfo.windowWidth || 375;
    const contentWidth = windowWidth * (1 - 76 / 750);
    const radarSize = Math.min(320, Math.max(240, contentWidth * 0.84));
    const radarTop = 24;
    const stageHeight = radarSize + 52;
    const radarLeft = (contentWidth - radarSize) / 2;
    const layout = {
      navShellStyle: navigation.shellStyle,
      navBarStyle: navigation.barStyle,
      radarCanvasStyle: `left:${radarLeft}px;top:${radarTop}px;width:${radarSize}px;height:${radarSize}px;`,
      radarStageStyle: `height:${stageHeight}px;`,
      radarSize,
      radarTop,
      radarContentWidth: contentWidth
    };
    this.setData({ ...layout, radar: this.positionRadar(this.data.radar, layout) }, () => this.drawRadar());
  },
  positionRadar(items, layout = this.data) {
    const count = items.length;
    if (!count) return [];
    const size = layout.radarSize;
    const centerX = layout.radarContentWidth / 2;
    const centerY = layout.radarTop + size / 2;
    const horizontalRadius = Math.min(size * 0.47, centerX - 54);
    const verticalRadius = size * 0.48;
    return items.map((item, index) => {
      const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
      const left = centerX + Math.cos(angle) * horizontalRadius;
      const top = centerY + Math.sin(angle) * verticalRadius;
      return { ...item, labelStyle: `left:${left}px;top:${top}px;` };
    });
  },
  async load() {
    this.setData({ loading: true });
    try {
      const result = await request(`/mastery?subject=${this.data.subject}`);
      const items = (result.items || []).map((item) => ({ ...item, mastery_rate: clampRate(item.mastery_rate) }));
      const radarSource = (result.radar || []).map((item) => ({ ...item, mastery_rate: clampRate(item.mastery_rate) }));
      const radar = this.positionRadar(radarSource);
      this.setData({ radar, items }, () => this.drawRadar());
    }
    catch (error) { showError(error); }
    finally { this.setData({ loading: false }); }
  },
  drawRadar() {
    const items = this.data.radar;
    if (items.length < 3) return;
    wx.createSelectorQuery().select('#radarCanvas').fields({ node: true, size: true }).exec((result) => {
      const canvas = result?.[0]?.node;
      if (!canvas) return;
      const size = this.data.radarSize;
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 1;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const cx = size / 2; const cy = size / 2; const radius = size * 0.37; const count = items.length;
      ctx.clearRect(0, 0, size, size);
      ctx.strokeStyle = '#aeb8ba'; ctx.lineWidth = 1;
      for (let level = 1; level <= 4; level++) {
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          const angle = -Math.PI / 2 + i * 2 * Math.PI / count;
          const levelRadius = radius * level / 4;
          const x = cx + Math.cos(angle) * levelRadius;
          const y = cy + Math.sin(angle) * levelRadius;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath(); ctx.stroke();
      }
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + i * 2 * Math.PI / count;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
        ctx.stroke();
      }
      ctx.beginPath();
      items.forEach((item, index) => {
        const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
        const valueRadius = radius * item.mastery_rate / 100;
        const x = cx + Math.cos(angle) * valueRadius;
        const y = cy + Math.sin(angle) * valueRadius;
        index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(15,190,184,.42)';
      ctx.strokeStyle = '#069f9a';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();
    });
  },
  filter(event) { getApp().globalData.listFilters = { knowledge_point: event.currentTarget.dataset.point }; wx.switchTab({ url: '/pages/question-list/index' }); }
});

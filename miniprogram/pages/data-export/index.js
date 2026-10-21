import { request, showError } from '../../services/api';
import { getNavigationLayout } from '../../utils/navigation';

const downloadExportPdf = (result) => new Promise((resolve, reject) => {
  const fileId = String(result?.pdf_file_id || '');
  const downloadUrl = String(result?.pdf_download_url || '');
  const fail = (error) => reject({ message: '导出文件下载失败，请稍后重试', detail: error?.errMsg || '' });
  if (/^cloud:\/\//i.test(fileId) && wx.cloud?.downloadFile) {
    wx.cloud.downloadFile({ fileID: fileId, success: ({ tempFilePath }) => tempFilePath ? resolve(tempFilePath) : fail(), fail });
    return;
  }
  if (/^https?:\/\//i.test(downloadUrl)) {
    wx.downloadFile({
      url: downloadUrl,
      success: ({ statusCode, tempFilePath }) => statusCode === 200 && tempFilePath ? resolve(tempFilePath) : fail({ errMsg: `HTTP ${statusCode || 0}` }),
      fail
    });
    return;
  }
  reject({ message: fileId.startsWith('memory://') ? '本地测试环境已生成数据，但不提供文件下载' : '导出文件暂时不可用' });
});

const openExportPdf = (filePath) => new Promise((resolve, reject) => wx.openDocument({
  filePath,
  fileType: 'pdf',
  showMenu: true,
  success: resolve,
  fail: (error) => reject({ message: '导出完成，但 PDF 无法打开', detail: error?.errMsg || '' })
}));

Page({
  data: {
    loading: true,
    exporting: false,
    questionCount: 0,
    practiceCount: 0,
    lastExport: null,
    navShellStyle: '',
    navBarStyle: '',
    navScrolled: false
  },
  onLoad() { this.updateNavBar(); this.loadSummary(); },
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
  async loadSummary() {
    try {
      const [profile, history] = await Promise.all([request('/profile'), request('/practice-records?limit=100')]);
      this.setData({
        questionCount: Number(profile?.stats?.total_questions) || 0,
        practiceCount: Number(history?.summary?.practice_count) || 0
      });
    } catch (error) { showError(error); }
    finally { this.setData({ loading: false }); }
  },
  async exportData() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    wx.showLoading({ title: '正在生成', mask: true });
    try {
      const result = await request('/exports', { method: 'POST', timeout: 60000 });
      this.setData({ lastExport: result });
      wx.showLoading({ title: '正在打开', mask: true });
      const filePath = await downloadExportPdf(result);
      wx.hideLoading();
      await openExportPdf(filePath);
    } catch (error) {
      wx.hideLoading();
      showError(error);
    } finally { this.setData({ exporting: false }); }
  }
});

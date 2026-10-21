import { request, showError } from '../../services/api';
import { LEGAL_VERSION } from '../../config/legal';

Page({
  data: {
    loading: false,
    agreed: false,
    returnToPrevious: false,
    frameStyle: ''
  },
  onLoad(options = {}) {
    this.setData({ returnToPrevious: options.return_to === 'previous' });
    this.updateFrame();
  },
  onShow() {
    if (getApp().globalData.token) this.finishLoginNavigation();
  },
  onResize({ size }) {
    this.updateFrame(size);
  },
  updateFrame(size) {
    const windowInfo = size || (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    const windowWidth = windowInfo.windowWidth;
    const windowHeight = windowInfo.windowHeight;
    const menuRect = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
    const prototypeRatio = 9 / 16;
    let frameWidth = windowWidth;
    let frameHeight = frameWidth / prototypeRatio;

    if (frameHeight > windowHeight) {
      frameHeight = windowHeight;
      frameWidth = frameHeight * prototypeRatio;
    }

    const left = (windowWidth - frameWidth) / 2;
    const centeredTop = (windowHeight - frameHeight) / 2;
    const capsuleBottom = Number(menuRect?.bottom) || 0;
    const top = capsuleBottom > 0 && capsuleBottom + frameHeight <= windowHeight
      ? capsuleBottom
      : centeredTop;
    this.setData({
      frameStyle: `width:${frameWidth}px;height:${frameHeight}px;left:${left}px;top:${top}px;`
    });
  },
  async login() {
    if (this.data.loading) return;
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并勾选同意协议', icon: 'none', duration: 2200 });
      return;
    }
    this.setData({ loading: true });
    let loginError = null;
    try {
      wx.showLoading({ title: '登录中…', mask: true });
      const loginResult = await new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }));
      const result = await request('/auth/wechat-login', {
        method: 'POST',
        data: {
          code: loginResult.code || 'dev-user',
          agreement_consent: true,
          privacy_consent: true,
          consent_version: LEGAL_VERSION
        }
      });
      getApp().globalData.token = result.token;
      getApp().globalData.user = result.user || null;
      wx.setStorageSync('session_token', result.token);
      if (result.user) wx.setStorageSync('profile_user', result.user);
      this.finishLoginNavigation();
    } catch (error) {
      loginError = error;
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
    if (loginError) showError(loginError);
  },
  finishLoginNavigation() {
    if (this.data.returnToPrevious && getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/index' }) });
      return;
    }
    wx.switchTab({ url: '/pages/home/index' });
  },
  toggleAgreement() {
    if (this.data.loading) return;
    this.setData({ agreed: !this.data.agreed });
  },
  showAgreement(event) {
    const type = event.currentTarget.dataset.type;
    wx.navigateTo({ url: `/pages/legal/index?type=${type === 'privacy' ? 'privacy' : 'agreement'}` });
  },
  continueAsGuest() {
    if (this.data.loading) return;
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1,
        fail: () => wx.switchTab({ url: '/pages/home/index' })
      });
      return;
    }
    wx.switchTab({ url: '/pages/home/index' });
  }
});

import { request, showError, uploadFile } from '../../services/api';
import { clearAuthSession, isLoggedIn, promptLogin } from '../../utils/auth';
import { APP_INFO } from '../../config/app-info';
import { getNavigationLayout } from '../../utils/navigation';
import { appShareMessage, enableShareMenu, timelineShareMessage } from '../../utils/share';
import { loadPointsDashboard } from '../../utils/points-dashboard';

const DEFAULT_AVATAR = '/assets/profile/avatar.jpg';
const LOCAL_AVATAR_KEY = 'profile_avatar_local';
const isDisplayableAvatar = (value) => /^(https?:\/\/|wxfile:\/\/|cloud:\/\/)/i.test(String(value || ''));

const keepLocalAvatar = (tempFilePath) => new Promise((resolve) => {
  const fileSystem = wx.getFileSystemManager?.();
  if (!fileSystem?.saveFile) return resolve('');
  fileSystem.saveFile({
    tempFilePath,
    success: ({ savedFilePath }) => resolve(savedFilePath || ''),
    fail: () => resolve('')
  });
});

const removeLocalAvatar = (filePath) => {
  if (!filePath) return;
  const fileSystem = wx.getFileSystemManager?.();
  if (!fileSystem?.unlink) return;
  fileSystem.unlink({ filePath, fail: () => {} });
};

const isCancel = (error) => /cancel/i.test(error?.errMsg || '');

const selectAvatarFile = () => new Promise((resolve, reject) => {
  wx.chooseImage({
    count: 1,
    sourceType: ['album', 'camera'],
    sizeType: ['compressed'],
    success: ({ tempFilePaths }) => resolve(tempFilePaths?.[0] || ''),
    fail: (error) => isCancel(error) ? resolve('') : reject(error)
  });
});

const imageInfo = (src) => new Promise((resolve, reject) => wx.getImageInfo({ src, success: resolve, fail: reject }));

Page({
  data: {
    loading: true,
    isGuest: false,
    profile: null,
    avatarSrc: DEFAULT_AVATAR,
    editingNickname: false,
    draftNickname: '',
    savingNickname: false,
    uploadingAvatar: false,
    loggingOut: false,
    appVersion: APP_INFO.version,
    navShellStyle: '',
    navBarStyle: '',
    navScrolled: false,
  },
  onLoad() { this.updateNavBar(); },
  onShow() {
    enableShareMenu();
    this.getTabBar()?.setSelected(3);
    if (!isLoggedIn()) {
      this.setData({ loading: false, isGuest: true, profile: null, avatarSrc: DEFAULT_AVATAR });
      return;
    }
    this.setData({ isGuest: false });
    loadPointsDashboard({ force: true }).catch(() => {});
    this.load();
  },
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
  openLogin() { promptLogin('登录后可同步错题、练习记录和学习进度。'); },
  async load() {
    this.setData({ loading: true });
    try {
      const profile = await request('/profile');
      const localAvatar = wx.getStorageSync(LOCAL_AVATAR_KEY) || '';
      const avatarSrc = isDisplayableAvatar(profile.user.avatar_url) ? profile.user.avatar_url : (localAvatar || DEFAULT_AVATAR);
      getApp().globalData.user = profile.user;
      wx.setStorageSync('profile_user', profile.user);
      this.setData({
        profile,
        avatarSrc,
        draftNickname: profile.user.nickname || '学霸同学'
      });
    }
    catch (error) { showError(error); }
    finally { this.setData({ loading: false }); }
  },
  async selectAvatar() {
    if (this.data.uploadingAvatar) return;
    let tempFilePath = '';
    try { tempFilePath = await selectAvatarFile(); }
    catch (error) { showError({ message: error?.errMsg || '选择头像失败' }); return; }
    if (!tempFilePath || this.data.uploadingAvatar) return;
    const previousAvatar = this.data.avatarSrc;
    this.setData({ avatarSrc: tempFilePath, uploadingAvatar: true });
    wx.showLoading({ title: '保存头像', mask: true });
    let avatarError = null;
    try {
      let uploadPath = tempFilePath;
      try { uploadPath = await this.createAvatarUploadFile(tempFilePath); }
      catch (error) {
        console.warn('[avatar-resize-fallback]', { message: error?.message || error?.errMsg || String(error || '') });
      }
      // saveFile 会移动临时文件；必须等待上传读完后再保存，避免 uploadFile 报 file not found。
      const user = await uploadFile('/profile/avatar', uploadPath, 'avatar');
      const previousLocalAvatar = wx.getStorageSync(LOCAL_AVATAR_KEY) || '';
      const savedLocalAvatar = await keepLocalAvatar(uploadPath);
      if (savedLocalAvatar) {
        wx.setStorageSync(LOCAL_AVATAR_KEY, savedLocalAvatar);
        if (previousLocalAvatar && previousLocalAvatar !== savedLocalAvatar) removeLocalAvatar(previousLocalAvatar);
      }
      wx.setStorageSync('profile_user', user);
      getApp().globalData.user = user;
      const avatarSrc = isDisplayableAvatar(user.avatar_url)
        ? user.avatar_url
        : (savedLocalAvatar || previousLocalAvatar || uploadPath);
      this.setData({ avatarSrc, profile: { ...this.data.profile, user } });
      wx.showToast({ title: '头像已保存', icon: 'success' });
    } catch (error) {
      avatarError = error;
      this.setData({ avatarSrc: previousAvatar });
    } finally {
      wx.hideLoading();
      this.setData({ uploadingAvatar: false });
    }
    if (avatarError) showError(avatarError);
  },
  async createAvatarUploadFile(imagePath) {
    const info = await imageInfo(imagePath);
    const sourceWidth = Number(info.width) || 0;
    const sourceHeight = Number(info.height) || 0;
    if (!sourceWidth || !sourceHeight) throw new Error('无法读取头像尺寸');
    const side = Math.min(sourceWidth, sourceHeight);
    const sx = Math.max(0, Math.round((sourceWidth - side) / 2));
    const sy = Math.max(0, Math.round((sourceHeight - side) / 2));
    const targetSize = 160;
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().select('#avatarCanvas').fields({ node: true, size: true }).exec((result) => {
        const canvas = result?.[0]?.node;
        if (!canvas) { reject(new Error('头像画布初始化失败')); return; }
        canvas.width = targetSize;
        canvas.height = targetSize;
        const context = canvas.getContext('2d');
        const image = canvas.createImage();
        image.onload = () => {
          context.clearRect(0, 0, targetSize, targetSize);
          context.drawImage(image, sx, sy, side, side, 0, 0, targetSize, targetSize);
          wx.canvasToTempFilePath({
            canvas,
            x: 0,
            y: 0,
            width: targetSize,
            height: targetSize,
            destWidth: targetSize,
            destHeight: targetSize,
            fileType: 'jpg',
            quality: 0.58,
            success: ({ tempFilePath }) => tempFilePath ? resolve(tempFilePath) : reject(new Error('头像生成失败')),
            fail: reject
          });
        };
        image.onerror = () => reject(new Error('头像图片加载失败'));
        image.src = imagePath;
      });
    });
  },
  startEditNickname() {
    this.setData({ editingNickname: true, draftNickname: this.data.profile?.user?.nickname || '' });
  },
  inputNickname(event) { this.setData({ draftNickname: event.detail.value }); },
  cancelNickname() {
    this.setData({ editingNickname: false, draftNickname: this.data.profile?.user?.nickname || '学霸同学' });
  },
  async saveNickname() {
    if (this.data.savingNickname) return;
    const nickname = this.data.draftNickname.trim();
    if (!nickname) return wx.showToast({ title: '请输入昵称', icon: 'none' });
    this.setData({ savingNickname: true });
    try {
      const user = await request('/profile', { method: 'PATCH', data: { nickname } });
      wx.setStorageSync('profile_user', user);
      getApp().globalData.user = user;
      this.setData({
        profile: { ...this.data.profile, user },
        draftNickname: user.nickname,
        editingNickname: false
      });
      wx.showToast({ title: '昵称已保存', icon: 'success' });
    } catch (error) { showError(error); }
    finally { this.setData({ savingNickname: false }); }
  },
  openQuestions() {
    getApp().globalData.libraryReturnTab = '/pages/profile/index';
    wx.switchTab({ url: '/pages/question-list/index' });
  },
  openMastery() { wx.navigateTo({ url: '/pages/mastery/index' }); },
  openPoints() {
    loadPointsDashboard().catch(() => {});
    wx.navigateTo({ url: '/pages/points/index' });
  },
  openAbout() { wx.navigateTo({ url: '/pages/about/index' }); },
  openExport() { wx.navigateTo({ url: '/pages/data-export/index' }); },
  openPrivacy() { wx.navigateTo({ url: '/pages/legal/index?type=privacy' }); },
  openSettings() { wx.navigateTo({ url: '/pages/settings/index' }); },
  openStudyRecords() { wx.navigateTo({ url: '/pages/practice-history/index' }); },
  openRecognitions() { wx.navigateTo({ url: '/pages/recognition-history/index' }); },
  logout() {
    if (this.data.loggingOut) return;
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录才能同步错题和学习记录，本机未提交的练习答案将被清除。',
      confirmText: '退出登录',
      confirmColor: '#e45454',
      success: ({ confirm }) => {
        if (!confirm) return;
        this.setData({ loggingOut: true });
        clearAuthSession();
        this.setData({
          loggingOut: false,
          loading: false,
          isGuest: true,
          profile: null,
          avatarSrc: DEFAULT_AVATAR,
          editingNickname: false,
          uploadingAvatar: false,
          savingNickname: false
        });
        wx.pageScrollTo?.({ scrollTop: 0, duration: 200 });
      }
    });
  }
});

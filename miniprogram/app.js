import { getRuntimeConfig } from './config/env';
import { learningReminderDelay, localDateKey } from './utils/learning-reminder';

const runtimeConfig = getRuntimeConfig();

App({
  globalData: {
    ...runtimeConfig,
    token: '',
    user: null,
    currentSubject: 'math',
    practiceSessionId: '',
    pendingPracticeEntry: null,
    listFilters: {},
    libraryReturnTab: '',
    libraryRestoreRequested: false,
    recognitionImagePath: '',
    pendingRecognition: null,
    pointsDashboardCache: null,
    pointsDashboardPromise: null
  },

  onLaunch() {
    this.globalData.token = wx.getStorageSync('session_token') || '';
    this.globalData.user = wx.getStorageSync('profile_user') || null;
    this.globalData.currentSubject = wx.getStorageSync('current_subject') || 'math';
    this.globalData.practiceSessionId = wx.getStorageSync('practice_session_id') || '';
    if (this.globalData.apiTransport === 'cloud') {
      if (!wx.cloud) {
        wx.showModal({ title: '当前版本过低', content: '请升级微信后重试', showCancel: false });
        return;
      }
      try {
        wx.cloud.init({ env: this.globalData.cloudEnvId, traceUser: true });
      } catch (error) {
        console.error('云开发初始化失败', error);
      }
    } else if (!this.globalData.apiBaseUrl) {
      wx.showModal({
        title: '后端地址未配置',
        content: `请先在 config/env.js 中配置 ${this.globalData.envVersion} 环境的 HTTPS API 地址`,
        showCancel: false
      });
    }
  },

  onShow() { this.scheduleLearningReminder(); },
  onHide() { this.clearLearningReminder(); },

  clearLearningReminder() {
    if (!this._learningReminderTimer) return;
    clearTimeout(this._learningReminderTimer);
    this._learningReminderTimer = null;
  },

  scheduleLearningReminder() {
    this.clearLearningReminder();
    const settings = wx.getStorageSync('learning_settings') || {};
    const delay = learningReminderDelay(settings, wx.getStorageSync('last_learning_reminder_date'));
    if (delay === null) return;
    // setTimeout 上限远大于一天；页面留在前台时也能在设置时间准时触发。
    this._learningReminderTimer = setTimeout(() => this.showLearningReminder(), Math.min(delay, 86_400_000));
  },

  showLearningReminder() {
    this._learningReminderTimer = null;
    const settings = wx.getStorageSync('learning_settings') || {};
    const today = localDateKey();
    if (learningReminderDelay(settings, wx.getStorageSync('last_learning_reminder_date')) !== 0) return;
    wx.setStorageSync('last_learning_reminder_date', today);
    wx.showModal({
      title: '今日巩固提醒',
      content: '现在练几道薄弱知识点错题，让掌握更牢固。',
      cancelText: '稍后再说',
      confirmText: '去练习',
      confirmColor: '#08a78f',
      success: ({ confirm }) => {
        if (!confirm) return;
        wx.switchTab({
          url: '/pages/home/index',
          success: () => setTimeout(() => {
            const pages = getCurrentPages();
            pages[pages.length - 1]?.startRecommended?.();
          }, 120)
        });
      }
    });
  }
});

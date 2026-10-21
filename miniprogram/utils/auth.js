import { clearAllPracticeSessions } from './practice-session';

export const isLoggedIn = () => Boolean(getApp().globalData.token);

export const clearAuthSession = () => {
  const application = getApp();
  clearAllPracticeSessions();
  [
    'session_token',
    'profile_user',
    'profile_avatar_local'
  ].forEach((key) => wx.removeStorageSync(key));

  application.globalData.token = '';
  application.globalData.user = null;
  application.globalData.listFilters = {};
  application.globalData.pendingPracticeEntry = null;
  application.globalData.recognitionImagePath = '';
};

export const promptLogin = (content = '登录后可同步你的学习数据，当前仍可继续浏览。') => {
  wx.showModal({
    title: '登录后继续',
    content,
    confirmText: '去登录',
    cancelText: '继续浏览',
    success: ({ confirm }) => {
      if (confirm) wx.navigateTo({ url: '/pages/login/index' });
    }
  });
};

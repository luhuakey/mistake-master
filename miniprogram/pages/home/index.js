import { request, showError } from '../../services/api';
import { isLoggedIn, promptLogin } from '../../utils/auth';
import { getGuestQuestions, getGuestSummary } from '../../utils/guest-data';
import { getNavigationLayout } from '../../utils/navigation';
import { normalizeVisibleSubjects, subjectItemsForKeys, SUBJECTS } from '../../config/subjects';
import { appShareMessage, enableShareMenu, timelineShareMessage } from '../../utils/share';

const pad = (value) => String(value).padStart(2, '0');

const mixColor = (from, to, ratio) => {
  const channel = (index) => Math.round(from[index] + (to[index] - from[index]) * ratio);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
};

const accuracyRingBackground = (value) => {
  const progress = Math.max(0, Math.min(100, Number(value) || 0));
  if (progress <= 0) return 'background:#e8f8f7;';
  const ratio = progress / 100;
  const startColor = mixColor([107, 231, 209], [31, 183, 165], ratio);
  const endColor = mixColor([72, 217, 191], [0, 110, 104], ratio);
  if (progress >= 100) {
    return `background:conic-gradient(from 0deg,${startColor} 0%,${endColor} 100%);`;
  }
  return `background:conic-gradient(from 0deg,${startColor} 0%,${endColor} ${progress}%,#e8f8f7 ${progress}% 100%);`;
};

const timeLabel = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--' : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const presentQuestion = (question) => {
  const id = String(question.id || question._id || '');
  const stem = String(question.stem || '');
  return {
    ...question,
    id,
    stem,
    stemTruncated: [...stem].length > 38,
    displayTags: (question.knowledge_points || []).slice(0, 3),
    timeLabel: timeLabel(question.created_at)
  };
};

Page({
  data: {
    subject: 'math',
    visibleSubjects: SUBJECTS,
    subjectChoices: SUBJECTS.map((item) => ({ ...item, checked: true })),
    subjectSettingsOpen: false,
    subjectDragKey: '',
    allSelected: true,
    selectedSubjectCount: SUBJECTS.length,
    savingSubjects: false,
    loading: true,
    refreshing: false,
    refreshFeedback: '',
    summary: {},
    recent: [],
    isGuest: false,
    avatarUrl: '/assets/home/avatar.jpg',
    accuracyText: '--',
    accuracyRingStyle: '',
    navStyle: '',
    subjectStickyStyle: '',
    navScrolled: false
  },
  onLoad() {
    this.updateNavBar();
  },
  onShow() {
    enableShareMenu();
    const visibleKeys = normalizeVisibleSubjects(wx.getStorageSync('visible_subjects'));
    const visibleSubjects = subjectItemsForKeys(visibleKeys);
    const currentSubject = getApp().globalData.currentSubject || 'math';
    const subject = visibleKeys.includes(currentSubject) ? currentSubject : visibleKeys[0];
    getApp().globalData.currentSubject = subject;
    this.setData({ subject, visibleSubjects });
    this.getTabBar()?.setSelected(0);
    this.load();
    this.syncSubjectSettings();
  },
  onResize() {
    this.updateNavBar();
  },
  onUnload() { clearTimeout(this._refreshFeedbackTimer); },
  onHomeRefresh() {
    if (this.data.loading || this.data.refreshing || this.data.subjectSettingsOpen) {
      this.setData({ refreshing: false });
      return;
    }
    this.load({ refreshing: true });
  },
  onHomeScroll({ detail } = {}) {
    const navScrolled = (detail?.scrollTop || 0) > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  onPageScroll({ scrollTop }) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  onShareAppMessage() { return appShareMessage(); },
  onShareTimeline() { return timelineShareMessage(); },
  updateNavBar() {
    const layout = getNavigationLayout();
    this.setData({ navStyle: layout.headerStyle, subjectStickyStyle: layout.stickyTopStyle });
  },
  async load({ refreshing = false } = {}) {
    const requestVersion = (this._homeRequestVersion || 0) + 1;
    this._homeRequestVersion = requestVersion;
    const subject = this.data.subject;
    if (refreshing) {
      clearTimeout(this._refreshFeedbackTimer);
      this.setData({ refreshing: true, refreshFeedback: 'loading' });
    } else {
      clearTimeout(this._refreshFeedbackTimer);
      this.setData({ loading: true, refreshing: false, refreshFeedback: '' });
    }
    if (!isLoggedIn()) {
      const summary = getGuestSummary(subject);
      const accuracy = summary.accuracy;
      this.setData({
        loading: false,
        isGuest: true,
        summary,
        recent: getGuestQuestions(subject).slice(0, 10).map(presentQuestion),
        avatarUrl: '/assets/home/avatar.jpg',
        accuracyText: `${accuracy}%`,
        accuracyRingStyle: accuracyRingBackground(accuracy)
      });
      if (refreshing) this.finishRefreshFeedback(true);
      return;
    }
    let succeeded = false;
    try {
      const [result, profile] = await Promise.all([
        request(`/home?subject=${subject}`),
        request('/profile')
      ]);
      if (requestVersion !== this._homeRequestVersion) return;
      const accuracy = result.summary.accuracy;
      const ringValue = Math.max(0, Math.min(100, Number(accuracy) || 0));
      const localAvatar = wx.getStorageSync('profile_avatar_local') || '';
      const remoteAvatar = /^(https?:\/\/|wxfile:\/\/|cloud:\/\/)/i.test(String(profile.user.avatar_url || '')) ? profile.user.avatar_url : '';
      getApp().globalData.user = profile.user;
      wx.setStorageSync('profile_user', profile.user);
      this.setData({
        isGuest: false,
        summary: result.summary,
        recent: (result.recent_questions || []).slice(0, 10).map(presentQuestion),
        avatarUrl: remoteAvatar || localAvatar || '/assets/home/avatar.jpg',
        accuracyText: accuracy === null ? '--' : `${accuracy}%`,
        accuracyRingStyle: accuracyRingBackground(ringValue)
      });
      succeeded = true;
    } catch (error) {
      if (requestVersion === this._homeRequestVersion) showError(error);
    }
    finally {
      if (requestVersion === this._homeRequestVersion) {
        this.setData({ loading: false });
        if (refreshing) this.finishRefreshFeedback(succeeded);
      }
    }
  },
  finishRefreshFeedback(succeeded) {
    clearTimeout(this._refreshFeedbackTimer);
    this.setData({ refreshing: false, refreshFeedback: succeeded ? 'success' : '' });
    if (!succeeded) return;
    this._refreshFeedbackTimer = setTimeout(() => {
      this.setData({ refreshFeedback: '' });
    }, 900);
  },
  changeSubject(event) {
    const subject = event.currentTarget.dataset.subject;
    getApp().globalData.currentSubject = subject;
    wx.setStorageSync('current_subject', subject);
    this.setData({ subject });
    this.load();
  },
  async syncSubjectSettings() {
    const token = getApp().globalData.token || '';
    if (!token || this._settingsToken === token) return;
    this._settingsToken = token;
    try {
      const settings = await request('/settings');
      const visibleKeys = normalizeVisibleSubjects(settings.visible_subjects);
      const visibleSubjects = subjectItemsForKeys(visibleKeys);
      const previousSubject = this.data.subject;
      const subject = visibleKeys.includes(previousSubject) ? previousSubject : visibleKeys[0];
      wx.setStorageSync('visible_subjects', visibleKeys);
      getApp().globalData.currentSubject = subject;
      this.setData({ visibleSubjects, subject });
      if (subject !== previousSubject) this.load();
    } catch (error) {
      this._settingsToken = '';
    }
  },
  openSubjectSettings() {
    const visibleKeys = this.data.visibleSubjects.map((item) => item.key);
    const visibleSet = new Set(visibleKeys);
    const subjectChoices = [
      ...subjectItemsForKeys(visibleKeys).map((item) => ({ ...item, checked: true })),
      ...SUBJECTS.filter((item) => !visibleSet.has(item.key)).map((item) => ({ ...item, checked: false }))
    ];
    this.setData({
      subjectChoices,
      allSelected: subjectChoices.every((item) => item.checked),
      selectedSubjectCount: subjectChoices.filter((item) => item.checked).length,
      subjectSettingsOpen: true
    });
  },
  closeSubjectSettings() {
    if (!this.data.savingSubjects) {
      this._subjectDrag = null;
      this.setData({ subjectSettingsOpen: false, subjectDragKey: '' });
    }
  },
  stopModalEvent() {},
  toggleSubjectChoice(event) {
    const key = event.currentTarget.dataset.key;
    const target = this.data.subjectChoices.find((item) => item.key === key);
    if (!target) return;
    const checkedItems = this.data.subjectChoices.filter((item) => item.checked && item.key !== key);
    if (target.checked && !checkedItems.length) {
      wx.showToast({ title: '至少保留一个科目', icon: 'none' });
      return;
    }
    const uncheckedItems = this.data.subjectChoices.filter((item) => !item.checked && item.key !== key);
    const choices = target.checked
      ? [...checkedItems, ...uncheckedItems, { ...target, checked: false }]
      : [...checkedItems, { ...target, checked: true }, ...uncheckedItems];
    this.setData({
      subjectChoices: choices,
      allSelected: choices.every((item) => item.checked),
      selectedSubjectCount: choices.filter((item) => item.checked).length
    });
  },
  dragSubjectStart(event) {
    const key = event.currentTarget.dataset.key;
    const touch = event.touches?.[0];
    const target = this.data.subjectChoices.find((item) => item.key === key);
    if (!touch || !target?.checked) return;
    this._subjectDrag = { key, lastY: Number(touch.clientY) || 0 };
    this.setData({ subjectDragKey: key });
  },
  dragSubjectMove(event) {
    const drag = this._subjectDrag;
    const touch = event.touches?.[0];
    if (!drag || !touch) return;
    const currentY = Number(touch.clientY) || 0;
    const delta = currentY - drag.lastY;
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const rowHeight = 62 * (Number(windowInfo.windowWidth) || 375) / 750;
    if (Math.abs(delta) < rowHeight * 0.55) return;
    const checkedItems = this.data.subjectChoices.filter((item) => item.checked);
    const uncheckedItems = this.data.subjectChoices.filter((item) => !item.checked);
    const index = checkedItems.findIndex((item) => item.key === drag.key);
    if (index < 0) return;
    const direction = delta > 0 ? 1 : -1;
    const distance = Math.max(1, Math.floor(Math.abs(delta) / rowHeight));
    const targetIndex = Math.max(0, Math.min(checkedItems.length - 1, index + direction * distance));
    if (targetIndex === index) return;
    const [moving] = checkedItems.splice(index, 1);
    checkedItems.splice(targetIndex, 0, moving);
    this._subjectDrag.lastY = currentY;
    this.setData({ subjectChoices: [...checkedItems, ...uncheckedItems] });
    try { wx.vibrateShort?.({ type: 'light' }); } catch (error) {}
  },
  dragSubjectEnd() {
    this._subjectDrag = null;
    this.setData({ subjectDragKey: '' });
  },
  toggleSelectAll() {
    const selectAll = !this.data.allSelected;
    this.setData({
      subjectChoices: this.data.subjectChoices.map((item) => ({ ...item, checked: selectAll })),
      allSelected: selectAll,
      selectedSubjectCount: selectAll ? this.data.subjectChoices.length : 0
    });
  },
  async confirmSubjectSettings() {
    if (this.data.savingSubjects) return;
    const visibleKeys = this.data.subjectChoices.filter((item) => item.checked).map((item) => item.key);
    if (!visibleKeys.length) {
      wx.showToast({ title: '至少保留一个科目', icon: 'none' });
      return;
    }
    const previousVisibleKeys = this.data.visibleSubjects.map((item) => item.key);
    const previousSubject = this.data.subject;
    const subject = visibleKeys.includes(previousSubject) ? previousSubject : visibleKeys[0];
    const visibleSubjects = subjectItemsForKeys(visibleKeys);
    wx.setStorageSync('visible_subjects', visibleKeys);
    wx.setStorageSync('current_subject', subject);
    getApp().globalData.currentSubject = subject;
    this.setData({ visibleSubjects, subject, subjectSettingsOpen: false });
    if (subject !== previousSubject) this.load();
    if (!isLoggedIn()) {
      wx.showToast({ title: '科目设置已更新', icon: 'success' });
      return;
    }
    this.setData({ savingSubjects: true });
    try {
      const settings = await request('/settings', { method: 'PATCH', data: { visible_subjects: visibleKeys } });
      const savedKeys = normalizeVisibleSubjects(settings.visible_subjects);
      wx.setStorageSync('visible_subjects', savedKeys);
      this.setData({ visibleSubjects: subjectItemsForKeys(savedKeys) });
      wx.showToast({ title: '科目设置已更新', icon: 'success' });
    } catch (error) {
      wx.setStorageSync('visible_subjects', previousVisibleKeys);
      wx.setStorageSync('current_subject', previousSubject);
      getApp().globalData.currentSubject = previousSubject;
      this.setData({ visibleSubjects: subjectItemsForKeys(previousVisibleKeys), subject: previousSubject });
      if (subject !== previousSubject) this.load();
      showError(error);
    }
    finally { this.setData({ savingSubjects: false }); }
  },
  goCrop() {
    if (!isLoggedIn()) {
      promptLogin('登录后即可拍照识别并保存错题，当前可以先浏览示例内容。');
      return;
    }
    wx.navigateTo({ url: '/pages/crop/index' });
  },
  startRecommended() {
    if (!isLoggedIn()) {
      promptLogin('登录后可根据你的错题生成个性化练习，当前可继续浏览首页。');
      return;
    }
    getApp().globalData.pendingPracticeEntry = { mode: 'recommended', subject: this.data.subject };
    wx.switchTab({ url: '/pages/practice/index' });
  },
  openProfile() { wx.switchTab({ url: '/pages/profile/index' }); },
  openLibraryMetric(event) {
    const masteryStatus = event.currentTarget.dataset.mastery;
    getApp().globalData.listFilters = {
      subject: this.data.subject,
      ...(masteryStatus === 'mastered' ? { mastery_status: 'mastered' } : {})
    };
    getApp().globalData.libraryReturnTab = '/pages/home/index';
    getApp().globalData.libraryRestoreRequested = false;
    wx.switchTab({ url: '/pages/question-list/index' });
  },
  openQuestion(event) {
    const id = event.currentTarget.dataset.id || event.detail?.id;
    if (id) wx.navigateTo({ url: `/pages/question-detail/index?id=${id}` });
  },
  openAll() {
    getApp().globalData.listFilters = {};
    getApp().globalData.libraryReturnTab = '/pages/home/index';
    getApp().globalData.libraryRestoreRequested = false;
    wx.switchTab({ url: '/pages/question-list/index' });
  }
});

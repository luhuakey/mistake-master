import { request, showError } from '../../services/api';
import { SUBJECTS, normalizeVisibleSubjects } from '../../config/subjects';
import { getNavigationLayout } from '../../utils/navigation';

const DIFFICULTIES = Object.freeze([
  { key: 'adaptive', label: '智能适配', description: '不偏向固定难度，综合知识点掌握度、历史错题率和练习间隔动态排序。' },
  { key: 'easy', label: '基础巩固', description: '在薄弱知识点优先的基础上，适当提高简单题的推荐顺序，适合打牢基础。' },
  { key: 'medium', label: '进阶练习', description: '适当提高中等题的推荐顺序，适合基础稳定后进行综合运用。' },
  { key: 'hard', label: '挑战提升', description: '适当提高困难题的推荐顺序，适合强化迁移能力和复杂问题处理。' }
]);
const REMINDER_FREQUENCIES = Object.freeze([
  { key: 'daily', label: '每天' },
  { key: 'weekdays', label: '仅工作日' }
]);
const PRACTICE_QUESTION_LIMITS = Object.freeze([
  { value: 5, label: '5 道' },
  { value: 10, label: '10 道' },
  { value: 15, label: '15 道' },
  { value: 20, label: '20 道' }
]);
const MASTERED_QUESTION_RATIOS = Object.freeze([
  { value: 0, label: '0%', description: '不主动安排已掌握题；未掌握题不足时仍会用于补足。' },
  { value: 10, label: '10%', description: '高度聚焦薄弱题，仅保留少量已掌握题用于防遗忘。' },
  { value: 20, label: '20%（专家建议）', description: '兼顾薄弱巩固与间隔复习，适合大多数学习阶段。' },
  { value: 30, label: '30%', description: '增加已掌握题复现频率，适合阶段复习和稳定性检查。' },
  { value: 40, label: '40%', description: '较多复查已掌握内容，适合考前综合回顾。' },
  { value: 50, label: '50%', description: '已掌握与未掌握题接近均衡，薄弱题较少时可选。' }
]);

const subjectItems = (visibleSubjects) => {
  const orderedVisible = normalizeVisibleSubjects(visibleSubjects);
  const visible = new Set(orderedVisible);
  const byKey = new Map(SUBJECTS.map((item) => [item.key, item]));
  return [
    ...orderedVisible.map((key) => ({ ...byKey.get(key), enabled: true })),
    ...SUBJECTS.filter((item) => !visible.has(item.key)).map((item) => ({ ...item, enabled: false }))
  ];
};

Page({
  data: {
    loading: true,
    saving: false,
    notificationEnabled: false,
    reminderTime: '20:00',
    reminderFrequencyIndex: 0,
    reminderFrequencyOptions: REMINDER_FREQUENCIES,
    recommendationWeakFirst: true,
    difficultyIndex: 0,
    difficultyOptions: DIFFICULTIES,
    practiceQuestionLimitIndex: 1,
    practiceQuestionLimitOptions: PRACTICE_QUESTION_LIMITS,
    masteredQuestionRatioIndex: 2,
    masteredQuestionRatioOptions: MASTERED_QUESTION_RATIOS,
    subjects: subjectItems(),
    subjectDragKey: '',
    navShellStyle: '',
    navBarStyle: '',
    navScrolled: false
  },

  onLoad() {
    this.updateNavBar();
    this.load();
  },
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
      const settings = await request('/settings');
      const difficultyIndex = Math.max(0, DIFFICULTIES.findIndex((item) => item.key === settings.recommendation_difficulty));
      const reminderFrequencyIndex = Math.max(0, REMINDER_FREQUENCIES.findIndex((item) => item.key === settings.reminder_frequency));
      const configuredPracticeLimitIndex = PRACTICE_QUESTION_LIMITS.findIndex((item) => item.value === settings.practice_question_limit);
      const practiceQuestionLimitIndex = configuredPracticeLimitIndex >= 0 ? configuredPracticeLimitIndex : 1;
      const configuredMasteredRatioIndex = MASTERED_QUESTION_RATIOS.findIndex((item) => item.value === settings.mastered_question_ratio);
      const masteredQuestionRatioIndex = configuredMasteredRatioIndex >= 0 ? configuredMasteredRatioIndex : 2;
      this.setData({
        notificationEnabled: settings.notification_enabled,
        reminderTime: settings.reminder_time || '20:00',
        reminderFrequencyIndex,
        recommendationWeakFirst: settings.recommendation_weak_first !== false,
        difficultyIndex,
        practiceQuestionLimitIndex,
        masteredQuestionRatioIndex,
        subjects: subjectItems(settings.visible_subjects)
      });
      wx.setStorageSync('learning_settings', settings);
    } catch (error) { showError(error); }
    finally { this.setData({ loading: false }); }
  },

  toggleNotification(event) { this.setData({ notificationEnabled: event.detail.value }); },
  changeReminderTime(event) { this.setData({ reminderTime: event.detail.value || '20:00' }); },
  changeReminderFrequency(event) { this.setData({ reminderFrequencyIndex: Number(event.detail.value) || 0 }); },
  toggleWeakFirst(event) { this.setData({ recommendationWeakFirst: event.detail.value }); },
  selectDifficulty(event) {
    const difficultyIndex = Number(event.currentTarget.dataset.index);
    if (Number.isInteger(difficultyIndex) && DIFFICULTIES[difficultyIndex]) this.setData({ difficultyIndex });
  },
  changePracticeQuestionLimit(event) { this.setData({ practiceQuestionLimitIndex: Number(event.detail.value) || 0 }); },
  changeMasteredQuestionRatio(event) { this.setData({ masteredQuestionRatioIndex: Number(event.detail.value) || 0 }); },
  toggleSubject(event) {
    const key = event.currentTarget.dataset.key;
    if (this._subjectSuppressTap === key) {
      this._subjectSuppressTap = '';
      return;
    }
    const target = this.data.subjects.find((item) => item.key === key);
    if (!target) return;
    const enabledItems = this.data.subjects.filter((item) => item.enabled && item.key !== key);
    if (target.enabled && !enabledItems.length) {
      wx.showToast({ title: '至少保留一个科目', icon: 'none' });
      return;
    }
    const disabledItems = this.data.subjects.filter((item) => !item.enabled && item.key !== key);
    const subjects = target.enabled
      ? [...enabledItems, ...disabledItems, { ...target, enabled: false }]
      : [...enabledItems, { ...target, enabled: true }, ...disabledItems];
    this.setData({ subjects });
  },
  dragSubjectStart(event) {
    const key = event.currentTarget.dataset.key;
    const target = this.data.subjects.find((item) => item.key === key);
    if (!target?.enabled) return;
    this._subjectSuppressTap = key;
    this._subjectDrag = { key, querying: false };
    this.setData({ subjectDragKey: key });
    try { wx.vibrateShort?.({ type: 'medium' }); } catch (error) {}
  },
  dragSubjectMove(event) {
    const drag = this._subjectDrag;
    const touch = event.touches?.[0];
    if (!drag || !touch || drag.querying) return;
    const clientX = Number(touch.clientX) || 0;
    const clientY = Number(touch.clientY) || 0;
    drag.querying = true;
    wx.createSelectorQuery().selectAll('.subject-chip.active').boundingClientRect((rects = []) => {
      if (!this._subjectDrag || this._subjectDrag.key !== drag.key) return;
      drag.querying = false;
      if (!rects.length) return;
      let targetIndex = rects.findIndex((rect) => (
        clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
      ));
      if (targetIndex < 0) {
        let nearestDistance = Infinity;
        rects.forEach((rect, index) => {
          const dx = clientX - (rect.left + rect.width / 2);
          const dy = clientY - (rect.top + rect.height / 2);
          const distance = dx * dx + dy * dy;
          if (distance < nearestDistance) { nearestDistance = distance; targetIndex = index; }
        });
      }
      const enabledItems = this.data.subjects.filter((item) => item.enabled);
      const disabledItems = this.data.subjects.filter((item) => !item.enabled);
      const currentIndex = enabledItems.findIndex((item) => item.key === drag.key);
      targetIndex = Math.max(0, Math.min(enabledItems.length - 1, targetIndex));
      if (currentIndex < 0 || targetIndex === currentIndex) return;
      const [moving] = enabledItems.splice(currentIndex, 1);
      enabledItems.splice(targetIndex, 0, moving);
      this.setData({ subjects: [...enabledItems, ...disabledItems] });
      try { wx.vibrateShort?.({ type: 'light' }); } catch (error) {}
    }).exec();
  },
  dragSubjectEnd() {
    const key = this._subjectDrag?.key || this._subjectSuppressTap;
    this._subjectDrag = null;
    this.setData({ subjectDragKey: '' });
    setTimeout(() => {
      if (this._subjectSuppressTap === key) this._subjectSuppressTap = '';
    }, 450);
  },

  async save() {
    if (this.data.saving) return;
    const visibleSubjects = this.data.subjects.filter((item) => item.enabled).map((item) => item.key);
    const recommendationDifficulty = DIFFICULTIES[this.data.difficultyIndex]?.key || 'adaptive';
    const reminderFrequency = REMINDER_FREQUENCIES[this.data.reminderFrequencyIndex]?.key || 'daily';
    const practiceQuestionLimit = PRACTICE_QUESTION_LIMITS[this.data.practiceQuestionLimitIndex]?.value || 10;
    const masteredQuestionRatio = MASTERED_QUESTION_RATIOS[this.data.masteredQuestionRatioIndex]?.value ?? 20;
    this.setData({ saving: true });
    try {
      const settings = await request('/settings', {
        method: 'PATCH',
        data: {
          notification_enabled: this.data.notificationEnabled,
          reminder_time: this.data.reminderTime,
          reminder_frequency: reminderFrequency,
          recommendation_weak_first: this.data.recommendationWeakFirst,
          recommendation_difficulty: recommendationDifficulty,
          practice_question_limit: practiceQuestionLimit,
          mastered_question_ratio: masteredQuestionRatio,
          visible_subjects: visibleSubjects
        }
      });
      const savedSubjects = normalizeVisibleSubjects(settings.visible_subjects);
      wx.setStorageSync('visible_subjects', savedSubjects);
      wx.setStorageSync('learning_settings', settings);
      if (!savedSubjects.includes(wx.getStorageSync('current_subject'))) {
        wx.setStorageSync('current_subject', savedSubjects[0]);
      }
      getApp().globalData.currentSubject = wx.getStorageSync('current_subject') || savedSubjects[0];
      wx.showToast({ title: '设置已保存', icon: 'success' });
      setTimeout(() => {
        this.back();
        getApp().scheduleLearningReminder?.();
      }, 450);
    } catch (error) { showError(error); }
    finally { this.setData({ saving: false }); }
  }
});

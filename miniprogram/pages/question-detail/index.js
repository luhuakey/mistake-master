import { request, showError } from '../../services/api';
import { subjectName, typeName, difficultyName, dateText, optionItems } from '../../utils/format';
import { promptLogin } from '../../utils/auth';
import { getGuestQuestionById } from '../../utils/guest-data';
import { getNavigationLayout } from '../../utils/navigation';
import { setCurrentPracticeSession } from '../../utils/practice-session';
import { questionImageDisplayWidth, resolveDisplayableFileUrl } from '../../utils/file-url';

Page({
  data: { id: '', fromLibrary: false, loading: true, question: null, questionImageUrl: '', questionImageWidth: '', optionItems: [], isGuestPreview: false, analysisExpanded: false, warningExpanded: false, primaryKnowledgePoint: '', navShellStyle: '', navBarStyle: '', navScrolled: false },
  onLoad(options) { this.updateNavBar(); this.setData({ id: options.id, fromLibrary: options.from === 'library' }); this.load(); },
  onUnload() {
    if (this.data.fromLibrary && !this._leavingLibraryContext) {
      getApp().globalData.libraryRestoreRequested = true;
    }
  },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onPageScroll({ scrollTop }) { const navScrolled = scrollTop > 8; if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled }); },
  updateNavBar(size) { const layout = getNavigationLayout(size); this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle }); },
  back() {
    if (this.data.fromLibrary) getApp().globalData.libraryRestoreRequested = true;
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/question-list/index' }) });
  },
  async load() {
    const guestQuestion = getGuestQuestionById(this.data.id);
    if (guestQuestion) {
      this.setData({
        loading: false,
        question: guestQuestion,
        questionImageUrl: await resolveDisplayableFileUrl(guestQuestion.question_image_file_id),
        questionImageWidth: questionImageDisplayWidth(guestQuestion.question_image_width, guestQuestion.question_image_height),
        optionItems: this.displayOptions(guestQuestion),
        subjectLabel: subjectName(guestQuestion.subject),
        typeLabel: typeName(guestQuestion.type),
        difficultyLabel: difficultyName(guestQuestion.difficulty),
        dateLabel: dateText(guestQuestion.created_at),
        primaryKnowledgePoint: guestQuestion.knowledge_points?.[0] || '',
        isGuestPreview: true
      });
      return;
    }
    try {
      const q = await request(`/questions/${this.data.id}`);
      this.setData({ question: q, questionImageUrl: await resolveDisplayableFileUrl(q.question_image_file_id), questionImageWidth: questionImageDisplayWidth(q.question_image_width, q.question_image_height), optionItems: this.displayOptions(q), subjectLabel: subjectName(q.subject), typeLabel: typeName(q.type), difficultyLabel: difficultyName(q.difficulty), dateLabel: dateText(q.created_at), primaryKnowledgePoint: q.knowledge_points?.[0] || '', canPractice: Boolean(q.stem && q.correct_answer) });
    } catch (error) { showError(error); }
    finally { this.setData({ loading: false }); }
  },
  displayOptions(question) {
    const answerKeys = new Set(String(question?.correct_answer || '').toUpperCase().match(/[A-H]/g) || []);
    return optionItems(question?.options).map((item) => ({ ...item, correct: answerKeys.has(item.key) }));
  },
  previewQuestionImage() {
    const url = String(this.data.questionImageUrl || '');
    if (url) wx.previewImage({ current: url, urls: [url] });
  },
  async toggleMastery() {
    const next = this.data.question.mastery_status === 'mastered' ? 'unmastered' : 'mastered';
    try {
      const question = await request(`/questions/${this.data.id}/mastery`, { method: 'PATCH', data: { mastery_status: next } });
      this.setData({ question });
      if (Number(question.points_reward?.amount) > 0) {
        wx.showToast({ title: `+${question.points_reward.amount} 积分`, icon: 'none', duration: 1800 });
      }
    }
    catch (error) { showError(error); }
  },
  async practice() {
    if (!this.data.canPractice) {
      wx.showToast({ title: '该题型暂不支持在线作答', icon: 'none' });
      return;
    }
    try {
      const result = await request('/practice-sessions/from-questions', { method: 'POST', data: { question_ids: [this.data.id], type: 'single' } });
      setCurrentPracticeSession(result.practice_session_id);
      this._leavingLibraryContext = true;
      wx.switchTab({ url: '/pages/practice/index' });
    } catch (error) { showError(error); }
  },
  toggleBlock(event) {
    const key = event.currentTarget.dataset.key;
    if (!['analysisExpanded', 'warningExpanded'].includes(key)) return;
    this.setData({ [key]: !this.data[key] });
  },
  openFilteredList(event) {
    const filter = event.currentTarget.dataset.filter;
    const value = event.currentTarget.dataset.value;
    if (!['subject', 'type', 'difficulty'].includes(filter) || !value) return;
    this._leavingLibraryContext = true;
    getApp().globalData.listFilters = { [filter]: value };
    wx.switchTab({ url: '/pages/question-list/index' });
  },
  openKnowledgeList(event) {
    const point = event.currentTarget.dataset.point || this.data.primaryKnowledgePoint;
    if (!point) return wx.showToast({ title: '暂无知识点信息', icon: 'none' });
    this._leavingLibraryContext = true;
    getApp().globalData.listFilters = { knowledge_point: point };
    wx.switchTab({ url: '/pages/question-list/index' });
  },
  openRelatedKnowledgeList() {
    const knowledgePoints = [...new Set((this.data.question?.knowledge_points || []).map(String).map((item) => item.trim()).filter(Boolean))];
    if (!knowledgePoints.length) return wx.showToast({ title: '暂无知识点信息', icon: 'none' });
    this._leavingLibraryContext = true;
    getApp().globalData.listFilters = { knowledge_points: knowledgePoints };
    wx.switchTab({ url: '/pages/question-list/index' });
  },
  openLogin() {
    promptLogin('当前展示的是示例错题，登录后即可收录、管理错题并立即重练。');
  }
});

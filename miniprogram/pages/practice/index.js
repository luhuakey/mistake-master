import { request, showError } from '../../services/api';
import { subjectName, difficultyName, optionItems } from '../../utils/format';
import { getNavigationLayout } from '../../utils/navigation';
import { displayableFileUrl, questionImageDisplayWidth, resolveDisplayableFileUrl } from '../../utils/file-url';
import {
  clearCurrentPracticeSession,
  clearPracticeSessionContext,
  getCurrentPracticeSessionId,
  getPracticeSessionId,
  PRACTICE_CONTEXT,
  setCurrentPracticeSession
} from '../../utils/practice-session';

const getAnsweredQuestionIds = (sessionId) => {
  const answers = wx.getStorageSync(`answers_${sessionId}`) || {};
  return Object.keys(answers).filter((questionId) => Boolean(String(answers[questionId] || '').trim()));
};

Page({
  data: { loading: true, preparing: false, preparationText: '正在载入练习进度', emptyMessage: '', submitting: false, submitFailed: false, sessionId: '', sessionType: '', pageTitle: '推荐习题', questions: [], currentIndex: 0, currentQuestion: null, questionImageUrl: '', questionImageWidth: '', currentOptionItems: [], hasOptions: false, needsConfirm: false, isLongAnswer: false, answerPlaceholder: '', answerHint: '', textAnswer: '', answers: {}, selected: '', answeredCount: 0, progressPercent: 0, backGuardVisible: false, navShellStyle: '', navBarStyle: '', navScrolled: false },
  onLoad() { this.updateNavBar(); },
  onShow() {
    this.getTabBar()?.setData({ hidden: true });
    const app = getApp();
    const pendingEntry = app.globalData.pendingPracticeEntry;
    app.globalData.pendingPracticeEntry = null;
    if (pendingEntry) {
      this.preparePractice(pendingEntry);
      return;
    }
    const sessionId = getCurrentPracticeSessionId();
    if (sessionId && sessionId !== this.data.sessionId) {
      this._completedPractice = false;
      this.setData({ sessionId, currentIndex: 0, answers: {}, selected: '', submitFailed: false });
      this.load();
    } else if (!sessionId && this._completedPractice) {
      this._completedPractice = false;
      this.resetPracticeState();
      wx.switchTab({ url: '/pages/home/index' });
    } else if (!sessionId) this.resetPracticeState();
  },
  onHide() { this.clearAutoAdvance(); this.getTabBar()?.setData({ hidden: false }); },
  onUnload() { this.clearAutoAdvance(); },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onPageScroll({ scrollTop }) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  updateNavBar(size) {
    const layout = getNavigationLayout(size);
    this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle });
  },
  clearAutoAdvance() {
    if (!this._autoAdvanceTimer) return;
    clearTimeout(this._autoAdvanceTimer);
    this._autoAdvanceTimer = null;
  },
  resetPracticeState() {
    this.clearAutoAdvance();
    this.setData({
      loading: false,
      preparing: false,
      preparationText: '正在载入练习进度',
      emptyMessage: '',
      submitting: false,
      submitFailed: false,
      sessionId: '',
      questions: [],
      currentIndex: 0,
      currentQuestion: null,
      questionImageUrl: '',
      questionImageWidth: '',
      currentOptionItems: [],
      hasOptions: false,
      needsConfirm: false,
      isLongAnswer: false,
      answerPlaceholder: '',
      answerHint: '',
      textAnswer: '',
      answers: {},
      selected: '',
      answeredCount: 0,
      progressPercent: 0,
      backGuardVisible: false,
      sessionType: '',
      pageTitle: '推荐习题',
      subjectLabel: '',
      difficultyLabel: ''
    });
  },
  shouldConfirmExit() {
    return Boolean(this.data.currentQuestion && this.data.answeredCount > 0 && !this.data.submitting);
  },
  armBackGuard() {
    if (!this.data.currentQuestion || this.data.submitting || this.data.backGuardVisible) return;
    this.setData({ backGuardVisible: true });
  },
  rearmBackGuard(force = false) {
    if (!this.data.currentQuestion || (!force && this.data.submitting) || this._leavingPractice) return;
    this.setData({ backGuardVisible: false }, () => {
      wx.nextTick(() => {
        if (this.data.currentQuestion && (force || !this.data.submitting) && !this._leavingPractice) {
          this.setData({ backGuardVisible: true });
        }
      });
    });
  },
  leavePractice({ discard = false } = {}) {
    if (this._leavingPractice) return;
    this._leavingPractice = true;
    if (discard) clearCurrentPracticeSession(this.data.sessionId);
    this.setData({ backGuardVisible: false }, () => {
      wx.switchTab({
        url: '/pages/home/index',
        complete: () => { this._leavingPractice = false; }
      });
    });
  },
  confirmExit({ rearmGuard = false } = {}) {
    if (this._confirmingExit || this.data.submitting) {
      if (rearmGuard) this.rearmBackGuard();
      return;
    }
    this._confirmingExit = true;
    wx.showModal({
      title: '确认返回？',
      content: '当前练习尚未全部完成，确认返回后，作答进度将被清除且无法恢复。',
      cancelText: '继续答题',
      confirmText: '确认返回',
      confirmColor: '#e45454',
      success: ({ confirm }) => {
        if (confirm) this.leavePractice({ discard: true });
        else if (rearmGuard) this.rearmBackGuard();
      },
      fail: () => {
        if (rearmGuard) this.rearmBackGuard();
        wx.showToast({ title: '返回提示打开失败，请重试', icon: 'none' });
      },
      complete: () => { this._confirmingExit = false; }
    });
  },
  exit() {
    if (this.data.submitting) return;
    if (this.shouldConfirmExit()) this.confirmExit();
    else this.leavePractice({ discard: Boolean(this.data.currentQuestion) });
  },
  onBackGuardLeave() {
    if (this._leavingPractice) return;
    this.setData({ backGuardVisible: false });
    if (this.data.submitting) {
      this.rearmBackGuard(true);
      return;
    }
    if (this.shouldConfirmExit()) this.confirmExit({ rearmGuard: true });
    else this.leavePractice({ discard: Boolean(this.data.currentQuestion) });
  },
  async load() {
    this.setData({ loading: true, preparationText: this.data.preparing ? this.data.preparationText : '正在载入练习进度' });
    try {
      const session = await request(`/practice-sessions/${this.data.sessionId}`);
      if (session.status === 'submitted') {
        clearCurrentPracticeSession(session.id);
        this.resetPracticeState();
        return this.startRecommended();
      }
      const cachedAnswers = wx.getStorageSync(`answers_${this.data.sessionId}`) || {};
      const answers = Object.fromEntries(Object.entries(cachedAnswers).map(([questionId, answer]) => [
        String(questionId),
        String(answer || '').trim()
      ]));
      const savedIndex = Number(wx.getStorageSync(`practice_index_${this.data.sessionId}`));
      const questions = await Promise.all(session.questions.map(async (question) => ({
        ...question,
        questionImageUrl: await resolveDisplayableFileUrl(question.question_image_file_id)
      })));
      const currentIndex = Number.isInteger(savedIndex)
        ? Math.min(Math.max(savedIndex, 0), Math.max(questions.length - 1, 0))
        : 0;
      this.setData({
        questions,
        answers,
        currentIndex,
        sessionType: session.type,
        pageTitle: session.type === 'comprehensive' ? '综合练习' : '推荐习题'
      });
      this.showCurrent();
    } catch (error) {
      this.setData({ emptyMessage: '练习载入失败，请点击重试' });
      showError(error);
    }
    finally { this.setData({ loading: false, preparing: false }); }
  },
  showCurrent() {
    const currentQuestion = this.data.questions[this.data.currentIndex];
    let currentOptionItems = optionItems(currentQuestion?.options);
    if (currentQuestion?.type === 'true_false' && !currentOptionItems.length) {
      currentOptionItems = [{ key: '正确', text: '正确', symbol: '✓' }, { key: '错误', text: '错误', symbol: '×' }];
    }
    const answeredCount = this.data.questions.filter((question) => this.isValidAnswer(question, this.data.answers[question.id])).length;
    const progressPercent = this.data.questions.length ? Math.round(answeredCount / this.data.questions.length * 100) : 0;
    const currentAnswer = this.data.answers[currentQuestion?.id] || '';
    const multiple = currentQuestion?.type === 'multiple_choice';
    const selectedKeys = multiple ? new Set(String(currentAnswer).toUpperCase().match(/[A-H]/g) || []) : new Set([String(currentAnswer).toUpperCase()]);
    currentOptionItems = currentOptionItems.map((item) => ({ ...item, selected: selectedKeys.has(item.key) }));
    const hasOptions = currentOptionItems.length > 0;
    const longTypes = ['short_answer', 'proof', 'reading', 'composition', 'other'];
    const isLongAnswer = longTypes.includes(currentQuestion?.type);
    const answerPlaceholder = isLongAnswer ? '请写下你的作答或解题思路' : '请输入答案';
    const answerHint = isLongAnswer
      ? '提交后将展示参考答案，由你完成自评'
      : currentQuestion?.type === 'calculation' ? '支持整数、小数和分数' : '填写完整答案后继续';
    this.setData({ currentQuestion, questionImageUrl: currentQuestion?.questionImageUrl || displayableFileUrl(currentQuestion?.question_image_file_id),
      questionImageWidth: questionImageDisplayWidth(currentQuestion?.question_image_width, currentQuestion?.question_image_height), currentOptionItems, hasOptions, needsConfirm: multiple || !hasOptions, isLongAnswer, answerPlaceholder, answerHint, textAnswer: currentAnswer, answeredCount, progressPercent, selected: currentAnswer, subjectLabel: subjectName(currentQuestion?.subject), difficultyLabel: difficultyName(currentQuestion?.difficulty) }, () => this.armBackGuard());
  },
  previewQuestionImage() {
    const url = String(this.data.questionImageUrl || '');
    if (url) wx.previewImage({ current: url, urls: [url] });
  },
  select(event) {
    if (this.data.submitting || !this.data.currentQuestion) return;
    this.clearAutoAdvance();
    const option = String(event.currentTarget.dataset.option || '').trim();
    const questionId = String(this.data.currentQuestion.id);
    const multiple = this.data.currentQuestion.type === 'multiple_choice';
    let selected = option;
    if (multiple) {
      const selectedKeys = new Set(String(this.data.answers[questionId] || '').toUpperCase().match(/[A-H]/g) || []);
      if (selectedKeys.has(option)) selectedKeys.delete(option);
      else selectedKeys.add(option);
      selected = [...selectedKeys].sort().join('');
    }
    if (!multiple && !this.isValidAnswer(this.data.currentQuestion, selected)) return;
    const currentIndex = this.data.currentIndex;
    const answers = { ...this.data.answers, [questionId]: selected };
    const answeredCount = this.data.questions.filter((question) => this.isValidAnswer(question, answers[question.id])).length;
    const progressPercent = this.data.questions.length ? Math.round(answeredCount / this.data.questions.length * 100) : 0;
    const selectedKeys = multiple ? new Set(selected) : new Set([selected]);
    const currentOptionItems = this.data.currentOptionItems.map((item) => ({ ...item, selected: selectedKeys.has(item.key) }));
    this.setData({ selected, currentOptionItems, answers, answeredCount, progressPercent, submitFailed: false }, () => {
      if (!multiple) this._autoAdvanceTimer = setTimeout(() => this.advanceAfterSelection(questionId, currentIndex), 420);
    });
    wx.setStorageSync(`answers_${this.data.sessionId}`, answers);
  },
  inputAnswer(event) {
    if (this.data.submitting || !this.data.currentQuestion) return;
    const questionId = String(this.data.currentQuestion.id);
    const textAnswer = String(event.detail.value || '');
    const answers = { ...this.data.answers, [questionId]: textAnswer };
    const answeredCount = this.data.questions.filter((question) => this.isValidAnswer(question, answers[question.id])).length;
    const progressPercent = this.data.questions.length ? Math.round(answeredCount / this.data.questions.length * 100) : 0;
    this.setData({ textAnswer, answers, answeredCount, progressPercent, submitFailed: false });
    wx.setStorageSync(`answers_${this.data.sessionId}`, answers);
  },
  confirmTextAnswer() {
    if (this.data.submitting || !this.data.currentQuestion) return;
    const currentAnswer = this.data.answers[String(this.data.currentQuestion.id)] || '';
    if (!this.isValidAnswer(this.data.currentQuestion, currentAnswer)) {
      wx.showToast({ title: this.data.hasOptions ? '请选择答案' : '请输入答案', icon: 'none' });
      return;
    }
    if (this.data.currentIndex < this.data.questions.length - 1) {
      const currentIndex = this.data.currentIndex + 1;
      this.setData({ currentIndex });
      wx.setStorageSync(`practice_index_${this.data.sessionId}`, currentIndex);
      this.showCurrent();
      return;
    }
    this.submitPractice();
  },
  advanceAfterSelection(questionId, currentIndex) {
    this._autoAdvanceTimer = null;
    if (this.data.submitting
      || this.data.currentIndex !== currentIndex
      || String(this.data.currentQuestion?.id) !== String(questionId)
      || !this.data.answers[questionId]) return;
    if (currentIndex < this.data.questions.length - 1) {
      const nextIndex = currentIndex + 1;
      this.setData({ currentIndex: nextIndex });
      wx.setStorageSync(`practice_index_${this.data.sessionId}`, nextIndex);
      this.showCurrent();
      return;
    }
    this.submitPractice();
  },
  previous() {
    if (this.data.submitting || this.data.currentIndex <= 0) return;
    this.clearAutoAdvance();
    const currentIndex = this.data.currentIndex - 1;
    this.setData({ currentIndex });
    wx.setStorageSync(`practice_index_${this.data.sessionId}`, currentIndex);
    this.showCurrent();
  },
  isValidAnswer(question, answer) {
    const value = String(answer || '').trim();
    if (!value) return false;
    if (question?.type === 'single_choice') {
      const key = value.toUpperCase();
      return Boolean(typeof question?.options?.[key] === 'string' && question.options[key].trim());
    }
    if (question?.type === 'multiple_choice') {
      const keys = [...new Set(value.toUpperCase().match(/[A-H]/g) || [])];
      return Boolean(keys.length && keys.every((key) => typeof question?.options?.[key] === 'string' && question.options[key].trim()));
    }
    if (question?.type === 'true_false') {
      if (Object.keys(question.options || {}).length) return typeof question.options?.[value.toUpperCase()] === 'string';
      return ['正确', '错误'].includes(value);
    }
    return true;
  },
  async submitPractice() {
    if (this.data.submitting) return;
    this.clearAutoAdvance();
    const firstUnansweredIndex = this.data.questions.findIndex((question) => !this.isValidAnswer(question, this.data.answers[question.id]));
    if (firstUnansweredIndex >= 0) {
      this.setData({ currentIndex: firstUnansweredIndex });
      wx.setStorageSync(`practice_index_${this.data.sessionId}`, firstUnansweredIndex);
      this.showCurrent();
      wx.showToast({ title: `请先完成第 ${firstUnansweredIndex + 1} 题`, icon: 'none' });
      return;
    }
    this.setData({ submitting: true, submitFailed: false });
    wx.showLoading({ title: '提交练习', mask: true });
    let submitError = null;
    try {
      const answers = Object.fromEntries(this.data.questions.map((question) => [
        String(question.id),
        String(this.data.answers[question.id] || '').trim()
      ]));
      const orderedAnswers = this.data.questions.map((question) => answers[String(question.id)]);
      const result = await request(`/practice-sessions/${this.data.sessionId}/submit`, {
        method: 'POST',
        data: { answers, ordered_answers: orderedAnswers }
      });
      const pointsAmount = Math.max(0, Number(result.points_reward?.amount) || 0);
      this._completedPractice = true;
      clearCurrentPracticeSession(this.data.sessionId);
      this.setData({ backGuardVisible: false }, () => {
        wx.navigateTo({
          url: `/pages/practice-result/index?id=${result.practice_record_id}&source=practice&points=${pointsAmount}`,
          fail: () => wx.switchTab({ url: '/pages/home/index' })
        });
      });
    } catch (error) {
      submitError = error;
      this.setData({ submitFailed: true });
    }
    finally {
      wx.hideLoading();
      this.setData({ submitting: false }, () => {
        if (this.data.currentQuestion && getCurrentPracticeSessionId()) this.armBackGuard();
      });
    }
    if (submitError) showError(submitError);
  },
  async findActiveSession(sessionId, matches, context = '') {
    if (!sessionId) return null;
    try {
      const session = await request(`/practice-sessions/${sessionId}`);
      if (session.status === 'active' && matches(session)) return session;
      if (context && getPracticeSessionId(context) === sessionId) clearPracticeSessionContext(context, sessionId);
      return null;
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') throw error;
      if (context && getPracticeSessionId(context) === sessionId) clearPracticeSessionContext(context, sessionId);
      return null;
    }
  },
  async prepareComprehensive() {
    const context = PRACTICE_CONTEXT.comprehensive;
    const contextSessionId = getPracticeSessionId(context);
    const sessionId = contextSessionId || getCurrentPracticeSessionId();
    const session = await this.findActiveSession(
      sessionId,
      (item) => item.subject === 'all' && ['comprehensive', 'recommended'].includes(item.type),
      contextSessionId === sessionId ? context : ''
    );
    if (session) return { sessionId, context };
    const result = await request('/practice-sessions/recommended', {
      method: 'POST',
      data: { subject: 'all', mode: 'comprehensive' }
    });
    return { result, sessionId: result.practice_session_id, context };
  },
  async prepareSubjectRecommendation(subject) {
    const context = PRACTICE_CONTEXT.recommended(subject);
    const matchesRecommendation = (session) => session.type === 'recommended' && session.subject === subject;
    const savedSessionId = getPracticeSessionId(context);
    const savedSession = await this.findActiveSession(savedSessionId, matchesRecommendation, context);
    if (savedSession) return { sessionId: savedSessionId, context };

    let excludeQuestionIds = [];
    const currentSessionId = getCurrentPracticeSessionId();
    if (currentSessionId && currentSessionId !== savedSessionId) {
      const currentRecommendation = await this.findActiveSession(currentSessionId, matchesRecommendation);
      if (currentRecommendation) return { sessionId: currentSessionId, context };
      const currentComprehensive = await this.findActiveSession(
        currentSessionId,
        (session) => session.subject === 'all' && ['comprehensive', 'recommended'].includes(session.type)
      );
      if (currentComprehensive) {
        setCurrentPracticeSession(currentSessionId, PRACTICE_CONTEXT.comprehensive);
        excludeQuestionIds = getAnsweredQuestionIds(currentSessionId);
      }
    }

    const comprehensiveSessionId = getPracticeSessionId(PRACTICE_CONTEXT.comprehensive);
    if (!excludeQuestionIds.length && comprehensiveSessionId && comprehensiveSessionId !== currentSessionId) {
      const comprehensiveSession = await this.findActiveSession(
        comprehensiveSessionId,
        (session) => session.subject === 'all' && ['comprehensive', 'recommended'].includes(session.type),
        PRACTICE_CONTEXT.comprehensive
      );
      if (comprehensiveSession) excludeQuestionIds = getAnsweredQuestionIds(comprehensiveSessionId);
    }

    const result = await request('/practice-sessions/recommended', {
      method: 'POST',
      data: { subject, mode: 'recommended', exclude_question_ids: excludeQuestionIds }
    });
    return { result, sessionId: result.practice_session_id, context };
  },
  async preparePractice(entry = { mode: 'comprehensive', subject: 'all' }) {
    if (this._preparingPractice) return;
    const mode = entry.mode === 'recommended' ? 'recommended' : 'comprehensive';
    const subject = mode === 'recommended' ? String(entry.subject || 'math') : 'all';
    const pageTitle = mode === 'comprehensive' ? '综合练习' : '推荐习题';
    this._lastPracticeEntry = { mode, subject };
    this._preparingPractice = true;
    this.clearAutoAdvance();
    this.setData({
      loading: true,
      preparing: true,
      preparationText: mode === 'comprehensive' ? '正在从各科错题中组合练习' : `正在生成${subjectName(subject)}专属练习`,
      emptyMessage: '',
      pageTitle,
      currentQuestion: null,
      questions: [],
      backGuardVisible: false
    });
    try {
      const prepared = mode === 'comprehensive'
        ? await this.prepareComprehensive()
        : await this.prepareSubjectRecommendation(subject);
      if (prepared.result?.available === false || !prepared.sessionId) {
        const message = prepared.result?.message || '暂无可练习错题，请先上传错题';
        this.resetPracticeState();
        this.setData({ pageTitle, emptyMessage: message });
        wx.showToast({ title: message, icon: 'none', duration: 2500 });
        return;
      }
      setCurrentPracticeSession(prepared.sessionId, prepared.context);
      this.setData({ sessionId: prepared.sessionId, currentIndex: 0, answers: {}, selected: '' });
      await this.load();
    } catch (error) {
      this.resetPracticeState();
      this.setData({ pageTitle, emptyMessage: '题目准备失败，请点击重试' });
      showError(error);
    } finally {
      this._preparingPractice = false;
      if (this.data.loading) this.setData({ loading: false, preparing: false });
    }
  },
  startRecommended() {
    return this.preparePractice(this._lastPracticeEntry || { mode: 'comprehensive', subject: 'all' });
  }
});

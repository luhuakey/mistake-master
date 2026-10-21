import { request, uploadImage, showError } from '../../services/api';
import { subjectName, typeName, difficultyName, optionItems } from '../../utils/format';
import { getNavigationLayout } from '../../utils/navigation';
import { displayableFileUrl, questionImageDisplayWidth, resolveDisplayableFileUrl } from '../../utils/file-url';

const displayItem = (item, index, savedItemIds = new Set()) => {
  const question = item.question || null;
  const valid = item.status === 'valid' && Boolean(question);
  const saved = savedItemIds.has(item.item_id);
  const subjectCandidates = question
    ? [...new Set([question.subject, ...(question.subject_candidates || [])])].filter(Boolean)
    : [];
  return {
    ...item,
    valid,
    saved,
    selected: valid && !saved,
    expanded: index === 0,
    subjectLabel: question ? subjectName(question.subject) : '',
    typeLabel: question ? typeName(question.type) : '',
    difficultyLabel: question ? difficultyName(question.difficulty) : '',
    optionItems: question ? optionItems(question.options) : [],
    hasOptions: Boolean(question && Object.keys(question.options || {}).length),
    questionImageUrl: displayableFileUrl(question?.question_image_file_id),
    questionImageWidth: questionImageDisplayWidth(question?.question_image_width, question?.question_image_height),
    selectedSubject: question?.subject || '',
    crossSubject: Boolean(question?.is_cross_subject || subjectCandidates.length > 1),
    subjectCandidateItems: subjectCandidates.map((key) => ({ key, label: subjectName(key) }))
  };
};

const selectedCount = (items) => items.filter((item) => item.selected && item.valid && !item.saved).length;

Page({
  data: {
    taskId: '', imagePath: '', mode: 'single', status: 'created', stage: 'uploaded', stageLabel: '图片已上传',
    parsedItems: [], detectedCount: 0, validCount: 0, selectedCount: 0, rawText: '', errorMessage: '',
    providerMode: '', saving: false, saveSuccess: null, errorCode: '', imageQuality: null, showPhotoGuide: false,
    failureTitle: '识别失败', retryMode: 'capture', retryLabel: '重新拍摄',
    navShellStyle: '', navBarStyle: '', navScrolled: false
  },
  onLoad(options) {
    this.updateNavBar();
    this.pollStartedAt = Date.now();
    this.pollFailures = 0;
    this.destroyed = false;
    const globalData = getApp().globalData;
    const pending = options.pending === '1' ? globalData.pendingRecognition : null;
    const imagePath = pending?.imagePath || globalData.recognitionImagePath;
    this.setData({ taskId: options.id || '', imagePath });
    if (options.id) {
      this.poll();
      return;
    }
    if (pending?.imagePath) {
      this.submitRecognition(pending);
      return;
    }
    if (!options.id) {
      this.setData({ status: 'failed', failureTitle: '任务无效', errorMessage: '未找到识别任务，请重新拍摄' });
    }
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
  onUnload() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.processingCopyTimer) clearInterval(this.processingCopyTimer);
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }); },
  previewImage() {
    if (!this.data.imagePath) return;
    wx.previewImage({ current: this.data.imagePath, urls: [this.data.imagePath] });
  },
  previewQuestionImage(event) {
    const url = String(event.currentTarget.dataset.url || '');
    if (url) wx.previewImage({ current: url, urls: [url] });
  },
  async normalizedItems(result) {
    const savedItemIds = new Set((result.saved_items || []).map((item) => item.item_id));
    let items;
    if (result.mode === 'batch') {
      items = (result.parsed_questions || []).map((item, index) => displayItem(item, index, savedItemIds));
    } else if (!result.parsed_question) {
      items = [];
    } else {
      items = [displayItem({
        item_id: 'item_1', order: 1, status: 'valid', error_message: '', source_line_range: null, question: result.parsed_question
      }, 0, savedItemIds)];
    }
    return Promise.all(items.map(async (item) => ({
      ...item,
      questionImageUrl: await resolveDisplayableFileUrl(item.question?.question_image_file_id)
    })));
  },
  startProcessingCopy() {
    if (this.processingCopyTimer) clearInterval(this.processingCopyTimer);
    const messages = [
      'AI 正在读取并理解题目…',
      '正在分析题干、选项与公式…',
      '正在整理多道题的识别结果…'
    ];
    let index = 0;
    this.processingCopyTimer = setInterval(() => {
      if (this.destroyed || this.data.status !== 'processing') return;
      index = (index + 1) % messages.length;
      this.setData({ stageLabel: messages[index] });
    }, 3600);
  },
  stopProcessingCopy() {
    if (this.processingCopyTimer) clearInterval(this.processingCopyTimer);
    this.processingCopyTimer = null;
  },
  async submitRecognition(pending = getApp().globalData.pendingRecognition) {
    if (this.submitting || !pending?.imagePath) return;
    this.submitting = true;
    this.pollStartedAt = Date.now();
    this.setData({
      status: 'processing', stage: 'uploading', stageLabel: 'AI 正在读取并理解题目…',
      failureTitle: '识别失败', errorMessage: '', retryMode: 'submit', retryLabel: '重新识别'
    });
    this.startProcessingCopy();
    try {
      const task = await uploadImage(`/recognitions?mode=${pending.mode || 'batch'}`, pending.imagePath);
      if (this.destroyed) return;
      getApp().globalData.pendingRecognition = null;
      this.setData({ taskId: task.task_id || '', status: task.status || 'processing', stage: task.stage || 'uploaded' });
      if (!task.task_id) throw { code: 'TASK_CREATE_FAILED', message: '识别任务创建失败，请重试' };
      this.driveRecognition();
    } catch (error) {
      if (this.destroyed) return;
      this.setData({
        status: 'failed', stage: 'failed', failureTitle: '未能完成识别',
        errorMessage: error?.message || '网络异常，请重试', retryMode: 'submit', retryLabel: '重新识别'
      });
    } finally {
      if (!['created', 'processing'].includes(this.data.status)) this.stopProcessingCopy();
      this.submitting = false;
    }
  },
  async driveRecognition() {
    if (this.destroyed || this.processingRequest || !this.data.taskId) return;
    this.processingRequest = true;
    this.startProcessingCopy();
    try {
      const task = await request(`/recognitions/${this.data.taskId}/process`, { method: 'POST', timeout: 100000 });
      if (this.destroyed) return;
      this.setData({ status: task.status || 'processing', stage: task.stage || this.data.stage });
    } catch (error) {
      if (this.destroyed) return;
      this.setData({ status: 'processing', stageLabel: '连接中断，正在确认识别进度…' });
    } finally {
      this.processingRequest = false;
    }
    if (!this.destroyed) this.poll();
  },
  async poll() {
    if (this.destroyed) return;
    if (Date.now() - this.pollStartedAt > 240000) {
      const canReparse = Boolean(this.data.rawText);
      this.setData({
        status: 'failed', stage: 'failed', failureTitle: '识别超时',
        errorMessage: canReparse ? 'AI 解析用时过长，可直接重新解析' : '识别用时过长，请重新拍摄',
        retryMode: canReparse ? 'parse' : 'capture', retryLabel: canReparse ? '重新解析' : '重新拍摄'
      });
      return;
    }
    try {
      const result = await request(`/recognitions/${this.data.taskId}`);
      if (this.destroyed) return;
      this.pollFailures = 0;
      const parsedItems = await this.normalizedItems(result);
      const stageLabels = {
        uploaded: '图片已上传', ocr: '正在识别图片内容…',
        deepseek: result.mode === 'batch' ? 'AI 正在理解并整理多道题…' : 'AI 正在理解题目…',
        completed: '识别解析完成', failed: '识别解析失败'
      };
      const stage = result.stage || (result.status === 'succeeded' ? 'completed' : result.status === 'failed' ? 'failed' : 'ocr');
      this.setData({
        mode: result.mode || 'single', status: result.status || 'created', stage,
        stageLabel: stageLabels[stage] || '正在识别解析…', parsedItems,
        detectedCount: Number(result.detected_question_count) || parsedItems.length,
        validCount: Number(result.valid_question_count) || parsedItems.filter((item) => item.valid).length,
        selectedCount: selectedCount(parsedItems), rawText: result.raw_text || '', errorMessage: result.error_message || '',
        providerMode: result.provider_mode || '', errorCode: result.error_code || '', imageQuality: result.image_quality || null,
        showPhotoGuide: Boolean(
          result.image_quality?.compliant === false
          || ['QUESTION_IMAGE_INCOMPLETE', 'NO_QUESTIONS_DETECTED', 'NO_VALID_QUESTIONS', 'FORMULA_OCR_UNCERTAIN', 'OCR_FAILED', 'IMAGE_INVALID'].includes(result.error_code)
          || parsedItems.some((item) => !item.valid)
        ),
        failureTitle: '识别失败', retryMode: result.status === 'failed' && result.raw_text ? 'parse' : 'capture',
        retryLabel: result.status === 'failed' && result.raw_text ? '重新解析' : '重新拍摄'
      });
      if (['created', 'processing'].includes(result.status)) {
        this.startProcessingCopy();
        this.timer = setTimeout(() => this.driveRecognition(), result.stage === 'ocr' ? 2500 : 600);
      } else {
        this.stopProcessingCopy();
      }
    } catch (error) {
      if (this.destroyed) return;
      this.pollFailures += 1;
      if (this.pollFailures < 3) {
        this.setData({ status: 'processing', stageLabel: '连接中断，正在重试…' });
        this.timer = setTimeout(() => this.poll(), 1500);
        return;
      }
      this.setData({
        status: 'failed', stage: 'failed', failureTitle: '无法查询识别结果',
        errorMessage: error?.message || '网络异常，请确认后端已启动', retryMode: 'poll', retryLabel: '重新检查'
      });
    }
  },
  toggleItem(event) {
    const itemId = event.currentTarget.dataset.id;
    this.setData({ parsedItems: this.data.parsedItems.map((item) => item.item_id === itemId ? { ...item, expanded: !item.expanded } : item) });
  },
  toggleSelection(event) {
    const itemId = event.currentTarget.dataset.id;
    const parsedItems = this.data.parsedItems.map((item) => item.item_id === itemId && item.valid && !item.saved
      ? { ...item, selected: !item.selected }
      : item);
    this.setData({ parsedItems, selectedCount: selectedCount(parsedItems) });
  },
  selectSubject(event) {
    const itemId = event.currentTarget.dataset.id;
    const subject = event.currentTarget.dataset.subject;
    const parsedItems = this.data.parsedItems.map((item) => item.item_id === itemId && item.crossSubject
      && item.subjectCandidateItems.some((candidate) => candidate.key === subject)
      ? { ...item, selectedSubject: subject, subjectLabel: subjectName(subject) }
      : item);
    this.setData({ parsedItems });
  },
  retake() { wx.redirectTo({ url: '/pages/crop/index' }); },
  async retry() {
    if (this.data.retryMode === 'submit') {
      this.submitRecognition();
      return;
    }
    if (this.data.retryMode === 'poll') {
      this.pollFailures = 0;
      this.pollStartedAt = Date.now();
      this.setData({ status: 'processing', stage: 'ocr', stageLabel: '正在重新连接…', errorMessage: '' });
      this.poll();
      return;
    }
    if (this.data.retryMode === 'parse') {
      this.pollFailures = 0;
      this.pollStartedAt = Date.now();
      this.setData({ status: 'processing', stage: 'deepseek', stageLabel: 'AI 正在重新解析…', errorMessage: '' });
      try {
        await request(`/recognitions/${this.data.taskId}/retry`, { method: 'POST' });
        this.driveRecognition();
      } catch (error) {
        this.setData({ status: 'failed', failureTitle: '重新解析失败', errorMessage: error?.message || '请稍后重试' });
        showError(error);
      }
      return;
    }
    wx.redirectTo({ url: '/pages/crop/index' });
  },
  async save() {
    if (this.data.saving || !this.data.selectedCount) return;
    const selectedIds = this.data.parsedItems.filter((item) => item.selected && item.valid && !item.saved).map((item) => item.item_id);
    const subjectOverrides = Object.fromEntries(this.data.parsedItems
      .filter((item) => selectedIds.includes(item.item_id) && item.crossSubject && item.selectedSubject)
      .map((item) => [item.item_id, item.selectedSubject]));
    this.setData({ saving: true });
    try {
      const result = await request(`/recognitions/${this.data.taskId}/save`, {
        method: 'POST', data: { item_ids: selectedIds, subject_overrides: subjectOverrides }, timeout: 120000
      });
      if (Number(result.points_reward?.amount) > 0) {
        wx.showToast({ title: `+${result.points_reward.amount} 积分`, icon: 'none', duration: 1800 });
      }
      const failedIds = new Set((result.failed_items || []).map((item) => item.item_id));
      const savedIds = new Set((result.items || []).map((item) => item.item_id));
      const parsedItems = this.data.parsedItems.map((item) => savedIds.has(item.item_id)
        ? { ...item, saved: true, selected: false }
        : failedIds.has(item.item_id) ? { ...item, selected: true } : item);
      const questionIds = result.question_ids || (result.question_id ? [result.question_id] : []);
      if (failedIds.size) {
        this.setData({ parsedItems, selectedCount: selectedCount(parsedItems) });
        wx.showModal({
          title: '部分保存完成', content: `已保存 ${questionIds.length} 道，${failedIds.size} 道失败，可点击按钮重试失败项。`,
          showCancel: false, confirmText: '知道了'
        });
        return;
      }
      this.setData({ parsedItems, selectedCount: 0, saveSuccess: { count: questionIds.length } });
    } catch (error) { showError(error); }
    finally { this.setData({ saving: false }); }
  },
  viewQuestions() {
    getApp().globalData.listFilters = { source: 'photo' };
    getApp().globalData.libraryReturnTab = '/pages/home/index';
    wx.switchTab({ url: '/pages/question-list/index' });
  },
  continueCapture() { wx.redirectTo({ url: '/pages/crop/index' }); }
});

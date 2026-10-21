import { request, showError } from '../../services/api';
import { getNavigationLayout } from '../../utils/navigation';
import { clearCurrentPracticeSession, setCurrentPracticeSession } from '../../utils/practice-session';
import { questionImageDisplayWidth, resolveDisplayableFileUrl } from '../../utils/file-url';

const displayRecord = async (record) => ({
  ...record,
  items: await Promise.all((record?.items || []).map(async (item) => ({
    ...item,
    questionImageUrl: await resolveDisplayableFileUrl(item.question_image_file_id),
    questionImageWidth: questionImageDisplayWidth(item.question_image_width, item.question_image_height)
  })))
});

Page({
  data: { id: '', source: '', pointsReward: 0, loading: true, record: null, assessingQuestionId: '', navShellStyle: '', navBarStyle: '', navScrolled: false },
  onLoad(options) { this.updateNavBar(); this.setData({ id: options.id, source: options.source || '', pointsReward: Math.max(0, Number(options.points) || 0) }); this.load(); },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onPageScroll({ scrollTop }) { const navScrolled = scrollTop > 8; if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled }); },
  updateNavBar(size) { const layout = getNavigationLayout(size); this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle }); },
  back() {
    if (this.data.source === 'practice') {
      wx.switchTab({ url: '/pages/home/index' });
      return;
    }
    wx.navigateBack({
      delta: 1,
      fail: () => wx.switchTab({ url: '/pages/home/index' })
    });
  },
  async load() {
    try {
      const record = await request(`/practice-records/${this.data.id}`);
      clearCurrentPracticeSession(record.session_id);
      this.setData({ record: await displayRecord(record) });
    }
    catch (error) { showError(error); }
    finally { this.setData({ loading: false }); }
  },
  async retryWrong() {
    const ids = this.data.record.items.filter((item) => item.is_correct === false).map((item) => item.question_id);
    if (!ids.length) return;
    try {
      const result = await request('/practice-sessions/from-questions', { method: 'POST', data: { question_ids: ids, type: 'review' } });
      setCurrentPracticeSession(result.practice_session_id);
      wx.switchTab({ url: '/pages/practice/index' });
    } catch (error) { showError(error); }
  },
  previewQuestionImage(event) {
    const url = String(event.currentTarget.dataset.url || '');
    if (url) wx.previewImage({ current: url, urls: [url] });
  },
  async selfAssess(event) {
    const questionId = String(event.currentTarget.dataset.questionId || '');
    const isCorrect = event.currentTarget.dataset.correct === true || event.currentTarget.dataset.correct === 'true';
    if (!questionId || this.data.assessingQuestionId) return;
    this.setData({ assessingQuestionId: questionId });
    try {
      const record = await request(`/practice-records/${this.data.id}/items/${questionId}/self-assess`, {
        method: 'POST',
        data: { is_correct: isCorrect }
      });
      this.setData({ record: await displayRecord(record) });
    } catch (error) { showError(error); }
    finally { this.setData({ assessingQuestionId: '' }); }
  }
});

import { request, showError } from '../../services/api';
import { isLoggedIn, promptLogin } from '../../utils/auth';
import { getGuestQuestions } from '../../utils/guest-data';
import { getNavigationLayout } from '../../utils/navigation';
import { subjectName, typeName, difficultyName } from '../../utils/format';
import { SUBJECT_KEYS, normalizeVisibleSubjects, subjectItemsForKeys } from '../../config/subjects';
import { appShareMessage, enableShareMenu, timelineShareMessage } from '../../utils/share';

const LIBRARY_FILTER_HEAD = [{ key: 'all', label: '全部' }];
const LIBRARY_FILTER_TAIL = [
  { key: 'single_choice', label: '选择题' },
  { key: 'this_week', label: '本周新增' }
];

const buildFilters = (visibleKeys) => [
  ...LIBRARY_FILTER_HEAD,
  ...subjectItemsForKeys(visibleKeys),
  ...LIBRARY_FILTER_TAIL
];

const EMPTY_MASTERY_SUMMARY = { total_count: 0, unmastered_count: 0, mastered_count: 0 };
const LIBRARY_PAGE_SIZE = 10;

const appendUniqueQuestions = (current = [], incoming = []) => {
  const knownIds = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !knownIds.has(item.id))];
};

const compactCount = (value) => {
  const count = Math.max(0, Number(value) || 0);
  return count > 999 ? '999+' : String(count);
};

const masteryDisplayCounts = (summary) => ({
  total: compactCount(summary.total_count),
  unmastered: compactCount(summary.unmastered_count),
  mastered: compactCount(summary.mastered_count)
});

const masterySummaryFor = (items) => ({
  total_count: items.length,
  unmastered_count: items.filter((item) => item.mastery_status !== 'mastered').length,
  mastered_count: items.filter((item) => item.mastery_status === 'mastered').length
});

const filterNoticeFor = (filters = {}) => {
  const labels = [];
  if (filters.subject) labels.push(subjectName(filters.subject));
  if (filters.type) labels.push(typeName(filters.type));
  if (filters.difficulty) labels.push(difficultyName(filters.difficulty));
  if (filters.knowledge_point) labels.push(filters.knowledge_point);
  if (Array.isArray(filters.knowledge_points)) labels.push(...filters.knowledge_points);
  if (filters.mastery_status === 'mastered') labels.push('已掌握');
  if (filters.mastery_status === 'unmastered') labels.push('未掌握');
  return labels.length ? `当前筛选：${labels.join(' · ')}` : '';
};

Page({
  data: {
    loading: true, loadingMore: false, refreshing: false, refreshFeedback: '', hasMore: false, nextCursor: '', scrollTop: 0,
    bottomPullDistance: 0, bottomPullReleasing: false,
    isGuest: false, keyword: '', activeFilter: 'all', masteryFilter: 'all', items: [], externalFilters: {}, filterNotice: '',
    masterySummary: EMPTY_MASTERY_SUMMARY,
    masteryDisplayCounts: masteryDisplayCounts(EMPTY_MASTERY_SUMMARY),
    navShellStyle: '', navBarStyle: '', filterStickyStyle: '', navScrolled: false, backGuardVisible: false, scrollIntoView: '',
    backTarget: '/pages/home/index',
    visibleKeys: normalizeVisibleSubjects(),
    filters: buildFilters(normalizeVisibleSubjects())
  },
  onLoad() { this.updateNavBar(); },
  onShow() {
    enableShareMenu();
    this.getTabBar()?.setSelected(1);
    const app = getApp();
    const visibleKeys = normalizeVisibleSubjects(wx.getStorageSync('visible_subjects'));
    const incoming = app.globalData.listFilters || {};
    app.globalData.listFilters = {};
    const backTarget = app.globalData.libraryReturnTab;
    app.globalData.libraryReturnTab = '';
    const hasIncomingFilters = Object.values(incoming).some(Boolean);
    const restoreFromDetail = app.globalData.libraryRestoreRequested && !hasIncomingFilters && this.data.items.length;
    app.globalData.libraryRestoreRequested = false;

    if (restoreFromDetail) {
      this.setData({
        visibleKeys,
        filters: buildFilters(visibleKeys),
        backGuardVisible: true,
        scrollIntoView: '',
        scrollTop: this._detailScrollTop || 0
      });
      return;
    }

    const masteryFilter = ['mastered', 'unmastered'].includes(incoming.mastery_status)
      ? incoming.mastery_status
      : 'all';
    const incomingSubject = SUBJECT_KEYS.includes(incoming.subject) && visibleKeys.includes(incoming.subject)
      ? incoming.subject
      : '';
    const externalFilters = { ...incoming };
    if (incomingSubject) delete externalFilters.subject;
    this.setData({
      visibleKeys,
      filters: buildFilters(visibleKeys),
      externalFilters,
      filterNotice: filterNoticeFor(incoming),
      backGuardVisible: true,
      backTarget: backTarget || '/pages/home/index',
      activeFilter: incomingSubject || 'all',
      masteryFilter,
      keyword: '',
      refreshFeedback: ''
    }, () => {
      this.scrollLibraryToTop();
      this.load();
    });
  },
  onReady() { this.measureLibraryViewport(); },
  onHide() {},
  onUnload() {
    clearTimeout(this._refreshFeedbackTimer);
    clearTimeout(this._bottomPullTimer);
  },
  onResize({ size } = {}) {
    this.updateNavBar(size);
    this.measureLibraryViewport();
  },
  onPageScroll({ scrollTop }) {
    this.updateScrollState(scrollTop);
  },
  onShareAppMessage() { return appShareMessage(); },
  onShareTimeline() { return timelineShareMessage(); },
  onLibraryScroll({ detail } = {}) {
    const scrollTop = detail?.scrollTop || 0;
    const scrollHeight = Number(detail?.scrollHeight) || 0;
    this._lastScrollTop = scrollTop;
    if (scrollHeight) this._libraryScrollHeight = scrollHeight;
    const wasAtBottom = Boolean(this._libraryAtBottom);
    this._libraryAtBottom = Boolean(
      this._libraryViewportHeight
      && this._libraryScrollHeight
      && scrollTop + this._libraryViewportHeight >= this._libraryScrollHeight - 3
    );
    if (!wasAtBottom && this._libraryAtBottom && this._libraryTouchActive) {
      this._bottomPullOriginY = this._libraryTouchLastY;
    }
    this.updateScrollState(scrollTop);
  },
  measureLibraryViewport() {
    wx.createSelectorQuery().select('.library-scroll').boundingClientRect((rect) => {
      if (rect?.height) this._libraryViewportHeight = rect.height;
    }).exec();
  },
  onLibraryTouchStart(event) {
    const clientY = Number(event.touches?.[0]?.clientY);
    if (!Number.isFinite(clientY)) return;
    this._libraryTouchActive = true;
    this._libraryTouchLastY = clientY;
    this._bottomPullOriginY = this._libraryAtBottom ? clientY : null;
    clearTimeout(this._bottomPullTimer);
    if (this.data.bottomPullReleasing) this.setData({ bottomPullReleasing: false });
  },
  onLibraryTouchMove(event) {
    const clientY = Number(event.touches?.[0]?.clientY);
    if (!Number.isFinite(clientY)) return;
    this._libraryTouchLastY = clientY;
    if (this.data.hasMore || !this.data.items.length || !this._libraryAtBottom) return;
    if (!Number.isFinite(this._bottomPullOriginY)) {
      this._bottomPullOriginY = clientY;
      return;
    }
    const pullDistance = this._bottomPullOriginY - clientY;
    if (pullDistance <= 0) {
      if (this.data.bottomPullDistance) this.setData({ bottomPullDistance: 0 });
      return;
    }
    const resistedDistance = Math.min(88, Math.round(Math.pow(pullDistance, 0.82) * 1.15));
    if (resistedDistance !== this.data.bottomPullDistance) {
      this.setData({ bottomPullDistance: resistedDistance, bottomPullReleasing: false });
    }
  },
  onLibraryTouchEnd() {
    this._libraryTouchActive = false;
    this._libraryTouchLastY = null;
    this._bottomPullOriginY = null;
    if (!this.data.bottomPullDistance) return;
    this.setData({ bottomPullDistance: 0, bottomPullReleasing: true });
    clearTimeout(this._bottomPullTimer);
    this._bottomPullTimer = setTimeout(() => this.setData({ bottomPullReleasing: false }), 420);
  },
  updateScrollState(scrollTop) {
    const navScrolled = scrollTop > 8;
    if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled });
  },
  updateNavBar(size) {
    const layout = getNavigationLayout(size);
    this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle, filterStickyStyle: layout.stickyTopStyle });
  },
  back() { wx.switchTab({ url: this.data.backTarget || '/pages/home/index' }); },
  onBackGuardLeave() {
    if (this._leavingByGesture) return;
    this._leavingByGesture = true;
    this.setData({ backGuardVisible: false }, () => {
      wx.switchTab({
        url: this.data.backTarget || '/pages/home/index',
        complete: () => { this._leavingByGesture = false; }
      });
    });
  },
  scrollLibraryToTop() {
    this.setData({ scrollIntoView: '' }, () => {
      wx.nextTick(() => this.setData({ scrollIntoView: 'library-top' }));
    });
  },
  queryString(cursor = '') {
    const params = [];
    const add = (key, value) => params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    add('limit', LIBRARY_PAGE_SIZE);
    if (cursor) add('cursor', cursor);
    const key = this.data.activeFilter;
    if (SUBJECT_KEYS.includes(key)) add('subject', key);
    if (key === 'single_choice') add('type', key);
    if (key === 'this_week') add('this_week', 'true');
    if (this.data.masteryFilter !== 'all') add('mastery_status', this.data.masteryFilter);
    const external = this.data.externalFilters || {};
    if (external.subject) add('subject', external.subject);
    if (external.type) add('type', external.type);
    if (external.difficulty) add('difficulty', external.difficulty);
    if (external.knowledge_point) add('knowledge_point', external.knowledge_point);
    if (Array.isArray(external.knowledge_points)) {
      external.knowledge_points.forEach((point) => add('knowledge_points', point));
    }
    if (external.source) add('source', external.source);
    return params.join('&');
  },
  async load({ append = false, refreshing = false } = {}) {
    if (append && (this.data.loading || this.data.loadingMore || !this.data.hasMore || this.data.isGuest)) return;
    const requestVersion = append ? (this._libraryRequestVersion || 0) : (this._libraryRequestVersion || 0) + 1;
    if (!append) this._libraryRequestVersion = requestVersion;
    if (refreshing) {
      clearTimeout(this._refreshFeedbackTimer);
      this.setData({ refreshing: true, refreshFeedback: 'loading' });
    }

    if (!isLoggedIn()) {
      let items = this.data.visibleKeys.flatMap((subject) => getGuestQuestions(subject));
      const key = this.data.activeFilter;
      if (SUBJECT_KEYS.includes(key)) items = items.filter((item) => item.subject === key);
      if (key === 'single_choice') items = items.filter((item) => item.type === key);
      if (key === 'this_week') {
        const monday = new Date();
        const day = (monday.getDay() + 6) % 7;
        monday.setHours(0, 0, 0, 0);
        monday.setDate(monday.getDate() - day);
        items = items.filter((item) => new Date(item.created_at) >= monday);
      }
      const external = this.data.externalFilters || {};
      if (external.subject) items = items.filter((item) => item.subject === external.subject);
      if (external.type) items = items.filter((item) => item.type === external.type);
      if (external.difficulty) items = items.filter((item) => item.difficulty === external.difficulty);
      if (external.knowledge_point) items = items.filter((item) => item.knowledge_points?.includes(external.knowledge_point));
      if (Array.isArray(external.knowledge_points) && external.knowledge_points.length) {
        items = items.filter((item) => external.knowledge_points.some((point) => item.knowledge_points?.includes(point)));
      }
      const masterySummary = masterySummaryFor(items);
      if (this.data.masteryFilter !== 'all') items = items.filter((item) => item.mastery_status === this.data.masteryFilter);
      this.setData({
        loading: false,
        loadingMore: false,
        hasMore: false,
        nextCursor: '',
        isGuest: true,
        items,
        masterySummary,
        masteryDisplayCounts: masteryDisplayCounts(masterySummary)
      }, () => this.measureLibraryViewport());
      if (refreshing) this.finishRefreshFeedback(true);
      return;
    }
    this.setData(append
      ? { loadingMore: true }
      : { loading: !refreshing, refreshing, loadingMore: false, hasMore: false, nextCursor: '' });
    let succeeded = false;
    try {
      const result = await request(`/questions?${this.queryString(append ? this.data.nextCursor : '')}`);
      if (requestVersion !== this._libraryRequestVersion) return;
      const masterySummary = result.mastery_summary || masterySummaryFor(result.items || []);
      const nextCursor = result.next_cursor || '';
      this.setData({
        items: append ? appendUniqueQuestions(this.data.items, result.items || []) : (result.items || []),
        isGuest: false,
        nextCursor,
        hasMore: Boolean(nextCursor),
        masterySummary,
        masteryDisplayCounts: masteryDisplayCounts(masterySummary)
      }, () => this.measureLibraryViewport());
      succeeded = true;
    }
    catch (error) {
      if (requestVersion === this._libraryRequestVersion) showError(error);
    }
    finally {
      if (requestVersion === this._libraryRequestVersion) {
        this.setData({ loading: false, loadingMore: false });
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
  refresh() {
    if (this.data.loading || this.data.refreshing) {
      this.setData({ refreshing: false });
      return;
    }
    this.load({ refreshing: true });
  },
  loadMore() {
    this.load({ append: true });
  },
  filter(event) {
    this.setData({ activeFilter: event.currentTarget.dataset.key, externalFilters: {}, filterNotice: '' });
    this.scrollLibraryToTop();
    this.load();
  },
  toggleMasteryFilter(event) {
    const selected = event.currentTarget.dataset.status;
    const masteryFilter = selected === 'all' || this.data.masteryFilter === selected ? 'all' : selected;
    if (masteryFilter === this.data.masteryFilter) return;
    this.setData({ masteryFilter });
    this.scrollLibraryToTop();
    this.load();
  },
  input(event) { this.setData({ keyword: event.detail.value }); },
  search() {
    if (!this.data.keyword.trim()) return;
    wx.navigateTo({ url: `/pages/smart-search/index?keyword=${encodeURIComponent(this.data.keyword.trim())}` });
  },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); },
  openMastery() {
    if (!isLoggedIn()) {
      promptLogin('登录后可查看你的知识点掌握度和薄弱项分析。');
      return;
    }
    wx.navigateTo({ url: '/pages/mastery/index' });
  },
  openQuestion(event) {
    this._detailScrollTop = this._lastScrollTop || 0;
    wx.navigateTo({ url: `/pages/question-detail/index?id=${event.detail.id}&from=library` });
  }
});

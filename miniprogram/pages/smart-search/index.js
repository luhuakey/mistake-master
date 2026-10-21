import { request, showError } from '../../services/api';
import { isLoggedIn } from '../../utils/auth';
import { searchGuestQuestions } from '../../utils/guest-data';
import { getNavigationLayout } from '../../utils/navigation';
import { setCurrentPracticeSession } from '../../utils/practice-session';

Page({
  data: { keyword: '', loading: false, searched: false, items: [], isGuest: true, searchMode: '', searchNotice: '', navShellStyle: '', navBarStyle: '', navScrolled: false },
  onLoad(options) {
    this.updateNavBar();
    this.setData({ isGuest: !isLoggedIn() });
    if (options.keyword) {
      this.setData({ keyword: decodeURIComponent(options.keyword) });
      this.search();
    }
  },
  onShow() {
    const isGuest = !isLoggedIn();
    if (isGuest === this.data.isGuest) return;
    this.setData({ isGuest, items: [], searched: false, searchMode: '', searchNotice: '' });
    if (this.data.keyword.trim()) this.search();
  },
  onResize({ size } = {}) { this.updateNavBar(size); },
  onPageScroll({ scrollTop }) { const navScrolled = scrollTop > 8; if (navScrolled !== this.data.navScrolled) this.setData({ navScrolled }); },
  updateNavBar(size) { const layout = getNavigationLayout(size); this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle }); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/question-list/index' }) }); }, input(event) { this.setData({ keyword: event.detail.value }); },
  guestSearch(keyword, notice = '当前为游客关键词匹配，仅检索体验题') {
    this.setData({
      loading: false,
      searched: true,
      isGuest: true,
      items: searchGuestQuestions(keyword),
      searchMode: 'guest_keyword',
      searchNotice: notice
    });
  },
  async search() {
    const keyword = this.data.keyword.trim();
    if (!keyword) return;
    if (!isLoggedIn()) {
      this.guestSearch(keyword);
      return;
    }
    this.setData({ loading: true });
    try {
      const result = await request('/search/questions', { method: 'POST', data: { keyword } });
      const searchMode = result.search_mode || 'semantic';
      const fallbackNotices = {
        VECTOR_NOT_CONFIGURED: '语义服务配置尚未完成，已使用关键词匹配',
        EMBEDDING_NOT_CONFIGURED: '文本向量服务尚未配置，已使用关键词匹配',
        EMBEDDING_FAILED: '文本向量服务暂时波动，已使用关键词匹配',
        EMBEDDING_TIMEOUT: '文本向量服务响应较慢，已使用关键词匹配',
        VECTOR_TIMEOUT: '语义索引响应较慢，已使用关键词匹配',
        VECTOR_RATE_LIMITED: '语义索引当前繁忙，已使用关键词匹配',
        VECTOR_ACCESS_DENIED: '云端语义服务连接受限，已使用关键词匹配；请联系管理员检查访问白名单',
        VECTOR_COLLECTION_NOT_FOUND: '云端语义索引配置不一致，已使用关键词匹配；请联系管理员检查服务配置',
        VECTOR_SEARCH_FAILED: '语义索引服务暂时波动，已使用关键词匹配',
        SEMANTIC_SEARCH_UNAVAILABLE: '语义检索暂时不可用，已使用关键词匹配'
      };
      this.setData({
        items: result.items || [],
        searched: true,
        isGuest: false,
        searchMode,
        searchNotice: ['semantic', 'hybrid'].includes(searchMode)
          ? (result.semantic_cache_used
            ? '实时语义服务短暂波动，已使用最近语义结果与关键词联合检索'
            : result.repaired_index_count
            ? `已自动补建 ${result.repaired_index_count} 道题的语义索引，并完成联合检索`
            : '已使用语义与关键词联合检索，兼顾题意和精确内容')
          : (fallbackNotices[result.degradation_code] || fallbackNotices.SEMANTIC_SEARCH_UNAVAILABLE)
      });
    }
    catch (error) {
      if (error?.code === 'AUTH_REQUIRED') {
        this.guestSearch(keyword, '登录状态已失效，已切换为游客关键词匹配');
        return;
      }
      showError(error);
    }
    finally { this.setData({ loading: false }); }
  },
  openQuestion(event) { wx.navigateTo({ url: `/pages/question-detail/index?id=${event.detail.id}` }); },
  openLogin() { wx.navigateTo({ url: '/pages/login/index?return_to=previous' }); },
  async practice() {
    if (this.data.isGuest) return this.openLogin();
    try {
      const result = await request('/practice-sessions/from-questions', { method: 'POST', data: { question_ids: this.data.items.map((item) => item.id), type: 'search' } });
      setCurrentPracticeSession(result.practice_session_id);
      wx.switchTab({ url: '/pages/practice/index' });
    } catch (error) { showError(error); }
  }
});

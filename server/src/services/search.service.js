import { assert } from '../shared/errors.js';
import { nowIso } from '../shared/utils.js';

const MIN_KEYWORD_SCORE = 0.45;
const MIN_SEMANTIC_SCORE = 0.25;
const WEAK_SEMANTIC_TOP_SCORE = 0.45;
const WEAK_SEMANTIC_MAX_GAP = 0.08;
const INDEX_REPAIR_BATCH_SIZE = 10;
const SEMANTIC_CACHE_TTL_MS = 10 * 60 * 1000;
const retryDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const qualifiedSemanticHits = (hits = []) => {
  const ranked = hits
    .map((hit) => ({ ...hit, score: Number(hit.score) }))
    .filter((hit) => hit.id && Number.isFinite(hit.score))
    .sort((a, b) => b.score - a.score);
  const topScore = ranked[0]?.score || 0;
  if (topScore < MIN_SEMANTIC_SCORE) return [];

  // 当前向量模型在短文本上的绝对分偏低。弱置信区间除设置绝对下限外，
  // 还只保留接近首条的结果，避免把向量空间中的背景噪声当成相关题目。
  const minimumScore = topScore < WEAK_SEMANTIC_TOP_SCORE
    ? Math.max(MIN_SEMANTIC_SCORE, topScore - WEAK_SEMANTIC_MAX_GAP)
    : MIN_SEMANTIC_SCORE;
  return ranked.filter((hit) => hit.score >= minimumScore);
};

export class SearchService {
  constructor(store, vector, questionService) {
    this.store = store;
    this.vector = vector;
    this.questionService = questionService;
    this.semanticCache = new Map();
    this.lastSemanticStatus = { available: null, code: '', checked_at: '' };
  }

  semanticCacheKey(userId, keyword, subject, limit) {
    return [userId, subject || 'all', limit, String(keyword).toLowerCase()].join(':');
  }

  async keywordFallback(userId, keyword, subject, limit) {
    const compactKeyword = String(keyword).toLowerCase().replace(/\s+/g, '');
    const keywordChars = [...new Set(compactKeyword)];
    const questions = await this.questionService.allForUser(userId);
    return questions
      .filter((question) => !subject || question.subject === subject)
      .map((question) => {
        const stem = String(question.stem || '').toLowerCase().replace(/\s+/g, '');
        const knowledge = (question.knowledge_points || []).join(' ').toLowerCase().replace(/\s+/g, '');
        const searchable = [
          stem,
          knowledge,
          ...Object.values(question.options || {}),
          question.analysis,
          question.error_prone_point
        ].filter(Boolean).join('').toLowerCase().replace(/\s+/g, '');
        const overlap = keywordChars.length
          ? keywordChars.filter((character) => searchable.includes(character)).length / keywordChars.length
          : 0;
        const exact = searchable.includes(compactKeyword) ? 0.75 : 0;
        const stemBoost = stem.includes(compactKeyword) ? 0.15 : 0;
        const knowledgeBoost = knowledge.includes(compactKeyword) ? 0.1 : 0;
        return { id: question._id, score: Math.min(1, exact + stemBoost + knowledgeBoost + overlap * 0.35) };
      })
      // 单字符重合最高只会得到 0.35；降级检索宁可少而准确，只返回完整关键词命中。
      .filter((item) => item.score >= MIN_KEYWORD_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async repairPendingIndexes(userId, subject) {
    if (typeof this.vector.upsertMany !== 'function') return 0;
    const questions = await this.questionService.allForUser(userId);
    const pending = questions
      .filter((question) => question.index_status !== 'ready' && (!subject || question.subject === subject))
      .slice(0, INDEX_REPAIR_BATCH_SIZE);
    if (!pending.length) return 0;
    try {
      await this.vector.upsertMany(pending);
      await Promise.all(pending.map((question) => this.store.update('questions', question._id, {
        index_status: 'ready',
        updated_at: nowIso()
      })));
      return pending.length;
    } catch {
      // 补建失败不阻断搜索，随后仍可走关键词降级链路。
      return 0;
    }
  }

  async search(userId, { keyword, subject, limit = 20 }) {
    const normalizedKeyword = String(keyword || '').trim();
    assert(normalizedKeyword, 'SEARCH_KEYWORD_REQUIRED', '请输入搜索内容');
    const normalizedLimit = Math.min(Number(limit) || 20, 30);
    const repairedIndexCount = await this.repairPendingIndexes(userId, subject);
    const cacheKey = this.semanticCacheKey(userId, normalizedKeyword, subject, normalizedLimit);
    let semanticHits = [];
    let semanticError = null;
    let semanticCacheUsed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rawSemanticHits = await this.vector.search({ userId, keyword: normalizedKeyword, subject, limit: normalizedLimit });
        semanticHits = qualifiedSemanticHits(rawSemanticHits);
        this.semanticCache.set(cacheKey, { hits: semanticHits, expiresAt: Date.now() + SEMANTIC_CACHE_TTL_MS });
        this.lastSemanticStatus = { available: true, code: '', checked_at: nowIso() };
        semanticError = null;
        break;
      } catch (error) {
        semanticError = error;
        this.lastSemanticStatus = {
          available: false,
          code: error?.code || 'SEMANTIC_SEARCH_UNAVAILABLE',
          reason: error?.details?.reason || '',
          checked_at: nowIso()
        };
        if (['VECTOR_NOT_CONFIGURED', 'EMBEDDING_NOT_CONFIGURED'].includes(error?.code)) break;
        if (attempt === 0) await retryDelay(600);
      }
    }

    if (semanticError) {
      const cached = this.semanticCache.get(cacheKey);
      if (cached?.expiresAt > Date.now()) {
        semanticHits = cached.hits;
        semanticCacheUsed = true;
        semanticError = null;
      } else if (cached) this.semanticCache.delete(cacheKey);
    }

    if (semanticError) {
      console.warn('[semantic-search-fallback]', {
        code: semanticError.code || 'SEMANTIC_SEARCH_UNAVAILABLE',
        reason: semanticError.details?.reason || '',
        provider_code: semanticError.details?.provider_code ?? null,
        http_status: semanticError.details?.http_status ?? null
      });
    }

    let hits;
    let searchMode;
    let degradationCode = '';
    if (semanticError) {
      hits = await this.keywordFallback(userId, normalizedKeyword, subject, normalizedLimit);
      searchMode = 'keyword_fallback';
      degradationCode = semanticError.code || 'SEMANTIC_SEARCH_UNAVAILABLE';
    } else {
      const keywordHits = await this.keywordFallback(userId, normalizedKeyword, subject, normalizedLimit);
      const merged = new Map();
      semanticHits.forEach((hit) => merged.set(hit.id, hit));
      keywordHits.forEach((hit) => {
        const existing = merged.get(hit.id);
        if (!existing || hit.score > existing.score) merged.set(hit.id, hit);
      });
      hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, normalizedLimit);
      searchMode = 'hybrid';
    }
    const items = [];
    for (const hit of hits) {
      const question = await this.store.get('questions', hit.id);
      if (question?.user_id === userId) items.push({ ...this.questionService.card(question), similarity: Math.round(hit.score * 100) });
    }
    return {
      keyword: normalizedKeyword,
      total: items.length,
      items,
      search_mode: searchMode,
      degradation_code: degradationCode,
      repaired_index_count: repairedIndexCount,
      semantic_cache_used: semanticCacheUsed
    };
  }

  status() {
    return { ...this.lastSemanticStatus };
  }
}

import { assert, notFound } from '../shared/errors.js';
import {
  dateKey,
  id,
  isSubjectivePracticeType,
  normalizePracticeAnswer,
  nowIso,
  practiceAnswerIsValid,
  practiceableQuestion,
  practiceAnswersEqual,
  unique
} from '../shared/utils.js';
import { isSubject, subjectName } from '../shared/subjects.js';

const msPerDay = 86_400_000;
const RECOMMENDATION_DIFFICULTIES = new Set(['adaptive', 'easy', 'medium', 'hard']);
const DEFAULT_PRACTICE_QUESTION_LIMIT = 10;
const DEFAULT_MASTERED_QUESTION_RATIO = 20;
const practiceQuestionLimitFor = (user) => {
  const value = Number(user?.practice_question_limit);
  return Number.isInteger(value) && value >= 1 && value <= 20 ? value : DEFAULT_PRACTICE_QUESTION_LIMIT;
};
const masteredQuestionRatioFor = (user) => {
  const value = Number(user?.mastered_question_ratio);
  return Number.isInteger(value) && value >= 0 && value <= 50 ? value : DEFAULT_MASTERED_QUESTION_RATIO;
};

const compactFingerprint = (value) => {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export class PracticeService {
  constructor(store, questionService, deepseek, learningStatsService = null) {
    this.store = store;
    this.questionService = questionService;
    this.deepseek = deepseek;
    this.learningStatsService = learningStatsService;
  }

  candidatePriority(question, statsByKnowledge, preferences = {}) {
    const wrongRate = question.practice_count ? question.wrong_count / question.practice_count : 0.5;
    const days = question.last_practiced_at ? Math.min(30, (Date.now() - new Date(question.last_practiced_at).getTime()) / msPerDay) : 30;
    const practicedPoints = (question.knowledge_points || []).flatMap((point) => {
      const stat = statsByKnowledge.get(`${question.subject}:${point}`);
      return Number(stat?.attempt_count) > 0
        ? [{ point, mastery: Math.max(0, Math.min(100, Number(stat.mastery_rate) || 0)) }]
        : [];
    });
    const averageMastery = practicedPoints.length
      ? practicedPoints.reduce((sum, item) => sum + item.mastery, 0) / practicedPoints.length
      : 50;
    const lowestMastery = practicedPoints.length
      ? Math.min(...practicedPoints.map((item) => item.mastery))
      : 50;
    // 只要题目涉及一个明显薄弱点就应优先，同时兼顾该题全部知识点的整体掌握情况。
    const knowledgeWeakness = 0.7 * (1 - lowestMastery / 100) + 0.3 * (1 - averageMastery / 100);
    const weakFirst = preferences.weakFirst !== false;
    const baseScore = weakFirst
      ? 0.55 * knowledgeWeakness + 0.25 * wrongRate + 0.20 * (days / 30)
      : 0.20 * knowledgeWeakness + 0.45 * wrongRate + 0.35 * (days / 30);
    const preferredDifficulty = RECOMMENDATION_DIFFICULTIES.has(preferences.difficulty)
      ? preferences.difficulty
      : 'adaptive';
    const difficultyBoost = preferredDifficulty !== 'adaptive' && question.difficulty === preferredDifficulty ? 0.08 : 0;
    return {
      id: question._id,
      score: Number((baseScore + difficultyBoost).toFixed(6)),
      knowledge_mastery: practicedPoints.length ? Math.round(averageMastery) : null,
      weak_knowledge_points: practicedPoints.filter((item) => item.mastery < 60).map((item) => item.point),
      wrong_rate: Number(wrongRate.toFixed(4)),
      days_since_practice: Math.round(days),
      difficulty: question.difficulty
    };
  }

  scoreCandidate(question, statsByKnowledge, preferences = {}) {
    return this.candidatePriority(question, statsByKnowledge, preferences).score;
  }

  selectComprehensiveQuestionIds(orderedIds, candidates, targetCount, masteredRatio) {
    const questionsById = new Map(candidates.map((question) => [String(question._id), question]));
    const ordered = unique(orderedIds).filter((questionId) => questionsById.has(String(questionId)));
    const masteredLimit = Math.floor(targetCount * masteredRatio / 100);
    const masteredIds = ordered.filter((questionId) => questionsById.get(String(questionId))?.mastery_status === 'mastered');
    const unmasteredIds = ordered.filter((questionId) => questionsById.get(String(questionId))?.mastery_status !== 'mastered');
    const selected = new Set([
      ...unmasteredIds.slice(0, Math.max(0, targetCount - masteredLimit)),
      ...masteredIds.slice(0, masteredLimit)
    ]);
    // 未掌握或已掌握题数量不足时，用另一类题目补足用户设置的练习总量。
    for (const questionId of ordered) {
      if (selected.size >= targetCount) break;
      selected.add(questionId);
    }
    return ordered.filter((questionId) => selected.has(questionId)).slice(0, targetCount);
  }

  async recommended(userId, subject, { mode = 'recommended', excludeQuestionIds = [] } = {}) {
    assert(subject === 'all' || isSubject(subject), 'INVALID_SUBJECT', '科目无效');
    assert(['recommended', 'comprehensive'].includes(mode), 'INVALID_PRACTICE_MODE', '练习入口无效');
    assert(mode !== 'comprehensive' || subject === 'all', 'INVALID_PRACTICE_MODE', '综合练习必须包含全部科目');
    assert(Array.isArray(excludeQuestionIds), 'INVALID_EXCLUDED_QUESTIONS', '排除题目格式无效');
    const today = dateKey();
    let daily = (await this.store.find('daily_recommendations', { where: { user_id: userId, subject, date_key: today }, limit: 1 }))[0];
    const [questions, stats, user] = await Promise.all([
      this.questionService.allForUser(userId),
      this.store.find('knowledge_point_stats', { where: subject === 'all' ? { user_id: userId } : { user_id: userId, subject }, limit: 100 }),
      this.store.get('users', userId)
    ]);
    const candidates = questions.filter((q) => (
      (subject === 'all' || q.subject === subject) && practiceableQuestion(q)
    ));
    if (!candidates.length) {
      const scopeLabel = subject === 'all' ? '' : subjectName(subject);
      return {
        available: false,
        practice_session_id: '',
        total_count: 0,
        type: mode,
        subject,
        message: `${scopeLabel}暂无可练习错题，请先上传错题`
      };
    }

    const practiceQuestionLimit = practiceQuestionLimitFor(user);
    const masteredQuestionRatio = masteredQuestionRatioFor(user);
    const targetCount = Math.min(practiceQuestionLimit, candidates.length);
    const preferences = {
      weakFirst: user?.recommendation_weak_first !== false,
      difficulty: RECOMMENDATION_DIFFICULTIES.has(user?.recommendation_difficulty)
        ? user.recommendation_difficulty
        : 'adaptive',
      questionLimit: practiceQuestionLimit,
      masteredQuestionRatio: mode === 'comprehensive' ? masteredQuestionRatio : null
    };
    const rankingFingerprint = compactFingerprint({
      preferences,
      candidates: candidates.map((question) => [
        question._id,
        question.practice_count || 0,
        question.wrong_count || 0,
        question.last_practiced_at || '',
        question.difficulty,
        question.knowledge_points || [],
        question.mastery_status || 'unmastered'
      ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      stats: stats.map((item) => [
        item.subject,
        item.knowledge_point,
        item.attempt_count || 0,
        item.mastery_rate || 0,
        item.updated_at || ''
      ]).sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`, 'zh-CN'))
    });
    const candidateIds = new Set(candidates.map((question) => question._id));
    const cachedIds = daily?.question_ids || [];
    const cacheMatchesCurrentTotal = daily?.ranking_fingerprint === rankingFingerprint
      && cachedIds.length === targetCount
      && cachedIds.every((questionId) => candidateIds.has(questionId));
    if (!cacheMatchesCurrentTotal) {
      const statsByKnowledge = new Map(stats.map((item) => [`${item.subject}:${item.knowledge_point}`, item]));
      const rankedCandidates = candidates
        .map((question) => this.candidatePriority(question, statsByKnowledge, preferences))
        .sort((a, b) => b.score - a.score);
      const aiIds = await this.deepseek.rankCandidateIds(rankedCandidates, targetCount);
      const orderedIds = unique([...aiIds, ...rankedCandidates.map((item) => item.id)]);
      const questionIds = mode === 'comprehensive'
        ? this.selectComprehensiveQuestionIds(orderedIds, candidates, targetCount, masteredQuestionRatio)
        : orderedIds.slice(0, targetCount);
      daily = {
        _id: daily?._id || id('daily'),
        user_id: userId,
        subject,
        date_key: today,
        question_ids: questionIds,
        ranking_fingerprint: rankingFingerprint,
        created_at: daily?.created_at || nowIso(),
        updated_at: nowIso()
      };
      await this.store.put('daily_recommendations', daily);
    }
    const excluded = new Set(excludeQuestionIds.slice(0, 50).map(String));
    let sessionQuestionIds = daily.question_ids;
    if (excluded.size) {
      const eligibleCandidates = candidates.filter((question) => !excluded.has(String(question._id)));
      if (eligibleCandidates.length) {
        const statsByKnowledge = new Map(stats.map((item) => [`${item.subject}:${item.knowledge_point}`, item]));
        const rankedEligibleIds = eligibleCandidates
          .map((question) => this.candidatePriority(question, statsByKnowledge, preferences))
          .sort((a, b) => b.score - a.score)
          .map((item) => item.id);
        const orderedEligibleIds = unique([
          ...daily.question_ids.filter((questionId) => !excluded.has(String(questionId))),
          ...rankedEligibleIds
        ]);
        const eligibleTargetCount = Math.min(practiceQuestionLimit, eligibleCandidates.length);
        sessionQuestionIds = mode === 'comprehensive'
          ? this.selectComprehensiveQuestionIds(orderedEligibleIds, eligibleCandidates, eligibleTargetCount, masteredQuestionRatio)
          : orderedEligibleIds.slice(0, eligibleTargetCount);
      }
    }
    return this.createSession(userId, sessionQuestionIds, mode, subject);
  }

  async createFromQuestions(userId, questionIds, type = 'review') {
    assert(Array.isArray(questionIds) && questionIds.length, 'QUESTION_IDS_REQUIRED', '请选择至少一道题');
    const owned = [];
    for (const questionId of unique(questionIds)) owned.push(await this.questionService.getOwned(userId, questionId));
    assert(owned.every(practiceableQuestion), 'QUESTION_INCOMPLETE', '题目信息不完整，暂时无法加入练习');
    return this.createSession(userId, owned.map((q) => q._id), type, owned[0].subject);
  }

  async createSession(userId, questionIds, type, subject) {
    const session = {
      _id: id('ps'), user_id: userId, subject, type, question_ids: questionIds,
      status: 'active', record_id: null, created_at: nowIso(), submitted_at: null
    };
    await this.store.put('practice_sessions', session);
    return { available: true, practice_session_id: session._id, total_count: questionIds.length, type };
  }

  async getOwnedSession(userId, sessionId) {
    const session = await this.store.get('practice_sessions', sessionId);
    if (!session || session.user_id !== userId) throw notFound('练习不存在');
    return session;
  }

  async getSession(userId, sessionId) {
    const session = await this.getOwnedSession(userId, sessionId);
    const questions = [];
    for (const questionId of session.question_ids) {
      const q = await this.questionService.getOwned(userId, questionId);
      questions.push({
        id: q._id,
        subject: q.subject,
        type: q.type,
        stem: q.stem,
        options: q.options,
        difficulty: q.difficulty,
        has_illustration: Boolean(q.has_illustration),
        question_image_file_id: q.question_image_file_id || '',
        question_image_width: q.question_image_width || 0,
        question_image_height: q.question_image_height || 0
      });
    }
    return { id: session._id, subject: session.subject, type: session.type, status: session.status, record_id: session.record_id, questions };
  }

  async submit(userId, sessionId, answers, orderedAnswers = []) {
    const session = await this.getOwnedSession(userId, sessionId);
    if (session.record_id) return { practice_record_id: session.record_id, already_submitted: true };
    assert(
      (answers && typeof answers === 'object') || Array.isArray(orderedAnswers),
      'ANSWERS_REQUIRED',
      '请完成全部题目'
    );
    const submittedAnswers = Object.fromEntries(Object.entries(answers || {}).map(([questionId, answer]) => [
      String(questionId),
      String(answer ?? '').trim()
    ]));
    const submittedOrderedAnswers = Array.isArray(orderedAnswers)
      ? orderedAnswers.map((answer) => String(answer ?? '').trim())
      : [];
    const items = [];
    for (let index = 0; index < session.question_ids.length; index += 1) {
      const questionId = session.question_ids[index];
      const question = await this.questionService.getOwned(userId, questionId);
      const submittedAnswer = submittedAnswers[String(questionId)] || submittedOrderedAnswers[index] || '';
      const userAnswer = ['single_choice', 'multiple_choice', 'true_false'].includes(question.type)
        ? normalizePracticeAnswer(submittedAnswer)
        : submittedAnswer;
      assert(practiceAnswerIsValid(question, userAnswer), 'ANSWER_INCOMPLETE', `请完成第 ${index + 1} 题`, 400);
      const gradingMode = isSubjectivePracticeType(question.type) ? 'self_review' : 'auto';
      items.push({
        question_id: question._id,
        type: question.type,
        stem: question.stem,
        options: question.options,
        has_illustration: Boolean(question.has_illustration),
        question_image_file_id: question.question_image_file_id || '',
        question_image_width: question.question_image_width || 0,
        question_image_height: question.question_image_height || 0,
        correct_answer: question.correct_answer,
        user_answer: userAnswer,
        grading_mode: gradingMode,
        is_correct: gradingMode === 'auto' ? practiceAnswersEqual(userAnswer, question.correct_answer, question.type) : null,
        analysis: question.analysis,
        error_prone_point: question.error_prone_point,
        knowledge_points: question.knowledge_points,
        difficulty: question.difficulty
      });
    }
    const correctCount = items.filter((item) => item.is_correct === true).length;
    const wrongCount = items.filter((item) => item.is_correct === false).length;
    const pendingCount = items.filter((item) => item.is_correct === null).length;
    const gradedCount = correctCount + wrongCount;
    const recordId = `pr_${sessionId}`;
    const submittedAt = nowIso();
    const record = {
      _id: recordId, session_id: sessionId, user_id: userId, subject: session.subject, type: session.type,
      total_count: items.length, graded_count: gradedCount, pending_count: pendingCount,
      correct_count: correctCount, wrong_count: wrongCount,
      accuracy: gradedCount ? Math.round(correctCount / gradedCount * 100) : null, items, submitted_at: submittedAt
    };
    await this.store.put('practice_records', record);
    if (this.learningStatsService) {
      try { await this.learningStatsService.recordPracticeDay(userId, submittedAt); }
      catch (error) { console.error('[learning-stats-record]', { userId, message: error?.message }); }
    }
    await this.store.update('practice_sessions', sessionId, { status: 'submitted', record_id: recordId, submitted_at: submittedAt });
    for (const item of items) {
      if (item.is_correct === null) continue;
      const question = await this.questionService.getOwned(userId, item.question_id);
      await this.store.update('questions', item.question_id, {
        practice_count: (question.practice_count || 0) + 1,
        wrong_count: (question.wrong_count || 0) + (item.is_correct ? 0 : 1),
        last_practiced_at: submittedAt,
        updated_at: submittedAt
      });
      await this.updateKnowledgeStats(userId, question.subject, question, item.is_correct);
    }
    return { practice_record_id: recordId, already_submitted: false };
  }

  async selfAssess(userId, recordId, questionId, isCorrect) {
    assert(typeof isCorrect === 'boolean', 'SELF_ASSESSMENT_REQUIRED', '请选择“基本正确”或“需要复习”');
    const record = await this.getRecord(userId, recordId);
    const itemIndex = record.items.findIndex((item) => String(item.question_id) === String(questionId));
    assert(itemIndex >= 0, 'PRACTICE_ITEM_NOT_FOUND', '练习题目不存在', 404);
    const item = record.items[itemIndex];
    assert(item.grading_mode === 'self_review', 'SELF_ASSESSMENT_NOT_ALLOWED', '该题由系统自动判分');
    if (item.is_correct !== null) {
      assert(item.is_correct === isCorrect, 'SELF_ASSESSMENT_ALREADY_SUBMITTED', '该题已完成自评');
      return record;
    }

    const items = record.items.map((current, index) => (
      index === itemIndex ? { ...current, is_correct: isCorrect, assessed_at: nowIso() } : current
    ));
    const correctCount = items.filter((current) => current.is_correct === true).length;
    const wrongCount = items.filter((current) => current.is_correct === false).length;
    const pendingCount = items.filter((current) => current.is_correct === null).length;
    const gradedCount = correctCount + wrongCount;
    const updated = await this.store.update('practice_records', recordId, {
      items,
      graded_count: gradedCount,
      pending_count: pendingCount,
      correct_count: correctCount,
      wrong_count: wrongCount,
      accuracy: gradedCount ? Math.round(correctCount / gradedCount * 100) : null
    });
    const question = await this.questionService.getOwned(userId, questionId);
    await this.store.update('questions', questionId, {
      practice_count: (question.practice_count || 0) + 1,
      wrong_count: (question.wrong_count || 0) + (isCorrect ? 0 : 1),
      last_practiced_at: nowIso(),
      updated_at: nowIso()
    });
    await this.updateKnowledgeStats(userId, question.subject, question, isCorrect);
    return updated;
  }

  async updateKnowledgeStats(userId, subject, question, isCorrect) {
    for (const point of question.knowledge_points || []) {
      let stat = (await this.store.find('knowledge_point_stats', { where: { user_id: userId, subject, knowledge_point: point }, limit: 1 }))[0];
      if (!stat) {
        const allQuestions = await this.questionService.allForUser(userId);
        stat = { _id: id('kp'), user_id: userId, subject, knowledge_point: point, question_count: allQuestions.filter((q) => q.subject === subject && q.knowledge_points?.includes(point)).length, attempt_count: 0, correct_count: 0, mastery_rate: 0 };
      }
      const previousAttemptCount = Math.max(0, Number(stat.attempt_count) || 0);
      const previousRate = Math.max(0, Math.min(100, Number(stat.mastery_rate) || 0));
      const previousCorrectCount = Number(stat.correct_count);
      stat.attempt_count = previousAttemptCount;
      stat.correct_count = Math.max(0, Math.min(
        previousAttemptCount,
        Number.isFinite(previousCorrectCount) ? previousCorrectCount : Math.round(previousAttemptCount * previousRate / 100)
      ));
      stat.attempt_count += 1;
      stat.correct_count += isCorrect ? 1 : 0;
      stat.mastery_rate = Math.round(stat.correct_count / stat.attempt_count * 100);
      stat.updated_at = nowIso();
      await this.store.put('knowledge_point_stats', stat);
    }
  }

  async getRecord(userId, recordId) {
    const record = await this.store.get('practice_records', recordId);
    if (!record || record.user_id !== userId) throw notFound('练习记录不存在');
    return record;
  }

  async history(userId, limit = 50) {
    const records = await this.store.find('practice_records', { where: { user_id: userId }, orderBy: 'submitted_at', direction: 'desc', limit: Math.min(Number(limit) || 50, 100) });
    const total = records.reduce((sum, row) => sum + row.total_count, 0);
    const graded = records.reduce((sum, row) => sum + (row.graded_count ?? row.total_count), 0);
    const correct = records.reduce((sum, row) => sum + row.correct_count, 0);
    return {
      summary: { practice_count: records.length, question_count: total, average_accuracy: graded ? Math.round(correct / graded * 100) : null },
      items: records.map(({ items, ...record }) => record)
    };
  }
}

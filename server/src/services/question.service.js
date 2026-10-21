import { assert, notFound } from '../shared/errors.js';
import { clamp, nowIso } from '../shared/utils.js';
import { isSubject } from '../shared/subjects.js';

export class QuestionService {
  constructor(store) {
    this.store = store;
  }

  async allForUser(userId) {
    const questions = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.store.find('questions', {
        where: { user_id: userId },
        orderBy: 'created_at',
        direction: 'desc',
        limit: pageSize,
        offset
      });
      questions.push(...page);
      if (page.length < pageSize) break;
    }
    return questions;
  }

  async list(userId, filters = {}) {
    let rows = await this.allForUser(userId);
    if (filters.subject) rows = rows.filter((row) => row.subject === filters.subject);
    if (filters.type) rows = rows.filter((row) => row.type === filters.type);
    if (filters.difficulty) rows = rows.filter((row) => row.difficulty === filters.difficulty);
    if (filters.source) rows = rows.filter((row) => row.source === filters.source);
    if (filters.knowledge_point) rows = rows.filter((row) => row.knowledge_points?.includes(filters.knowledge_point));
    const requestedKnowledgePoints = (Array.isArray(filters.knowledge_points)
      ? filters.knowledge_points
      : String(filters.knowledge_points || '').split(','))
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean);
    if (requestedKnowledgePoints.length) {
      rows = rows.filter((row) => requestedKnowledgePoints.some((point) => row.knowledge_points?.includes(point)));
    }
    if (filters.this_week === 'true') {
      const now = new Date();
      const day = (now.getDay() + 6) % 7;
      const monday = new Date(now);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(now.getDate() - day);
      rows = rows.filter((row) => new Date(row.created_at) >= monday);
    }
    const masterySummary = {
      total_count: rows.length,
      unmastered_count: rows.filter((row) => row.mastery_status !== 'mastered').length,
      mastered_count: rows.filter((row) => row.mastery_status === 'mastered').length
    };
    if (filters.mastery_status) rows = rows.filter((row) => row.mastery_status === filters.mastery_status);
    const limit = clamp(Number(filters.limit || 20), 1, 50);
    const offset = Math.max(0, Number(filters.cursor || 0));
    return {
      items: rows.slice(offset, offset + limit).map(this.card),
      next_cursor: offset + limit < rows.length ? String(offset + limit) : null,
      mastery_summary: masterySummary
    };
  }

  card(question) {
    return {
      id: question._id,
      subject: question.subject,
      type: question.type,
      stem: question.stem,
      knowledge_points: question.knowledge_points,
      mastery_status: question.mastery_status,
      difficulty: question.difficulty,
      source: question.source,
      created_at: question.created_at
    };
  }

  async getOwned(userId, questionId) {
    const question = await this.store.get('questions', questionId);
    if (!question || question.user_id !== userId) throw notFound('题目不存在');
    return question;
  }

  async detail(userId, questionId) {
    return this.getOwned(userId, questionId);
  }

  async updateMastery(userId, questionId, masteryStatus) {
    assert(['mastered', 'unmastered'].includes(masteryStatus), 'INVALID_MASTERY_STATUS', '掌握状态无效');
    const question = await this.getOwned(userId, questionId);
    const updatedAt = nowIso();
    return this.store.update('questions', questionId, {
      mastery_status: masteryStatus,
      ...(
        masteryStatus === 'mastered'
        && question.mastery_status !== 'mastered'
        && !question.first_mastered_at
          ? { first_mastered_at: updatedAt }
          : {}
      ),
      updated_at: updatedAt
    });
  }

  async home(userId, subject) {
    assert(isSubject(subject), 'INVALID_SUBJECT', '科目无效');
    const [questions, records] = await Promise.all([
      this.allForUser(userId),
      this.store.find('practice_records', { where: { user_id: userId }, limit: 100 })
    ]);
    const subjectQuestions = questions.filter((row) => row.subject === subject);
    const subjectRecords = records.filter((row) => row.subject === subject);
    const totalAnswered = subjectRecords.reduce((sum, row) => sum + (row.graded_count ?? row.total_count), 0);
    const totalCorrect = subjectRecords.reduce((sum, row) => sum + row.correct_count, 0);
    return {
      subject,
      summary: {
        collected_count: subjectQuestions.length,
        mastered_count: subjectQuestions.filter((row) => row.mastery_status === 'mastered').length,
        accuracy: totalAnswered ? Math.round(totalCorrect / totalAnswered * 100) : null
      },
      recent_questions: subjectQuestions.slice(0, 10).map(this.card)
    };
  }
}

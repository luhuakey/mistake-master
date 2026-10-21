import { dateKey, id, nowIso } from '../shared/utils.js';
import { streak as computeStreak, studyDays } from '../shared/study-stats.js';
import { assert } from '../shared/errors.js';
import { DEFAULT_VISIBLE_SUBJECTS, isSubject, normalizeVisibleSubjects } from '../shared/subjects.js';

const RECOMMENDATION_DIFFICULTIES = new Set(['adaptive', 'easy', 'medium', 'hard']);
const REMINDER_FREQUENCIES = new Set(['daily', 'weekdays']);
const DEFAULT_PRACTICE_QUESTION_LIMIT = 10;
const validPracticeQuestionLimit = (value) => Number.isInteger(value) && value >= 1 && value <= 20;
const DEFAULT_MASTERED_QUESTION_RATIO = 20;
const validMasteredQuestionRatio = (value) => Number.isInteger(value) && value >= 0 && value <= 50;
const validReminderTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));

export class ProfileService {
  constructor(store, questionService, practiceService, storage, pointsService = null, learningStatsService = null) {
    this.store = store;
    this.questionService = questionService;
    this.practiceService = practiceService;
    this.storage = storage;
    this.pointsService = pointsService;
    this.learningStatsService = learningStatsService;
  }

  async publicUser(user) {
    let avatarUrl = user.avatar_url || '';
    if (user.avatar_file_id && this.storage) {
      try { avatarUrl = await this.storage.downloadUrl(user.avatar_file_id); }
      catch { avatarUrl = user.avatar_url || ''; }
    }
    return { id: user._id, nickname: user.nickname || '学霸同学', avatar_url: avatarUrl };
  }

  async allPracticeRecordsForUser(userId) {
    const records = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.store.find('practice_records', {
        where: { user_id: userId },
        orderBy: 'submitted_at',
        direction: 'desc',
        limit: pageSize,
        offset
      });
      records.push(...page);
      if (page.length < pageSize) break;
    }
    return records;
  }

  streak(records, now = new Date()) {
    return computeStreak(records, now);
  }

  practiceDays(records) {
    return studyDays(records);
  }

  checkinRecordSummary(record) {
    return {
      id: record._id,
      subject: record.subject,
      type: record.type,
      total_count: Number(record.total_count) || 0,
      graded_count: Number(record.graded_count) || 0,
      accuracy: record.accuracy ?? null,
      submitted_at: record.submitted_at
    };
  }

  async checkin(userId, query = {}) {
    const month = String(query.month || '').trim();
    const date = String(query.date || '').trim();
    const validMonth = /^\d{4}-(?:0[1-9]|1[0-2])$/;
    const validDay = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
    const isRealDate = (value) => {
      const [year, monthNumber, day] = value.split('-').map(Number);
      const parsed = new Date(Date.UTC(year, monthNumber - 1, day));
      return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === monthNumber - 1 && parsed.getUTCDate() === day;
    };
    assert((month && !date) || (!month && date), 'CHECKIN_QUERY_INVALID', '请提供 month 或 date，且只能提供其一');
    const records = await this.allPracticeRecordsForUser(userId);
    if (month) {
      assert(validMonth.test(month), 'CHECKIN_QUERY_INVALID', 'month 格式应为 YYYY-MM');
      const prefix = `${month}-`;
      const days = [...new Set(records
        .map((record) => dateKey(new Date(record.submitted_at)))
        .filter((day) => day.startsWith(prefix)))]
        .sort();
      return { month, days };
    }
    assert(validDay.test(date) && isRealDate(date), 'CHECKIN_QUERY_INVALID', 'date 格式应为 YYYY-MM-DD');
    const items = records
      .filter((record) => dateKey(new Date(record.submitted_at)) === date)
      .map((record) => this.checkinRecordSummary(record));
    return { date, items };
  }

  async profile(userId) {
    const [user, questions, records] = await Promise.all([
      this.store.get('users', userId),
      this.questionService.allForUser(userId),
      this.allPracticeRecordsForUser(userId)
    ]);
    const answered = records.reduce((sum, row) => sum + (row.graded_count ?? row.total_count), 0);
    const correct = records.reduce((sum, row) => sum + row.correct_count, 0);
    const learningStats = this.learningStatsService
      ? await this.learningStatsService.getStats(userId, records)
      : null;
    const totalStudyDays = learningStats ? learningStats.total_study_days : studyDays(records).size;
    const streakDays = learningStats ? learningStats.streak_days : this.streak(records);
    return {
      user: await this.publicUser(user),
      points: this.pointsService ? await this.pointsService.profileSummary(userId) : { status: 'disabled', balance: 0 },
      stats: {
        total_questions: questions.length,
        mastered_questions: questions.filter((q) => q.mastery_status === 'mastered').length,
        accuracy: answered ? Math.round(correct / answered * 100) : null,
        total_study_days: totalStudyDays,
        streak_days: streakDays
      }
    };
  }

  async updateProfile(userId, patch) {
    const nickname = String(patch.nickname || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    assert(nickname, 'NICKNAME_REQUIRED', '请输入昵称');
    assert([...nickname].length <= 20, 'NICKNAME_TOO_LONG', '昵称不能超过 20 个字符');
    const user = await this.store.update('users', userId, { nickname, updated_at: nowIso() });
    return this.publicUser(user);
  }

  async updateAvatar(userId, buffer, mimeType) {
    assert(buffer?.length, 'AVATAR_REQUIRED', '请选择头像图片');
    const extensions = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    const extension = extensions[mimeType];
    assert(extension, 'AVATAR_TYPE_INVALID', '头像仅支持 JPG、PNG 或 WebP 格式');
    const previousUser = await this.store.get('users', userId);
    const previousAvatarFileId = previousUser.avatar_file_id || '';
    // 每次使用唯一文件路径，避免微信图片组件和 CDN 继续复用固定 avatar.jpg 的旧缓存。
    const avatarFileId = await this.storage.upload(
      `users/${userId}/profile/avatar-${id('asset')}.${extension}`,
      buffer
    );
    let user;
    try {
      user = await this.store.update('users', userId, {
        avatar_file_id: avatarFileId,
        avatar_url: '',
        updated_at: nowIso()
      });
    } catch (error) {
      try { await this.storage.delete?.(avatarFileId); } catch {}
      throw error;
    }
    if (previousAvatarFileId && previousAvatarFileId !== avatarFileId) {
      try { await this.storage.delete?.(previousAvatarFileId); }
      catch (error) {
        console.warn('清理旧头像文件失败', { userId, message: error?.message });
      }
    }
    return this.publicUser(user);
  }

  async mastery(userId, subject) {
    assert(isSubject(subject), 'INVALID_SUBJECT', '科目无效');
    const [questions, stats] = await Promise.all([
      this.questionService.allForUser(userId),
      this.store.find('knowledge_point_stats', { where: { user_id: userId, subject }, limit: 100 })
    ]);
    const subjectQuestions = questions.filter((q) => q.subject === subject);
    const names = new Set(subjectQuestions.flatMap((q) => q.knowledge_points || []));
    const statMap = new Map(stats.map((item) => [item.knowledge_point, item]));
    const items = [...names].map((name) => {
      const stat = statMap.get(name);
      const attemptCount = Math.max(0, Number(stat?.attempt_count) || 0);
      const storedRate = Math.max(0, Math.min(100, Number(stat?.mastery_rate) || 0));
      const storedCorrectCount = Number(stat?.correct_count);
      const correctCount = Math.max(0, Math.min(
        attemptCount,
        Number.isFinite(storedCorrectCount) ? storedCorrectCount : Math.round(attemptCount * storedRate / 100)
      ));
      const masteryRate = attemptCount ? Math.round(correctCount / attemptCount * 100) : 0;
      return {
        knowledge_point: name,
        question_count: subjectQuestions.filter((q) => q.knowledge_points?.includes(name)).length,
        attempt_count: attemptCount,
        correct_count: correctCount,
        mastery_rate: masteryRate,
        weak: masteryRate < 60
      };
    }).sort((a, b) => (
      Number(b.attempt_count > 0) - Number(a.attempt_count > 0)
      || b.attempt_count - a.attempt_count
      || b.question_count - a.question_count
      || a.mastery_rate - b.mastery_rate
      || a.knowledge_point.localeCompare(b.knowledge_point, 'zh-CN')
    ));
    return { subject, radar: items.slice(0, 5), items };
  }

  async getSettings(userId) {
    const user = await this.store.get('users', userId);
    return {
      notification_enabled: Boolean(user.notification_enabled),
      reminder_time: validReminderTime(user.reminder_time) ? user.reminder_time : '20:00',
      reminder_frequency: REMINDER_FREQUENCIES.has(user.reminder_frequency) ? user.reminder_frequency : 'daily',
      visible_subjects: normalizeVisibleSubjects(user.visible_subjects),
      recommendation_weak_first: user.recommendation_weak_first !== false,
      recommendation_difficulty: RECOMMENDATION_DIFFICULTIES.has(user.recommendation_difficulty)
        ? user.recommendation_difficulty
        : 'adaptive',
      practice_question_limit: validPracticeQuestionLimit(user.practice_question_limit)
        ? user.practice_question_limit
        : DEFAULT_PRACTICE_QUESTION_LIMIT,
      mastered_question_ratio: validMasteredQuestionRatio(user.mastered_question_ratio)
        ? user.mastered_question_ratio
        : DEFAULT_MASTERED_QUESTION_RATIO
    };
  }

  async updateSettings(userId, patch) {
    const user = await this.store.get('users', userId);
    const changes = { updated_at: nowIso() };
    if (Object.prototype.hasOwnProperty.call(patch, 'notification_enabled')) {
      changes.notification_enabled = Boolean(patch.notification_enabled);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'reminder_time')) {
      assert(validReminderTime(patch.reminder_time), 'INVALID_REMINDER_TIME', '提醒时间格式无效');
      changes.reminder_time = patch.reminder_time;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'reminder_frequency')) {
      assert(REMINDER_FREQUENCIES.has(patch.reminder_frequency), 'INVALID_REMINDER_FREQUENCY', '提醒频率设置无效');
      changes.reminder_frequency = patch.reminder_frequency;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'recommendation_weak_first')) {
      changes.recommendation_weak_first = Boolean(patch.recommendation_weak_first);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'recommendation_difficulty')) {
      assert(RECOMMENDATION_DIFFICULTIES.has(patch.recommendation_difficulty),
        'INVALID_RECOMMENDATION_DIFFICULTY', '推题难度设置无效');
      changes.recommendation_difficulty = patch.recommendation_difficulty;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'practice_question_limit')) {
      assert(validPracticeQuestionLimit(patch.practice_question_limit),
        'INVALID_PRACTICE_QUESTION_LIMIT', '每次练习题数须为 1 到 20 之间的整数');
      changes.practice_question_limit = patch.practice_question_limit;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'mastered_question_ratio')) {
      assert(validMasteredQuestionRatio(patch.mastered_question_ratio),
        'INVALID_MASTERED_QUESTION_RATIO', '已掌握题目占比须为 0% 到 50% 之间的整数');
      changes.mastered_question_ratio = patch.mastered_question_ratio;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'visible_subjects')) {
      assert(Array.isArray(patch.visible_subjects), 'INVALID_VISIBLE_SUBJECTS', '科目设置格式无效');
      const visibleSubjects = normalizeVisibleSubjects(patch.visible_subjects, []);
      assert(visibleSubjects.length, 'VISIBLE_SUBJECT_REQUIRED', '至少保留一个科目');
      assert(visibleSubjects.length === patch.visible_subjects.length,
        'INVALID_VISIBLE_SUBJECTS', '科目设置包含不支持的科目');
      changes.visible_subjects = visibleSubjects;
    }
    await this.store.update('users', userId, changes);
    return {
      notification_enabled: Object.prototype.hasOwnProperty.call(changes, 'notification_enabled')
        ? changes.notification_enabled
        : Boolean(user.notification_enabled),
      reminder_time: changes.reminder_time || (validReminderTime(user.reminder_time) ? user.reminder_time : '20:00'),
      reminder_frequency: changes.reminder_frequency
        || (REMINDER_FREQUENCIES.has(user.reminder_frequency) ? user.reminder_frequency : 'daily'),
      visible_subjects: changes.visible_subjects || normalizeVisibleSubjects(user.visible_subjects, DEFAULT_VISIBLE_SUBJECTS),
      recommendation_weak_first: Object.prototype.hasOwnProperty.call(changes, 'recommendation_weak_first')
        ? changes.recommendation_weak_first
        : user.recommendation_weak_first !== false,
      recommendation_difficulty: changes.recommendation_difficulty
        || (RECOMMENDATION_DIFFICULTIES.has(user.recommendation_difficulty) ? user.recommendation_difficulty : 'adaptive'),
      practice_question_limit: validPracticeQuestionLimit(changes.practice_question_limit)
        ? changes.practice_question_limit
        : validPracticeQuestionLimit(user.practice_question_limit)
          ? user.practice_question_limit
          : DEFAULT_PRACTICE_QUESTION_LIMIT,
      mastered_question_ratio: validMasteredQuestionRatio(changes.mastered_question_ratio)
        ? changes.mastered_question_ratio
        : validMasteredQuestionRatio(user.mastered_question_ratio)
          ? user.mastered_question_ratio
          : DEFAULT_MASTERED_QUESTION_RATIO
    };
  }
}

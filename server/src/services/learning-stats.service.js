import { dateKey, nowIso } from '../shared/utils.js';
import { shiftDateKey, streakFromDays, studyDays } from '../shared/study-stats.js';

export class LearningStatsService {
  constructor(store) {
    this.store = store;
  }

  async allPracticeRecords(userId) {
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

  buildStats(records, now = new Date()) {
    const days = studyDays(records);
    let latestDay = '';
    records.forEach((record) => {
      const submittedAt = new Date(record?.submitted_at);
      if (!Number.isFinite(submittedAt.getTime())) return;
      const day = dateKey(submittedAt);
      if (!latestDay || day > latestDay) latestDay = day;
    });
    return {
      total_study_days: days.size,
      streak_days: streakFromDays(days, now),
      last_study_date: latestDay,
      updated_at: nowIso()
    };
  }

  async ensureStats(userId, records = null) {
    const existing = await this.store.get('user_learning_stats', userId);
    if (existing) return existing;
    const rows = Array.isArray(records) ? records : await this.allPracticeRecords(userId);
    const stats = this.buildStats(rows);
    const row = { _id: userId, user_id: userId, ...stats };
    await this.store.put('user_learning_stats', row);
    return row;
  }

  async getStats(userId, records = null) {
    let stats = await this.store.get('user_learning_stats', userId);
    if (!stats) stats = await this.ensureStats(userId, records);
    const totalStudyDays = Math.max(0, Number(stats?.total_study_days) || 0);
    const rawStreakDays = Math.max(0, Number(stats?.streak_days) || 0);
    const today = dateKey();
    const yesterday = shiftDateKey(today, -1);
    const active = stats?.last_study_date === today || stats?.last_study_date === yesterday;
    const streakDays = active ? rawStreakDays : 0;
    if (!active && rawStreakDays !== 0) {
      try {
        await this.store.update('user_learning_stats', userId, { streak_days: 0, updated_at: nowIso() });
      } catch {}
    }
    return { total_study_days: totalStudyDays, streak_days: streakDays };
  }

  async recordPracticeDay(userId, submittedAt) {
    const day = dateKey(new Date(submittedAt));
    let stats = await this.store.get('user_learning_stats', userId);
    if (!stats) {
      const rows = await this.allPracticeRecords(userId);
      const days = studyDays(rows);
      if (days.has(day)) {
        // 当前练习已写入 practice_records，直接按全量记录回填。
        const built = this.buildStats(rows);
        const row = { _id: userId, user_id: userId, ...built };
        await this.store.put('user_learning_stats', row);
        return row;
      }
      let latestDay = '';
      rows.forEach((record) => {
        const submittedAtValue = new Date(record?.submitted_at);
        if (!Number.isFinite(submittedAtValue.getTime())) return;
        const recordDay = dateKey(submittedAtValue);
        if (!latestDay || recordDay > latestDay) latestDay = recordDay;
      });
      const streakDays = latestDay === shiftDateKey(day, -1)
        ? streakFromDays(days, new Date(`${latestDay}T12:00:00+08:00`)) + 1
        : 1;
      const row = {
        _id: userId,
        user_id: userId,
        total_study_days: days.size + 1,
        streak_days: streakDays,
        last_study_date: day,
        updated_at: nowIso()
      };
      await this.store.put('user_learning_stats', row);
      return row;
    }

    const previousDay = stats.last_study_date || '';
    if (previousDay === day) return stats;

    const yesterday = shiftDateKey(day, -1);
    const streakDays = previousDay === yesterday
      ? Math.max(0, Number(stats.streak_days) || 0) + 1
      : 1;
    const totalStudyDays = Math.max(0, Number(stats.total_study_days) || 0) + 1;
    const row = {
      _id: userId,
      user_id: userId,
      total_study_days: totalStudyDays,
      streak_days: streakDays,
      last_study_date: day,
      updated_at: nowIso()
    };
    await this.store.put('user_learning_stats', row);
    return row;
  }
}

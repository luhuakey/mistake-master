import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataStore } from '../src/data/store.js';
import { LearningStatsService } from '../src/services/learning-stats.service.js';
import { ProfileService } from '../src/services/profile.service.js';
import { PracticeService } from '../src/services/practice.service.js';
import { dateKey, nowIso } from '../src/shared/utils.js';
import { shiftDateKey } from '../src/shared/study-stats.js';

const atDay = (day, hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`).toISOString();
const today = dateKey();
const yesterday = shiftDateKey(today, -1);
const dayBefore = shiftDateKey(today, -2);

test('同一自然日多次练习只计 1 天且连续天数不重复累加', async () => {
  const store = new MemoryDataStore();
  const stats = new LearningStatsService(store);
  await stats.recordPracticeDay('usr_same', atDay(today, 9));
  await stats.recordPracticeDay('usr_same', atDay(today, 21));
  const row = await store.get('user_learning_stats', 'usr_same');
  assert.equal(row.total_study_days, 1);
  assert.equal(row.streak_days, 1);
  assert.equal(row.last_study_date, today);
});

test('相邻自然日练习时累计天数和连续天数同步递增', async () => {
  const store = new MemoryDataStore();
  const stats = new LearningStatsService(store);
  await stats.recordPracticeDay('usr_consecutive', atDay(yesterday));
  await stats.recordPracticeDay('usr_consecutive', atDay(today));
  const row = await store.get('user_learning_stats', 'usr_consecutive');
  assert.equal(row.total_study_days, 2);
  assert.equal(row.streak_days, 2);
  assert.equal(row.last_study_date, today);
});

test('断档后再次练习时连续天数重置但累计天数继续增加', async () => {
  const store = new MemoryDataStore();
  const stats = new LearningStatsService(store);
  await stats.recordPracticeDay('usr_gap', atDay(shiftDateKey(today, -3)));
  await stats.recordPracticeDay('usr_gap', atDay(shiftDateKey(today, -2)));
  await stats.recordPracticeDay('usr_gap', atDay(today));
  const row = await store.get('user_learning_stats', 'usr_gap');
  assert.equal(row.total_study_days, 3);
  assert.equal(row.streak_days, 1);
  assert.equal(row.last_study_date, today);
});

test('最近学习日早于昨天时连续天数按 0 返回且累计天数不变', async () => {
  const store = new MemoryDataStore();
  const stats = new LearningStatsService(store);
  await store.put('user_learning_stats', {
    _id: 'usr_expired', user_id: 'usr_expired', total_study_days: 5, streak_days: 3,
    last_study_date: dayBefore, updated_at: nowIso()
  });
  const result = await stats.getStats('usr_expired');
  assert.equal(result.total_study_days, 5);
  assert.equal(result.streak_days, 0);
});

test('统计缺失时从存量练习记录回填并落库', async () => {
  const store = new MemoryDataStore();
  await store.put('practice_records', { _id: 'pr_1', user_id: 'usr_backfill', submitted_at: atDay(yesterday) });
  await store.put('practice_records', { _id: 'pr_2', user_id: 'usr_backfill', submitted_at: atDay(today, 8) });
  await store.put('practice_records', { _id: 'pr_3', user_id: 'usr_backfill', submitted_at: atDay(shiftDateKey(today, -3)) });
  const stats = new LearningStatsService(store);
  const ensured = await stats.ensureStats('usr_backfill');
  assert.equal(ensured.total_study_days, 3);
  assert.equal(ensured.streak_days, 2);
  const stored = await store.get('user_learning_stats', 'usr_backfill');
  assert.ok(stored);
  assert.equal(stored.total_study_days, 3);
});

test('个人中心 profile 返回累计学习日与连续打卡两个独立字段', async () => {
  const store = new MemoryDataStore();
  const userId = 'usr_profile';
  await store.put('users', {
    _id: userId, nickname: '同学', avatar_url: '', avatar_file_id: '',
    preferred_subject: 'math', notification_enabled: false, reminder_time: '20:00',
    reminder_frequency: 'daily', recommendation_weak_first: true, recommendation_difficulty: 'adaptive',
    practice_question_limit: 10, mastered_question_ratio: 20, created_at: nowIso(), updated_at: nowIso()
  });
  await store.put('practice_records', { _id: 'pr_p1', user_id: userId, submitted_at: atDay(today) });
  await store.put('practice_records', { _id: 'pr_p2', user_id: userId, submitted_at: atDay(shiftDateKey(today, -2)) });
  const learningStats = new LearningStatsService(store);
  const profile = new ProfileService(store, { allForUser: async () => [] }, null, {}, null, learningStats);
  const result = await profile.profile(userId);
  assert.equal(result.stats.total_study_days, 2);
  assert.equal(result.stats.streak_days, 1);
});

test('提交练习后写入 user_learning_stats', async () => {
  const store = new MemoryDataStore();
  const userId = 'usr_submit';
  const sessionId = 'ps_submit';
  const questionId = 'q_submit';
  await store.put('practice_sessions', {
    _id: sessionId, user_id: userId, subject: 'math', type: 'review', question_ids: [questionId],
    status: 'active', record_id: null, created_at: nowIso(), submitted_at: null
  });
  await store.put('questions', {
    _id: questionId, user_id: userId, subject: 'math', type: 'single_choice', stem: '1+1=?',
    options: { A: '1', B: '2' }, correct_answer: 'B', analysis: '1+1=2。', error_prone_point: '',
    knowledge_points: [], difficulty: 'easy', mastery_status: 'unmastered', practice_count: 0,
    wrong_count: 0, last_practiced_at: null, created_at: nowIso(), updated_at: nowIso()
  });
  const questionService = {
    getOwned: async (_userId, id) => {
      assert.equal(_userId, userId);
      assert.equal(id, questionId);
      return store.get('questions', questionId);
    }
  };
  const practices = new PracticeService(store, questionService, {}, new LearningStatsService(store));
  practices.updateKnowledgeStats = async () => {};
  await practices.submit(userId, sessionId, { [questionId]: 'B' });
  const stats = await store.get('user_learning_stats', userId);
  assert.ok(stats);
  assert.equal(stats.total_study_days, 1);
  assert.equal(stats.streak_days, 1);
  assert.equal(stats.last_study_date, today);
});

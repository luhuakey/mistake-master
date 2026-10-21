import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { assert } from '../shared/errors.js';
import { clamp, dateKey, nowIso } from '../shared/utils.js';

export const POINTS_RULE_VERSION = 'v1';
export const POINTS_TERMS_VERSION = '2026-09-01';
export const POINTS_DAILY_BASE_CAP = 35;

const RULES = Object.freeze({
  question_saved: Object.freeze({ code: 'question_saved', title: '有效收题', points: 2, dailyLimit: 5, description: '每道内容唯一的新错题 +2' }),
  practice_completed: Object.freeze({ code: 'practice_completed', title: '完成练习', points: 1, dailyLimit: 10, description: '每道当日首次完成的题目 +1' }),
  question_mastered: Object.freeze({ code: 'question_mastered', title: '学会错题', points: 5, dailyLimit: 3, description: '练习后首次达到已掌握 +5' })
});

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const transactionId = (userId, ruleCode, sourceId) => `pt_${sha(`${userId}:${ruleCode}:${sourceId}`).slice(0, 40)}`;
const dailyId = (userId, day) => `pd_${sha(`${userId}:${day}`).slice(0, 40)}`;
const normalizedText = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\s+/g, '')
  .trim();
const questionFingerprint = (question) => sha(JSON.stringify({
  subject: question.subject || '',
  stem: normalizedText(question.stem),
  options: Object.entries(question.options || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, normalizedText(value)]),
  answer: normalizedText(question.correct_answer)
}));
const eligibleTime = (value, fallback = nowIso()) => {
  const parsed = new Date(value || fallback);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
};
const afterOrAt = (value, minimum) => new Date(value).getTime() >= new Date(minimum).getTime();
const emptyReward = (balance = 0, extra = {}) => ({ amount: 0, balance, reason_codes: [], ...extra });

export class PointsService {
  constructor(store, config = env) {
    this.store = store;
    this.config = config;
    this.enabled = config.pointsEnabled !== false;
    this.reconcileJobs = new Map();
  }

  async all(collection, where, orderBy = 'created_at', direction = 'asc') {
    const rows = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.store.find(collection, { where, orderBy, direction, limit: pageSize, offset });
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  async account(userId) {
    if (!this.enabled) return null;
    return this.store.get('point_accounts', userId);
  }

  async activate(userId, consent = {}, { newUser = false } = {}) {
    assert(this.enabled, 'POINTS_DISABLED', '积分功能暂未开放', 503);
    if (!newUser) {
      assert(
        consent.agreementConsent === true && consent.privacyConsent === true,
        'POINTS_CONSENT_REQUIRED',
        '请先阅读并主动同意积分规则和隐私说明'
      );
      assert(consent.termsVersion === POINTS_TERMS_VERSION, 'POINTS_TERMS_OUTDATED', '积分规则已更新，请重新阅读');
    }
    const activatedAt = nowIso();
    return this.store.runTransaction(async (tx) => {
      const existing = await tx.get('point_accounts', userId);
      if (existing) return this.publicAccount(existing);
      const user = await tx.get('users', userId);
      const account = {
        _id: userId,
        user_id: userId,
        balance: 0,
        lifetime_earned: 0,
        activated_at: activatedAt,
        rule_version: POINTS_RULE_VERSION,
        terms_version: POINTS_TERMS_VERSION,
        created_at: activatedAt,
        updated_at: activatedAt
      };
      await tx.put('point_accounts', account);
      if (user) {
        await tx.update('users', userId, {
          agreement_consent_version: POINTS_TERMS_VERSION,
          privacy_consent_version: POINTS_TERMS_VERSION,
          consented_at: activatedAt,
          updated_at: activatedAt
        });
      }
      return this.publicAccount(account);
    });
  }

  publicAccount(account) {
    return {
      status: account ? 'active' : 'inactive',
      balance: Math.max(0, Number(account?.balance) || 0),
      activated_at: account?.activated_at || null,
      rule_version: account?.rule_version || POINTS_RULE_VERSION
    };
  }

  async profileSummary(userId) {
    if (!this.enabled) return { status: 'disabled', balance: 0 };
    try { return this.publicAccount(await this.account(userId)); }
    catch (error) {
      console.error('[points-profile-unavailable]', { userId, message: error?.message });
      return { status: 'unavailable', balance: 0 };
    }
  }

  async award(userId, rule, sourceId, sourceTime, { milestone = false, metadata = {} } = {}) {
    if (!this.enabled) return emptyReward();
    const sourceAt = eligibleTime(sourceTime);
    const day = dateKey(new Date(sourceAt));
    const rowId = transactionId(userId, rule.code, sourceId);
    return this.store.runTransaction(async (tx) => {
      const account = await tx.get('point_accounts', userId);
      if (!account) return emptyReward(0, { inactive: true });
      const balance = Math.max(0, Number(account.balance) || 0);
      if (!afterOrAt(sourceAt, account.activated_at)) return emptyReward(balance, { before_activation: true });
      if (await tx.get('point_transactions', rowId)) return emptyReward(balance, { duplicate: true });

      const counterId = dailyId(userId, day);
      const currentCounter = await tx.get('point_daily_counters', counterId) || {
        _id: counterId,
        user_id: userId,
        date_key: day,
        counts: {},
        base_earned: 0,
        milestone_earned: 0,
        created_at: nowIso()
      };
      const currentCount = Math.max(0, Number(currentCounter.counts?.[rule.code]) || 0);
      const capped = Number.isFinite(rule.dailyLimit) && currentCount >= rule.dailyLimit;
      const amount = capped ? 0 : rule.points;
      const createdAt = nowIso();
      const transaction = {
        _id: rowId,
        user_id: userId,
        type: 'earn',
        rule_code: rule.code,
        rule_version: POINTS_RULE_VERSION,
        delta: amount,
        status: capped ? 'capped' : 'awarded',
        source_id: String(sourceId),
        source_time: sourceAt,
        date_key: day,
        description: rule.title,
        metadata,
        created_at: createdAt
      };
      await tx.put('point_transactions', transaction);
      if (capped) return emptyReward(balance, { capped: true });

      const counter = {
        ...currentCounter,
        counts: { ...(currentCounter.counts || {}), [rule.code]: currentCount + 1 },
        base_earned: (Number(currentCounter.base_earned) || 0) + (milestone ? 0 : amount),
        milestone_earned: (Number(currentCounter.milestone_earned) || 0) + (milestone ? amount : 0),
        updated_at: createdAt
      };
      const nextAccount = {
        ...account,
        balance: balance + amount,
        lifetime_earned: (Number(account.lifetime_earned) || 0) + amount,
        updated_at: createdAt
      };
      await tx.put('point_daily_counters', counter);
      await tx.put('point_accounts', nextAccount);
      return { amount, balance: nextAccount.balance, reason_codes: [rule.code] };
    });
  }

  mergeRewards(rewards, fallbackBalance = 0) {
    return rewards.reduce((result, reward) => ({
      amount: result.amount + (Number(reward?.amount) || 0),
      balance: Number.isFinite(Number(reward?.balance)) ? Number(reward.balance) : result.balance,
      reason_codes: [...new Set([...result.reason_codes, ...(reward?.reason_codes || [])])]
    }), emptyReward(fallbackBalance));
  }

  async awardSavedQuestions(userId, questionIds = []) {
    const account = await this.account(userId);
    if (!account) return emptyReward();
    const rewards = [];
    for (const questionId of [...new Set(questionIds.map(String))]) {
      const question = await this.store.get('questions', questionId);
      if (!question || question.user_id !== userId) continue;
      const fingerprint = questionFingerprint(question);
      rewards.push(await this.award(userId, RULES.question_saved, `content:${fingerprint}`, question.created_at, {
        metadata: { question_id: question._id, content_fingerprint: fingerprint }
      }));
    }
    return this.mergeRewards(rewards, account.balance);
  }

  async recordsForUser(userId) {
    return this.all('practice_records', { user_id: userId }, 'submitted_at', 'asc');
  }

  streakAt(records, at) {
    const atDay = dateKey(new Date(at));
    const days = new Set(records
      .filter((record) => new Date(record.submitted_at).getTime() <= new Date(at).getTime())
      .map((record) => dateKey(new Date(record.submitted_at))));
    let cursor = new Date(`${atDay}T12:00:00+08:00`);
    let count = 0;
    while (days.has(dateKey(cursor))) {
      count += 1;
      cursor = new Date(cursor.getTime() - 86_400_000);
    }
    return count;
  }

  milestoneRules(streak) {
    const milestones = [3, 7, 14, 30];
    for (let value = 60; value <= streak; value += 30) milestones.push(value);
    return milestones.filter((value) => value <= streak).map((value) => ({
      code: `streak_${value}`,
      title: `连续学习 ${value} 天`,
      points: value === 3 ? 10 : value === 7 ? 20 : value === 14 ? 30 : 60,
      dailyLimit: Number.POSITIVE_INFINITY
    }));
  }

  async awardPracticeRecord(userId, recordId, { records: suppliedRecords = null } = {}) {
    const account = await this.account(userId);
    if (!account) return emptyReward();
    const record = await this.store.get('practice_records', recordId);
    if (!record || record.user_id !== userId) return emptyReward(account.balance);
    const day = dateKey(new Date(record.submitted_at));
    const rewards = [];
    for (const questionId of [...new Set((record.items || []).map((item) => String(item.question_id)))]) {
      rewards.push(await this.award(userId, RULES.practice_completed, `${day}:${questionId}`, record.submitted_at, {
        metadata: { question_id: questionId, practice_record_id: record._id }
      }));
    }
    const allRecords = suppliedRecords || await this.recordsForUser(userId);
    const records = allRecords.filter((item) => afterOrAt(item.submitted_at, account.activated_at));
    const streak = this.streakAt(records, record.submitted_at);
    for (const milestoneRule of this.milestoneRules(streak)) {
      rewards.push(await this.award(userId, milestoneRule, `milestone:${milestoneRule.code}`, record.submitted_at, {
        milestone: true,
        metadata: { streak_days: Number(milestoneRule.code.split('_')[1]) }
      }));
    }
    const masteryRewards = await this.awardEligibleMastery(
      userId,
      (record.items || []).map((item) => item.question_id),
      allRecords
    );
    rewards.push(masteryRewards);
    return this.mergeRewards(rewards, account.balance);
  }

  async firstPracticeAt(userId, questionId, suppliedRecords = null) {
    const records = suppliedRecords || await this.recordsForUser(userId);
    return records.find((record) => (record.items || []).some((item) => String(item.question_id) === String(questionId)))?.submitted_at || null;
  }

  async awardEligibleMastery(userId, questionIds = [], suppliedRecords = null) {
    const account = await this.account(userId);
    if (!account) return emptyReward();
    const records = suppliedRecords || await this.recordsForUser(userId);
    const rewards = [];
    for (const questionId of [...new Set(questionIds.map(String))]) {
      const question = await this.store.get('questions', questionId);
      if (!question || question.user_id !== userId || question.mastery_status !== 'mastered' || !question.first_mastered_at) continue;
      const practicedAt = await this.firstPracticeAt(userId, questionId, records);
      if (!practicedAt) continue;
      const qualifiedAt = new Date(question.first_mastered_at).getTime() >= new Date(practicedAt).getTime()
        ? question.first_mastered_at
        : practicedAt;
      rewards.push(await this.award(userId, RULES.question_mastered, `question:${questionId}`, qualifiedAt, {
        metadata: { question_id: questionId }
      }));
    }
    return this.mergeRewards(rewards, account.balance);
  }

  async awardMastery(userId, questionId) {
    return this.awardEligibleMastery(userId, [questionId]);
  }

  async reconcile(userId) {
    const account = await this.account(userId);
    if (!account) return;
    const allQuestions = await this.all('questions', { user_id: userId }, 'created_at', 'asc');
    const newQuestions = allQuestions.filter((question) => afterOrAt(question.created_at, account.activated_at));
    await this.awardSavedQuestions(userId, newQuestions.map((question) => question._id));
    const allRecords = await this.recordsForUser(userId);
    const records = allRecords.filter((record) => afterOrAt(record.submitted_at, account.activated_at));
    for (const record of records) await this.awardPracticeRecord(userId, record._id, { records: allRecords });
    await this.awardEligibleMastery(userId, allQuestions.map((question) => question._id), allRecords);
  }

  async currentStreak(userId, activatedAt) {
    const today = dateKey();
    const yesterday = dateKey(new Date(Date.now() - 86_400_000));
    const days = new Set();
    const pageSize = 100;
    const activatedTime = new Date(activatedAt).getTime();
    let startDay = '';

    for (let offset = 0; ; offset += pageSize) {
      const page = await this.store.find('practice_records', {
        where: { user_id: userId },
        orderBy: 'submitted_at',
        direction: 'desc',
        limit: pageSize,
        offset
      });
      if (!page.length) return startDay ? this.streakFromDays(days, startDay) : 0;
      page.forEach((record) => {
        if (afterOrAt(record.submitted_at, activatedAt)) days.add(dateKey(new Date(record.submitted_at)));
      });
      if (!startDay) {
        startDay = days.has(today) ? today : days.has(yesterday) ? yesterday : '';
        if (!startDay) return 0;
      }

      const streak = this.streakFromDays(days, startDay);
      const missingDay = dateKey(new Date(`${startDay}T12:00:00+08:00`).getTime() - streak * 86_400_000);
      const oldestTime = Math.min(...page.map((record) => new Date(record.submitted_at).getTime()).filter(Number.isFinite));
      const oldestDay = Number.isFinite(oldestTime) ? dateKey(new Date(oldestTime)) : '';
      if (page.length < pageSize || oldestTime < activatedTime || (oldestDay && oldestDay <= missingDay)) return streak;
    }
  }

  streakFromDays(days, startDay) {
    let cursor = new Date(`${startDay}T12:00:00+08:00`);
    let count = 0;
    while (days.has(dateKey(cursor))) {
      count += 1;
      cursor = new Date(cursor.getTime() - 86_400_000);
    }
    return count;
  }

  async summary(userId, { reconcile = false, account: suppliedAccount } = {}) {
    if (!this.enabled) return { status: 'disabled', balance: 0, redemption_status: 'upgrading' };
    let account = suppliedAccount === undefined ? await this.account(userId) : suppliedAccount;
    if (!account) return {
      status: 'inactive',
      balance: 0,
      earned_today: 0,
      daily_base_cap: POINTS_DAILY_BASE_CAP,
      rule_version: POINTS_RULE_VERSION,
      terms_version: POINTS_TERMS_VERSION,
      rules: Object.values(RULES).map((rule) => ({
        code: rule.code,
        title: rule.title,
        points: rule.points,
        daily_limit: rule.dailyLimit,
        description: rule.description,
        progress: 0
      })),
      streak: { days: 0, next_milestone: 3 },
      redemption_status: 'upgrading'
    };
    if (reconcile) {
      await this.reconcile(userId);
      account = await this.account(userId);
    }
    const day = dateKey();
    const [counter, streakDays] = await Promise.all([
      this.store.get('point_daily_counters', dailyId(userId, day)),
      this.currentStreak(userId, account.activated_at)
    ]);
    const milestones = [3, 7, 14, 30];
    let nextMilestone = milestones.find((value) => value > streakDays) || (Math.floor(streakDays / 30) + 1) * 30;
    if (nextMilestone <= streakDays) nextMilestone += 30;
    return {
      status: 'active',
      balance: Math.max(0, Number(account.balance) || 0),
      earned_today: (Number(counter?.base_earned) || 0) + (Number(counter?.milestone_earned) || 0),
      daily_base_cap: POINTS_DAILY_BASE_CAP,
      rule_version: POINTS_RULE_VERSION,
      terms_version: POINTS_TERMS_VERSION,
      rules: Object.values(RULES).map((rule) => ({
        code: rule.code,
        title: rule.title,
        points: rule.points,
        daily_limit: rule.dailyLimit,
        description: rule.description,
        progress: clamp(Number(counter?.counts?.[rule.code]) || 0, 0, rule.dailyLimit)
      })),
      streak: { days: streakDays, next_milestone: nextMilestone },
      redemption_status: 'upgrading'
    };
  }

  async transactions(userId, cursor = 0, limit = 20, { account: suppliedAccount } = {}) {
    const account = suppliedAccount === undefined ? await this.account(userId) : suppliedAccount;
    if (!account) return { items: [], next_cursor: null };
    const pageSize = clamp(Number(limit) || 20, 1, 50);
    let scanOffset = Math.max(0, Number(cursor) || 0);
    const items = [];
    const scanLimit = 100;
    let nextCursor = null;
    let exhausted = false;

    while (!exhausted && !nextCursor) {
      const rows = await this.store.find('point_transactions', {
        where: { user_id: userId },
        orderBy: 'created_at',
        direction: 'desc',
        limit: scanLimit,
        offset: scanOffset
      });
      if (!rows.length) break;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (Number(row.delta) <= 0) continue;
        if (items.length >= pageSize) {
          nextCursor = String(scanOffset + index);
          break;
        }
        items.push({
          id: row._id,
          type: row.type,
          rule_code: row.rule_code,
          delta: row.delta,
          description: row.description,
          created_at: row.created_at
        });
      }
      if (nextCursor) break;
      scanOffset += rows.length;
      exhausted = rows.length < scanLimit;
    }
    return { items, next_cursor: nextCursor };
  }

  async dashboard(userId, transactionLimit = 5) {
    const account = await this.account(userId);
    const [summary, recent] = await Promise.all([
      this.summary(userId, { account }),
      this.transactions(userId, 0, transactionLimit, { account })
    ]);
    return { ...summary, recent_transactions: recent.items };
  }

  scheduleReconcile(userId) {
    if (!this.enabled || this.config.nodeEnv === 'test' || this.reconcileJobs.has(userId)) return;
    const job = Promise.resolve()
      .then(async () => {
        const account = await this.account(userId);
        if (!account) return;
        const lastRun = new Date(account.last_reconciled_at || 0).getTime();
        if (Number.isFinite(lastRun) && Date.now() - lastRun < 24 * 60 * 60 * 1000) return;
        await this.reconcile(userId);
        await this.store.update('point_accounts', userId, { last_reconciled_at: nowIso() });
      })
      .catch((error) => console.error('[points-background-reconcile]', { userId, message: error?.message }))
      .finally(() => this.reconcileJobs.delete(userId));
    this.reconcileJobs.set(userId, job);
  }
}

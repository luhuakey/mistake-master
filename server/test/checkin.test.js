import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataStore } from '../src/data/store.js';
import { ProfileService } from '../src/services/profile.service.js';
import { buildCheckinMonth, shiftMonth } from '../../miniprogram/utils/checkin-calendar.js';

const service = (store) => new ProfileService(store, null, null, null, null, null);

test('打卡月视图按北京时间返回当月唯一日期并排除相邻月份', async () => {
  const store = new MemoryDataStore();
  const userId = 'usr_month';
  await store.put('practice_records', { _id: 'pr_m1', user_id: userId, submitted_at: '2026-09-01T00:30:00+08:00' });
  await store.put('practice_records', { _id: 'pr_m2', user_id: userId, submitted_at: '2026-09-01T09:00:00+08:00' });
  await store.put('practice_records', { _id: 'pr_m3', user_id: userId, submitted_at: '2026-09-15T12:00:00+08:00' });
  await store.put('practice_records', { _id: 'pr_m4', user_id: userId, submitted_at: '2026-08-31T23:30:00+08:00' });

  const result = await service(store).checkin(userId, { month: '2026-09' });
  assert.deepEqual(result.days, ['2026-09-01', '2026-09-15']);
});

test('打卡日期详情只返回当天记录并按提交时间倒序', async () => {
  const store = new MemoryDataStore();
  const userId = 'usr_day';
  await store.put('practice_records', {
    _id: 'pr_d1', user_id: userId, subject: 'math', type: 'recommended', total_count: 5,
    graded_count: 4, accuracy: 80, submitted_at: '2026-09-15T02:00:00.000Z'
  });
  await store.put('practice_records', {
    _id: 'pr_d2', user_id: userId, subject: 'english', type: 'review', total_count: 3,
    graded_count: 3, accuracy: 100, submitted_at: '2026-09-15T05:00:00.000Z'
  });
  await store.put('practice_records', {
    _id: 'pr_d3', user_id: userId, subject: 'math', type: 'review', total_count: 2,
    graded_count: 2, accuracy: 50, submitted_at: '2026-09-14T05:00:00.000Z'
  });

  const result = await service(store).checkin(userId, { date: '2026-09-15' });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, 'pr_d2');
  assert.equal(result.items[1].id, 'pr_d1');
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    'accuracy', 'graded_count', 'id', 'subject', 'submitted_at', 'total_count', 'type'
  ]);
});

test('无记录的月份或日期返回空数组', async () => {
  const store = new MemoryDataStore();
  assert.deepEqual(await service(store).checkin('usr_empty', { month: '2026-09' }), { month: '2026-09', days: [] });
  assert.deepEqual(await service(store).checkin('usr_empty', { date: '2026-09-15' }), { date: '2026-09-15', items: [] });
});

test('打卡查询参数缺失、同时提供或格式非法时拒绝', async () => {
  const profile = service(new MemoryDataStore());
  await assert.rejects(() => profile.checkin('usr_bad', {}), (error) => error.code === 'CHECKIN_QUERY_INVALID');
  await assert.rejects(() => profile.checkin('usr_bad', { month: '2026-09', date: '2026-09-01' }), (error) => error.code === 'CHECKIN_QUERY_INVALID');
  await assert.rejects(() => profile.checkin('usr_bad', { month: '2026-9' }), (error) => error.code === 'CHECKIN_QUERY_INVALID');
  await assert.rejects(() => profile.checkin('usr_bad', { date: '2026-09-32' }), (error) => error.code === 'CHECKIN_QUERY_INVALID');
  await assert.rejects(() => profile.checkin('usr_bad', { date: '2026-02-31' }), (error) => error.code === 'CHECKIN_QUERY_INVALID');
});

test('打卡日历以周一为每周起点且跨年切换正确', () => {
  const weeks = buildCheckinMonth(2026, 9, []);
  assert.equal(weeks[0][0].day, '');
  assert.equal(weeks[0][1].date, '2026-09-01');
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
});

test('打卡日历正确标记有练习的自然日', () => {
  const weeks = buildCheckinMonth(2026, 9, ['2026-09-08']);
  const cells = weeks.flat();
  const marked = cells.find((cell) => cell.date === '2026-09-08');
  assert.ok(marked);
  assert.equal(marked.marked, true);
});

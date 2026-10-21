import { dateKey } from './utils.js';

export const studyDays = (records) => new Set((Array.isArray(records) ? records : []).flatMap((record) => {
  const submittedAt = new Date(record?.submitted_at);
  return Number.isFinite(submittedAt.getTime()) ? [dateKey(submittedAt)] : [];
}));

export const shiftDateKey = (day, deltaDays) => dateKey(
  new Date(`${day}T12:00:00+08:00`).getTime() + Number(deltaDays || 0) * 86_400_000
);

export const streakFromDays = (days, now = new Date()) => {
  const today = dateKey(now);
  let cursor = days.has(today) ? new Date(now) : new Date(now.getTime() - 86_400_000);
  let count = 0;
  while (days.has(dateKey(cursor))) {
    count += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return count;
};

export const streak = (records, now = new Date()) => streakFromDays(studyDays(records), now);

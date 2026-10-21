export const localDateKey = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const isReminderDay = (frequency, date = new Date()) => (
  frequency !== 'weekdays' || (date.getDay() >= 1 && date.getDay() <= 5)
);

export const reminderDueAt = (time, date = new Date()) => {
  const matched = String(time || '').match(/^(\d{2}):(\d{2})$/);
  if (!matched) return null;
  const due = new Date(date);
  due.setHours(Number(matched[1]), Number(matched[2]), 0, 0);
  return due;
};

export const learningReminderDelay = (settings, lastReminderDate, now = new Date()) => {
  if (!settings?.notification_enabled || !isReminderDay(settings.reminder_frequency, now)) return null;
  if (lastReminderDate === localDateKey(now)) return null;
  const due = reminderDueAt(settings.reminder_time || '20:00', now);
  if (!due) return null;
  return Math.max(0, due.getTime() - now.getTime());
};

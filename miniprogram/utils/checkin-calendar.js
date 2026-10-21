const pad = (value) => String(value).padStart(2, '0');

export const dateKeyOf = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;

export const shiftMonth = (year, month, delta) => {
  const total = Number(year) * 12 + (Number(month) - 1) + Number(delta || 0);
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
};

export const buildCheckinMonth = (year, month, checkinDays = []) => {
  const daySet = new Set((Array.isArray(checkinDays) ? checkinDays : []).map(String));
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(Number(year), Number(month) - 1, 1)).getUTCDay();
  const leadingBlanks = (firstWeekday + 6) % 7;

  const cells = [];
  for (let index = 0; index < leadingBlanks; index += 1) {
    cells.push({ key: `blank-${index}`, day: '', date: '', marked: false, currentMonth: false });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = dateKeyOf(Number(year), Number(month), day);
    cells.push({ key: date, day, date, marked: daySet.has(date), currentMonth: true });
  }
  let tailIndex = 0;
  while (cells.length % 7 !== 0) {
    cells.push({ key: `blank-end-${tailIndex}`, day: '', date: '', marked: false, currentMonth: false });
    tailIndex += 1;
  }

  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }
  return weeks;
};

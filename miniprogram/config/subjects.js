export const SUBJECTS = Object.freeze([
  { key: 'chinese', label: '语文' },
  { key: 'math', label: '数学' },
  { key: 'english', label: '英语' },
  { key: 'physics', label: '物理' },
  { key: 'chemistry', label: '化学' },
  { key: 'biology', label: '生物' },
  { key: 'history', label: '历史' },
  { key: 'geography', label: '地理' },
  { key: 'politics', label: '道德与法治' }
]);

export const SUBJECT_KEYS = Object.freeze(SUBJECTS.map((item) => item.key));
export const DEFAULT_VISIBLE_SUBJECTS = SUBJECT_KEYS;

export const normalizeVisibleSubjects = (value, fallback = DEFAULT_VISIBLE_SUBJECTS) => {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set();
  const normalized = value.map(String).filter((key) => {
    if (!SUBJECT_KEYS.includes(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return normalized.length ? normalized : [...fallback];
};

export const subjectItemsForKeys = (keys) => {
  const byKey = new Map(SUBJECTS.map((item) => [item.key, item]));
  return normalizeVisibleSubjects(keys).map((key) => byKey.get(key)).filter(Boolean);
};

export const subjectName = (subject) => {
  if (subject === 'all') return '综合';
  return SUBJECTS.find((item) => item.key === subject)?.label || '';
};

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

const SUBJECT_ALIASES = Object.freeze({
  chinese: ['chinese', 'chineselanguage', '语文', '中文', '汉语'],
  math: ['math', 'mathematics', '数学', '算术'],
  english: ['english', '英语', '英文'],
  physics: ['physics', '物理'],
  chemistry: ['chemistry', '化学'],
  biology: ['biology', '生物'],
  history: ['history', '历史'],
  geography: ['geography', '地理'],
  politics: ['politics', 'civics', '道德与法治', '道法', '政治', '思想政治', '思政']
});

const subjectToken = (value) => String(value || '').trim().toLowerCase().replace(/[\s_\-·]/g, '');
const SUBJECT_ALIAS_MAP = new Map(Object.entries(SUBJECT_ALIASES)
  .flatMap(([key, aliases]) => aliases.map((alias) => [subjectToken(alias), key])));

export const normalizeSubject = (value) => SUBJECT_ALIAS_MAP.get(subjectToken(value)) || '';

export const isSubject = (value) => SUBJECT_KEYS.includes(String(value || ''));

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

export const subjectName = (subject) => {
  if (subject === 'all') return '综合';
  return SUBJECTS.find((item) => item.key === subject)?.label || '未分类';
};

export const QUESTION_TYPES = Object.freeze([
  { key: 'single_choice', label: '单项选择题', choice: true },
  { key: 'multiple_choice', label: '多项选择题', choice: true },
  { key: 'fill_blank', label: '填空题' },
  { key: 'true_false', label: '判断题' },
  { key: 'short_answer', label: '简答题' },
  { key: 'calculation', label: '计算题' },
  { key: 'proof', label: '证明题' },
  { key: 'reading', label: '阅读理解题' },
  { key: 'composition', label: '作文题' },
  { key: 'other', label: '其他题型' }
]);

export const QUESTION_TYPE_KEYS = Object.freeze(QUESTION_TYPES.map((item) => item.key));
export const isQuestionType = (value) => QUESTION_TYPE_KEYS.includes(String(value || ''));
export const isChoiceType = (value) => QUESTION_TYPES.some((item) => item.key === value && item.choice);
export const questionTypeName = (value) => QUESTION_TYPES.find((item) => item.key === value)?.label || '其他题型';

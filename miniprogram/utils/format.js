import { stripOptionPrefix } from './options';
export { subjectName } from '../config/subjects';
export const typeName = (type) => ({
  single_choice: '单项选择题',
  multiple_choice: '多项选择题',
  fill_blank: '填空题',
  true_false: '判断题',
  short_answer: '简答题',
  calculation: '计算题',
  proof: '证明题',
  reading: '阅读理解题',
  composition: '作文题',
  other: '其他题型'
}[type] || type || '其他题型');
export const difficultyName = (difficulty) => ({ easy: '简单', medium: '中等', hard: '困难' }[difficulty] || difficulty);
export const dateText = (value) => value ? String(value).slice(0, 10) : '';
export const timeText = (value) => value ? String(value).slice(5, 16).replace('T', ' ') : '';
export const optionItems = (options = {}) => ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  .filter((key) => typeof options[key] === 'string' && options[key].trim())
  .map((key) => ({
    key,
    text: stripOptionPrefix(options[key], key)
  }));

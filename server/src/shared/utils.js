import crypto from 'node:crypto';
import { isQuestionType } from './question-types.js';

export const nowIso = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const dateKey = (date = new Date(), timezone = 'Asia/Shanghai') => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};
export const unique = (items) => [...new Set(items)];
export const OPTION_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
export const questionOptionKeys = (question) => OPTION_KEYS.filter(
  (key) => typeof question?.options?.[key] === 'string' && question.options[key].trim()
);
export const escapeSqlString = (value) => String(value).replaceAll("'", "''");
export const safeJson = (text) => {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
};
export const completeQuestion = (q) => {
  const rawOptionKeys = Object.keys(q?.options || {}).filter(
    (key) => typeof q.options[key] === 'string' && q.options[key].trim()
  );
  const optionKeys = questionOptionKeys(q);
  const consecutive = optionKeys.every((key, index) => key === OPTION_KEYS[index]);
  return Boolean(
    q?.stem
    && optionKeys.length >= 2
    && optionKeys.length <= OPTION_KEYS.length
    && rawOptionKeys.length === optionKeys.length
    && consecutive
    && optionKeys.includes(q?.correct_answer)
  );
};

export const practiceableQuestion = (question) => {
  if (!isQuestionType(question?.type)) return false;
  if (!String(question.stem || '').trim() || !String(question.correct_answer || '').trim()) return false;
  if (!['single_choice', 'multiple_choice'].includes(question.type)) return true;
  const rawOptionKeys = Object.keys(question.options || {}).filter(
    (key) => typeof question.options[key] === 'string' && question.options[key].trim()
  );
  const optionKeys = questionOptionKeys(question);
  const consecutive = optionKeys.length >= 2
    && rawOptionKeys.length === optionKeys.length
    && optionKeys.every((key, index) => key === OPTION_KEYS[index]);
  if (!consecutive) return false;
  const answerKeys = String(question.correct_answer || '').toUpperCase().match(/[A-H]/g) || [];
  if (question.type === 'single_choice') return answerKeys.length === 1 && optionKeys.includes(answerKeys[0]);
  return answerKeys.length > 0 && answerKeys.every((key) => optionKeys.includes(key));
};

export const SUBJECTIVE_PRACTICE_TYPES = Object.freeze(['short_answer', 'proof', 'reading', 'composition', 'other']);
export const isSubjectivePracticeType = (type) => SUBJECTIVE_PRACTICE_TYPES.includes(type);

export const normalizePracticeAnswer = (value) => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\s,，]/g, '')
  .replace(/[−–—]/g, '-')
  .toUpperCase();

const numericAnswer = (value) => {
  const normalized = normalizePracticeAnswer(value);
  if (/^[+-]?\d+(?:\.\d+)?%$/.test(normalized)) return Number(normalized.slice(0, -1)) / 100;
  const fraction = normalized.match(/^([+-]?\d+(?:\.\d+)?)\/([+-]?\d+(?:\.\d+)?)$/);
  if (fraction && Number(fraction[2]) !== 0) return Number(fraction[1]) / Number(fraction[2]);
  return /^[+-]?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
};

const normalizedChoiceText = (value) => normalizePracticeAnswer(value).replace(/[\u3001;；/]/g, '');
const choiceKeys = (value) => {
  const normalized = normalizedChoiceText(value);
  if (!/^[A-H]+$/.test(normalized)) return '';
  return [...new Set(normalized)].sort().join('');
};
const booleanAnswer = (value) => {
  const normalized = normalizePracticeAnswer(value);
  if (['TRUE', 'T', '对', '正确', '是', '√'].includes(normalized)) return 'TRUE';
  if (['FALSE', 'F', '错', '错误', '否', '×'].includes(normalized)) return 'FALSE';
  return '';
};

export const practiceAnswerIsValid = (question, answer) => {
  const normalized = normalizePracticeAnswer(answer);
  if (!normalized) return false;
  if (question?.type === 'single_choice') return typeof question.options?.[normalized] === 'string';
  if (question?.type === 'multiple_choice') {
    const keys = choiceKeys(normalized);
    return Boolean(keys) && [...keys].every((key) => typeof question.options?.[key] === 'string');
  }
  if (question?.type === 'true_false') {
    const options = question.options || {};
    return Object.keys(options).length
      ? typeof options[normalized] === 'string' && Boolean(options[normalized].trim())
      : Boolean(booleanAnswer(normalized));
  }
  return true;
};

export const practiceAnswersEqual = (actual, expected, type = '') => {
  const left = normalizePracticeAnswer(actual);
  const right = normalizePracticeAnswer(expected);
  if (!left || !right) return false;
  if (type === 'multiple_choice') return choiceKeys(left) === choiceKeys(right);
  if (type === 'true_false') {
    const leftBoolean = booleanAnswer(left);
    const rightBoolean = booleanAnswer(right);
    if (leftBoolean || rightBoolean) return Boolean(leftBoolean) && leftBoolean === rightBoolean;
    return left === right;
  }
  if (left === right) return true;
  const leftNumber = numericAnswer(left);
  const rightNumber = numericAnswer(right);
  return leftNumber !== null && rightNumber !== null && Math.abs(leftNumber - rightNumber) < 1e-10;
};

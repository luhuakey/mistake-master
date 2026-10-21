export const stripOptionPrefix = (value, key) => {
  const text = String(value || '').trim();
  const optionKey = String(key || '').trim().replace(/[^A-H]/gi, '');
  if (!optionKey) return text;
  const patterns = [
    new RegExp(`^\\s*\\$*\\s*(?:\\\\left\\s*)?[（(\\[]\\s*${optionKey}\\s*(?:\\\\right\\s*)?[）)\\]]\\s*(?:[.．、:：]\\s*)?\\$*\\s*`, 'i'),
    new RegExp(`^\\s*(?:\\\\\\(|\\\\\\[)\\s*(?:\\\\left\\s*)?[（(\\[]?\\s*${optionKey}\\s*(?:\\\\right\\s*)?[）)\\]]?\\s*(?:\\\\\\)|\\\\\\])\\s*(?:[.．、:：]\\s*)?`, 'i'),
    new RegExp(`^\\s*${optionKey}\\s*[.．、:：]\\s*`, 'i')
  ];
  return patterns.reduce((result, pattern) => result.replace(pattern, ''), text).trim();
};

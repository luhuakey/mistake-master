const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

const GUEST_QUESTIONS = [
  {
    id: 'GMA001',
    subject: 'math',
    type: 'single_choice',
    difficulty: 'easy',
    stem: '一个合数至少有几个因数？',
    options: { A: '1个', B: '2个', C: '3个', D: '4个' },
    correct_answer: 'C',
    analysis: '合数除了1和它本身以外，还有其他因数，因此至少有3个因数。例如4的因数是1、2、4。',
    error_prone_point: '不要把合数与质数混淆，质数只有1和它本身两个因数。',
    knowledge_points: ['合数的定义', '因数的概念'],
    mastery_status: 'unmastered',
    created_at: minutesAgo(8)
  },
  {
    id: 'GMA002',
    subject: 'math',
    type: 'single_choice',
    difficulty: 'easy',
    stem: '方程 3x＋5＝20 的解是（　）。',
    options: { A: 'x＝3', B: 'x＝5', C: 'x＝8', D: 'x＝15' },
    correct_answer: 'B',
    analysis: '等式两边同时减去5，得到3x＝15；再同时除以3，得到x＝5。',
    error_prone_point: '移项时要改变运算关系，并注意最后还需要除以未知数前的系数。',
    knowledge_points: ['一元一次方程', '等式性质'],
    mastery_status: 'mastered',
    created_at: minutesAgo(34)
  },
  {
    id: 'GMA003',
    subject: 'math',
    type: 'single_choice',
    difficulty: 'medium',
    stem: '三个连续偶数的和是42，中间的偶数是（　）。',
    options: { A: '12', B: '14', C: '16', D: '18' },
    correct_answer: 'B',
    analysis: '连续三个偶数可以表示为x－2、x、x＋2，它们的和为3x＝42，所以x＝14。',
    error_prone_point: '连续偶数之间相差2，不是相差1。',
    knowledge_points: ['连续偶数', '方程应用'],
    mastery_status: 'unmastered',
    created_at: minutesAgo(71)
  },
  {
    id: 'GMA004',
    subject: 'math',
    type: 'single_choice',
    difficulty: 'medium',
    stem: '下面各数中，既是2的倍数又是3的倍数的是（　）。',
    options: { A: '8', B: '12', C: '15', D: '21' },
    correct_answer: 'B',
    analysis: '同时是2和3的倍数，也就是6的倍数。四个选项中只有12能被6整除。',
    error_prone_point: '需要同时满足两个条件，不能只检查是否为偶数或只检查各位数字之和。',
    knowledge_points: ['倍数特征', '公倍数'],
    mastery_status: 'mastered',
    created_at: minutesAgo(126)
  },
  {
    id: 'GEN001',
    subject: 'english',
    type: 'single_choice',
    difficulty: 'easy',
    stem: 'There ___ a book and two pens on the desk.',
    options: { A: 'is', B: 'are', C: 'am', D: 'be' },
    correct_answer: 'A',
    analysis: 'There be句型遵循“就近原则”，离be动词最近的主语a book是单数，因此使用is。',
    error_prone_point: '不要只看到two pens就选择are，应根据最靠近be动词的主语判断。',
    knowledge_points: ['There be句型', '就近原则'],
    mastery_status: 'unmastered',
    created_at: minutesAgo(12)
  },
  {
    id: 'GEN002',
    subject: 'english',
    type: 'single_choice',
    difficulty: 'easy',
    stem: 'She ___ to school by bus every day.',
    options: { A: 'go', B: 'goes', C: 'going', D: 'went' },
    correct_answer: 'B',
    analysis: 'every day表示一般现在时，主语She是第三人称单数，动词go要变为goes。',
    error_prone_point: '一般现在时中，主语为第三人称单数时，谓语动词需要使用相应的单数形式。',
    knowledge_points: ['一般现在时', '三单形式'],
    mastery_status: 'mastered',
    created_at: minutesAgo(48)
  },
  {
    id: 'GEN003',
    subject: 'english',
    type: 'single_choice',
    difficulty: 'easy',
    stem: 'The past tense of “go” is ___.',
    options: { A: 'goed', B: 'goes', C: 'went', D: 'gone' },
    correct_answer: 'C',
    analysis: 'go是不规则动词，其过去式是went，过去分词是gone。',
    error_prone_point: '不规则动词的过去式不能直接在词尾加-ed，需要单独记忆。',
    knowledge_points: ['一般过去时', '不规则动词'],
    mastery_status: 'unmastered',
    created_at: minutesAgo(93)
  },
  {
    id: 'GEN004',
    subject: 'english',
    type: 'single_choice',
    difficulty: 'medium',
    stem: '—How often do you exercise? —___.',
    options: { A: 'For two hours', B: 'Twice a week', C: 'At the gym', D: 'By bike' },
    correct_answer: 'B',
    analysis: 'How often询问频率，应使用once、twice、every day等频率表达作答。',
    error_prone_point: 'How often询问频率，How long才用于询问持续时间。',
    knowledge_points: ['特殊疑问句', '频率表达'],
    mastery_status: 'mastered',
    created_at: minutesAgo(154)
  }
];

const GUEST_SUMMARIES = {
  math: { collected_count: 6, mastered_count: 2, accuracy: 67 },
  english: { collected_count: 5, mastered_count: 2, accuracy: 60 }
};

const cloneGuestQuestion = (question) => ({
  ...question,
  options: { ...question.options },
  knowledge_points: [...question.knowledge_points]
});

const normalizeSearchText = (value) => {
  let text = String(value || '');
  if (typeof text.normalize === 'function') text = text.normalize('NFKC');
  return text.toLowerCase().replace(/\s+/g, '');
};

export const getGuestQuestions = (subject = 'math') => GUEST_QUESTIONS
  .filter((question) => question.subject === subject)
  .map(cloneGuestQuestion);

export const searchGuestQuestions = (keyword) => {
  const normalizedKeyword = normalizeSearchText(keyword);
  if (!normalizedKeyword) return [];

  return GUEST_QUESTIONS
    .map((question, index) => {
      const stemMatched = normalizeSearchText(question.stem).includes(normalizedKeyword);
      const knowledgeMatched = (question.knowledge_points || [])
        .some((point) => normalizeSearchText(point).includes(normalizedKeyword));
      const optionMatched = Object.values(question.options || {})
        .some((option) => normalizeSearchText(option).includes(normalizedKeyword));
      const analysisMatched = normalizeSearchText(question.analysis).includes(normalizedKeyword);
      const errorProneMatched = normalizeSearchText(question.error_prone_point).includes(normalizedKeyword);
      const score = (stemMatched ? 40 : 0)
        + (knowledgeMatched ? 30 : 0)
        + (optionMatched ? 20 : 0)
        + (analysisMatched ? 10 : 0)
        + (errorProneMatched ? 5 : 0);
      return { question, index, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => cloneGuestQuestion(item.question));
};

export const getGuestQuestionById = (id) => {
  const question = GUEST_QUESTIONS.find((item) => item.id === String(id || ''));
  return question ? cloneGuestQuestion(question) : null;
};

export const getGuestSummary = (subject = 'math') => ({
  ...(GUEST_SUMMARIES[subject] || { collected_count: 0, mastered_count: 0, accuracy: 0 })
});

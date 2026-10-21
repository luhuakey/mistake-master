import { AppError } from './errors.js';

export const COMPLIANCE_BLOCKED_MESSAGE = '内容不符合要求，已停止处理';

const normalize = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .replace(/[\s\u3000]+/g, '');

const RULES = Object.freeze([
  {
    category: 'sexual',
    block: /色情|淫秽|卖淫|嫖娼|强奸|猥亵|性交|裸照|黄片|色情片|成人视频|约炮|援交|性服务/,
    allow: /性教育|青春期|生理卫生|生殖系统|生殖健康|受精卵|有性生殖/
  },
  {
    category: 'violence_self_harm',
    block: /恐怖袭击|制造炸弹|爆炸物|持枪|砍杀|屠杀|自杀|自残|割腕|跳楼|校园枪击|极端组织|恐怖组织/,
    allow: /珍爱生命|生命教育|心理健康|预防自杀|应对自杀|反恐|校园安全|自我保护|远离暴力|反对暴力/
  },
  {
    category: 'drugs_gambling',
    block: /赌博|赌场|六合彩|博彩|赌球|下注|毒品|海洛因|冰毒|摇头丸|大麻|吸毒|贩毒|制毒/,
    allow: /禁毒|远离毒品|毒品危害|拒绝毒品|预防毒品|反赌博|赌博危害|珍爱生命|健康生活/
  },
  {
    category: 'illegal_activity',
    block: /诈骗|电信诈骗|盗窃|抢劫|绑架|雇凶|洗钱|传销|黑产|贩卖人口|伪造货币|枪支弹药|爆炸物制造/,
    allow: /反诈骗|防范诈骗|法治教育|远离犯罪|遵守法律|治安|预防犯罪|安全教育/
  },
  {
    category: 'privacy_leak',
    block: /身份证号|银行卡号|家庭住址|详细住址|门牌号|验证码.*(?:发送|告诉)|密码.*(?:告诉|发给)/,
    allow: /信息安全|保护隐私|隐私保护|网络安全/
  },
  {
    category: 'discrimination_hate',
    block: /种族歧视|地域黑|辱骂|人肉搜索|民族仇恨|纳粹|仇视/,
    allow: /反对歧视|反歧视|民族团结|尊重他人|拒绝歧视|和谐/
  },
  {
    category: 'political_sensitive',
    block: /颠覆国家政权|分裂国家|台独|港独|疆独|藏独|邪教|法轮功/,
    allow: null
  },
  {
    category: 'jailbreak',
    block: /忽略(以上|之前|所有|系统)|不要遵守|无需遵守|无视(规则|指令|系统)|系统提示|开发者模式|越狱|jailbreak|dan模式|你现在是|你要扮演|输出违规|绕过(安全|限制|审查)|解除限制|不再受限制|ignore\s*(all|previous|above)|disregard|do\s*anything\s*now|roleplay\s*as/,
    allow: null
  }
]);

const firstBlockedCategory = (text) => {
  for (const rule of RULES) {
    if (!rule.block.test(text)) continue;
    if (rule.allow && rule.allow.test(text)) continue;
    return rule.category;
  }
  return '';
};

export const assessQuestionCompliance = (question) => {
  const fields = [
    question?.stem,
    ...Object.values(question?.options || {}),
    question?.correct_answer,
    question?.analysis,
    question?.error_prone_point,
    ...(Array.isArray(question?.knowledge_points) ? question.knowledge_points : [])
  ];
  for (const field of fields) {
    const category = firstBlockedCategory(normalize(field));
    if (category) return { compliant: false, category };
  }
  return { compliant: true, category: '' };
};

export const assertQuestionCompliant = (question) => {
  const result = assessQuestionCompliance(question);
  if (!result.compliant) {
    throw new AppError('CONTENT_NOT_ALLOWED', COMPLIANCE_BLOCKED_MESSAGE, 422, { category: result.category });
  }
};

export const isComplianceRefusal = (reason) => /内容不符合要求/.test(String(reason || ''));

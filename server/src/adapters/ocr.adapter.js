import { Readable } from 'node:stream';
import OcrSdk from '@alicloud/ocr-api20210707';
import OpenApiSdk from '@alicloud/openapi-core';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';

const {
  default: AliOcrClient,
  RecognizeEduPaperCutRequest,
  RecognizeEduPaperOcrRequest,
  RecognizeEduQuestionOcrRequest
} = OcrSdk;
const { Config: OpenApiConfig } = OpenApiSdk.$OpenApiUtil;

const MOCK_TEXT = `数学 单项选择题
若关于x的一元二次方程 x²-5x+6=0，则它的两个根是（ ）
A. 1和6
B. 2和3
C. -2和-3
D. 3和6`;

const OCR_ACTIONS = Object.freeze({
  single: 'RecognizeEduQuestionOcr',
  batch: 'RecognizeEduPaperCut',
  verification: 'RecognizeEduPaperOcr'
});

const point = (value) => ({
  x: Number(value?.x ?? value?.X) || 0,
  y: Number(value?.y ?? value?.Y) || 0
});

const coordRect = (positions) => {
  const points = (Array.isArray(positions) ? positions.flat(Infinity) : [])
    .filter((value) => value && typeof value === 'object' && ('x' in value || 'X' in value))
    .map(point);
  if (!points.length) return null;
  const xs = points.map((item) => item.x);
  const ys = points.map((item) => item.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top
  };
};

const unionRects = (rects) => {
  const valid = (rects || []).filter((rect) => rect && rect.width >= 0 && rect.height >= 0);
  if (!valid.length) return null;
  const left = Math.min(...valid.map((rect) => rect.x));
  const top = Math.min(...valid.map((rect) => rect.y));
  const right = Math.max(...valid.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...valid.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const normalizeFigure = (figure) => {
  const rect = coordRect(figure?.points) || (
    Number.isFinite(Number(figure?.x)) && Number.isFinite(Number(figure?.y))
      ? {
        x: Number(figure.x),
        y: Number(figure.y),
        width: Math.max(0, Number(figure.w ?? figure.width) || 0),
        height: Math.max(0, Number(figure.h ?? figure.height) || 0)
      }
      : null
  );
  return rect ? { type: String(figure?.type || ''), rect } : null;
};

const normalizeLine = (item, originalIndex, paragraphNo = 0) => {
  const polygon = (Array.isArray(item?.pos) ? item.pos : []).map(point);
  return {
    index: originalIndex + 1,
    text: String(item?.word ?? item?.string ?? item?.text ?? '').trim(),
    confidence: Number(item?.prob) || 0,
    paragraph_no: paragraphNo,
    item_polygon: coordRect(item?.pos),
    polygon,
    original_index: originalIndex
  };
};

const rowReadingOrder = (lines) => {
  const positioned = lines.filter((line) => line.item_polygon);
  const unpositioned = lines.filter((line) => !line.item_polygon);
  const rows = [];
  positioned
    .sort((a, b) => a.item_polygon.y - b.item_polygon.y || a.item_polygon.x - b.item_polygon.x)
    .forEach((line) => {
      const rect = line.item_polygon;
      const center = rect.y + rect.height / 2;
      const row = rows.find((candidate) => {
        const tolerance = Math.max(4, Math.min(candidate.height, rect.height) * 0.55);
        return Math.abs(candidate.center - center) <= tolerance;
      });
      if (row) {
        row.lines.push(line);
        row.center = row.lines.reduce((sum, item) => sum + item.item_polygon.y + item.item_polygon.height / 2, 0) / row.lines.length;
        row.height = Math.max(row.height, rect.height);
      } else {
        rows.push({ center, height: rect.height, lines: [line] });
      }
    });
  return rows
    .sort((a, b) => a.center - b.center)
    .flatMap((row) => row.lines.sort((a, b) => a.item_polygon.x - b.item_polygon.x || a.original_index - b.original_index))
    .concat(unpositioned.sort((a, b) => a.original_index - b.original_index));
};

const parseOption = (text) => {
  const match = String(text || '').match(/^\s*\$*\s*(?:\\left\s*)?[（(]?\s*([A-F])\s*(?:\\right\s*)?[）).、:：]\s*/i);
  return match ? { key: match[1].toUpperCase(), text: String(text).trim() } : null;
};

const questionNumberOf = (text) => {
  const value = String(text || '').trim();
  const parenthesized = value.match(/^\$*\s*(?:\\left\s*)?[（(]\s*(\d{1,3})\s*(?:\\right\s*)?[）)]/);
  if (parenthesized) return Number(parenthesized[1]);
  const dotted = value.match(/^\s*(\d{1,3})\s*[.．、]\s*/);
  return dotted ? Number(dotted[1]) : null;
};

const blockFromLines = (blockLines, index, start, extras = {}) => {
  const options = {};
  const questionText = [];
  const normalizedLines = blockLines.map((line, offset) => {
    const option = parseOption(line.text);
    if (option) options[option.key] = option.text;
    else questionText.push(line.text);
    return {
      ...line,
      index: start + offset,
      paragraph_no: index,
      ...(option ? { group_type: 'option', option_key: option.key } : { group_type: 'question', option_key: undefined })
    };
  });
  return {
    lines: normalizedLines,
    block: {
      index,
      source_line_range: [start, start + normalizedLines.length - 1],
      source_rect: unionRects(normalizedLines.map((line) => line.item_polygon)),
      question_text: questionText.join('\n').trim(),
      options,
      ...extras
    }
  };
};

const numberedQuestionBoundaries = (lines) => {
  const candidates = lines.map((line, lineIndex) => ({
    lineIndex,
    number: questionNumberOf(line.text),
    x: line.item_polygon?.x,
    height: line.item_polygon?.height
  })).filter((item) => Number.isInteger(item.number));
  if (candidates.length < 2) return [];

  const positioned = candidates.filter((item) => Number.isFinite(item.x));
  let aligned = candidates;
  if (positioned.length >= 2) {
    const minX = Math.min(...positioned.map((item) => item.x));
    const heights = positioned.map((item) => Number(item.height) || 0).filter(Boolean).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 20;
    const tolerance = Math.max(30, medianHeight * 3);
    aligned = candidates.filter((item) => !Number.isFinite(item.x) || item.x <= minX + tolerance);
  }

  let best = [];
  let current = [];
  aligned.forEach((candidate) => {
    if (!current.length || candidate.number === current[current.length - 1].number + 1) current.push(candidate);
    else current = [candidate];
    if (current.length > best.length) best = current.slice();
  });
  return best.length >= 2 ? best : [];
};

const segmentNumberedQuestions = (lines) => {
  const boundaries = numberedQuestionBoundaries(lines);
  if (!boundaries.length) return null;
  const segmentedLines = [];
  const questionBlocks = [];
  boundaries.forEach((boundary, index) => {
    const end = index + 1 < boundaries.length ? boundaries[index + 1].lineIndex : lines.length;
    const segment = blockFromLines(
      lines.slice(boundary.lineIndex, end),
      index + 1,
      segmentedLines.length + 1,
      { question_number: boundary.number, segmentation_source: 'numbered_lines' }
    );
    segmentedLines.push(...segment.lines);
    questionBlocks.push(segment.block);
  });
  return { lines: segmentedLines, questionBlocks };
};

const normalizeOralText = (text) => String(text || '')
  .replace(/[（【]/g, '(')
  .replace(/[）】]/g, ')')
  .replace(/[＝]/g, '=')
  .replace(/[−–—]/g, '-')
  .replace(/[xX＊*]/g, '×')
  .replace(/\s+/g, '');

const oralExpressionPattern = /\d+(?:[×÷+\-/]\d+)+=\(\)/g;
const oralStartPattern = /^\d+(?:[×÷+\-/]\d+)+=?$/;
const oralFragmentPattern = /^(?:=|\(\)|=\(\))$/;

const canonicalOralText = (text) => normalizeOralText(text)
  .replace(/([×÷+\-/=])/g, ' $1 ')
  .replace(/\(\)/g, '( )')
  .replace(/\s+/g, ' ')
  .trim();

const segmentOralCalculations = (lines) => {
  const items = [];
  let pending = null;
  let recognizedSourceLines = 0;

  const pushExpression = (text, sources) => {
    const normalized = normalizeOralText(text);
    if (!new RegExp(`^${oralExpressionPattern.source}$`).test(normalized)) return false;
    items.push({ text: canonicalOralText(normalized), sources });
    return true;
  };

  for (const line of lines) {
    const normalized = normalizeOralText(line.text);
    const matches = [...normalized.matchAll(oralExpressionPattern)].map((match) => match[0]);
    if (matches.length && matches.join('') === normalized) {
      if (pending) return null;
      matches.forEach((match) => pushExpression(match, [line]));
      recognizedSourceLines += 1;
      continue;
    }
    if (oralStartPattern.test(normalized)) {
      if (pending) return null;
      pending = { text: normalized, sources: [line] };
      recognizedSourceLines += 1;
      continue;
    }
    if (pending && oralFragmentPattern.test(normalized)) {
      pending.text += normalized;
      pending.sources.push(line);
      recognizedSourceLines += 1;
      if (pushExpression(pending.text, pending.sources)) pending = null;
      continue;
    }
    return null;
  }
  if (pending || items.length < 3 || recognizedSourceLines !== lines.length) return null;

  const segmentedLines = [];
  const questionBlocks = [];
  items.forEach((item, index) => {
    const source = item.sources[0] || {};
    const segment = blockFromLines([{
      ...source,
      text: item.text,
      item_polygon: item.sources.map((line) => line.item_polygon).find(Boolean) || null,
      polygon: source.polygon || [],
      oral_source_line_count: item.sources.length
    }], index + 1, index + 1, {
      question_text: item.text,
      question_kind: 'oral_calculation',
      segmentation_source: 'oral_expression'
    });
    segmentedLines.push(...segment.lines);
    questionBlocks.push(segment.block);
  });
  return { lines: segmentedLines, questionBlocks };
};

const refineQuestionSegmentation = (document) => {
  const oral = segmentOralCalculations(document.lines);
  const numbered = oral ? null : segmentNumberedQuestions(document.lines);
  const segmentation = oral || numbered;
  if (!segmentation) return document;
  const originalBlocks = Array.isArray(document.questionBlocks) ? document.questionBlocks : [];
  const questionBlocks = segmentation.questionBlocks.map((block, index) => {
    const original = originalBlocks.find((candidate) => {
      const [leftStart, leftEnd] = candidate?.source_line_range || [];
      const [rightStart, rightEnd] = block?.source_line_range || [];
      return [leftStart, leftEnd, rightStart, rightEnd].every(Number.isInteger)
        && Math.min(leftEnd, rightEnd) >= Math.max(leftStart, rightStart);
    }) || originalBlocks[index];
    return original?.source_rect ? { ...block, source_rect: original.source_rect } : block;
  });
  return {
    ...document,
    lines: segmentation.lines,
    rawText: segmentation.lines.map((line) => line.text).join('\n'),
    questionBlocks
  };
};

const blockLines = (document, block) => {
  const [start, end] = block?.source_line_range || [];
  return Number.isInteger(start) && Number.isInteger(end) ? document.lines.slice(start - 1, end) : [];
};

const recoverMissingNumberedQuestions = (primary, verifier) => {
  const verifierNumbered = verifier.questionBlocks.filter((block) => Number.isInteger(block.question_number));
  const primaryByNumber = new Map(primary.questionBlocks
    .filter((block) => Number.isInteger(block.question_number))
    .map((block) => [block.question_number, block]));
  if (verifierNumbered.length <= primaryByNumber.size) return primary;

  const lines = [];
  const questionBlocks = [];
  let recovered = 0;
  verifierNumbered.forEach((verifierBlock, index) => {
    const primaryBlock = primaryByNumber.get(verifierBlock.question_number);
    const sourceDocument = primaryBlock ? primary : verifier;
    const sourceBlock = primaryBlock || verifierBlock;
    if (!primaryBlock) recovered += 1;
    const segment = blockFromLines(
      blockLines(sourceDocument, sourceBlock),
      index + 1,
      lines.length + 1,
      {
        question_number: verifierBlock.question_number,
        segmentation_source: primaryBlock ? sourceBlock.segmentation_source : 'verification_recovery'
      }
    );
    lines.push(...segment.lines);
    questionBlocks.push(segment.block);
  });
  if (!recovered || !lines.length) return primary;
  return {
    ...primary,
    lines,
    rawText: lines.map((line) => line.text).join('\n'),
    questionBlocks,
    recoveredQuestionCount: recovered
  };
};

const fallbackTextLines = (text) => String(text || '')
  .replace(/\s+(?=[（(]?[A-F][）).、:：]\s*)/g, '\n')
  .split(/\n+/)
  .map((value) => value.trim())
  .filter(Boolean);

const parseResponseData = (response, action) => {
  const body = response?.body || response || {};
  const code = String(body.code || '');
  if (code && code !== '200') {
    const error = new Error(body.message || `${action} 调用失败`);
    error.code = code;
    throw error;
  }
  if (body.data && typeof body.data === 'object') return body.data;
  try {
    return JSON.parse(String(body.data || '{}'));
  } catch {
    throw new Error(`${action} 返回了无法解析的数据`);
  }
};

const normalizeWordDocument = (data, engine) => {
  let lines = rowReadingOrder((data?.prism_wordsInfo || [])
    .map((item, index) => normalizeLine(item, index, 1))
    .filter((line) => line.text));
  if (!lines.length) {
    lines = fallbackTextLines(data?.content).map((text, index) => ({
      index: index + 1,
      text,
      confidence: 0,
      paragraph_no: 1,
      item_polygon: null,
      polygon: [],
      original_index: index
    }));
  }
  lines = lines.map((line, index) => ({ ...line, index: index + 1 }));
  const rawText = lines.map((line) => line.text).join('\n').trim() || String(data?.content || '').trim();
  if (!rawText) throw new Error('OCR 未返回文字');
  return refineQuestionSegmentation({
    rawText,
    lines,
    angle: Number(data?.angle) || 0,
    engine,
    questionBlocks: [],
    imageWidth: Number(data?.orgWidth || data?.width) || 0,
    imageHeight: Number(data?.orgHeight || data?.height) || 0,
    figures: (Array.isArray(data?.figure) ? data.figure : []).map(normalizeFigure).filter(Boolean)
  });
};

const normalizePaperCutDocument = (data, engine) => {
  const pages = (data?.page_list || []).slice().sort((a, b) => (Number(a?.doc_index) || 0) - (Number(b?.doc_index) || 0));
  const lines = [];
  const questionBlocks = [];

  pages.forEach((page) => {
    (page?.subject_list || []).forEach((subject) => {
      const paragraphNo = questionBlocks.length + 1;
      let blockLines = rowReadingOrder((subject?.prism_wordsInfo || [])
        .map((item, index) => normalizeLine(item, index, paragraphNo))
        .filter((line) => line.text));
      if (!blockLines.length) {
        blockLines = fallbackTextLines(subject?.text).map((text, index) => ({
          index: index + 1,
          text,
          confidence: 0,
          paragraph_no: paragraphNo,
          item_polygon: null,
          polygon: [],
          original_index: index
        }));
      }
      if (!blockLines.length) return;

      const start = lines.length + 1;
      const options = {};
      const questionText = [];
      const contentRect = unionRects((Array.isArray(subject?.content_list_info) ? subject.content_list_info : [])
        .map((content) => coordRect(content?.pos)));
      blockLines.forEach((line) => {
        const option = parseOption(line.text);
        lines.push({
          ...line,
          index: lines.length + 1,
          paragraph_no: paragraphNo,
          ...(option ? { group_type: 'option', option_key: option.key } : { group_type: 'question' })
        });
        if (option) options[option.key] = option.text;
        else questionText.push(line.text);
      });
      questionBlocks.push({
        index: paragraphNo,
        source_line_range: [start, lines.length],
        source_rect: contentRect || unionRects(blockLines.map((line) => line.item_polygon)),
        question_text: questionText.join('\n').trim() || String(subject?.text || '').trim(),
        options
      });
    });
  });

  const rawText = lines.map((line) => line.text).join('\n').trim();
  if (!rawText || !questionBlocks.length) throw new Error('试卷切题 OCR 未返回题目结构');
  return refineQuestionSegmentation({
    rawText,
    lines,
    angle: Number(pages[0]?.angle) || 0,
    engine,
    questionBlocks,
    imageWidth: Number(pages[0]?.orgWidth || pages[0]?.width) || 0,
    imageHeight: Number(pages[0]?.orgHeight || pages[0]?.height) || 0,
    figures: pages.flatMap((page) => (Array.isArray(page?.figure) ? page.figure : [])).map(normalizeFigure).filter(Boolean)
  });
};

const mockDocument = () => ({
  rawText: MOCK_TEXT,
  angle: 0,
  engine: OCR_ACTIONS.single,
  verificationText: '',
  verificationLines: [],
  verificationEngine: '',
  questionBlocks: [],
  imageWidth: 800,
  imageHeight: MOCK_TEXT.split('\n').length * 32,
  figures: [],
  lines: MOCK_TEXT.split('\n').map((text, index) => ({
    index: index + 1,
    text,
    confidence: 100,
    paragraph_no: 1,
    item_polygon: { x: 0, y: index * 32, width: 800, height: 28 },
    polygon: []
  }))
});

const friendlyOcrError = (error) => {
  const detail = `${error?.code || ''} ${error?.message || ''}`;
  if (/no.?permission|forbidden|unauthorized|invalidaccesskey|signature|access.?key|鉴权/i.test(detail)) {
    return '阿里云读光 OCR 鉴权失败，请检查 AccessKey 和 RAM 授权';
  }
  if (/not.?open|noactiveproduct|service.?not.?enabled|服务未开通|未开通/i.test(detail)) {
    return '阿里云读光教育场景识别尚未开通，请在 OCR 控制台开通后重试';
  }
  if (/throttl|requestlimit|频率|限流|quota|余额|欠费|资源包|耗尽/i.test(detail)) {
    return '阿里云读光 OCR 可用额度已耗尽或请求受限，请检查资源包和计费状态';
  }
  if (/timeout|aborted|超时/i.test(detail)) return '阿里云读光 OCR 识别超时，请重试';
  if (/enotfound|econn|network|socket|fetch failed|网络|连接/i.test(detail)) return '无法连接阿里云读光 OCR，请检查网络后重试';
  if (/image|图片|body|format|size/i.test(detail)) return '图片不符合阿里云读光 OCR 要求，请重新裁剪后再试';
  return '图片文字识别失败，请重试';
};

export class OcrAdapter {
  constructor(config = env) {
    this.config = config;
    this.action = config.aliyunOcrSingleAction || OCR_ACTIONS.single;
    this.questionAction = config.aliyunOcrPaperCutAction || OCR_ACTIONS.batch;
    this.verificationAction = config.aliyunOcrPaperAction || OCR_ACTIONS.verification;
    this.client = config.aliyunOcrClient || null;
  }

  getClient() {
    if (this.client) return this.client;
    if (!this.config.alibabaCloudAccessKeyId || !this.config.alibabaCloudAccessKeySecret) {
      throw new Error('缺少 ALIBABA_CLOUD_ACCESS_KEY_ID 或 ALIBABA_CLOUD_ACCESS_KEY_SECRET');
    }
    const sdkConfig = new OpenApiConfig({
      accessKeyId: this.config.alibabaCloudAccessKeyId,
      accessKeySecret: this.config.alibabaCloudAccessKeySecret,
      securityToken: this.config.alibabaCloudSecurityToken || undefined,
      endpoint: this.config.aliyunOcrEndpoint || 'ocr-api.cn-hangzhou.aliyuncs.com',
      regionId: this.config.aliyunOcrRegionId || 'cn-hangzhou',
      readTimeout: this.config.aiRequestTimeoutMs || 90000,
      connectTimeout: Math.min(this.config.aiRequestTimeoutMs || 90000, 10000)
    });
    this.client = new AliOcrClient(sdkConfig);
    return this.client;
  }

  async request(action, imageBuffer) {
    const common = { body: Readable.from(imageBuffer) };
    const imageType = this.config.aliyunOcrImageType || 'photo';
    const subject = this.config.aliyunOcrSubject || 'default';
    let request;
    let method;

    if (action === OCR_ACTIONS.single) {
      request = new RecognizeEduQuestionOcrRequest({
        ...common,
        needRotate: this.config.aliyunOcrNeedRotate !== false
      });
      method = 'recognizeEduQuestionOcr';
    } else if (action === OCR_ACTIONS.batch) {
      request = new RecognizeEduPaperCutRequest({
        ...common,
        cutType: 'question',
        imageType,
        subject,
        outputOricoord: true
      });
      method = 'recognizeEduPaperCut';
    } else if (action === OCR_ACTIONS.verification) {
      request = new RecognizeEduPaperOcrRequest({
        ...common,
        imageType,
        subject,
        outputOricoord: true
      });
      method = 'recognizeEduPaperOcr';
    } else {
      throw new Error(`不支持的阿里云读光 OCR 接口: ${action}`);
    }

    const response = await this.getClient()[method](request);
    return parseResponseData(response, action);
  }

  async recognizeQuestionDocument(imageBuffer) {
    const data = await this.request(this.questionAction, imageBuffer);
    return normalizePaperCutDocument(data, this.questionAction);
  }

  async recognizeVerificationDocument(imageBuffer) {
    const data = await this.request(this.verificationAction, imageBuffer);
    return normalizeWordDocument(data, this.verificationAction);
  }

  async recognizeSingleDocument(imageBuffer) {
    const data = await this.request(this.action, imageBuffer);
    return normalizeWordDocument(data, this.action);
  }

  async recognize(imageBuffer, { mode = 'single' } = {}) {
    if (this.config.mockExternalServices) return mockDocument();
    try {
      if (!this.config.alibabaCloudAccessKeyId || !this.config.alibabaCloudAccessKeySecret) {
        throw new Error('缺少 ALIBABA_CLOUD_ACCESS_KEY_ID 或 ALIBABA_CLOUD_ACCESS_KEY_SECRET');
      }
      if (mode === 'batch' && this.config.aliyunOcrPaperCutEnabled !== false) {
        const [questionResult, verificationResult] = await Promise.allSettled([
          this.recognizeQuestionDocument(imageBuffer),
          this.recognizeVerificationDocument(imageBuffer)
        ]);
        if (questionResult.status === 'fulfilled') {
          const verifier = verificationResult.status === 'fulfilled' ? verificationResult.value : null;
          const primary = verifier
            ? recoverMissingNumberedQuestions(questionResult.value, verifier)
            : questionResult.value;
          return {
            ...primary,
            verificationText: verifier?.rawText || '',
            verificationLines: verifier?.lines || [],
            verificationEngine: verifier?.engine || '',
            figures: verifier?.figures?.length ? verifier.figures : primary.figures || [],
            imageWidth: primary.imageWidth || verifier?.imageWidth || 0,
            imageHeight: primary.imageHeight || verifier?.imageHeight || 0
          };
        }
        if (verificationResult.status === 'fulfilled') return verificationResult.value;
        throw questionResult.reason || verificationResult.reason;
      }
      return await this.recognizeSingleDocument(imageBuffer);
    } catch (error) {
      throw new AppError('OCR_FAILED', friendlyOcrError(error), 502, error.message);
    }
  }
}

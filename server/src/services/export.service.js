import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { subjectName } from '../shared/subjects.js';
import { id, questionOptionKeys } from '../shared/utils.js';
import { questionTypeName } from '../shared/question-types.js';

const streamToBuffer = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', () => resolve(Buffer.concat(chunks)));
  stream.on('error', reject);
});

const recordTime = (value) => value ? String(value).replace('T', ' ').slice(0, 19) : '—';
const inferredFontFamily = (path) => {
  if (/NotoSansCJK/i.test(path)) return 'NotoSansCJKsc-Regular';
  if (/PingFang/i.test(path)) return 'PingFangSC-Regular';
  if (/Hiragino Sans GB/i.test(path)) return 'HiraginoSansGB-W3';
  return undefined;
};
const pdfFontCandidates = (config) => [
  { path: config.pdfFontPath, family: config.pdfFontFamily || inferredFontFamily(config.pdfFontPath) },
  { path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf' },
  { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFangSC-Regular' },
  { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', family: 'HiraginoSansGB-W3' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' }
].filter(({ path }) => path && existsSync(path));

const useChinesePdfFont = (doc, config) => {
  for (const candidate of pdfFontCandidates(config)) {
    try {
      doc.font(candidate.path, candidate.family);
      return candidate;
    } catch { /* 继续尝试下一个中文字体 */ }
  }
  throw new AppError(
    'EXPORT_FONT_UNAVAILABLE',
    '导出服务缺少可用的简体中文字体，请联系管理员',
    503
  );
};

const markdown = (questions, records) => [
  '# 学霸省题数据导出',
  '',
  `导出时间：${recordTime(new Date().toISOString())}`,
  '',
  `## 错题记录（${questions.length} 道）`,
  '',
  ...(questions.length ? questions.flatMap((q, index) => [
    `### ${index + 1}. ${q.stem}`,
    '',
    `- 科目：${subjectName(q.subject)}`,
    `- 题型：${questionTypeName(q.type)}`,
    `- 难度：${q.difficulty || '—'}`,
    `- 知识点：${(q.knowledge_points || []).join('、') || '—'}`,
    ...questionOptionKeys(q).map((key) => `- ${key}. ${q.options[key]}`),
    `- 正确答案：${q.correct_answer}`,
    `- 掌握状态：${q.mastery_status === 'mastered' ? '已掌握' : '未掌握'}`,
    '',
    `解析：${q.analysis || '—'}`,
    '',
    `易错点：${q.error_prone_point || '—'}`,
    ''
  ]) : ['暂无错题记录。', '']),
  `## 学习记录（${records.length} 次）`,
  '',
  ...(records.length ? records.flatMap((record, index) => [
    `### ${index + 1}. ${recordTime(record.submitted_at)} · ${subjectName(record.subject)}`,
    '',
    `- 练习题数：${record.total_count || 0}`,
    `- 答对：${record.correct_count || 0}`,
    `- 答错：${record.wrong_count || 0}`,
    ...(record.pending_count ? [`- 待自评：${record.pending_count}`] : []),
    `- 正确率：${record.accuracy ?? '—'}%`,
    ''
  ]) : ['暂无学习记录。', ''])
].join('\n');

export class ExportService {
  constructor(store, storage, config = env) {
    this.store = store;
    this.storage = storage;
    this.config = config;
  }

  async pdf(questions, records) {
    const output = new PassThrough();
    const bufferPromise = streamToBuffer(output);
    const doc = new PDFDocument({ margin: 54, size: 'A4' });
    doc.pipe(output);
    try {
      useChinesePdfFont(doc, this.config);
      doc.fontSize(20).text('学霸省题数据导出');
      doc.fontSize(9).fillColor('#667276').text(`导出时间：${recordTime(new Date().toISOString())}`);
      doc.moveDown();
      doc.fillColor('#111111').fontSize(15).text(`错题记录（${questions.length} 道）`);
      doc.moveDown(0.5);
      if (!questions.length) doc.fontSize(10).fillColor('#667276').text('暂无错题记录。');
      questions.forEach((q, index) => {
        doc.fillColor('#111111').fontSize(12).text(`${index + 1}. ${q.stem}`);
        doc.fontSize(9).text(`科目：${subjectName(q.subject)}　题型：${questionTypeName(q.type)}　难度：${q.difficulty || '—'}\n知识点：${(q.knowledge_points || []).join('、') || '—'}`);
        doc.text(questionOptionKeys(q).map((key) => `${key}. ${q.options[key]}`).join('\n'));
        doc.text(`正确答案：${q.correct_answer}\n解析：${q.analysis || '—'}\n易错点：${q.error_prone_point || '—'}`);
        doc.moveDown();
      });
      doc.addPage();
      doc.fillColor('#111111').fontSize(15).text(`学习记录（${records.length} 次）`);
      doc.moveDown(0.5);
      if (!records.length) doc.fontSize(10).fillColor('#667276').text('暂无学习记录。');
      records.forEach((record, index) => {
        doc.fillColor('#111111').fontSize(11).text(`${index + 1}. ${recordTime(record.submitted_at)} · ${subjectName(record.subject)}`);
        doc.fontSize(9).text(`练习题数：${record.total_count || 0}　答对：${record.correct_count || 0}　答错：${record.wrong_count || 0}　待自评：${record.pending_count || 0}　正确率：${record.accuracy ?? '—'}%`);
        doc.moveDown();
      });
    } catch (error) {
      doc.end();
      await bufferPromise.catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError('EXPORT_PDF_FAILED', 'PDF 导出失败，请稍后重试', 500, error.message);
    }
    doc.end();
    return bufferPromise;
  }

  async create(userId) {
    const [questions, records] = await Promise.all([
      this.store.find('questions', { where: { user_id: userId }, orderBy: 'created_at', direction: 'desc', limit: 100 }),
      this.store.find('practice_records', { where: { user_id: userId }, orderBy: 'submitted_at', direction: 'desc', limit: 100 })
    ]);
    const md = Buffer.from(markdown(questions, records));
    const pdf = await this.pdf(questions, records);
    const output = new PassThrough();
    const zipPromise = streamToBuffer(output);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(output);
    archive.append(md, { name: 'mistakes.md' });
    archive.append(pdf, { name: 'mistakes.pdf' });
    await archive.finalize();
    const zip = await zipPromise;
    const exportId = id('export');
    const basePath = `users/${userId}/exports/${exportId}`;
    const [fileId, pdfFileId, markdownFileId] = await Promise.all([
      this.storage.upload(`${basePath}/mistake-master.zip`, zip),
      this.storage.upload(`${basePath}/mistake-master.pdf`, pdf),
      this.storage.upload(`${basePath}/mistake-master.md`, md)
    ]);
    const [downloadUrl, pdfDownloadUrl] = await Promise.all([
      this.storage.downloadUrl(fileId),
      this.storage.downloadUrl(pdfFileId)
    ]);
    return {
      export_id: exportId,
      file_id: fileId,
      download_url: downloadUrl,
      pdf_file_id: pdfFileId,
      pdf_download_url: pdfDownloadUrl,
      markdown_file_id: markdownFileId,
      question_count: questions.length,
      practice_record_count: records.length
    };
  }
}

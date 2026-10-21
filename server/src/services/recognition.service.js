import crypto from 'node:crypto';
import { AppError, assert, notFound } from '../shared/errors.js';
import { id, nowIso, questionOptionKeys } from '../shared/utils.js';
import { isSubject, subjectName } from '../shared/subjects.js';
import { questionTypeName } from '../shared/question-types.js';
import { attachQuestionImages } from '../shared/question-image.js';

const questionMarkdown = (question) => {
  const options = questionOptionKeys(question).map((key) => `- ${key}. ${question.options[key]}`).join('\n');
  return `# ${question.stem}\n\n- 科目：${subjectName(question.subject)}\n- 题型：${questionTypeName(question.type)}\n- 难度：${question.difficulty}\n- 标识来源：AI 自动识别${question.is_cross_subject ? '，用户确认交叉学科归类' : ''}\n\n${options ? `## 选项\n\n${options}\n\n` : ''}## 答案\n\n${question.correct_answer}\n\n## 解析\n\n${question.analysis}\n\n## 易错点\n\n${question.error_prone_point || '—'}\n\n## 知识点\n\n${question.knowledge_points.join('、')}\n`;
};

const withTimeout = (promise, timeout, code, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new AppError(code, message, 504)), timeout);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

const normalizeOcrDocument = (result) => {
  if (typeof result === 'string') return {
    rawText: result, lines: [], angle: 0, engine: '', questionBlocks: [],
    verificationText: '', verificationLines: [], verificationEngine: '',
    imageWidth: 0, imageHeight: 0, figures: []
  };
  return {
    rawText: String(result?.rawText || ''),
    lines: Array.isArray(result?.lines) ? result.lines : [],
    angle: Number(result?.angle) || 0,
    engine: String(result?.engine || ''),
    questionBlocks: Array.isArray(result?.questionBlocks) ? result.questionBlocks : [],
    imageWidth: Number(result?.imageWidth) || 0,
    imageHeight: Number(result?.imageHeight) || 0,
    figures: Array.isArray(result?.figures) ? result.figures : [],
    verificationText: String(result?.verificationText || ''),
    verificationLines: Array.isArray(result?.verificationLines) ? result.verificationLines : [],
    verificationEngine: String(result?.verificationEngine || '')
  };
};

const deterministicQuestionId = (taskId, itemId) => `q_${crypto.createHash('sha256').update(`${taskId}:${itemId}`).digest('hex').slice(0, 32)}`;

const mergeSavedItems = (...groups) => {
  const byItem = new Map();
  groups.flat().filter(Boolean).forEach((item) => {
    if (item.item_id && item.question_id) byItem.set(item.item_id, item);
  });
  return [...byItem.values()];
};

export class RecognitionService {
  constructor({ store, storage, ocr, deepseek, vector }) {
    Object.assign(this, { store, storage, ocr, deepseek, vector });
  }

  taskState(task) {
    return {
      task_id: task?._id || '',
      status: task?.status || 'failed',
      stage: task?.stage || 'failed'
    };
  }

  async create(userId, imageBuffer, mimeType = 'image/jpeg', mode = 'single') {
    assert(imageBuffer?.length, 'IMAGE_INVALID', '请选择有效图片');
    assert(['single', 'batch'].includes(mode), 'RECOGNITION_MODE_INVALID', '识别模式无效');
    const taskId = id('rec');
    const extension = mimeType.includes('png') ? 'png' : 'jpg';
    const imageFileId = await this.storage.upload(`users/${userId}/recognitions/${taskId}/cropped.${extension}`, imageBuffer);
    const task = {
      _id: taskId,
      user_id: userId,
      image_file_id: imageFileId,
      mode,
      status: 'created',
      stage: 'uploaded',
      raw_text: '',
      ocr_lines: [],
      ocr_angle: 0,
      ocr_engine: '',
      ocr_question_blocks: [],
      ocr_image_width: 0,
      ocr_image_height: 0,
      ocr_figures: [],
      ocr_verification_text: '',
      ocr_verification_lines: [],
      ocr_verification_engine: '',
      parsed_question: null,
      parsed_questions: [],
      valid_question_count: 0,
      image_quality: null,
      saved_items: [],
      ignored_item_ids: [],
      error_code: null,
      question_id: null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await this.store.put('recognition_tasks', task);
    return {
      task_id: taskId,
      status: 'created',
      stage: 'uploaded'
    };
  }

  async processOcr(taskId, imageBuffer, mode = 'single') {
    const requestTimeout = this.ocr.config?.aiRequestTimeoutMs || 90000;
    try {
      const ocrDocument = normalizeOcrDocument(await withTimeout(
        this.ocr.recognize(imageBuffer, { mode }),
        requestTimeout,
        'OCR_TIMEOUT',
        '阿里云读光 OCR 识别超时，请重试'
      ));
      await this.store.update('recognition_tasks', taskId, {
        raw_text: ocrDocument.rawText,
        ocr_lines: ocrDocument.lines,
        ocr_angle: ocrDocument.angle,
        ocr_engine: ocrDocument.engine,
        ocr_question_blocks: ocrDocument.questionBlocks,
        ocr_image_width: ocrDocument.imageWidth,
        ocr_image_height: ocrDocument.imageHeight,
        ocr_figures: ocrDocument.figures,
        ocr_verification_text: ocrDocument.verificationText,
        ocr_verification_lines: ocrDocument.verificationLines,
        ocr_verification_engine: ocrDocument.verificationEngine,
        status: 'processing',
        stage: 'deepseek',
        processing_started_at: null,
        updated_at: nowIso()
      });
    } catch (error) {
      await this.store.update('recognition_tasks', taskId, {
        status: 'failed', stage: 'failed', processing_started_at: null,
        error_code: error.code || 'OCR_FAILED', error_message: error.message || '识别解析失败', updated_at: nowIso()
      });
    }
  }

  async processNext(userId, taskId) {
    let task = await this.getOwned(userId, taskId);
    if (['succeeded', 'failed', 'saved', 'partially_saved'].includes(task.status)) return this.taskState(task);

    const leaseStartedAt = Date.parse(task.processing_started_at || 0);
    const leaseMs = Math.min(75000, this.ocr.config?.recognitionTaskTimeoutMs || 240000);
    if (Number.isFinite(leaseStartedAt) && Date.now() - leaseStartedAt < leaseMs) return this.taskState(task);

    if (!task.raw_text?.trim()) {
      await this.store.update('recognition_tasks', taskId, {
        status: 'processing', stage: 'ocr', processing_started_at: nowIso(), error_code: null, error_message: '', updated_at: nowIso()
      });
      let imageBuffer;
      try {
        imageBuffer = await this.storage.download(task.image_file_id);
        assert(imageBuffer?.length, 'RECOGNITION_IMAGE_MISSING', '识别图片已失效，请重新拍摄', 409);
      } catch (error) {
        await this.store.update('recognition_tasks', taskId, {
          status: 'failed', stage: 'failed', processing_started_at: null,
          error_code: error.code || 'RECOGNITION_IMAGE_DOWNLOAD_FAILED',
          error_message: error.message || '读取识别图片失败，请重新拍摄', updated_at: nowIso()
        });
        return this.taskState(await this.store.get('recognition_tasks', taskId));
      }
      await this.processOcr(taskId, imageBuffer, task.mode || 'single');
      return this.taskState(await this.store.get('recognition_tasks', taskId));
    }

    await this.store.update('recognition_tasks', taskId, {
      status: 'processing', stage: 'deepseek', processing_started_at: nowIso(), error_code: null, error_message: '', updated_at: nowIso()
    });
    await this.parseAndComplete(taskId, {
      rawText: task.raw_text,
      lines: task.ocr_lines || [],
      angle: task.ocr_angle || 0,
      engine: task.ocr_engine || '',
      questionBlocks: task.ocr_question_blocks || [],
      imageWidth: task.ocr_image_width || 0,
      imageHeight: task.ocr_image_height || 0,
      figures: task.ocr_figures || [],
      verificationText: task.ocr_verification_text || '',
      verificationLines: task.ocr_verification_lines || [],
      verificationEngine: task.ocr_verification_engine || ''
    });
    task = await this.store.get('recognition_tasks', taskId);
    return this.taskState(task);
  }

  async parseAndComplete(taskId, ocrInput) {
    const requestTimeout = this.ocr.config?.aiRequestTimeoutMs || 90000;
    try {
      const task = await this.store.get('recognition_tasks', taskId);
      if (!task) throw notFound('识别任务不存在');
      const document = normalizeOcrDocument(typeof ocrInput === 'string'
        ? {
          rawText: ocrInput,
          lines: task.ocr_lines || [],
          angle: task.ocr_angle || 0,
          engine: task.ocr_engine || '',
          questionBlocks: task.ocr_question_blocks || [],
          imageWidth: task.ocr_image_width || 0,
          imageHeight: task.ocr_image_height || 0,
          figures: task.ocr_figures || [],
          verificationText: task.ocr_verification_text || '',
          verificationLines: task.ocr_verification_lines || [],
          verificationEngine: task.ocr_verification_engine || ''
        }
        : ocrInput);
      const mode = task.mode || 'single';
      const parsed = mode === 'batch'
        ? await withTimeout(
          this.deepseek.parseQuestions(document),
          requestTimeout,
          'AI_PARSE_TIMEOUT',
          'DeepSeek 批量解析超时，请重试'
        )
        : await withTimeout(
          this.deepseek.parseQuestion(document.rawText),
          requestTimeout,
          'AI_PARSE_TIMEOUT',
          'DeepSeek 解析超时，请重试'
        );
      let imageBuffer = Buffer.alloc(0);
      try { imageBuffer = await this.storage.download(task.image_file_id) || imageBuffer; } catch {}
      const parsedItems = mode === 'batch'
        ? parsed.parsed_questions
        : [{
          item_id: 'item_1',
          order: 1,
          status: 'valid',
          error_message: '',
          source_line_range: document.lines.length ? [1, document.lines.length] : null,
          question: parsed
        }];
      const itemsWithImages = await attachQuestionImages({
        imageBuffer,
        imageFileId: task.image_file_id,
        items: parsedItems,
        document,
        upload: (path, content) => this.storage.upload(path, content),
        basePath: `users/${task.user_id}/recognitions/${task._id}/question-images`,
        mode
      });
      await this.store.put('recognition_tasks', {
        ...task,
        status: 'succeeded',
        stage: 'completed',
        raw_text: document.rawText,
        ocr_lines: document.lines,
        ocr_angle: document.angle,
        ocr_engine: document.engine || task.ocr_engine || '',
        ocr_question_blocks: document.questionBlocks,
        ocr_image_width: document.imageWidth,
        ocr_image_height: document.imageHeight,
        ocr_figures: document.figures,
        ocr_verification_text: document.verificationText,
        ocr_verification_lines: document.verificationLines,
        ocr_verification_engine: document.verificationEngine,
        parsed_question: mode === 'single' ? itemsWithImages[0]?.question || parsed : null,
        parsed_questions: mode === 'batch' ? itemsWithImages : [],
        valid_question_count: mode === 'batch' ? parsed.valid_question_count : 1,
        detected_question_count: mode === 'batch' ? parsed.detected_count : 1,
        image_quality: mode === 'batch' ? parsed.image_quality || null : { compliant: true, issues: [], message: '', tips: [] },
        error_code: null,
        error_message: '',
        processing_started_at: null,
        updated_at: nowIso()
      });
    } catch (error) {
      await this.store.update('recognition_tasks', taskId, {
        status: 'failed', stage: 'failed', processing_started_at: null,
        error_code: error.code || 'AI_PARSE_FAILED', error_message: error.message || 'DeepSeek 解析失败',
        ...(error.details && typeof error.details === 'object' ? { image_quality: error.details } : {}),
        updated_at: nowIso()
      });
    }
  }

  async getOwned(userId, taskId) {
    const task = await this.store.get('recognition_tasks', taskId);
    if (!task || task.user_id !== userId) throw notFound('识别任务不存在');
    return task;
  }

  isStale(task) {
    const taskAge = Date.now() - Date.parse(task.updated_at || task.created_at || 0);
    const timeout = this.ocr.config?.recognitionTaskTimeoutMs || 240000;
    return ['created', 'processing'].includes(task.status) && Number.isFinite(taskAge) && taskAge > timeout;
  }

  async failTask(task, message = '识别任务已超时或因服务重启中断，请重新拍摄') {
    return this.store.update('recognition_tasks', task._id, {
      status: 'failed',
      stage: 'failed',
      error_code: 'RECOGNITION_INTERRUPTED',
      error_message: message,
      updated_at: nowIso()
    });
  }

  async get(userId, taskId) {
    const task = await this.getOwned(userId, taskId);
    const mode = task.mode || 'single';
    const persistedBatchItems = mode === 'batch'
      ? (await Promise.all((task.parsed_questions || []).map(async (item) => {
        const questionId = deterministicQuestionId(task._id, item.item_id);
        return await this.store.get('questions', questionId) ? { item_id: item.item_id, question_id: questionId } : null;
      }))).filter(Boolean)
      : [];
    const savedItems = mode === 'batch'
      ? mergeSavedItems(task.saved_items || [], persistedBatchItems)
      : (task.saved_items || (task.question_id ? [{ item_id: 'item_1', question_id: task.question_id }] : []));
    return {
      task_id: task._id,
      mode,
      status: task.status,
      stage: task.stage || (task.status === 'succeeded' ? 'completed' : task.status === 'failed' ? 'failed' : 'ocr'),
      image_file_id: task.image_file_id,
      image_quality: task.image_quality || null,
      raw_text: task.raw_text || '',
      ocr_lines: task.ocr_lines || [],
      parsed_question: task.parsed_question || null,
      parsed_questions: task.parsed_questions || [],
      detected_question_count: task.detected_question_count || (task.parsed_question ? 1 : 0),
      valid_question_count: task.valid_question_count || (task.parsed_question ? 1 : 0),
      saved_items: savedItems,
      ignored_item_ids: task.ignored_item_ids || [],
      error_code: task.error_code || '',
      error_message: task.error_message || '',
      question_id: task.question_id || '',
      question_ids: savedItems.map((item) => item.question_id),
      provider_mode: this.ocr.config?.mockExternalServices ? 'mock' : 'real',
      ocr_engine: task.ocr_engine || this.ocr.action || this.ocr.config?.aliyunOcrSingleAction || 'RecognizeEduQuestionOcr',
      deepseek_model: this.deepseek.config?.deepseekModel || ''
    };
  }

  async retry(userId, taskId) {
    const task = await this.getOwned(userId, taskId);
    assert(task.status === 'failed' || this.isStale(task), 'RECOGNITION_NOT_RETRYABLE', '当前任务无需重试');
    if (task.raw_text?.trim()) {
      await this.store.update('recognition_tasks', taskId, {
        status: 'processing',
        stage: 'deepseek',
        processing_started_at: null,
        error_code: null,
        error_message: '',
        updated_at: nowIso()
      });
      return {
        task_id: taskId,
        status: 'processing',
        stage: 'deepseek'
      };
    }
    throw new AppError('IMAGE_REUPLOAD_REQUIRED', '请返回裁剪页重新提交图片', 409);
  }

  questionRecord(userId, task, itemId, parsedQuestion, questionId) {
    const createdAt = nowIso();
    return {
      ...parsedQuestion,
      _id: questionId,
      user_id: userId,
      mastery_status: 'unmastered',
      source: 'photo',
      image_file_id: task.image_file_id,
      markdown_file_id: '',
      recognition_task_id: task._id,
      recognition_item_id: itemId,
      index_status: 'pending',
      practice_count: 0,
      wrong_count: 0,
      last_practiced_at: null,
      created_at: createdAt,
      updated_at: createdAt
    };
  }

  async persistQuestion(userId, task, item, subjectOverride = '') {
    const questionId = deterministicQuestionId(task._id, item.item_id);
    const existing = await this.store.get('questions', questionId);
    if (existing) return { item_id: item.item_id, question_id: questionId, question: existing, existing: true };
    const candidates = item.question.subject_candidates || [item.question.subject];
    const selectedSubject = subjectOverride || item.question.subject;
    assert(isSubject(selectedSubject), 'QUESTION_SUBJECT_INVALID', '请选择有效的归类科目');
    assert(!item.question.is_cross_subject || candidates.includes(selectedSubject), 'QUESTION_SUBJECT_INVALID', '所选科目不在 AI 推荐范围内');
    const question = this.questionRecord(userId, task, item.item_id, {
      ...item.question,
      subject: selectedSubject,
      classification: {
        subject: selectedSubject,
        type: item.question.type,
        difficulty: item.question.difficulty,
        source: 'ai',
        user_confirmed_subject: Boolean(subjectOverride)
      },
      source_line_range: item.source_line_range || null
    }, questionId);
    question.markdown_file_id = await this.storage.upload(
      `users/${userId}/questions/${questionId}/question.md`,
      Buffer.from(questionMarkdown(question))
    );
    await this.store.put('questions', question);
    return { item_id: item.item_id, question_id: questionId, question, existing: false };
  }

  async saveBatch(userId, task, requestedItemIds, subjectOverrides = {}) {
    assert(Array.isArray(requestedItemIds) && requestedItemIds.length, 'QUESTION_ITEMS_REQUIRED', '请至少选择一道题');
    const itemIds = [...new Set(requestedItemIds.map(String))];
    const byId = new Map((task.parsed_questions || []).map((item) => [item.item_id, item]));
    const selected = itemIds.map((itemId) => byId.get(itemId));
    assert(selected.every(Boolean), 'QUESTION_ITEMS_INVALID', '选中的题目不存在');
    assert(selected.every((item) => item.status === 'valid' && item.question), 'QUESTION_ITEMS_INVALID', '选中项中包含不可保存的题目');

    const settled = await Promise.allSettled(selected.map((item) => this.persistQuestion(
      userId,
      task,
      item,
      String(subjectOverrides?.[item.item_id] || '')
    )));
    const saved = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const failedItems = settled.flatMap((result, index) => result.status === 'rejected' ? [{
      item_id: selected[index].item_id,
      error_message: result.reason?.message || '题目保存失败'
    }] : []);

    if (saved.length) {
      try {
        await this.vector.upsertMany(saved.map((item) => item.question));
        await Promise.all(saved.map((item) => this.store.update('questions', item.question_id, { index_status: 'ready', updated_at: nowIso() })));
      } catch {
        await Promise.all(saved.map((item) => this.store.update('questions', item.question_id, { index_status: 'failed', updated_at: nowIso() })));
      }
    }

    const latestTask = await this.store.get('recognition_tasks', task._id) || task;
    const savedItems = mergeSavedItems(latestTask.saved_items || [], saved.map(({ item_id, question_id }) => ({ item_id, question_id })));
    const validItemIds = (task.parsed_questions || []).filter((item) => item.status === 'valid').map((item) => item.item_id);
    const ignoredItemIds = validItemIds.filter((itemId) => !itemIds.includes(itemId) && !savedItems.some((item) => item.item_id === itemId));
    await this.store.update('recognition_tasks', task._id, {
      status: failedItems.length ? 'partially_saved' : 'saved',
      saved_items: savedItems,
      ignored_item_ids: ignoredItemIds,
      question_id: savedItems.length === 1 ? savedItems[0].question_id : null,
      updated_at: nowIso()
    });
    const responseItems = saved.map(({ item_id, question_id }) => ({ item_id, question_id }));
    const questionIds = responseItems.map((item) => item.question_id);
    return {
      question_ids: questionIds,
      items: responseItems,
      failed_items: failedItems,
      ...(questionIds.length === 1 ? { question_id: questionIds[0] } : {})
    };
  }

  async save(userId, taskId, requested = {}) {
    const task = await this.getOwned(userId, taskId);
    const mode = task.mode || 'single';
    const requestedItemIds = Array.isArray(requested) ? requested : requested?.item_ids;
    const subjectOverrides = Array.isArray(requested) ? {} : requested?.subject_overrides || {};
    if (mode === 'batch') {
      assert(['succeeded', 'partially_saved', 'saved'].includes(task.status), 'RECOGNITION_NOT_READY', '识别尚未完成');
      return this.saveBatch(userId, task, requestedItemIds, subjectOverrides);
    }
    if (task.question_id) return { question_id: task.question_id };
    assert(task.status === 'succeeded', 'RECOGNITION_NOT_READY', '识别尚未完成');
    const questionId = id('q');
    const createdAt = nowIso();
    const selectedSubject = String(subjectOverrides.item_1 || task.parsed_question.subject);
    const candidates = task.parsed_question.subject_candidates || [task.parsed_question.subject];
    assert(isSubject(selectedSubject), 'QUESTION_SUBJECT_INVALID', '请选择有效的归类科目');
    assert(!task.parsed_question.is_cross_subject || candidates.includes(selectedSubject), 'QUESTION_SUBJECT_INVALID', '所选科目不在 AI 推荐范围内');
    const question = {
      ...task.parsed_question,
      subject: selectedSubject,
      classification: {
        subject: selectedSubject,
        type: task.parsed_question.type,
        difficulty: task.parsed_question.difficulty,
        source: 'ai',
        user_confirmed_subject: Boolean(subjectOverrides.item_1)
      },
      _id: questionId,
      user_id: userId,
      mastery_status: 'unmastered',
      source: 'photo',
      image_file_id: task.image_file_id,
      recognition_task_id: task._id,
      recognition_item_id: 'item_1',
      markdown_file_id: '',
      index_status: 'pending',
      practice_count: 0,
      wrong_count: 0,
      last_practiced_at: null,
      created_at: createdAt,
      updated_at: createdAt
    };
    question.markdown_file_id = await this.storage.upload(
      `users/${userId}/questions/${questionId}/question.md`,
      Buffer.from(questionMarkdown(question))
    );
    await this.store.put('questions', question);
    try {
      await this.vector.upsert(question);
      await this.store.update('questions', questionId, { index_status: 'ready', updated_at: nowIso() });
    } catch {
      await this.store.update('questions', questionId, { index_status: 'failed', updated_at: nowIso() });
    }
    await this.store.update('recognition_tasks', taskId, { status: 'saved', question_id: questionId, updated_at: nowIso() });
    return { question_id: questionId };
  }
}

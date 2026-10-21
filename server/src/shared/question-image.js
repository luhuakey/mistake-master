import sharp from 'sharp';

const illustrationPattern = /(?:如图|图中|下图|上图|左图|右图|附图|示意图|波形图|电路图|函数图(?:象|像)|坐标图|结构图|流程图|统计图|地图|漫画|插图|看图|读图|观察图|figure|diagram|graph|chart|map|illustration|shown\s+(?:below|above|in\s+the\s+figure))/i;

const finiteRect = (rect) => rect
  && [rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(Number(value)))
  && Number(rect.width) >= 0
  && Number(rect.height) >= 0;

const normalizeRect = (rect) => finiteRect(rect) ? {
  x: Number(rect.x),
  y: Number(rect.y),
  width: Number(rect.width),
  height: Number(rect.height)
} : null;

const unionRects = (rects) => {
  const valid = (rects || []).map(normalizeRect).filter(Boolean);
  if (!valid.length) return null;
  const x = Math.min(...valid.map((rect) => rect.x));
  const y = Math.min(...valid.map((rect) => rect.y));
  const right = Math.max(...valid.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...valid.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
};

const area = (rect) => rect ? Number(rect.width) * Number(rect.height) : 0;

const intersectionArea = (left, right) => {
  if (!left || !right) return 0;
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottom = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottom <= y) return 0;
  return (rightEdge - x) * (bottom - y);
};

const centerOf = (rect) => rect
  ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  : { x: 0, y: 0 };

const overlapsRange = (left, right) => {
  const [leftStart, leftEnd] = left || [];
  const [rightStart, rightEnd] = right || [];
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isInteger)) return 0;
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart) + 1);
};

const linesForRange = (lines, range) => {
  const [start, end] = range || [];
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
  return (lines || []).filter((line) => Number(line?.index) >= start && Number(line?.index) <= end);
};

const sourceRectsForItem = (item, document) => {
  const blocks = Array.isArray(document?.questionBlocks) ? document.questionBlocks : [];
  const bestBlock = blocks
    .map((block) => ({ block, overlap: overlapsRange(item?.source_line_range, block?.source_line_range) }))
    .sort((a, b) => b.overlap - a.overlap)[0];
  const blockRect = bestBlock?.overlap ? normalizeRect(bestBlock.block?.source_rect) : null;
  const lineRect = unionRects(linesForRange(document?.lines, item?.source_line_range).map((line) => line?.item_polygon));
  return { blockRect, lineRect, sourceRect: unionRects([blockRect, lineRect]) };
};

const sourceRectForItem = (item, document) => sourceRectsForItem(item, document).sourceRect;

const geometrySuggestsIllustration = (item, document) => {
  const { blockRect, lineRect } = sourceRectsForItem(item, document);
  if (!blockRect || !lineRect || !lineRect.width || !lineRect.height) return false;
  const blockArea = blockRect.width * blockRect.height;
  const lineArea = lineRect.width * lineRect.height;
  return blockArea > lineArea * 1.28
    && (blockRect.width > lineRect.width * 1.12 || blockRect.height > lineRect.height * 1.12);
};

const figureRect = (figure) => normalizeRect(figure?.rect || figure);

const verticallyOverlaps = (left, right) => {
  if (!left || !right) return false;
  return Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
};

const hasIllustrationText = (question) => illustrationPattern.test([
  question?.stem,
  ...Object.values(question?.options || {})
].filter(Boolean).join(' '));

// ---------------------------------------------------------------------------
// 坐标归一化：把 OCR 源图坐标映射到 sharp().rotate() 处理后的像素空间，
// 并处理 EXIF 旋转导致的长宽互换，避免 90°/270° 照片裁剪错位。
// ---------------------------------------------------------------------------
const orientationTransform = (orientation, W, H) => {
  switch (Number(orientation) || 1) {
    case 2: return { outW: W, outH: H, map: (x, y) => [W - x, y] };
    case 3: return { outW: W, outH: H, map: (x, y) => [W - x, H - y] };
    case 4: return { outW: W, outH: H, map: (x, y) => [x, H - y] };
    case 5: return { outW: H, outH: W, map: (x, y) => [y, x] };
    case 6: return { outW: H, outH: W, map: (x, y) => [H - y, x] };
    case 7: return { outW: H, outH: W, map: (x, y) => [H - y, W - x] };
    case 8: return { outW: H, outH: W, map: (x, y) => [y, W - x] };
    default: return { outW: W, outH: H, map: (x, y) => [x, y] };
  }
};

const buildCoordinateMapper = ({ metadata, document, imageInfo }) => {
  const outW = Number(imageInfo?.width) || 0;
  const outH = Number(imageInfo?.height) || 0;
  const srcW = Number(document?.imageWidth) || outW;
  const srcH = Number(document?.imageHeight) || outH;
  const orientation = Number(metadata?.orientation) || 1;

  // 当 OCR 返回的源尺寸与旋转后图像一致时，视作 OCR 已给出校正坐标，直接按比例缩放。
  const ocrAligned = Math.abs(srcW - outW) <= 2 && Math.abs(srcH - outH) <= 2;

  let tf;
  let tfOutW;
  let tfOutH;
  if (ocrAligned) {
    tf = (x, y) => [x, y];
    tfOutW = srcW;
    tfOutH = srcH;
  } else {
    const mapped = orientationTransform(orientation, srcW, srcH);
    tf = mapped.map;
    tfOutW = mapped.outW;
    tfOutH = mapped.outH;
  }

  const scaleX = tfOutW ? outW / tfOutW : 1;
  const scaleY = tfOutH ? outH / tfOutH : 1;

  const mapRect = (rect) => {
    const source = normalizeRect(rect);
    if (!source) return null;
    const [ax, ay] = tf(source.x, source.y);
    const [bx, by] = tf(source.x + source.width, source.y + source.height);
    const left = Math.min(ax, bx);
    const top = Math.min(ay, by);
    const right = Math.max(ax, bx);
    const bottom = Math.max(ay, by);
    return {
      x: left * scaleX,
      y: top * scaleY,
      width: (right - left) * scaleX,
      height: (bottom - top) * scaleY
    };
  };

  return { mapRect, outW, outH };
};

// ---------------------------------------------------------------------------
// 图形归属：把每个 OCR 图形矩形关联到最优的一道题。
// 以「与题目块矩形在 X/Y 轴的相交程度」为主，中心点归一化距离为辅；
// 无任何文字重叠的孤立图形（含最后一道题下方的图形）按中心最近原则分配。
// ---------------------------------------------------------------------------
const assignFigures = (figureRects, itemRegions, outW, outH) => {
  const imageDiag = Math.hypot(outW, outH) || 1;
  const assigned = new Map();
  (figureRects || []).forEach((figure) => {
    let bestIndex = null;
    let bestScore = -Infinity;
    itemRegions.forEach(({ index, textRect, blockRect }) => {
      const anchor = blockRect || textRect;
      if (!anchor) return;
      const overlap = intersectionArea(figure, anchor);
      const containment = area(figure) ? overlap / area(figure) : 0;
      const fc = centerOf(figure);
      const ac = centerOf(anchor);
      const dist = Math.hypot(fc.x - ac.x, fc.y - ac.y) / imageDiag;
      const proximity = 1 / (1 + dist);
      const score = containment * 10 + proximity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex !== null) {
      if (!assigned.has(bestIndex)) assigned.set(bestIndex, []);
      assigned.get(bestIndex).push(figure);
    }
  });
  return assigned;
};

// ---------------------------------------------------------------------------
// 像素扫描：在给定条带内做低分辨率非白像素扫描，屏蔽文字行后找出
// 不与文字重叠的连通内容，按邻近关系聚合并取最大簇作为图形区域。
// 用于「无 OCR 图形矩形」的整条带定位，以及「有 OCR 图形矩形」的邻域精确定界。
// ---------------------------------------------------------------------------
const pixelScanRegions = async ({ buffer, band, excludeRects, outW, outH }) => {
  const bandX = Math.max(0, Math.floor(band.x));
  const bandY = Math.max(0, Math.floor(band.y));
  const bandW = Math.min(outW - bandX, Math.max(1, Math.round(band.width)));
  const bandH = Math.min(outH - bandY, Math.max(1, Math.round(band.height)));
  if (bandW < 8 || bandH < 8) return null;

  const targetWidth = 800;
  const scale = Math.min(1, targetWidth / bandW);
  const gw = Math.max(1, Math.round(bandW * scale));
  const gh = Math.max(1, Math.round(bandH * scale));

  let resized;
  try {
    resized = await sharp(buffer)
      .extract({ left: bandX, top: bandY, width: bandW, height: bandH })
      .resize(gw, gh, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }

  const { data } = resized;
  const mask = new Uint8Array(gw * gh);
  const threshold = 235;
  for (let i = 0; i < data.length; i += 1) mask[i] = data[i] < threshold ? 1 : 0;

  (excludeRects || []).forEach((rect) => {
    if (!rect) return;
    const left = Math.max(0, Math.floor(((rect.x - bandX) / bandW) * gw));
    const top = Math.max(0, Math.floor(((rect.y - bandY) / bandH) * gh));
    const right = Math.min(gw, Math.ceil(((rect.x + rect.width - bandX) / bandW) * gw));
    const bottom = Math.min(gh, Math.ceil(((rect.y + rect.height - bandY) / bandH) * gh));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) mask[y * gw + x] = 0;
    }
  });

  const visited = new Uint8Array(mask.length);
  const components = [];
  const stack = [];
  const minArea = Math.max(3, Math.round(gw * gh * 0.0003));

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let count = 0;
    let minX = gw;
    let minY = gh;
    let maxX = 0;
    let maxY = 0;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      const xx = idx % gw;
      const yy = (idx / gw) | 0;
      count += 1;
      if (xx < minX) minX = xx;
      if (xx > maxX) maxX = xx;
      if (yy < minY) minY = yy;
      if (yy > maxY) maxY = yy;
      [idx - 1, idx + 1, idx - gw, idx + gw].forEach((neighbor) => {
        if (neighbor < 0 || neighbor >= mask.length) return;
        if (Math.abs((neighbor % gw) - xx) > 1) return;
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          stack.push(neighbor);
        }
      });
    }
    if (count >= minArea) {
      components.push({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1, area: count });
    }
  }

  if (!components.length) return null;

  // 按空间邻近关系聚合连通域，避免把远处残留文字/噪点并入图形包围盒；
  // 再取总面积最大的簇作为图形区域。
  const gap = Math.max(10, Math.round(gw * 0.025));
  const clusters = [];
  components
    .sort((a, b) => b.area - a.area)
    .forEach((component) => {
      const cluster = clusters.find((candidate) => {
        const dx = Math.max(0, Math.max(candidate.left, component.left)
          - Math.min(candidate.left + candidate.width, component.left + component.width));
        const dy = Math.max(0, Math.max(candidate.top, component.top)
          - Math.min(candidate.top + candidate.height, component.top + component.height));
        return Math.max(dx, dy) <= gap;
      });
      if (cluster) {
        cluster.components.push(component);
        const left = Math.min(cluster.left, component.left);
        const top = Math.min(cluster.top, component.top);
        const right = Math.max(cluster.left + cluster.width, component.left + component.width);
        const bottom = Math.max(cluster.top + cluster.height, component.top + component.height);
        cluster.left = left;
        cluster.top = top;
        cluster.width = right - left;
        cluster.height = bottom - top;
      } else {
        clusters.push({
          left: component.left,
          top: component.top,
          width: component.width,
          height: component.height,
          components: [component]
        });
      }
    });

  const best = clusters
    .map((cluster) => ({
      ...cluster,
      totalArea: cluster.components.reduce((sum, component) => sum + component.area, 0)
    }))
    .sort((a, b) => b.totalArea - a.totalArea)[0];
  if (!best) return null;

  return {
    x: bandX + (best.left / gw) * bandW,
    y: bandY + (best.top / gh) * bandH,
    width: (best.width / gw) * bandW,
    height: (best.height / gh) * bandH
  };
};

const bandForRegion = (region, index, itemRegions, outW, outH) => {
  const top = Math.max(0, Math.floor(region.textRect.y));
  const next = itemRegions[index + 1];
  const nextTop = next ? next.textRect.y : outH;
  const bottom = nextTop > top ? Math.min(outH, Math.ceil(nextTop)) : outH;
  return { x: 0, y: top, width: outW, height: Math.max(1, bottom - top) };
};

const expandRect = (rect, outW, outH) => {
  if (!rect) return null;
  const marginX = Math.max(24, Math.round(rect.width * 0.25));
  const marginY = Math.max(24, Math.round(rect.height * 0.25));
  const left = Math.max(0, Math.floor(rect.x) - marginX);
  const top = Math.max(0, Math.floor(rect.y) - marginY);
  const right = Math.min(outW, Math.ceil(rect.x + rect.width) + marginX);
  const bottom = Math.min(outH, Math.ceil(rect.y + rect.height) + marginY);
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
};

const padRegion = (rect, outW, outH) => {
  if (!rect) return null;
  const padding = Math.max(8, Math.round(outH * 0.008));
  const left = Math.max(0, Math.floor(rect.x) - padding);
  const top = Math.max(0, Math.floor(rect.y) - padding);
  const right = Math.min(outW, Math.ceil(rect.x + rect.width) + padding);
  const bottom = Math.min(outH, Math.ceil(rect.y + rect.height) + padding);
  if (right - left < 1 || bottom - top < 24) return null;
  return { left, top, width: right - left, height: bottom - top };
};

const fallbackQuestionItem = (item, imageFileId, source) => ({
  ...item,
  question: {
    ...item.question,
    question_image_file_id: imageFileId,
    question_image_is_fallback: true,
    question_image_source: source
  }
});

export const attachQuestionImages = async ({
  imageBuffer,
  imageFileId,
  items,
  document,
  upload,
  basePath,
  mode = 'batch'
}) => {
  const sourceItems = Array.isArray(items) ? items : [];
  const figures = Array.isArray(document?.figures) ? document.figures : [];
  const candidates = sourceItems.map((item) => ({
    ...item,
    question: item?.question ? {
      ...item.question,
      has_illustration: hasIllustrationText(item.question)
        || geometrySuggestsIllustration(item, document)
        || figures.some((figure) => {
          const rect = figureRect(figure);
          return rect && verticallyOverlaps(sourceRectForItem(item, document), rect);
        })
    } : item?.question
  }));

  if (!candidates.some((item) => item?.question?.has_illustration)) return candidates;

  let metadata;
  let normalized;
  try {
    metadata = await sharp(imageBuffer).metadata();
    normalized = await sharp(imageBuffer).rotate().jpeg({ quality: 96 }).toBuffer({ resolveWithObject: true });
  } catch {
    return candidates.map((item) => item?.question?.has_illustration
      ? fallbackQuestionItem(item, imageFileId, 'full_image_fallback')
      : item);
  }

  const { mapRect, outW, outH } = buildCoordinateMapper({ metadata, document, imageInfo: normalized.info });
  const itemRegions = candidates.map((item, index) => {
    const { blockRect, lineRect, sourceRect } = sourceRectsForItem(item, document);
    const mappedSource = mapRect(sourceRect);
    return {
      item,
      index,
      textRect: mappedSource || { x: 0, y: 0, width: outW, height: outH },
      blockRect: mapRect(blockRect),
      lineRect: mapRect(lineRect)
    };
  });

  const figureRects = figures.map(figureRect).map((rect) => mapRect(rect)).filter(Boolean);
  const assignedMap = assignFigures(figureRects, itemRegions, outW, outH);
  // 屏蔽整张图的所有 OCR 文字行，避免残留文字混入图形包围盒。
  const allTextRects = (Array.isArray(document?.lines) ? document.lines : [])
    .map((line) => mapRect(line?.item_polygon))
    .filter(Boolean);

  return Promise.all(itemRegions.map(async (region, index) => {
    const { item } = region;
    if (!item?.question?.has_illustration) return item;

    const assigned = assignedMap.get(index) || [];
    let figureRegion = null;
    let source = null;

    if (assigned.length) {
      // OCR 图形矩形负责归属（多栏/多题不串图），在其邻域内用像素扫描精确定界。
      const window = expandRect(unionRects(assigned), outW, outH);
      const pixel = await pixelScanRegions({
        buffer: normalized.data,
        band: window,
        excludeRects: allTextRects,
        outW,
        outH
      });
      figureRegion = pixel || unionRects(assigned);
      source = 'ocr_figure';
    } else {
      // 无 OCR 图形矩形时，在题目纵向条带内扫描非文字内容定位图形。
      const band = bandForRegion(region, index, itemRegions, outW, outH);
      const pixel = await pixelScanRegions({
        buffer: normalized.data,
        band,
        excludeRects: allTextRects,
        outW,
        outH
      });
      if (pixel) {
        figureRegion = pixel;
        source = 'pixel_detected';
      }
    }

    if (!source) {
      // 图形无法干净分离时，回退为「题+图」整块，避免图形丢失。
      if (mode === 'single') {
        return fallbackQuestionItem(item, imageFileId, 'full_image_fallback');
      }
      const band = bandForRegion(region, index, itemRegions, outW, outH);
      figureRegion = { x: 0, y: region.textRect.y, width: outW, height: Math.max(region.textRect.height, band.height) };
      source = 'region_fallback';
    }

    const padded = padRegion(figureRegion, outW, outH);
    if (!padded) return fallbackQuestionItem(item, imageFileId, 'full_image_fallback');

    try {
      const output = await sharp(normalized.data)
        .extract(padded)
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
        .toBuffer();
      const fileId = await upload(`${basePath}/${item.item_id}.jpg`, output);
      return {
        ...item,
        question: {
          ...item.question,
          question_image_file_id: fileId,
          question_image_is_fallback: false,
          question_image_width: padded.width,
          question_image_height: padded.height,
          question_image_source: source
        }
      };
    } catch {
      return fallbackQuestionItem(item, imageFileId, 'full_image_fallback');
    }
  }));
};

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constrainRotatedDisplayToCrop,
  fitImageDisplay,
  normalizeRotation,
  normalizedCropRect,
  reflowCropLayout,
  rotatedCropCoverageScale,
  rotatedSourceCropGeometry,
  sourceCropRect
} from '../../miniprogram/utils/crop.js';

const assertRectClose = (actual, expected, epsilon = 1e-9) => {
  Object.keys(expected).forEach((key) => {
    assert.ok(Math.abs(actual[key] - expected[key]) <= epsilon, `${key}: ${actual[key]} !== ${expected[key]}`);
  });
};

test('未缩放裁剪继续使用原有的原图坐标映射', () => {
  const imageDisplay = { left: 0, top: 20, width: 100, height: 60 };
  const crop = { left: 10, top: 26, width: 80, height: 48 };

  assert.deepEqual(normalizedCropRect(crop, imageDisplay), {
    left: 0.1,
    top: 0.1,
    right: 0.9,
    bottom: 0.9,
    width: 0.8,
    height: 0.8
  });
});

test('双指放大后仍直接从原始图片像素裁剪', () => {
  const imageDisplay = { left: -50, top: -30, width: 200, height: 160 };
  const crop = { left: 0, top: 10, width: 100, height: 80 };
  const imageInfo = { width: 4000, height: 3000 };

  assert.deepEqual(sourceCropRect(crop, imageDisplay, imageInfo), {
    sx: 1000,
    sy: 750,
    sw: 2000,
    sh: 1500
  });
});

test('拖动放大后的图片仍按移动后的原图区域精确裁剪', () => {
  const imageDisplay = { left: -80, top: -45, width: 200, height: 160 };
  const crop = { left: 0, top: 0, width: 100, height: 80 };
  const imageInfo = { width: 4000, height: 3000 };

  assert.deepEqual(sourceCropRect(crop, imageDisplay, imageInfo), {
    sx: 1600,
    sy: 843.75,
    sw: 2000,
    sh: 1500
  });
});

test('裁剪边线超出图片显示范围时坐标会限制在原图内', () => {
  const result = normalizedCropRect(
    { left: -20, top: -20, width: 160, height: 160 },
    { left: 0, top: 0, width: 100, height: 100 }
  );

  assert.deepEqual(result, { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 });
});

test('响应式扫描区域按原图比例完整适配且不拉伸', () => {
  assert.deepEqual(
    fitImageDisplay({ width: 4000, height: 3000 }, { width: 320, height: 500 }),
    { left: 0, top: 26, width: 100, height: 48 }
  );
  assert.deepEqual(
    fitImageDisplay({ width: 2000, height: 4000 }, { width: 390, height: 620 }),
    { left: 10.256410256410255, top: 0, width: 79.48717948717949, height: 100 }
  );
});

test('扫描区域重排后保持同一组原图裁剪像素', () => {
  const imageInfo = { width: 4000, height: 3000 };
  const before = {
    imageDisplay: { left: -48, top: -12, width: 180, height: 108 },
    crop: { left: 4, top: 8, width: 92, height: 72 }
  };
  const expectedSource = sourceCropRect(before.crop, before.imageDisplay, imageInfo);
  const next = reflowCropLayout({
    ...before,
    imageInfo,
    area: { width: 646, height: 760 },
    imageScale: 1.8
  });

  assertRectClose(sourceCropRect(next.crop, next.imageDisplay, imageInfo), expectedSource);
  assert.ok(next.crop.left >= 0 && next.crop.top >= 0);
  assert.ok(next.crop.left + next.crop.width <= 100);
  assert.ok(next.crop.top + next.crop.height <= 100);
});

test('双指左右旋转角度在跨越正负一百八十度时保持连续', () => {
  assert.equal(normalizeRotation(190), -170);
  assert.equal(normalizeRotation(-190), 170);
  assert.equal(normalizeRotation(360), 0);
});

test('旋转时自动计算覆盖裁剪框所需的最小原图缩放', () => {
  const area = { width: 500, height: 500 };
  const full = { left: 0, top: 0, width: 100, height: 100 };
  assert.ok(Math.abs(rotatedCropCoverageScale(full, full, area, 45) - Math.SQRT2) < 1e-9);

  const enlarged = { left: -25, top: -25, width: 150, height: 150 };
  const constrained = constrainRotatedDisplayToCrop(enlarged, full, area, 45);
  assert.ok(rotatedCropCoverageScale(constrained, full, area, 45) <= 1.000001);
});

test('旋转裁剪按原图像素密度计算输出区域而非截取屏幕图片', () => {
  const geometry = rotatedSourceCropGeometry({
    crop: { left: 50, top: 25, width: 50, height: 50 },
    imageDisplay: { left: 0, top: 0, width: 100, height: 100 },
    imageInfo: { width: 4000, height: 4000 },
    area: { width: 500, height: 500 },
    imageRotation: 90
  });

  assertRectClose(geometry, {
    centerX: 2000,
    centerY: 1000,
    width: 2000,
    height: 2000,
    rotation: 90
  });
});

test('旋转状态下扫描区域重排仍保持同一原图裁剪几何', () => {
  const imageInfo = { width: 4000, height: 3000 };
  const previousArea = { width: 360, height: 600 };
  const before = {
    imageDisplay: { left: -35, top: -10, width: 170, height: 102 },
    crop: { left: 8, top: 12, width: 84, height: 68 }
  };
  const expected = rotatedSourceCropGeometry({
    ...before,
    imageInfo,
    area: previousArea,
    imageRotation: -27
  });
  const next = reflowCropLayout({
    ...before,
    imageInfo,
    previousArea,
    area: { width: 430, height: 760 },
    imageScale: 1.7,
    imageRotation: -27
  });
  const actual = rotatedSourceCropGeometry({
    crop: next.crop,
    imageDisplay: next.imageDisplay,
    imageInfo,
    area: { width: 430, height: 760 },
    imageRotation: -27
  });

  assertRectClose(actual, expected, 1e-7);
});

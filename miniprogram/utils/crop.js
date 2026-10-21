const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const radians = (degrees) => degrees * Math.PI / 180;
const rotateVector = (x, y, angle) => ({
  x: x * Math.cos(angle) - y * Math.sin(angle),
  y: x * Math.sin(angle) + y * Math.cos(angle)
});
const pixelRect = (rect, area) => ({
  left: rect.left / 100 * area.width,
  top: rect.top / 100 * area.height,
  width: rect.width / 100 * area.width,
  height: rect.height / 100 * area.height
});
const percentRect = (rect, area) => ({
  left: rect.left / area.width * 100,
  top: rect.top / area.height * 100,
  width: rect.width / area.width * 100,
  height: rect.height / area.height * 100
});
const rectCorners = (rect) => [
  { x: rect.left, y: rect.top },
  { x: rect.left + rect.width, y: rect.top },
  { x: rect.left, y: rect.top + rect.height },
  { x: rect.left + rect.width, y: rect.top + rect.height }
];

export const normalizeRotation = (degrees) => {
  const normalized = ((Number(degrees) || 0) + 180) % 360;
  return (normalized < 0 ? normalized + 360 : normalized) - 180;
};

export const normalizedCropRect = (crop, imageDisplay) => {
  const left = clamp((crop.left - imageDisplay.left) / imageDisplay.width, 0, 1);
  const top = clamp((crop.top - imageDisplay.top) / imageDisplay.height, 0, 1);
  const right = clamp((crop.left + crop.width - imageDisplay.left) / imageDisplay.width, left, 1);
  const bottom = clamp((crop.top + crop.height - imageDisplay.top) / imageDisplay.height, top, 1);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

export const sourceCropRect = (crop, imageDisplay, imageInfo) => {
  const normalized = normalizedCropRect(crop, imageDisplay);
  return {
    sx: imageInfo.width * normalized.left,
    sy: imageInfo.height * normalized.top,
    sw: imageInfo.width * normalized.width,
    sh: imageInfo.height * normalized.height
  };
};

export const fitImageDisplay = (imageInfo, area) => {
  const imageRatio = imageInfo.width / imageInfo.height;
  const areaRatio = area.width / area.height;
  if (imageRatio >= areaRatio) {
    const height = area.width / imageRatio / area.height * 100;
    return { left: 0, top: (100 - height) / 2, width: 100, height };
  }
  const width = area.height * imageRatio / area.width * 100;
  return { left: (100 - width) / 2, top: 0, width, height: 100 };
};

export const rotatedCropCoverageScale = (imageDisplay, crop, area, imageRotation = 0) => {
  const displayPx = pixelRect(imageDisplay, area);
  const cropPx = pixelRect(crop, area);
  if (!displayPx.width || !displayPx.height) return 1;
  const angle = -radians(imageRotation);
  const rotatedCorners = rectCorners(cropPx).map((point) => rotateVector(point.x, point.y, angle));
  const xs = rotatedCorners.map((point) => point.x);
  const ys = rotatedCorners.map((point) => point.y);
  return Math.max(
    1,
    (Math.max(...xs) - Math.min(...xs)) / displayPx.width,
    (Math.max(...ys) - Math.min(...ys)) / displayPx.height
  );
};

export const constrainRotatedDisplayToCrop = (imageDisplay, crop, area, imageRotation = 0) => {
  const displayPx = pixelRect(imageDisplay, area);
  const cropPx = pixelRect(crop, area);
  const halfWidth = displayPx.width / 2;
  const halfHeight = displayPx.height / 2;
  const angle = -radians(imageRotation);
  const rotatedCorners = rectCorners(cropPx).map((point) => rotateVector(point.x, point.y, angle));
  const center = rotateVector(
    displayPx.left + halfWidth,
    displayPx.top + halfHeight,
    angle
  );
  const minCenterX = Math.max(...rotatedCorners.map((point) => point.x - halfWidth));
  const maxCenterX = Math.min(...rotatedCorners.map((point) => point.x + halfWidth));
  const minCenterY = Math.max(...rotatedCorners.map((point) => point.y - halfHeight));
  const maxCenterY = Math.min(...rotatedCorners.map((point) => point.y + halfHeight));
  const constrainedCenter = rotateVector(
    clamp(center.x, minCenterX, maxCenterX),
    clamp(center.y, minCenterY, maxCenterY),
    -angle
  );
  return percentRect({
    left: constrainedCenter.x - halfWidth,
    top: constrainedCenter.y - halfHeight,
    width: displayPx.width,
    height: displayPx.height
  }, area);
};

export const rotatedSourceCropGeometry = ({ crop, imageDisplay, imageInfo, area, imageRotation = 0 }) => {
  const displayPx = pixelRect(imageDisplay, area);
  const cropPx = pixelRect(crop, area);
  const displayCenter = {
    x: displayPx.left + displayPx.width / 2,
    y: displayPx.top + displayPx.height / 2
  };
  const cropCenter = {
    x: cropPx.left + cropPx.width / 2,
    y: cropPx.top + cropPx.height / 2
  };
  const localCenter = rotateVector(
    cropCenter.x - displayCenter.x,
    cropCenter.y - displayCenter.y,
    -radians(imageRotation)
  );
  return {
    centerX: (localCenter.x / displayPx.width + 0.5) * imageInfo.width,
    centerY: (localCenter.y / displayPx.height + 0.5) * imageInfo.height,
    width: cropPx.width / displayPx.width * imageInfo.width,
    height: cropPx.height / displayPx.height * imageInfo.height,
    rotation: normalizeRotation(imageRotation)
  };
};

export const reflowCropLayout = ({
  crop, imageDisplay, imageInfo, area, previousArea = area, imageScale, imageRotation = 0
}) => {
  const oldDisplayPx = pixelRect(imageDisplay, previousArea);
  const oldCropPx = pixelRect(crop, previousArea);
  const oldDisplayCenter = {
    x: oldDisplayPx.left + oldDisplayPx.width / 2,
    y: oldDisplayPx.top + oldDisplayPx.height / 2
  };
  const oldCropCenter = {
    x: oldCropPx.left + oldCropPx.width / 2,
    y: oldCropPx.top + oldCropPx.height / 2
  };
  const localCenter = rotateVector(
    oldCropCenter.x - oldDisplayCenter.x,
    oldCropCenter.y - oldDisplayCenter.y,
    -radians(imageRotation)
  );
  const normalizedCenterX = localCenter.x / oldDisplayPx.width;
  const normalizedCenterY = localCenter.y / oldDisplayPx.height;
  const normalizedWidth = oldCropPx.width / oldDisplayPx.width;
  const normalizedHeight = oldCropPx.height / oldDisplayPx.height;
  const baseImageDisplay = fitImageDisplay(imageInfo, area);
  const baseDisplayPx = pixelRect(baseImageDisplay, area);
  const requestedScale = Math.max(1, Number(imageScale) || 1);
  const maxWidthScale = normalizedWidth
    ? area.width / (normalizedWidth * baseDisplayPx.width)
    : requestedScale;
  const maxHeightScale = normalizedHeight
    ? area.height / (normalizedHeight * baseDisplayPx.height)
    : requestedScale;
  const nextScale = Math.max(1, Math.min(requestedScale, maxWidthScale, maxHeightScale));
  const width = baseDisplayPx.width * nextScale;
  const height = baseDisplayPx.height * nextScale;
  const cropWidth = normalizedWidth * width;
  const cropHeight = normalizedHeight * height;
  const desiredCropCenter = {
    x: oldCropCenter.x / previousArea.width * area.width,
    y: oldCropCenter.y / previousArea.height * area.height
  };
  const cropCenter = {
    x: clamp(desiredCropCenter.x, cropWidth / 2, area.width - cropWidth / 2),
    y: clamp(desiredCropCenter.y, cropHeight / 2, area.height - cropHeight / 2)
  };
  const rotatedLocalCenter = rotateVector(
    normalizedCenterX * width,
    normalizedCenterY * height,
    radians(imageRotation)
  );
  const imageCenter = {
    x: cropCenter.x - rotatedLocalCenter.x,
    y: cropCenter.y - rotatedLocalCenter.y
  };
  const nextCrop = percentRect({
    left: cropCenter.x - cropWidth / 2,
    top: cropCenter.y - cropHeight / 2,
    width: cropWidth,
    height: cropHeight
  }, area);
  const nextImageDisplay = percentRect({
    left: imageCenter.x - width / 2,
    top: imageCenter.y - height / 2,
    width,
    height
  }, area);
  return { baseImageDisplay, imageDisplay: nextImageDisplay, crop: nextCrop, imageScale: nextScale };
};

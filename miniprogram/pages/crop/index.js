import { showError } from '../../services/api';
import { isLoggedIn, promptLogin } from '../../utils/auth';
import { getNavigationLayout } from '../../utils/navigation';
import {
  constrainRotatedDisplayToCrop,
  fitImageDisplay,
  normalizeRotation,
  reflowCropLayout,
  rotatedCropCoverageScale,
  rotatedSourceCropGeometry,
  sourceCropRect
} from '../../utils/crop';

const FULL_AREA = { left: 0, top: 0, width: 100, height: 100 };
const MID_HANDLE_MIN_PX = 72;
const MIN_IMAGE_SCALE = 1;
const MAX_IMAGE_SCALE = 8;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const touchDistance = (touches) => {
  const [first, second] = touches;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
};
const touchAngle = (touches) => {
  const [first, second] = touches;
  return Math.atan2(second.clientY - first.clientY, second.clientX - first.clientX) * 180 / Math.PI;
};

Page({
  data: {
    imagePath: '',
    imageDisplay: { ...FULL_AREA },
    imageScale: MIN_IMAGE_SCALE,
    imageScaleLabel: '100%',
    imageRotation: 0,
    imageRotationLabel: '0°',
    crop: { ...FULL_AREA },
    showHorizontalMidHandles: false,
    showVerticalMidHandles: false,
    dragging: '',
    busy: false,
    navShellStyle: '',
    navBarStyle: ''
  },
  onLoad() {
    this.updateNavBar();
    if (!isLoggedIn()) {
      wx.showModal({
        title: '登录后使用',
        content: '登录后即可拍照识别并保存错题，当前可以先浏览示例内容。',
        confirmText: '去登录',
        cancelText: '继续浏览',
        confirmColor: '#08a7a0',
        success: ({ confirm }) => {
          if (confirm) wx.redirectTo({ url: '/pages/login/index' });
          else wx.switchTab({ url: '/pages/home/index' });
        }
      });
      return;
    }
    this.chooseImage();
  },
  onResize({ size } = {}) {
    this.updateNavBar(size, () => {
      this.reflowToImageArea().catch(() => {});
    });
  },
  updateNavBar(size, callback) {
    const layout = getNavigationLayout(size);
    this.setData({ navShellStyle: layout.shellStyle, navBarStyle: layout.barStyle }, callback);
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }); },
  getImageInfo(imagePath) {
    return new Promise((resolve, reject) => wx.getImageInfo({ src: imagePath, success: resolve, fail: reject }));
  },
  getImageAreaRect() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().select('.image-area').boundingClientRect((rect) => {
        if (rect?.width && rect?.height) resolve(rect);
        else reject(new Error('裁剪区域初始化失败'));
      }).exec();
    });
  },
  getHandleVisibility(crop, area) {
    return {
      showHorizontalMidHandles: area.width * crop.width / 100 >= MID_HANDLE_MIN_PX,
      showVerticalMidHandles: area.height * crop.height / 100 >= MID_HANDLE_MIN_PX
    };
  },
  setCrop(crop, area) {
    const currentArea = area || this.imageAreaRect;
    this.setData({
      crop,
      ...(currentArea ? this.getHandleVisibility(crop, currentArea) : {})
    });
  },
  visibleImageBounds(display = this.data.imageDisplay) {
    return {
      left: Math.max(0, display.left),
      top: Math.max(0, display.top),
      right: Math.min(100, display.left + display.width),
      bottom: Math.min(100, display.top + display.height)
    };
  },
  clampCropToDisplay(crop, display) {
    const bounds = this.visibleImageBounds(display);
    const width = Math.min(crop.width, Math.max(0, bounds.right - bounds.left));
    const height = Math.min(crop.height, Math.max(0, bounds.bottom - bounds.top));
    return {
      left: clamp(crop.left, bounds.left, Math.max(bounds.left, bounds.right - width)),
      top: clamp(crop.top, bounds.top, Math.max(bounds.top, bounds.bottom - height)),
      width,
      height
    };
  },
  constrainDisplayToCrop(display, crop) {
    const next = { ...display };
    if (next.width >= crop.width) {
      next.left = clamp(next.left, crop.left + crop.width - next.width, crop.left);
    }
    if (next.height >= crop.height) {
      next.top = clamp(next.top, crop.top + crop.height - next.height, crop.top);
    }
    return next;
  },
  fitDisplayToCrop(display, crop, imageRotation, imageScale, area = this.imageAreaRect) {
    if (!area) return { imageDisplay: display, imageScale };
    const coverageScale = rotatedCropCoverageScale(display, crop, area, imageRotation);
    let nextDisplay = { ...display };
    let nextScale = imageScale;
    if (coverageScale > 1.000001) {
      const centerX = nextDisplay.left + nextDisplay.width / 2;
      const centerY = nextDisplay.top + nextDisplay.height / 2;
      nextDisplay = {
        left: centerX - nextDisplay.width * coverageScale / 2,
        top: centerY - nextDisplay.height * coverageScale / 2,
        width: nextDisplay.width * coverageScale,
        height: nextDisplay.height * coverageScale
      };
      nextScale *= coverageScale;
    }
    nextDisplay = constrainRotatedDisplayToCrop(nextDisplay, crop, area, imageRotation);
    return { imageDisplay: nextDisplay, imageScale: nextScale };
  },
  async fitCropToImage(imagePath) {
    const [info, area] = await Promise.all([this.getImageInfo(imagePath), this.getImageAreaRect()]);
    const imageDisplay = fitImageDisplay(info, area);
    this.imageInfo = info;
    this.baseImageDisplay = { ...imageDisplay };
    this.imageAreaRect = area;
    this.setData({
      imageDisplay,
      imageScale: MIN_IMAGE_SCALE,
      imageScaleLabel: '100%',
      imageRotation: 0,
      imageRotationLabel: '0°'
    });
    this.setCrop({ ...imageDisplay }, area);
  },
  async reflowToImageArea() {
    const area = await this.getImageAreaRect();
    const previousArea = this.imageAreaRect || area;
    if (!this.data.imagePath || !this.imageInfo) {
      this.imageAreaRect = area;
      return;
    }
    const next = reflowCropLayout({
      crop: this.data.crop,
      imageDisplay: this.data.imageDisplay,
      imageInfo: this.imageInfo,
      area,
      previousArea,
      imageScale: this.data.imageScale,
      imageRotation: this.data.imageRotation
    });
    this.imageAreaRect = area;
    this.baseImageDisplay = next.baseImageDisplay;
    this.pinch = null;
    this.pan = null;
    this.setData({
      imageDisplay: next.imageDisplay,
      imageScale: next.imageScale,
      imageScaleLabel: `${Math.round(next.imageScale * 100)}%`,
      crop: next.crop,
      ...this.getHandleVisibility(next.crop, area)
    });
  },
  async processSelectedImage(imagePath) {
    this.imageInfo = null;
    this.baseImageDisplay = null;
    this.pinch = null;
    this.pan = null;
    await new Promise((resolve) => this.setData({
      imagePath,
      imageDisplay: { ...FULL_AREA },
      imageScale: MIN_IMAGE_SCALE,
      imageScaleLabel: '100%',
      imageRotation: 0,
      imageRotationLabel: '0°',
      crop: { ...FULL_AREA },
      showHorizontalMidHandles: false,
      showVerticalMidHandles: false
    }, resolve));
    await this.fitCropToImage(imagePath);
  },
  async chooseImage(event) {
    try {
      const requestedSource = event?.currentTarget?.dataset?.source;
      const sourceType = requestedSource ? [requestedSource] : ['camera', 'album'];
      const result = await new Promise((resolve, reject) => wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['original'],
        sourceType,
        success: resolve,
        fail: reject
      }));
      const imagePath = result.tempFiles?.[0]?.tempFilePath;
      if (imagePath) await this.processSelectedImage(imagePath);
    } catch (error) {
      if (!/cancel/i.test(String(error?.errMsg || error?.message || ''))) showError(error);
    }
  },
  dragStart(event) {
    if (event.touches.length !== 1) return;
    this.pan = null;
    this.setData({ dragging: event.currentTarget.dataset.handle });
  },
  dragMove(event) {
    if (!this.data.dragging) return;
    const touch = event.touches[0];
    if (!touch) return;
    const updateCrop = (rect) => {
      if (!rect) return;
      const x = clamp((touch.clientX - rect.left) / rect.width * 100, 0, 100);
      const y = clamp((touch.clientY - rect.top) / rect.height * 100, 0, 100);
      const c = { ...this.data.crop };
      const right = c.left + c.width; const bottom = c.top + c.height;
      const minWidth = Math.max(1.5, Math.min(10, this.data.imageDisplay.width * 0.04));
      const minHeight = Math.max(1.5, Math.min(10, this.data.imageDisplay.height * 0.04));
      if (this.data.dragging.includes('l')) { c.left = Math.min(x, right - minWidth); c.width = right - c.left; }
      if (this.data.dragging.includes('r')) c.width = Math.max(minWidth, x - c.left);
      if (this.data.dragging.includes('t')) { c.top = Math.min(y, bottom - minHeight); c.height = bottom - c.top; }
      if (this.data.dragging.includes('b')) c.height = Math.max(minHeight, y - c.top);
      const fitted = this.fitDisplayToCrop(
        this.data.imageDisplay,
        c,
        this.data.imageRotation,
        this.data.imageScale,
        rect
      );
      this.setData({
        crop: c,
        imageDisplay: fitted.imageDisplay,
        imageScale: fitted.imageScale,
        imageScaleLabel: `${Math.round(fitted.imageScale * 100)}%`,
        ...this.getHandleVisibility(c, rect)
      });
    };
    if (this.imageAreaRect) {
      updateCrop(this.imageAreaRect);
      return;
    }
    wx.createSelectorQuery().select('.image-area').boundingClientRect(updateCrop).exec();
  },
  dragEnd() { this.setData({ dragging: '' }); },
  imageTouchStart(event) {
    if (!this.data.imagePath) return;
    const rect = this.imageAreaRect;
    if (!rect) return;
    if (event.touches.length === 1) {
      if (event.target?.dataset?.handle || this.data.dragging) return;
      const [touch] = event.touches;
      this.pan = {
        clientX: touch.clientX,
        clientY: touch.clientY,
        display: { ...this.data.imageDisplay }
      };
      return;
    }
    if (event.touches.length < 2) return;
    this.pan = null;
    const distance = touchDistance(event.touches);
    if (!distance) return;
    const centerX = ((event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left) / rect.width * 100;
    const centerY = ((event.touches[0].clientY + event.touches[1].clientY) / 2 - rect.top) / rect.height * 100;
    this.pinch = {
      distance,
      angle: touchAngle(event.touches),
      centerX,
      centerY,
      display: { ...this.data.imageDisplay },
      crop: { ...this.data.crop },
      scale: this.data.imageScale,
      rotation: this.data.imageRotation
    };
    if (this.data.dragging) this.setData({ dragging: '' });
  },
  panImage(event) {
    const [touch] = event.touches;
    const rect = this.imageAreaRect;
    if (!this.pan || !touch || !rect) return;
    const imageDisplay = constrainRotatedDisplayToCrop({
      ...this.pan.display,
      left: this.pan.display.left + (touch.clientX - this.pan.clientX) / rect.width * 100,
      top: this.pan.display.top + (touch.clientY - this.pan.clientY) / rect.height * 100
    }, this.data.crop, rect, this.data.imageRotation);
    this.setData({ imageDisplay });
  },
  imageTouchMove(event) {
    if (event.touches.length < 2) {
      if (this.data.dragging) this.dragMove(event);
      else this.panImage(event);
      return;
    }
    if (!this.pinch) this.imageTouchStart(event);
    if (!this.pinch) return;
    const requestedScale = clamp(
      this.pinch.scale * touchDistance(event.touches) / this.pinch.distance,
      MIN_IMAGE_SCALE,
      MAX_IMAGE_SCALE
    );
    const factor = requestedScale / this.pinch.scale;
    const imageRotation = normalizeRotation(
      this.pinch.rotation + normalizeRotation(touchAngle(event.touches) - this.pinch.angle)
    );
    const requestedDisplay = {
      left: this.pinch.centerX - (this.pinch.centerX - this.pinch.display.left) * factor,
      top: this.pinch.centerY - (this.pinch.centerY - this.pinch.display.top) * factor,
      width: this.pinch.display.width * factor,
      height: this.pinch.display.height * factor
    };
    const fitted = this.fitDisplayToCrop(
      requestedDisplay,
      this.pinch.crop,
      imageRotation,
      requestedScale
    );
    this.setData({
      imageDisplay: fitted.imageDisplay,
      imageScale: fitted.imageScale,
      imageScaleLabel: `${Math.round(fitted.imageScale * 100)}%`,
      imageRotation,
      imageRotationLabel: `${Math.round(imageRotation)}°`,
      crop: this.pinch.crop,
      ...this.getHandleVisibility(this.pinch.crop, this.imageAreaRect)
    });
  },
  imageTouchEnd(event) {
    if (event.touches.length < 2) this.pinch = null;
    if (!event.touches.length) {
      this.pan = null;
      this.dragEnd();
    }
  },
  resetImageScale() {
    if (!this.baseImageDisplay || (this.data.imageScale === MIN_IMAGE_SCALE && !this.data.imageRotation)) return;
    const imageDisplay = { ...this.baseImageDisplay };
    const crop = this.clampCropToDisplay(this.data.crop, imageDisplay);
    this.pinch = null;
    this.pan = null;
    this.setData({
      imageDisplay,
      imageScale: MIN_IMAGE_SCALE,
      imageScaleLabel: '100%',
      imageRotation: 0,
      imageRotationLabel: '0°',
      crop,
      ...this.getHandleVisibility(crop, this.imageAreaRect)
    });
  },
  drawCropToCanvas({ sx, sy, sw, sh, targetWidth, targetHeight }) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().select('#cropCanvas').fields({ node: true, size: true }).exec((result) => {
        const canvas = result?.[0]?.node;
        if (!canvas) return reject(new Error('Canvas 2D 初始化失败'));
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        const image = canvas.createImage();
        image.onload = () => {
          ctx.clearRect(0, 0, targetWidth, targetHeight);
          ctx.drawImage(image, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
          wx.canvasToTempFilePath({
            canvas,
            x: 0,
            y: 0,
            width: targetWidth,
            height: targetHeight,
            destWidth: targetWidth,
            destHeight: targetHeight,
            fileType: 'jpg',
            quality: 0.95,
            success: (response) => resolve(response.tempFilePath),
            fail: reject
          });
        };
        image.onerror = () => reject(new Error('裁剪图片加载失败'));
        image.src = this.data.imagePath;
      });
    });
  },
  drawRotatedCropToCanvas({ area, targetWidth, targetHeight }) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().select('#cropCanvas').fields({ node: true, size: true }).exec((result) => {
        const canvas = result?.[0]?.node;
        if (!canvas) return reject(new Error('Canvas 2D 初始化失败'));
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        const image = canvas.createImage();
        image.onload = () => {
          const display = this.data.imageDisplay;
          const crop = this.data.crop;
          const displayPx = {
            left: display.left / 100 * area.width,
            top: display.top / 100 * area.height,
            width: display.width / 100 * area.width,
            height: display.height / 100 * area.height
          };
          const cropPx = {
            left: crop.left / 100 * area.width,
            top: crop.top / 100 * area.height,
            width: crop.width / 100 * area.width,
            height: crop.height / 100 * area.height
          };
          const scaleX = targetWidth / cropPx.width;
          const scaleY = targetHeight / cropPx.height;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, targetWidth, targetHeight);
          ctx.setTransform(scaleX, 0, 0, scaleY, -cropPx.left * scaleX, -cropPx.top * scaleY);
          ctx.translate(displayPx.left + displayPx.width / 2, displayPx.top + displayPx.height / 2);
          ctx.rotate(this.data.imageRotation * Math.PI / 180);
          ctx.drawImage(image, -displayPx.width / 2, -displayPx.height / 2, displayPx.width, displayPx.height);
          wx.canvasToTempFilePath({
            canvas,
            x: 0,
            y: 0,
            width: targetWidth,
            height: targetHeight,
            destWidth: targetWidth,
            destHeight: targetHeight,
            fileType: 'jpg',
            quality: 0.95,
            success: (response) => resolve(response.tempFilePath),
            fail: reject
          });
        };
        image.onerror = () => reject(new Error('旋转图片加载失败'));
        image.src = this.data.imagePath;
      });
    });
  },
  async cropImage() {
    const info = await this.getImageInfo(this.data.imagePath);
    const c = this.data.crop;
    const display = this.data.imageDisplay;
    if (Math.abs(this.data.imageRotation) < 0.01) {
      const { sx, sy, sw, sh } = sourceCropRect(c, display, info);
      const scale = Math.min(1, 1800 / sw, 2400 / Math.max(sw, sh));
      const targetWidth = Math.max(1, Math.round(sw * scale));
      const targetHeight = Math.max(1, Math.round(sh * scale));
      return this.drawCropToCanvas({ sx, sy, sw, sh, targetWidth, targetHeight });
    }
    const area = this.imageAreaRect || await this.getImageAreaRect();
    const geometry = rotatedSourceCropGeometry({
      crop: c,
      imageDisplay: display,
      imageInfo: info,
      area,
      imageRotation: this.data.imageRotation
    });
    const scale = Math.min(1, 1800 / geometry.width, 2400 / Math.max(geometry.width, geometry.height));
    const targetWidth = Math.max(1, Math.round(geometry.width * scale));
    const targetHeight = Math.max(1, Math.round(geometry.height * scale));
    return this.drawRotatedCropToCanvas({ area, targetWidth, targetHeight });
  },
  async recognize() {
    if (!this.data.imagePath || this.data.busy) return;
    if (!isLoggedIn()) {
      promptLogin('登录状态已失效，重新登录后即可继续识别并保存错题。');
      return;
    }
    let redirected = false;
    this.setData({ busy: true });
    try {
      const croppedPath = await this.cropImage();
      const globalData = getApp().globalData;
      globalData.recognitionImagePath = croppedPath;
      globalData.pendingRecognition = { imagePath: croppedPath, mode: 'batch', createdAt: Date.now() };
      await new Promise((resolve, reject) => wx.redirectTo({
        url: '/pages/recognition/index?pending=1', success: resolve, fail: reject
      }));
      redirected = true;
    } catch (error) { showError(error); }
    finally { if (!redirected) this.setData({ busy: false }); }
  }
});

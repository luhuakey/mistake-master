import { request } from '../services/api';

const CACHE_KEY = 'points_dashboard_cache';
const FRESH_MS = 30 * 1000;

const currentUserId = () => String(getApp().globalData.user?.id || '');

export const readPointsDashboard = ({ allowStale = false } = {}) => {
  const userId = currentUserId();
  if (!userId) return null;
  const app = getApp();
  const memory = app.globalData.pointsDashboardCache;
  const cached = memory?.user_id === userId ? memory : wx.getStorageSync(CACHE_KEY);
  if (!cached || cached.user_id !== userId || !cached.dashboard) return null;
  if (!allowStale && Date.now() - Number(cached.cached_at || 0) > FRESH_MS) return null;
  app.globalData.pointsDashboardCache = cached;
  return cached.dashboard;
};

const savePointsDashboard = (dashboard) => {
  const userId = currentUserId();
  if (!userId) return dashboard;
  const cached = { user_id: userId, dashboard, cached_at: Date.now() };
  getApp().globalData.pointsDashboardCache = cached;
  wx.setStorageSync(CACHE_KEY, cached);
  return dashboard;
};

export const loadPointsDashboard = ({ force = false } = {}) => {
  const app = getApp();
  if (app.globalData.pointsDashboardPromise) return app.globalData.pointsDashboardPromise;
  if (!force) {
    const cached = readPointsDashboard();
    if (cached) return Promise.resolve(cached);
  }
  const pending = request('/points')
    .then(savePointsDashboard)
    .finally(() => {
      if (app.globalData.pointsDashboardPromise === pending) app.globalData.pointsDashboardPromise = null;
    });
  app.globalData.pointsDashboardPromise = pending;
  return pending;
};

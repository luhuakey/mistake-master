const SESSION_KEY = 'practice_session_id';
const CONTEXT_SESSIONS_KEY = 'practice_session_contexts';

export const PRACTICE_CONTEXT = {
  comprehensive: 'comprehensive',
  recommended: (subject) => `recommended:${subject}`
};

const removeLocalProgress = (sessionId) => {
  if (!sessionId) return;
  wx.removeStorageSync(`answers_${sessionId}`);
  wx.removeStorageSync(`practice_index_${sessionId}`);
};

const getContextSessions = () => wx.getStorageSync(CONTEXT_SESSIONS_KEY) || {};

const saveContextSessions = (sessions) => {
  if (Object.keys(sessions).length) wx.setStorageSync(CONTEXT_SESSIONS_KEY, sessions);
  else wx.removeStorageSync(CONTEXT_SESSIONS_KEY);
};

export const getCurrentPracticeSessionId = () => (
  getApp().globalData.practiceSessionId || wx.getStorageSync(SESSION_KEY) || ''
);

export const getPracticeSessionId = (context) => String(getContextSessions()[context] || '');

export const setCurrentPracticeSession = (sessionId, context = '') => {
  const nextSessionId = String(sessionId || '');
  getApp().globalData.practiceSessionId = nextSessionId;
  if (nextSessionId) wx.setStorageSync(SESSION_KEY, nextSessionId);
  else wx.removeStorageSync(SESSION_KEY);

  if (context) {
    const sessions = getContextSessions();
    const previousSessionId = String(sessions[context] || '');
    if (previousSessionId && previousSessionId !== nextSessionId) removeLocalProgress(previousSessionId);
    if (nextSessionId) sessions[context] = nextSessionId;
    else delete sessions[context];
    saveContextSessions(sessions);
  }
};

export const clearPracticeSessionContext = (context, expectedSessionId = '') => {
  const sessions = getContextSessions();
  const sessionId = String(sessions[context] || '');
  if (expectedSessionId && sessionId && sessionId !== expectedSessionId) return false;
  if (!sessionId) return true;

  delete sessions[context];
  saveContextSessions(sessions);
  removeLocalProgress(sessionId);
  if (getCurrentPracticeSessionId() === sessionId) {
    getApp().globalData.practiceSessionId = '';
    wx.removeStorageSync(SESSION_KEY);
  }
  return true;
};

export const clearAllPracticeSessions = () => {
  const sessionIds = new Set([getCurrentPracticeSessionId(), ...Object.values(getContextSessions())].filter(Boolean));
  sessionIds.forEach(removeLocalProgress);
  getApp().globalData.practiceSessionId = '';
  wx.removeStorageSync(SESSION_KEY);
  wx.removeStorageSync(CONTEXT_SESSIONS_KEY);
};

export const clearCurrentPracticeSession = (expectedSessionId = '') => {
  const currentSessionId = getCurrentPracticeSessionId();
  if (expectedSessionId && currentSessionId && currentSessionId !== expectedSessionId) return false;
  const sessionId = expectedSessionId || currentSessionId;
  removeLocalProgress(sessionId);
  getApp().globalData.practiceSessionId = '';
  wx.removeStorageSync(SESSION_KEY);
  if (sessionId) {
    const sessions = getContextSessions();
    Object.keys(sessions).forEach((context) => {
      if (String(sessions[context]) === sessionId) delete sessions[context];
    });
    saveContextSessions(sessions);
  }
  return true;
};

const SHARE_TITLE = '学霸省题｜拍照收录, AI解析 · 语义搜索 · 智能推荐';

export const enableShareMenu = () => {
  if (typeof wx.showShareMenu !== 'function') return;
  wx.showShareMenu({
    withShareTicket: true,
    menus: ['shareAppMessage', 'shareTimeline'],
    fail: (error) => console.warn('分享菜单开启失败', error)
  });
};

// 个人题库和学习数据不放入转发链接，好友统一从可公开访问的首页进入。
export const appShareMessage = () => ({
  title: SHARE_TITLE,
  path: '/pages/home/index?from=share'
});

export const timelineShareMessage = () => ({
  title: SHARE_TITLE,
  query: 'from=timeline'
});

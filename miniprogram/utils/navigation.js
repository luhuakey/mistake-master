export const getNavigationLayout = (size) => {
  const runtimeWindowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const windowInfo = { ...runtimeWindowInfo, ...(size || {}) };
  const menuRect = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
  const statusBarHeight = Number(windowInfo.statusBarHeight) || 20;
  const windowWidth = Number(windowInfo.windowWidth || windowInfo.screenWidth) || 375;
  const hasMenuRect = Boolean(menuRect?.top && menuRect?.height && menuRect?.left);
  const navHeight = hasMenuRect
    ? Math.max(44, (menuRect.top - statusBarHeight) * 2 + menuRect.height)
    : 44;
  const actionRight = hasMenuRect
    ? Math.max(16, windowWidth - menuRect.left + 8)
    : 16;

  return {
    shellStyle: `padding-top:${statusBarHeight}px;`,
    barStyle: `height:${navHeight}px;`,
    headerStyle: `padding-top:${statusBarHeight}px;height:${navHeight}px;`,
    actionStyle: `right:${actionRight}px;`,
    stickyTopStyle: `top:${statusBarHeight + navHeight}px;`
  };
};

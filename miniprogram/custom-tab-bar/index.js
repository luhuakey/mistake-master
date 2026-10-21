import { isLoggedIn, promptLogin } from '../utils/auth';

Component({
  data: {
    hidden: false,
    selected: 0,
    items: [
      { text: '首页', icon: 'home', url: '/pages/home/index' },
      { text: '题库', icon: 'library', url: '/pages/question-list/index' },
      { text: '练习', icon: 'practice', url: '/pages/practice/index' },
      { text: '我的', icon: 'profile', url: '/pages/profile/index' }
    ]
  },

  methods: {
    setSelected(selected) { this.setData({ selected, hidden: false }); },
    onTap(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (index === 2) {
        if (!isLoggedIn()) {
          promptLogin('登录后可使用个性化练习，你也可先继续浏览首页和题库。');
          return;
        }
        getApp().globalData.pendingPracticeEntry = { mode: 'comprehensive', subject: 'all' };
        wx.switchTab({ url: '/pages/practice/index' });
        return;
      }
      if (index === 1) getApp().globalData.libraryReturnTab = '/pages/home/index';
      wx.switchTab({ url: this.data.items[index].url });
    }
  }
});

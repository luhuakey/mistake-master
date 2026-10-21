import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError, assert, unauthorized } from '../shared/errors.js';
import { id, nowIso } from '../shared/utils.js';

export class AuthService {
  constructor(store, config = env) {
    this.store = store;
    this.config = config;
  }

  async exchangeCode(code) {
    assert(code, 'LOGIN_CODE_REQUIRED', '缺少微信登录凭证');
    if (this.config.mockExternalServices) return { openid: `mock_${code}` };
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', this.config.wechatAppId);
    url.searchParams.set('secret', this.config.wechatAppSecret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    const response = await fetch(url);
    const result = await response.json();
    if (!response.ok || result.errcode || !result.openid) {
      throw new AppError('WECHAT_LOGIN_FAILED', '微信登录失败，请重试', 502, result.errmsg);
    }
    return result;
  }

  async login(code, consent = {}, wechatProfile = {}) {
    assert(
      consent.agreementConsent === true && consent.privacyConsent === true,
      'PRIVACY_CONSENT_REQUIRED',
      '请先阅读并主动同意用户服务协议和隐私政策'
    );
    assert(consent.consentVersion, 'CONSENT_VERSION_REQUIRED', '缺少协议版本');
    const wechatNickname = [...String(wechatProfile?.nickname || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()].slice(0, 20).join('');
    const rawAvatarUrl = String(wechatProfile?.avatar_url || '').trim();
    const wechatAvatarUrl = /^https:\/\//i.test(rawAvatarUrl) ? rawAvatarUrl : '';
    const session = await this.exchangeCode(code);
    let user = (await this.store.find('users', { where: { openid: session.openid }, limit: 1 }))[0];
    const isNew = !user;
    const consentAt = nowIso();
    if (!user) {
      const createdAt = consentAt;
      user = {
        _id: id('usr'),
        openid: session.openid,
        nickname: wechatNickname || '学霸同学',
        avatar_url: wechatAvatarUrl,
        avatar_file_id: '',
        preferred_subject: 'math',
        notification_enabled: false,
        reminder_time: '20:00',
        reminder_frequency: 'daily',
        recommendation_weak_first: true,
        recommendation_difficulty: 'adaptive',
        practice_question_limit: 10,
        mastered_question_ratio: 20,
        agreement_consent_version: consent.consentVersion,
        privacy_consent_version: consent.consentVersion,
        consented_at: consentAt,
        created_at: createdAt,
        updated_at: createdAt
      };
      await this.store.put('users', user);
    } else {
      user = {
        ...user,
        ...((!user.nickname || user.nickname === '学霸同学') && wechatNickname ? { nickname: wechatNickname } : {}),
        ...(!user.avatar_url && !user.avatar_file_id && wechatAvatarUrl ? { avatar_url: wechatAvatarUrl } : {}),
        agreement_consent_version: consent.consentVersion,
        privacy_consent_version: consent.consentVersion,
        consented_at: consentAt,
        updated_at: consentAt
      };
      await this.store.put('users', user);
    }
    const token = jwt.sign({ sub: user._id }, this.config.sessionSecret, { expiresIn: '30d' });
    return { token, user: this.publicUser(user), is_new: isNew };
  }

  verify(token) {
    try {
      return jwt.verify(token, this.config.sessionSecret);
    } catch {
      throw new AppError('AUTH_REQUIRED', '登录状态已失效，请重新登录', 401);
    }
  }

  async authenticate(token) {
    const payload = this.verify(token);
    const user = await this.store.get('users', payload.sub);
    if (!user) throw unauthorized();
    return user;
  }

  publicUser(user) {
    return {
      id: user._id,
      nickname: user.nickname,
      avatar_url: user.avatar_url,
      preferred_subject: user.preferred_subject
    };
  }
}

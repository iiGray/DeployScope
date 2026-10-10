import { escapeHtml as esc } from './app-state.mjs';
export function createSessionEpoch() {
  let epoch = 0;
  return { current: () => epoch, advance: () => ++epoch, isCurrent: captured => epoch === captured };
}
export function renderLogin(message = '') {
  return `<main class="login-page"><form class="login-card" id="team-login"><h1>DeployScope</h1><p>团队共享推理部署</p><label>网页访问口令<input id="team-password" type="password" autocomplete="current-password" required aria-label="网页访问口令"/></label><p class="login-error" role="alert">${esc(message)}</p><button class="button primary" type="submit">登录</button><small>每个浏览器独立操作 · 部署服务共同可见</small></form></main>`;
}

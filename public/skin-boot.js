/*
 * G6（docs/40，docs/42 §5.1-6）：首帧皮肤预置，消除浅色闪白（FOUC）。
 *
 * 必须是独立静态文件（经典脚本、同步执行），不能内联进 index.html：生产 CSP
 * `script-src 'self'`（public/_headers、worker/http.ts）会拦截内联脚本，dev 通过、
 * 生产静默失效。本文件由 index.html head 以 `%BASE_URL%skin-boot.js` 引入。
 *
 * 逻辑与 skin/prefs.ts 的读取口径一致：只做宽松白名单校验，解析失败/存储不可用
 * 一律保持默认皮肤（不抛错阻塞首帧）。白名单变更须同步 SKIN_IDS——
 * src/test/bootstrapSecurity.test.ts 会互锁。
 */
;(function () {
  try {
    var prefs = JSON.parse(localStorage.getItem('skin.prefs.v1') || '{}')
    var skinId = prefs.skinId
    if (['dream', 'violet', 'liuhua'].indexOf(skinId) >= 0) {
      document.documentElement.dataset.skin = skinId
    }
  } catch (e) {
    /* 损坏的 localStorage / 隐私模式：保持默认皮肤 */
  }
})()

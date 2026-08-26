const LINK = 'https://github.com/BingLi37/Welfare-Express/blob/main/articles/2026-08-16-six-free-ai-sites.zh.md';
const IMG = '/images/promo-card.jpg';

const CSS = `
.pc-wrap{position:fixed;right:24px;bottom:24px;z-index:9999;width:300px;
  background:#0d1117;border:1px solid #4b4b4b;border-radius:16px;
  padding:12px;box-shadow:0 16px 48px rgba(0,0,0,.6);
  font-family:'iA Writer Quattro S','IBM Plex Sans',system-ui,sans-serif;
  animation:pc-in .62s cubic-bezier(.22,1.28,.36,1) both}
/* y2 > 1 让曲线在末段过冲再回落，是那点"弹"的来源；纯 ease-out 不会有。 */
@keyframes pc-in{
  0%{opacity:0;transform:translateY(72px) scale(.94)}
  55%{opacity:1}
  100%{opacity:1;transform:translateY(0) scale(1)}}
/* 内部元素依次跟进，卡片落位后内容才浮上来，比整体一起滑更有层次。 */
.pc-media,.pc-body>*{animation:pc-rise .5s cubic-bezier(.16,1,.3,1) both}
.pc-title{animation-delay:.17s}
.pc-desc{animation-delay:.23s}
.pc-cta{animation-delay:.29s}
@keyframes pc-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
/* 必须整块置为 none：pc-rise 的 0% 是 opacity:0 且带 both，
   只去掉时长而留下 fill-mode 会让元素永久停在透明状态。 */
@media (prefers-reduced-motion:reduce){
  .pc-wrap,.pc-media,.pc-body>*{animation:none}}
.pc-media{position:relative;border-radius:10px;overflow:hidden;aspect-ratio:1/1;
  background:#161b22;animation-delay:.10s}
.pc-media img{width:100%;height:100%;object-fit:cover;display:block}
.pc-x{position:absolute;top:8px;right:8px;width:26px;height:26px;
  border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;
  font-size:15px;line-height:1;cursor:pointer;backdrop-filter:blur(4px);
  display:flex;align-items:center;justify-content:center;padding:0}
.pc-x:hover{background:rgba(0,0,0,.8)}
.pc-body{padding:14px 4px 4px}
.pc-title{margin:0 0 6px;font-size:15px;font-weight:700;color:#f0f6fc}
.pc-desc{margin:0 0 14px;font-size:12.5px;line-height:1.55;color:#8b949e}
.pc-cta{display:block;width:100%;padding:10px 0;border-radius:9px;
  background:#f0f6fc;color:#0d1117;font-size:13px;font-weight:600;
  text-align:center;text-decoration:none;transition:opacity .15s}
.pc-cta:hover{opacity:.85}
`;

function mount() {
  if (document.querySelector('.pc-wrap')) return;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.className = 'pc-wrap';
  el.innerHTML = `
    <div class="pc-media">
      <img src="${IMG}" alt="">
      <button class="pc-x" type="button" aria-label="关闭">✕</button>
    </div>
    <div class="pc-body">
      <h3 class="pc-title">免费蹬claude和gpt顶级模型，公益站!</h3>
      <p class="pc-desc">整理了 6 个不用付费就能用的 AI 站点，包含各自的实际限制和适用场景。</p>
      <a class="pc-cta" href="${LINK}" target="_blank" rel="noopener">立即查看 →</a>
    </div>
  `;

  el.querySelector('.pc-x').addEventListener('click', () => {
    el.remove();
  });

  document.body.appendChild(el);
}

// 关闭不做任何持久化：只移除当前页面上的节点，每次重新加载都会重新弹出。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}

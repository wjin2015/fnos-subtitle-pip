(() => {
  "use strict";

  // FNOS Subtitle PiP 0.4.0
  //
  // Edge 适配说明（已在 Edge 155 实测）：
  // Document Picture-in-Picture API 带 [SecureContext] 限制，仅在 HTTPS / localhost 下暴露。
  // 飞牛影视通常以 http://局域网IP 访问，此时 window.documentPictureInPicture 完全不存在
  // （与Edge 版本无关，Edge 116+ 均支持该 API），旧版本因此误报"请更新 Edge"。
  //
  // 现在提供两条路径，自动选择：
  //   A. 文档画中画（documentPictureInPicture）：安全上下文下可用。
  //      字幕是画中画窗口内的 DOM 层，播放控件也放在画中画窗口里。
  //   B. 视频画中画（canvas 字幕合成 + video.requestPictureInPicture）：
  //      HTTP 页面同样可用。字幕按源页面样式直接绘制进视频帧，
  //      声音保留在原页面播放器输出，画中画视频本身静音。
  //      A 失败（如无用户激活、Firefox 隔离世界限制）时也会自动降级到 B。
  //
  // 0.3.0 起的行为变化：
  //   - 页面内不再注入"字幕画中画"按钮；统一由 background.js 转发
  //     工具栏图标点击与快捷键 Alt+P 触发（见 manifest.json 的 commands）。
  //   - 画中画期间原页面视频隐藏（opacity:0，仍继续解码出声），退出后恢复默认显示。
  //   - 字幕大小可在画中画内调整（0.5x–2.5x，持久化到 chrome.storage.local）。
  //
  // 0.3.1 修复：
  //   画中画窗口持焦时按 Alt+P 无法关闭画中画。根因不在快捷键本身
  //   （chrome.commands 仍会派发），而在 background 的标签页路由：
  //   画中画窗口是独立浏览器窗口，tabs.query({active,currentWindow})
  //   此时返回的是画中画自己的 about:blank 标签页。现改为由 background 记住
  //   承载画中画的标签页 id 并直接投递（见 background.js）。
  //
  // 0.4.0 新增：
  //   - 快进 / 快退：单击 ±10 秒，长按连续快进（每 100ms 1 秒）。
  //   - 连播支持：上一集 / 下一集 / 选集。剧集列表从播放器页面启发式识别
  //     （常见容器选择器优先，按父级与 class 聚合"第N集"形式的可见项兜底），
  //     切换时直接点击页面自身的剧集项，交由播放器完成换集。
  //   - 切换剧集后播放器可能重建 video 元素：两种模式的循环都会检测并重新绑定
  //     （模式 A 重新 captureStream，模式 B 重新调整画布），否则画中画会黑屏。
  //   - MediaSession 重新映射：seekbackward/seekforward = 快退/快进，
  //     previoustrack/nexttrack = 上一集/下一集（此前被借去调字幕大小，
  //     字幕大小现在只保留在工具条/控制面板按钮上）。

  if (window.__fnosSubtitlePipInstalled) return;
  window.__fnosSubtitlePipInstalled = true;

  const SUBTITLE_SELECTOR = "#trim-ui__player-subtitle-mount-point-wrapper";

  // ---- 全局状态 ----
  let mode = null;            // "document" | "canvas" | null
  let starting = false;
  let cleaningUp = false;
  let pendingSwitch = null;   // "document"：退出视频画中画后切换到文档画中画

  let pipWindow = null;       // 模式 A：文档画中画窗口
  let pipVideo = null;        // 两种模式各自的画中画 video 元素
  let subtitleLayer = null;   // 模式 A：画中画窗口内的字幕层
  let statusNode = null;      // 模式 A：画中画窗口内的状态条
  let sourceVideo = null;
  let sourceStream = null;    // 源视频捕获流
  let canvasStream = null;    // 模式 B：canvas 合成流
  let canvas = null;          // 模式 B：合成画布
  let canvasCtx = null;
  let panel = null;           // 模式 B：页面上的控制面板
  let panelStyleInjected = false;

  let subtitleScale = 1;          // 字幕大小倍率（0.5–2.5），持久化到 chrome.storage
  let hiddenVideoOpacity = null;  // 画中画期间原页面视频被隐藏前的 opacity 值

  // ---- 播放控制 / 选集 ----
  let seekHoldTimer = 0;          // 长按快进快退的连续跳转定时器
  let videoEventsAbort = null;    // 源视频事件监听（换集后整体重绑）
  let lastSourceVideo = null;     // 用于检测播放器重建了 video 元素
  // ---- 连播 ----
  let autoNextTimer = 0;          // ended 后等待页面自行连播的宽限定时器
  // 页面没有自动连播时，由扩展兜底切下一集的宽限时间。
  // 取值要大于正常播放器「ended → 换源/重建 → 起播」的耗时，又不足以让用户明显等待。
  const AUTO_NEXT_DELAY = 1200;

  let subtitleRoot = null;
  let observer = null;
  let rafId = 0;
  let timerId = 0;
  let syncTimerId = 0;            // 模式 A：画中画窗口持焦时原标签页进后台，rAF 暂停，用定时器兜底
  let controlsTimer = 0;
  let lastDrawTime = 0;
  let lastCacheRefresh = 0;

  // 字幕缓存：MutationObserver / 定时刷新写入，绘制循环只读缓存
  const subtitleCache = { text: "", style: null };

  const styleText = `
    #fnos-pip-panel {
      position: fixed; right: 18px; top: 18px; z-index: 2147483646;
      border: 1px solid rgba(255,255,255,.24); border-radius: 9px;
      padding: 10px 12px; color: #fff; background: #202124;
      box-shadow: 0 3px 14px rgba(0,0,0,.35); font: 12px/1.4 system-ui,sans-serif;
      min-width: 158px;
    }
    #fnos-pip-panel .fnos-pip-row { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
    #fnos-pip-panel button {
      color: #fff; background: rgba(60,60,62,.95); border: 1px solid #777;
      border-radius: 5px; padding: 4px 8px; font: 12px system-ui,sans-serif; cursor: pointer;
    }
    #fnos-pip-panel button:hover { background: #3c4043; }
    #fnos-pip-panel .fnos-pip-time { font: 11px ui-monospace,monospace; color: #bbb; }
    #fnos-pip-panel .fnos-pip-mode { margin-top: 4px; color: #9aa0a6; font-size: 11px; }
    #fnos-pip-panel .fnos-pip-sub { margin-top: 2px; color: #e8eaed; font-size: 11px;
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #fnos-pip-panel .fnos-pip-scale { align-self: center; color: #bbb; font-size: 11px; }
    #fnos-pip-panel button:active { background: #2b6cb0; border-color: #2b6cb0; }
    #fnos-pip-panel [data-act="backward"], #fnos-pip-panel [data-act="forward"] {
      min-width: 44px; font-variant-numeric: tabular-nums; }
    #fnos-pip-panel [data-role="hint"] { margin-top: 2px; color: #ffd166; font-size: 11px; }
    #fnos-pip-panel [data-role="hint"][hidden] { display: none; }

    /* 选集浮层（模式 B，挂在页面上） */
    #fnos-pip-episodes {
      position: fixed; right: 18px; top: 62px; z-index: 2147483646; width: 280px;
      max-height: 60vh; overflow: auto; padding: 10px; color: #fff; background: #202124;
      border: 1px solid rgba(255,255,255,.24); border-radius: 9px;
      box-shadow: 0 3px 14px rgba(0,0,0,.35); font: 12px/1.4 system-ui,sans-serif;
    }
    #fnos-pip-episodes[hidden] { display: none; }
    #fnos-pip-episodes .fnos-pip-ep-head { display: flex; align-items: center;
      justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
    #fnos-pip-episodes .fnos-pip-ep-head button { padding: 3px 8px; }
    #fnos-pip-episodes-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 6px; }
    #fnos-pip-episodes-grid button { padding: 7px 4px; text-align: center; }
    #fnos-pip-episodes-grid button.is-active { background: #2b6cb0; border-color: #4b9cff; font-weight: 600; }
    #fnos-pip-episodes .fnos-pip-ep-empty { color: #bbb; padding: 8px 2px; }
  `;

  // ---- 入口：只响应 background.js 转发的图标点击 / Alt+P 快捷键 ----
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== "fnos-subtitle-pip-toggle") return;
      toggleFromUser();
      // 告知后台画中画是否处于开启状态，供其记住正确的标签页 id
      sendResponse({ pipTabActive: !!mode || starting });
      return true;
    });
  } catch (_) {}

  function toggleFromUser() {
    if (starting) return;
    if (mode) {
      cleanup();
      return;
    }
    startPiP().catch(showError);
  }

  loadSubtitleScale();

  function findVideo() {
    const videos = [...document.querySelectorAll("video")];
    const visible = videos.filter(v => {
      const r = v.getBoundingClientRect();
      const s = getComputedStyle(v);
      return r.width > 180 && r.height > 100 && s.display !== "none" &&
        s.visibility !== "hidden" && Number(s.opacity || 1) > 0;
    });
    // Prefer a video within XGPlayer, then the largest visible video.
    visible.sort((a, b) => {
      const ax = a.closest(".xgplayer") ? 1 : 0;
      const bx = b.closest(".xgplayer") ? 1 : 0;
      if (ax !== bx) return bx - ax;
      return (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight);
    });
    return visible[0] || null;
  }

  function getSubtitleRoot() {
    return document.querySelector(SUBTITLE_SELECTOR);
  }

  function readSubtitleText(root) {
    if (!root) return "";
    // The screenshot shows the mount point can contain modal/control UI too.
    // Exclude hidden nodes and common player controls, then choose visible text nodes.
    const candidates = [...root.querySelectorAll("*")].filter(el => {
      if (!el.children.length) {
        const text = (el.textContent || "").trim();
        if (!text) return false;
        if (el.closest("button,[role=button],input,textarea,select")) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 &&
          s.display !== "none" && s.visibility !== "hidden" &&
          Number(s.opacity || 1) > 0;
      }
      return false;
    });

    if (!candidates.length) return "";
    // Prefer text nodes near the lower part of the player, which is where subtitles appear.
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      const aScore = ar.top + ar.height / 2;
      const bScore = br.top + br.height / 2;
      return bScore - aScore;
    });
    // Usually there is one subtitle text leaf; combine if the subtitle uses multiple spans.
    const texts = [];
    for (const el of candidates) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !texts.includes(t)) texts.push(t);
    }
    return texts.slice(0, 3).join(" ");
  }

  function getSubtitleStyle(root) {
    if (!root) return null;
    const leaves = [...root.querySelectorAll("*")].filter(el => {
      if (el.children.length || !(el.textContent || "").trim()) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    leaves.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const el = leaves[0];
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      color: cs.color || "#fff",
      fontFamily: cs.fontFamily || "Arial, sans-serif",
      fontSize: cs.fontSize || "28px",
      fontWeight: cs.fontWeight || "600",
      textShadow: cs.textShadow && cs.textShadow !== "none"
        ? cs.textShadow
        : "0 2px 3px #000, 1px 1px 4px #000",
      backgroundColor: cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)"
        ? cs.backgroundColor : null,
      textAlign: cs.textAlign || "center"
    };
  }

  // ---- 字幕大小倍率（两种模式共用，持久化）----
  function clampScale(v) {
    return Math.round(Math.min(2.5, Math.max(0.5, v)) * 10) / 10;
  }

  function loadSubtitleScale() {
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get("subtitleScale", (res) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (res && typeof res.subtitleScale === "number") {
          subtitleScale = clampScale(res.subtitleScale);
          updateSubtitleScaleUI();
          if (mode === "document") updateSubtitleStyle();
        }
      });
    } catch (_) {}
  }

  function saveSubtitleScale() {
    try {
      if (chrome.storage && chrome.storage.local) chrome.storage.local.set({ subtitleScale });
    } catch (_) {}
  }

  function adjustSubtitleScale(delta) {
    subtitleScale = clampScale(subtitleScale + delta);
    saveSubtitleScale();
    updateSubtitleScaleUI();
    if (mode === "document") updateSubtitleStyle();
    // 模式 B 的绘制循环下一帧自动应用新倍率
  }

  function updateSubtitleScaleUI() {
    const label = "字幕 " + Math.round(subtitleScale * 100) + "%";
    if (panel) {
      const n = panel.querySelector('[data-role="scale"]');
      if (n) n.textContent = label;
    }
    if (pipWindow && pipWindow.document) {
      const n = pipWindow.document.getElementById("sub-scale");
      if (n) n.textContent = Math.round(subtitleScale * 100) + "%";
    }
  }

  // ---- 原页面视频显隐（画中画期间隐藏画面，退出后恢复默认）----
  function hideSourceVideo() {
    if (!sourceVideo || hiddenVideoOpacity !== null) return;
    hiddenVideoOpacity = sourceVideo.style.opacity;
    sourceVideo.style.opacity = "0";
  }

  function restoreSourceVideo() {
    if (!sourceVideo || hiddenVideoOpacity === null) return;
    sourceVideo.style.opacity = hiddenVideoOpacity;
    hiddenVideoOpacity = null;
  }

  // ---- 播放控制：快进 / 快退 ----
  const SEEK_STEP = 10;           // 单击快进快退的秒数
  const SEEK_HOLD_STEP = 1;       // 长按时每次跳转的秒数
  const SEEK_HOLD_INTERVAL = 100; // 长按跳转间隔（ms）

  function liveVideo() {
    return sourceVideo && sourceVideo.isConnected ? sourceVideo : null;
  }

  // ---- 播放 / 暂停：统一入口 ----
  // 播放失败不能静默：play() 被浏览器自动播放策略拒绝时 Promise 会 reject，
  // 直接 .catch(() => {}) 吞掉的话按钮看起来「点了没反应」，用户完全无法判断原因。
  function resumeVideo() {
    const v = liveVideo();
    if (!v || !v.paused) return;
    v.play().catch((e) => {
      showHint("无法播放：" + ((e && e.name) || "未知错误") +
        "（浏览器自动播放限制，请回页面点击一次播放器后再试）");
    });
  }

  function pauseVideo() {
    const v = liveVideo();
    if (v && !v.paused) v.pause();
  }

  // 模式 B：画中画里的 video 元素（pv）只是 canvas 流的载体，它自身的播放/暂停状态
  // 必须与源视频保持一致，否则两端状态会漂移：
  //   - 源视频被暂停（面板/快捷键/播完）而 pv 仍在播放 → 用户点画中画自带的「播放」时，
  //     pv.play() 对已在播放的元素不会再次派发 play 事件，恢复源视频的监听器根本不执行；
  //   - pv 被暂停（用户点过自带按钮）而源视频又恢复 → pv 停在暂停态，画中画画面直接冻住。
  // 由源视频的 play/pause/ended 单向驱动 pv，pv 自身的处理器只负责反向通知，不会成环。
  function syncPiPPlayback() {
    if (mode !== "canvas" || !pipVideo || !sourceVideo) return;
    try {
      if (sourceVideo.paused) {
        if (!pipVideo.paused) pipVideo.pause();
      } else if (pipVideo.paused) {
        pipVideo.play().catch(() => {});
      }
    } catch (_) {}
  }

  function seekBy(delta) {
    const v = liveVideo();
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return false;
    v.currentTime = Math.min(v.duration - 0.05, Math.max(0, v.currentTime + delta));
    return true;
  }

  // 长按连续快进：按下立即先跳一次，之后每 100ms 跳 1 秒，抬起/取消即停
  function startSeekHold(delta) {
    stopSeekHold();
    if (!seekBy(delta)) return false;
    seekHoldTimer = setInterval(() => { if (!seekBy(delta)) stopSeekHold(); }, SEEK_HOLD_INTERVAL);
    return true;
  }

  function stopSeekHold() {
    if (seekHoldTimer) { clearInterval(seekHoldTimer); seekHoldTimer = 0; }
  }

  function bindSeekHold(el, delta) {
    if (!el) return;
    // 单击与长按共用同一套 pointer 事件：pointerdown 立即跳一次并启动连续跳转，
    // 之后的 click 若已由长按"消费"过就跳过，避免长按结束后再多跳一次
    let consumed = false;
    el.addEventListener("click", () => {
      if (consumed) { consumed = false; return; }
      if (!seekBy(delta)) hintNoSeek();
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      consumed = false;
      if (startSeekHold(delta)) { consumed = true; e.preventDefault(); }
    });
    el.addEventListener("pointerup", stopSeekHold);
    el.addEventListener("pointerleave", stopSeekHold);
    el.addEventListener("pointercancel", stopSeekHold);
    // 键盘触发（Tab 聚焦后回车/空格）不产生 pointer 事件，只走 click 分支跳一次
  }

  // ---- 剧集识别 ----
  // 剧集项文本：纯数字、"第12集"、"第 3 话"，以及 END/预告等常见标记
  const EPISODE_LABEL_RE = /^(?:\d{1,4}|第\s*\d+\s*[集话期話]?|END|ed|预告|片头|片尾|彩蛋|花絮)$/i;

  function isVisibleEl(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity || 1) > 0;
  }

  function classNameOf(el) {
    return el && typeof el.className === "string" ? el.className : "";
  }

  function findEpisodeItems() {
    if (!document || !document.body) return [];
    // 1) 常见剧集容器优先：命中后取容器内可见的列表项
    const containerSel = [
      "[class*=episode]", "[class*=anthology]", "[class*=juji]",
      "[class*=playlist]", "[class*=series]", "[class*=film-list]", "[class*=num-list]"
    ].join(",");
    const containers = [...document.querySelectorAll(containerSel)].filter(isVisibleEl);
    // 先小容器后大容器，避免外层容器把整页列表都吃进来
    containers.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
    for (const c of containers) {
      const items = [...c.querySelectorAll("li,button,a,[role=button],[class*=item],[class*=num]")]
        .filter(el => isVisibleEl(el) && !el.querySelector("li,button,a,[role=button]") &&
          EPISODE_LABEL_RE.test((el.textContent || "").trim()));
      if (items.length >= 2) return items;
    }
    // 2) 兜底：文本像剧集号的可见项，按「父级 + class」聚成组，取最大的一组
    const groups = new Map();
    for (const el of document.querySelectorAll("li,button,a,[role=button],[class*=item],[class*=num]")) {
      if (!isVisibleEl(el) || el.querySelector("li,button,a,[role=button]")) continue;
      const text = (el.textContent || "").trim();
      if (!EPISODE_LABEL_RE.test(text)) continue;
      const parent = el.parentElement;
      if (!parent) continue;
      const key = parent.tagName + "|" + classNameOf(el);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    }
    let best = null;
    for (const list of groups.values()) {
      if (list.length >= 2 && (!best || list.length > best.length)) best = list;
    }
    return best || [];
  }

  // 当前集判定：元素自身或其 li 父级带 active/current/selected 类，或带 aria 选中标记
  function findActiveEpisodeIndex(items) {
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) return i;
      const targets = [el, el.parentElement, el.closest("li")];
      if (targets.some(t => /(^|[\s_-])(active|current|playing|selected|cur)([\s_-]|$)/i.test(classNameOf(t)))) return i;
    }
    return -1;
  }

  // 切换到指定集（index 为 findEpisodeItems 结果中的下标），点击页面自身的剧集项
  function switchEpisodeIndex(index) {
    const items = findEpisodeItems();
    if (items.length < 2) return { ok: false, reason: "no-episodes" };
    if (index < 0 || index >= items.length) return { ok: false, reason: "out-of-range" };
    const el = items[index];
    try { el.click(); } catch (_) {
      return { ok: false, reason: "click-failed" };
    }
    return { ok: true, index, total: items.length };
  }

  function switchEpisode(delta) {
    const items = findEpisodeItems();
    if (items.length < 2) return { ok: false, reason: "no-episodes" };
    const current = findActiveEpisodeIndex(items);
    if (current < 0) return { ok: false, reason: "no-active" };
    return switchEpisodeIndex(current + delta);
  }

  // 画中画期间的临时提示（模式 A 走画中画窗口状态条，模式 B 走页面面板提示）
  let hintTimer = 0;
  function showHint(text) {
    if (mode === "document" && statusNode) {
      statusNode.textContent = text;
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { if (mode === "document") refreshSubtitle(); }, 2600);
      return;
    }
    if (panel) {
      const hint = panel.querySelector('[data-role="hint"]');
      if (hint) {
        hint.textContent = text;
        hint.hidden = false;
        if (hintTimer) clearTimeout(hintTimer);
        hintTimer = setTimeout(() => {
          if (hint) { hint.textContent = ""; hint.hidden = true; }
        }, 2600);
      }
    }
  }

  function hintNoSeek() { showHint("无法快进/快退：视频时长未知或已失效"); }
  function hintNoEpisodes() { showHint("未识别到剧集列表（可能不是连播内容）"); }

  // ---- MediaSession：画中画窗口/键盘媒体键的播放控制 ----
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const safe = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {} };
    safe("play", () => resumeVideo());
    safe("pause", () => pauseVideo());
    safe("seekbackward", () => { if (!seekBy(-SEEK_STEP)) hintNoSeek(); });
    safe("seekforward", () => { if (!seekBy(SEEK_STEP)) hintNoSeek(); });
    safe("previoustrack", () => { const r = switchEpisode(-1); if (!r.ok) hintNoEpisodes(); });
    safe("nexttrack", () => { const r = switchEpisode(1); if (!r.ok) hintNoEpisodes(); });
  }

  function teardownMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const actions = ["play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack"];
    for (const a of actions) {
      try { navigator.mediaSession.setActionHandler(a, null); } catch (_) {}
    }
  }

  // ---- 字幕缓存刷新（两种模式共用）----
  function refreshSubtitle() {
    lastCacheRefresh = performance.now();
    // 播放器可能整体重渲染导致挂载点被替换，这里自动重新挂载观察器
    if (!subtitleRoot || !subtitleRoot.isConnected) {
      if (observer) { observer.disconnect(); observer = null; }
      subtitleRoot = getSubtitleRoot();
    }
    if (subtitleRoot && !observer) {
      observer = new MutationObserver(() => refreshSubtitle());
      observer.observe(subtitleRoot, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    subtitleCache.text = readSubtitleText(subtitleRoot);
    subtitleCache.style = getSubtitleStyle(subtitleRoot);
    if (mode === "document") applySubtitleToLayer();
  }

  // ==================== 模式 A：文档画中画 ====================

  function buildPiPDocument() {
    const doc = pipWindow.document;
    doc.documentElement.style.cssText = "height:100%;background:#000;margin:0;";
    doc.body.style.cssText = [
      "margin:0", "height:100%", "width:100%", "overflow:hidden",
      "background:#000", "color:#fff", "font-family:system-ui,sans-serif"
    ].join(";");

    const css = doc.createElement("style");
    css.textContent = `
      * { box-sizing: border-box; }
      #stage { position:relative; width:100%; height:100%; background:#000; overflow:hidden; }
      #video { display:block; width:100%; height:100%; object-fit:contain; background:#000; }
      #subtitle {
        position:absolute; left:4%; right:4%; bottom:8%;
        color:#fff; text-align:center; white-space:pre-wrap; overflow-wrap:anywhere;
        font:600 26px/1.35 Arial,sans-serif;
        text-shadow:0 2px 3px #000,1px 1px 4px #000;
        pointer-events:none; padding:0 2%; z-index:5;
      }
      #status {
        position:absolute; left:8px; top:8px; z-index:10; font-size:12px;
        color:#ddd; background:rgba(0,0,0,.55); padding:4px 6px; border-radius:4px;
        max-width:90%; pointer-events:none;
      }
      #toolbar {
        position:absolute; left:0; right:0; bottom:0; z-index:20;
        display:flex; flex-direction:column; gap:6px; padding:8px;
        background:linear-gradient(transparent,rgba(0,0,0,.88));
        opacity:0; transition:opacity .18s ease;
      }
      #stage:hover #toolbar, #toolbar:focus-within { opacity:1; }
      .fnos-pip-bar { display:flex; gap:7px; align-items:center; flex-wrap:wrap; }
      button, select { color:#fff; background:rgba(40,40,40,.92); border:1px solid #777;
        border-radius:5px; padding:5px 7px; font:12px system-ui,sans-serif; }
      button { cursor:pointer; white-space:nowrap; }
      button:active { background:#2b6cb0; border-color:#2b6cb0; }
      input[type=range] { min-width:20px; flex:1; accent-color:#4b9cff; }
      #time { white-space:nowrap; font:11px ui-monospace,monospace; }
      #volume { max-width:70px; }
      #backward, #forward { min-width:44px; font-variant-numeric:tabular-nums; }
      @media (max-width:420px) { #volume { display:none; } #time { font-size:10px; }

      /* 选集浮层 */
      #episodes-layer {
        position:absolute; left:0; right:0; bottom:0; top:0; z-index:30;
        display:flex; flex-direction:column; background:rgba(0,0,0,.92);
        padding:10px; overflow:auto;
      }
      #episodes-layer[hidden] { display:none; }
      .fnos-pip-ep-head {
        display:flex; align-items:center; justify-content:space-between;
        margin-bottom:8px; font-size:13px; color:#fff;
      }
      .fnos-pip-ep-head button { padding:3px 8px; }
      #episodes-grid {
        display:grid; grid-template-columns:repeat(auto-fill,minmax(52px,1fr));
        gap:6px; align-content:start;
      }
      #episodes-grid button { padding:7px 4px; text-align:center; }
      #episodes-grid button.is-active { background:#2b6cb0; border-color:#4b9cff; font-weight:600; }
      .fnos-pip-ep-empty { color:#bbb; font-size:12px; padding:8px 2px; }
    `;
    doc.head.appendChild(css);

    const stage = doc.createElement("div");
    stage.id = "stage";
    stage.innerHTML = `
      <video id="video" autoplay playsinline></video>
      <div id="subtitle" aria-live="off"></div>
      <div id="status">正在连接飞牛影音视频…</div>
      <div id="toolbar">
        <div class="fnos-pip-bar">
          <button id="backward" title="快退 10 秒（按住可连续快退）">−10s</button>
          <button id="play" title="播放/暂停">暂停</button>
          <button id="forward" title="快进 10 秒（按住可连续快进）">+10s</button>
          <span id="time">--:-- / --:--</span>
          <input id="seek" type="range" min="0" max="1000" value="0" step="1" title="进度（点击后跳转原播放器）">
        </div>
        <div class="fnos-pip-bar fnos-pip-bar-2">
          <button id="prev-ep" title="上一集">‹ 上一集</button>
          <button id="next-ep" title="下一集">下一集 ›</button>
          <button id="episodes" title="选集">选集</button>
          <button id="mute" title="静音/取消静音">静音</button>
          <input id="volume" type="range" min="0" max="1" value="1" step="0.05" title="音量">
          <button id="sub-smaller" title="减小字幕">A−</button>
          <button id="sub-larger" title="增大字幕">A+</button>
          <span id="sub-scale" title="字幕大小倍率">100%</span>
          <button id="exit" title="退出画中画">退出</button>
        </div>
      </div>
      <div id="episodes-layer" hidden>
        <div class="fnos-pip-ep-head">
          <span id="episodes-title">选集</span>
          <button id="episodes-close" title="关闭选集">✕</button>
        </div>
        <div id="episodes-grid"></div>
      </div>
    `;
    doc.body.appendChild(stage);

    pipVideo = doc.getElementById("video");
    subtitleLayer = doc.getElementById("subtitle");
    statusNode = doc.getElementById("status");

    doc.getElementById("play").addEventListener("click", () => {
      const v = liveVideo();
      if (!v) return;
      if (v.paused) resumeVideo(); else pauseVideo();
    });
    doc.getElementById("seek").addEventListener("change", e => {
      if (!sourceVideo || !Number.isFinite(sourceVideo.duration) || sourceVideo.duration <= 0) return;
      sourceVideo.currentTime = (Number(e.target.value) / 1000) * sourceVideo.duration;
    });
    doc.getElementById("mute").addEventListener("click", () => {
      if (!sourceVideo) return;
      sourceVideo.muted = !sourceVideo.muted;
      doc.getElementById("mute").textContent = sourceVideo.muted ? "取消静音" : "静音";
    });
    doc.getElementById("volume").addEventListener("input", e => {
      if (sourceVideo) sourceVideo.volume = Number(e.target.value);
    });
    bindSeekHold(doc.getElementById("backward"), -SEEK_STEP);
    bindSeekHold(doc.getElementById("forward"), SEEK_STEP);
    doc.getElementById("prev-ep").addEventListener("click", () => {
      const r = switchEpisode(-1);
      if (!r.ok) hintNoEpisodes();
    });
    doc.getElementById("next-ep").addEventListener("click", () => {
      const r = switchEpisode(1);
      if (!r.ok) hintNoEpisodes();
    });
    doc.getElementById("episodes").addEventListener("click", () => toggleEpisodeLayer());
    doc.getElementById("episodes-close").addEventListener("click", () => toggleEpisodeLayer(false));
    doc.getElementById("sub-smaller").addEventListener("click", () => adjustSubtitleScale(-0.1));
    doc.getElementById("sub-larger").addEventListener("click", () => adjustSubtitleScale(0.1));
    doc.getElementById("exit").addEventListener("click", () => cleanup());
    // Document PiP 窗口中 CSS :hover 不生效，改用 JS 事件控制工具条显隐
    doc.getElementById("stage").addEventListener("mousemove", () => {
      const toolbar = doc.getElementById("toolbar");
      toolbar.style.opacity = "1";
      clearTimeout(controlsTimer);
      controlsTimer = setTimeout(() => {
        if (!doc.activeElement || !toolbar.contains(doc.activeElement)) {
          toolbar.style.opacity = "";
        }
      }, 1800);
    });
  }

  // ---- 选集浮层（模式 A 在画中画窗口内，模式 B 在页面上）----
  function episodeEntries() {
    const items = findEpisodeItems();
    return items.map((el, index) => ({
      index,
      label: (el.textContent || "").replace(/\s+/g, " ").trim() || String(index + 1),
      active: index === findActiveEpisodeIndex(items)
    }));
  }

  function buildEpisodeGrid(doc, grid, titleNode) {
    const entries = episodeEntries();
    if (titleNode) {
      titleNode.textContent = entries.length ? "选集（共 " + entries.length + " 集）" : "选集";
    }
    if (!entries.length) {
      grid.innerHTML = `<div class="fnos-pip-ep-empty">未识别到剧集列表，可能不是连播内容</div>`;
      return false;
    }
    grid.innerHTML = "";
    for (const entry of entries) {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = entry.label;
      // dataset 用 1-based，与「第N集」标签保持一致，便于调试与自动化
      b.dataset.episode = String(entry.index + 1);
      if (entry.active) b.classList.add("is-active");
      b.addEventListener("click", () => {
        const r = switchEpisodeIndex(entry.index);
        if (r.ok) {
          // 重新渲染以更新高亮，并关闭浮层
          buildEpisodeGrid(doc, grid, titleNode);
          toggleEpisodeLayer(false);
        } else {
          hintNoEpisodes();
        }
      });
      grid.appendChild(b);
    }
    return true;
  }

  function toggleEpisodeLayer(force) {
    let doc, layer, grid, title;
    if (mode === "document" && pipWindow) {
      doc = pipWindow.document;
      layer = doc.getElementById("episodes-layer");
      grid = doc.getElementById("episodes-grid");
      title = doc.getElementById("episodes-title");
    } else {
      doc = document;
      layer = ensureEpisodeLayer();
      grid = layer.querySelector("#fnos-pip-episodes-grid");
      title = layer.querySelector("#fnos-pip-episodes-title");
    }
    if (!layer) return;
    const show = typeof force === "boolean" ? force : layer.hidden;
    if (show) {
      const ok = buildEpisodeGrid(doc, grid, title);
      layer.hidden = false;
      if (!ok) {
        hintNoEpisodes();
        // 没有剧集时也让用户看一眼提示，随后自动收起
        setTimeout(() => { if (layer && !layer.hidden) layer.hidden = true; }, 1600);
      }
    } else {
      layer.hidden = true;
    }
  }

  function applySubtitleToLayer() {
    if (!pipWindow || !subtitleLayer) return;
    subtitleLayer.textContent = subtitleCache.text;
    updateSubtitleStyle();
    if (statusNode) {
      statusNode.textContent = subtitleCache.text
        ? "字幕同步中（文档画中画）"
        : "视频已连接；暂未检测到可见字幕（请确认字幕已开启）";
    }
  }

  function updateSubtitleStyle() {
    if (mode !== "document" || !pipWindow || !subtitleLayer) return;
    const s = subtitleCache.style;
    if (!s) return;
    if (s.color) subtitleLayer.style.color = s.color;
    if (s.fontFamily) subtitleLayer.style.fontFamily = s.fontFamily;
    if (s.fontSize) {
      const px = parseFloat(s.fontSize);
      if (Number.isFinite(px)) {
        const ratio = pipWindow.innerWidth / Math.max(320, sourceVideo?.getBoundingClientRect().width || 720);
        subtitleLayer.style.fontSize = Math.max(12, Math.min(120, px * ratio * subtitleScale)) + "px";
      }
    }
    if (s.fontWeight) subtitleLayer.style.fontWeight = s.fontWeight;
    if (s.textShadow) subtitleLayer.style.textShadow = s.textShadow;
    if (s.backgroundColor) subtitleLayer.style.backgroundColor = s.backgroundColor;
    if (s.textAlign) subtitleLayer.style.textAlign = s.textAlign;
    // Keep subtitles near the lower area in the PiP window.
    subtitleLayer.style.bottom = "8%";
  }

  // 检测源视频是否被页面替换（换集 / 连播）：发现就整体重绑
  function pollSourceVideo() {
    if (!mode || cleaningUp) return;
    checkSourceVideo();
    if (!mode || !sourceVideo) return;
    if (!sourceVideo.isConnected) {
      showError(new Error("视频元素已被页面移除或更换，请重新开启字幕画中画。"));
      cleanup();
    }
  }

  // 模式 A 控件刷新：rAF 循环与后台兜底定时器共用
  function updateDocumentControls() {
    if (mode !== "document" || !pipWindow || !sourceVideo) return;
    const doc = pipWindow.document;
    const playButton = doc.getElementById("play");
    const timeNode = doc.getElementById("time");
    const seek = doc.getElementById("seek");
    const fmt = t => {
      if (!Number.isFinite(t)) return "--:--";
      const s = Math.max(0, Math.floor(t));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      return h ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` :
        `${m}:${String(sec).padStart(2,"0")}`;
    };
    if (playButton) playButton.textContent = sourceVideo.paused ? "播放" : "暂停";
    if (timeNode) timeNode.textContent = `${fmt(sourceVideo.currentTime)} / ${fmt(sourceVideo.duration)}`;
    if (seek && Number.isFinite(sourceVideo.duration) && sourceVideo.duration > 0 &&
        doc.activeElement !== seek) {
      seek.value = String(Math.round(sourceVideo.currentTime / sourceVideo.duration * 1000));
    }
  }

  function startSyncLoop() {
    cancelAnimationFrame(rafId);
    const tick = () => {
      if (mode !== "document" || !pipWindow || !sourceVideo) return;
      pollSourceVideo();
      if (mode !== "document") return;
      updateDocumentControls();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    startSyncFallback();
  }

  // 画中画窗口持焦时，原标签页会被切到后台，rAF 直接停摆 —— 换集检测、进度/按钮刷新全部冻结，
  // 表现为「连播后画中画不动，只能回页面重开」。用定时器兜底（有声音播放的标签页计时器不会被严重限流）。
  function startSyncFallback() {
    stopSyncFallback();
    syncTimerId = setInterval(() => {
      if (mode !== "document" || cleaningUp) { stopSyncFallback(); return; }
      pollSourceVideo();
      updateDocumentControls();
    }, 250);
  }

  function stopSyncFallback() {
    if (syncTimerId) { clearInterval(syncTimerId); syncTimerId = 0; }
  }

  async function startDocumentPiP() {
    pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 720,
      height: 405,
      disallowReturnToOpener: false
    });
    mode = "document";
    setModeMarker("document");
    buildPiPDocument();
    hideSourceVideo(); // 画中画期间原页面不再显示画面（仍继续解码出声）
    updateSubtitleScaleUI();

    try {
      sourceStream = (sourceVideo.captureStream || sourceVideo.mozCaptureStream).call(sourceVideo);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      teardownDocumentPiP();
      throw new Error("无法捕获视频流：" + msg + "（受 DRM 保护的内容无法捕获，可尝试非加密片源）");
    }

    // Keep audio output on the original FNOS video; mute only the PiP clone to avoid double audio.
    pipVideo.muted = true;
    pipVideo.srcObject = sourceStream;

    bindVideoEvents();

    pipVideo.addEventListener("loadedmetadata", () => {
      if (statusNode) statusNode.textContent = "视频流已连接；声音由原页面输出";
    }, { once: true });
    pipVideo.play().catch(() => {
      if (statusNode) statusNode.textContent = "视频已连接。若画面未动，请在窗口内点击一次。";
    });

    refreshSubtitle();
    startSyncLoop();

    pipWindow.addEventListener("pagehide", cleanup, { once: true });
    pipWindow.addEventListener("resize", () => updateSubtitleStyle());
    updateSubtitleStyle();
  }

  // 源视频事件集中绑定：换集导致播放器重建 video 元素时整体重绑一次
  function bindVideoEvents() {
    if (videoEventsAbort) videoEventsAbort.abort();
    videoEventsAbort = new AbortController();
    const opt = { signal: videoEventsAbort.signal };
    const updatePlayButton = () => {
      if (!pipWindow) return;
      const b = pipWindow.document.getElementById("play");
      if (b) b.textContent = sourceVideo && sourceVideo.paused ? "播放" : "暂停";
    };
    sourceVideo.addEventListener("play", updatePlayButton, opt);
    sourceVideo.addEventListener("pause", updatePlayButton, opt);
    sourceVideo.addEventListener("ended", updatePlayButton, opt);
    // 模式 B：源视频状态变化时同步画中画 video 元素，避免自带播放按钮失灵/画面冻住
    sourceVideo.addEventListener("play", syncPiPPlayback, opt);
    sourceVideo.addEventListener("pause", syncPiPPlayback, opt);
    sourceVideo.addEventListener("ended", syncPiPPlayback, opt);
    sourceVideo.addEventListener("ended", onSourceEnded, opt);
    sourceVideo.addEventListener("resize", updateSubtitleStyle, opt);
    syncPiPPlayback();
  }

  // ---- 自动连播 ----
  // 视频播完时分两种情形：
  //   1) 页面自身支持连播：很快换 src / 重建 video 元素并起播 → 什么都不做，交给 rebind 流程；
  //   2) 页面不连播：宽限期后仍停在 ended → 由扩展点「下一集」，画中画里继续播，不用回页面。
  function onSourceEnded() {
    if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = 0; }
    if (!mode || cleaningUp) return;
    autoNextTimer = setTimeout(() => {
      autoNextTimer = 0;
      if (!mode || cleaningUp) return;
      const v = liveVideo();
      // 页面已经自己接上连播就不插手：换了 src（load 后 ended 复位）、重建了元素
      // （sourceVideo 已被轮询换成新元素，ended 为 false）、或用户又点了播放
      if (!v || !v.ended || !v.paused) return;
      const items = findEpisodeItems();
      if (items.length < 2) return;                 // 不是连播内容
      const current = findActiveEpisodeIndex(items);
      if (current < 0) return;                      // 判不出当前集，宁可不动作
      if (current + 1 >= items.length) {
        showHint("已是最后一集");
        return;
      }
      const r = switchEpisodeIndex(current + 1);
      if (r.ok) {
        showHint("连播：已切换到下一集");
        refreshEpisodeLayer();
      } else {
        hintNoEpisodes();
      }
    }, AUTO_NEXT_DELAY);
  }

  function cancelAutoNext() {
    if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = 0; }
  }

  // 选集浮层若正开着，换集后重建以更新高亮
  function refreshEpisodeLayer() {
    let doc, layer, grid, title;
    if (mode === "document" && pipWindow) {
      doc = pipWindow.document;
      layer = doc.getElementById("episodes-layer");
      grid = doc.getElementById("episodes-grid");
      title = doc.getElementById("episodes-title");
    } else if (mode === "canvas") {
      doc = document;
      layer = document.getElementById("fnos-pip-episodes");
      grid = layer && layer.querySelector("#fnos-pip-episodes-grid");
      title = layer && layer.querySelector("#fnos-pip-episodes-title");
    }
    if (doc && layer && grid && !layer.hidden) buildEpisodeGrid(doc, grid, title);
  }

  // 播放器可能在切换剧集后重建 video 元素；此时重新捕获流，否则画中画停在旧画面
  async function rebindSourceVideo(nextVideo) {
    lastSourceVideo = nextVideo;
    // 先把旧元素的隐藏样式还回去，再让新元素也进入隐藏态：
    // 播放器重建 video 时新元素是干净的原生样式，不处理的话画中画期间原页面又把画面显示出来了
    restoreSourceVideo();
    sourceVideo = nextVideo;
    hiddenVideoOpacity = null;
    hideSourceVideo();

    subtitleRoot = getSubtitleRoot();
    refreshSubtitle();
    // 源视频元素已经换了，事件必须整体重绑（ended 自动连播、resize 等）。
    // 注意不能只放在下面的 document 分支里：canvas 分支会提前 return，
    // 那样 rebuild 换集后新元素就没有 ended 监听了。
    bindVideoEvents();
    if (mode === "canvas") {
      setupCanvas();
      syncCanvasSize();
      refreshEpisodeLayer();
      return true;
    }
    if (mode !== "document" || !pipVideo) return false;
    try {
      if (sourceStream) {
        try { sourceStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      }
      sourceStream = (nextVideo.captureStream || nextVideo.mozCaptureStream).call(nextVideo);
      pipVideo.srcObject = sourceStream;
      pipVideo.play().catch(() => {});
      refreshEpisodeLayer();
      return true;
    } catch (e) {
      showError(new Error("切换剧集后无法重新捕获视频流：" + (e && e.message ? e.message : e) +
        "（受 DRM 保护的内容无法捕获）"));
      cleanup();
      return false;
    }
  }

  // 两种模式的循环里调用：检测 video 元素是否被页面替换
  function checkSourceVideo() {
    if (!mode || cleaningUp) return;
    const v = findVideo();
    if (v && v !== sourceVideo) { rebindSourceVideo(v); return; }
    if (sourceVideo && !sourceVideo.isConnected) {
      const again = findVideo();
      if (again && again !== sourceVideo) rebindSourceVideo(again);
    }
  }

  function teardownDocumentPiP() {
    if (observer) { observer.disconnect(); observer = null; }
    cancelAnimationFrame(rafId);
    clearTimeout(controlsTimer);
    if (pipVideo) {
      try { pipVideo.pause(); pipVideo.srcObject = null; } catch (_) {}
    }
    if (sourceStream) {
      try { sourceStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      sourceStream = null;
    }
    if (pipWindow) { try { pipWindow.close(); } catch (_) {} }
    pipWindow = null;
    pipVideo = null;
    subtitleLayer = null;
    statusNode = null;
    mode = null;
    setModeMarker(null);
  }

  // ==================== 模式 B：canvas 字幕合成 + 视频画中画 ====================

  async function startCanvasPiP() {
    if (typeof HTMLCanvasElement.prototype.captureStream !== "function") {
      throw new Error("当前浏览器不支持 canvas.captureStream()，无法合成字幕画面。");
    }
    if (typeof sourceVideo.requestPictureInPicture !== "function") {
      throw new Error("当前浏览器不支持视频画中画（video.requestPictureInPicture）。");
    }

    mode = "canvas";
    setModeMarker("canvas");
    setupCanvas();
    buildPanel();
    hideSourceVideo();      // 画中画期间原页面不再显示画面（仍继续解码出声）
    // 源视频事件（ended 自动连播、resize 重算字幕比例）；换集后由 rebindSourceVideo 重挂
    bindVideoEvents();
    setupMediaSession();    // 画中画窗口内的上一首/下一首 → 字幕减小/增大

    canvasStream = canvas.captureStream(30);

    const pv = document.createElement("video");
    pipVideo = pv;
    pv.muted = true; // 声音保留在原页面播放器，避免双重音频
    pv.playsInline = true;
    pv.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
    document.body.appendChild(pv);
    pv.srcObject = canvasStream;

    // 画中画窗口自带的播放/暂停按钮：反向同步到原播放器。
    // 注意只在状态确实不一致时动作，否则会和 syncPiPPlayback 互相触发形成环。
    pv.addEventListener("pause", () => {
      if (cleaningUp || mode !== "canvas") return;
      pauseVideo();
    });
    pv.addEventListener("play", () => {
      if (cleaningUp || mode !== "canvas") return;
      resumeVideo();
    });
    pv.addEventListener("leavepictureinpicture", onCanvasLeave);

    // 清晰度切换导致视频分辨率变化时，同步调整画布
    sourceVideo.addEventListener("resize", setupCanvas);

    // 先启动绘制循环（否则画布没有帧，视频播放永远不会开始），再 play + 进入画中画
    refreshSubtitle();
    startCanvasTimers();
    try { await pv.play(); } catch (_) {}
    // 兜底：启动时若源视频恰好是暂停态，pv 不应抢先播放（否则自带播放按钮又会失灵）
    syncPiPPlayback();
    if (mode !== "canvas" || pipVideo !== pv) return; // 等待期间已被关闭/切换
    await pv.requestPictureInPicture();
  }

  function onCanvasLeave() {
    if (pendingSwitch === "document") {
      pendingSwitch = null;
      cleanup(); // 清理模式 B 残留（面板/定时器/隐藏的视频），否则 startPiP 会被 mode 卡住
      setTimeout(() => { startPiP().catch(showError); }, 60);
      return;
    }
    cleanup();
  }

  function setupCanvas() {
    if (!sourceVideo) return;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvasCtx = canvas.getContext("2d");
    }
    syncCanvasSize();
  }

  // 画布尺寸跟随源视频实际分辨率。换集（特别是播放器重建 video 元素）后新元素的
  // 元数据要等一会儿才好，期间 videoWidth/videoHeight 为 0，所以每帧都校正一次，
  // 尺寸没变就不动（改 canvas.width 会清空内容并触发重新分配）。
  function syncCanvasSize() {
    if (!canvas || !canvasCtx || !sourceVideo || mode !== "canvas") return false;
    const vw = sourceVideo.videoWidth || 0;
    const vh = sourceVideo.videoHeight || 0;
    if (!vw || !vh) return false;
    const scale = Math.min(1, 1280 / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  function buildPanel() {
    if (!panelStyleInjected) {
      const style = document.createElement("style");
      style.textContent = styleText;
      (document.documentElement || document.head).appendChild(style);
      panelStyleInjected = true;
    }
    panel = document.createElement("div");
    panel.id = "fnos-pip-panel";
    panel.innerHTML = `
      <div class="fnos-pip-row">
        <button type="button" data-act="backward" title="快退 10 秒（按住可连续快退）">−10s</button>
        <button type="button" data-act="play">暂停</button>
        <button type="button" data-act="forward" title="快进 10 秒（按住可连续快进）">+10s</button>
        <button type="button" data-act="mute">静音</button>
      </div>
      <div class="fnos-pip-row">
        <button type="button" data-act="prev-ep" title="上一集">‹ 上一集</button>
        <button type="button" data-act="next-ep" title="下一集">下一集 ›</button>
        <button type="button" data-act="episodes" title="选集">选集</button>
      </div>
      <div class="fnos-pip-row">
        <button type="button" data-act="sub-smaller" title="减小字幕">A−</button>
        <button type="button" data-act="sub-larger" title="增大字幕">A+</button>
        <span class="fnos-pip-scale" data-role="scale">字幕 100%</span>
      </div>
      <div class="fnos-pip-time" data-role="time">--:-- / --:--</div>
      <div class="fnos-pip-mode">视频画中画 · 字幕已合成进画面</div>
      <div class="fnos-pip-sub" data-role="sub">字幕：检测中…</div>
      <div class="fnos-pip-hint" data-role="hint" hidden></div>`;
    if (window.documentPictureInPicture) {
      panel.insertAdjacentHTML("beforeend",
        `<div class="fnos-pip-row" style="margin-top:6px;margin-bottom:0">
          <button type="button" data-act="exit">退出画中画</button>
          <button type="button" data-act="docpip">切换到文档画中画</button></div>`);
    } else {
      panel.insertAdjacentHTML("beforeend",
        `<div class="fnos-pip-row" style="margin-top:6px;margin-bottom:0">
          <button type="button" data-act="exit">退出画中画</button></div>`);
    }
    panel.addEventListener("click", (e) => {
      const act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
      if (!act || !liveVideo()) return;
      if (act === "play") {
        if (liveVideo().paused) resumeVideo(); else pauseVideo();
      } else if (act === "mute") {
        sourceVideo.muted = !sourceVideo.muted;
      } else if (act === "exit") {
        if (document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {});
      } else if (act === "prev-ep") {
        const r = switchEpisode(-1);
        if (!r.ok) hintNoEpisodes();
      } else if (act === "next-ep") {
        const r = switchEpisode(1);
        if (!r.ok) hintNoEpisodes();
      } else if (act === "episodes") {
        toggleEpisodeLayer();
      } else if (act === "sub-smaller") {
        adjustSubtitleScale(-0.1);
      } else if (act === "sub-larger") {
        adjustSubtitleScale(0.1);
      } else if (act === "docpip") {
        pendingSwitch = "document";
        if (document.exitPictureInPicture) {
          document.exitPictureInPicture().catch(() => { pendingSwitch = null; });
        }
      }
    });
    bindSeekHold(panel.querySelector('[data-act="backward"]'), -SEEK_STEP);
    bindSeekHold(panel.querySelector('[data-act="forward"]'), SEEK_STEP);
    document.documentElement.appendChild(panel);
    updateSubtitleScaleUI();
  }

  // 模式 B 的选集浮层挂在页面上，随面板一起创建/销毁
  function ensureEpisodeLayer() {
    let layer = document.getElementById("fnos-pip-episodes");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.id = "fnos-pip-episodes";
    layer.hidden = true;
    layer.innerHTML = `
      <div class="fnos-pip-ep-head">
        <span id="fnos-pip-episodes-title">选集</span>
        <button type="button" id="fnos-pip-episodes-close" title="关闭选集">✕</button>
      </div>
      <div id="fnos-pip-episodes-grid"></div>`;
    layer.querySelector("#fnos-pip-episodes-close").addEventListener("click", () => toggleEpisodeLayer(false));
    document.documentElement.appendChild(layer);
    return layer;
  }

  function startCanvasTimers() {
    stopCanvasTimers();
    const tick = () => {
      if (mode !== "canvas" || !sourceVideo) return;
      drawFrame();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    // 后台标签页中 rAF 会暂停，用定时器兜底（有声音播放的标签页计时器不会被严重限流）
    timerId = setInterval(() => {
      if (mode !== "canvas" || !sourceVideo) return;
      pollSourceVideo();
      if (mode !== "canvas" || !sourceVideo) return;
      updatePanel();
      if (document.visibilityState !== "visible" || performance.now() - lastDrawTime > 250) {
        drawFrame();
      }
      if (performance.now() - lastCacheRefresh > 500) refreshSubtitle();
    }, 33);
  }

  function stopCanvasTimers() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    clearInterval(timerId);
    timerId = 0;
  }

  function updatePanel() {
    if (!panel || !sourceVideo) return;
    const playBtn = panel.querySelector('[data-act="play"]');
    const muteBtn = panel.querySelector('[data-act="mute"]');
    const time = panel.querySelector('[data-role="time"]');
    const sub = panel.querySelector('[data-role="sub"]');
    const scale = panel.querySelector('[data-role="scale"]');
    if (playBtn) playBtn.textContent = sourceVideo.paused ? "播放" : "暂停";
    if (muteBtn) muteBtn.textContent = sourceVideo.muted ? "取消静音" : "静音";
    if (scale) scale.textContent = "字幕 " + Math.round(subtitleScale * 100) + "%";
    if (sub) {
      sub.textContent = subtitleCache.text
        ? "字幕：" + subtitleCache.text
        : "字幕：未检测到（请确认字幕已开启）";
    }
    if (time) {
      const fmt = t => {
        if (!Number.isFinite(t)) return "--:--";
        const s = Math.max(0, Math.floor(t));
        const m = Math.floor(s / 60), sec = s % 60;
        return `${m}:${String(sec).padStart(2, "0")}`;
      };
      time.textContent = `${fmt(sourceVideo.currentTime)} / ${fmt(sourceVideo.duration)}`;
    }
  }

  function drawFrame() {
    if (!canvasCtx || !sourceVideo || mode !== "canvas") return;
    syncCanvasSize();
    const w = canvas.width, h = canvas.height;
    try {
      canvasCtx.drawImage(sourceVideo, 0, 0, w, h);
    } catch (_) {
      return;
    }
    lastDrawTime = performance.now();
    const text = subtitleCache.text;
    const styleValue = subtitleCache.style;
    if (text) drawSubtitleText(canvasCtx, text, styleValue, w, h);
  }

  function parseShadow(v) {
    if (!v || v === "none") return null;
    const s = String(v);
    // 兼容两种书写顺序："offsetX offsetY blur color" 与 "color offsetX offsetY blur"
    let m = s.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(.+)$/);
    if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]), blur: parseFloat(m[3]), color: m[4].trim() };
    m = s.match(/^(.*?)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/);
    if (m) return { color: m[1].trim(), x: parseFloat(m[2]), y: parseFloat(m[3]), blur: parseFloat(m[4]) };
    return null;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 将字幕文字按源页面样式绘制到画布（带自动换行、描边阴影、可选背景框）
  function drawSubtitleText(ctx, text, styleValue, w, h) {
    const s = styleValue || {};
    const playerH = (sourceVideo && sourceVideo.getBoundingClientRect().height) || h;
    const ratio = h / Math.max(1, playerH);
    let px = parseFloat(s.fontSize) * ratio * subtitleScale;
    if (!Number.isFinite(px)) px = h * 0.05;
    px = Math.max(12, Math.min(h * 0.2, px));

    const family = s.fontFamily || "Arial, sans-serif";
    ctx.font = (s.fontWeight || "600") + " " + px + "px " + family;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    // 换行：按字符测量，中文可任意断行
    const maxWidth = w * 0.9;
    const lines = [];
    let line = "";
    for (const ch of text) {
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    const shown = lines.slice(0, 3);
    const lineHeight = px * 1.4;
    const bottomPad = h * 0.08;

    // 背景框（源字幕带底色时）
    const bg = s.backgroundColor;
    if (bg && bg !== "transparent" && !/,\s*0\)$/.test(bg)) {
      let widest = 0;
      for (const l of shown) widest = Math.max(widest, ctx.measureText(l).width);
      const padX = px * 0.5, padY = px * 0.28;
      const boxW = Math.min(w * 0.96, widest + padX * 2);
      const boxH = shown.length * lineHeight + padY * 2 - (lineHeight - px) * 0.5;
      const boxX = (w - boxW) / 2;
      const boxY = h - bottomPad - boxH + px * 0.25;
      ctx.save();
      ctx.fillStyle = bg;
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      roundRectPath(ctx, boxX, boxY, boxW, boxH, Math.min(12, px * 0.3));
      ctx.fill();
      ctx.restore();
    }

    // 阴影（canvas 仅支持单层阴影，取第一组值）
    const sh = parseShadow(s.textShadow);
    if (sh) {
      ctx.shadowColor = sh.color;
      ctx.shadowBlur = sh.blur;
      ctx.shadowOffsetX = sh.x;
      ctx.shadowOffsetY = sh.y;
    } else {
      ctx.shadowColor = "rgba(0,0,0,.85)";
      ctx.shadowBlur = px * 0.18;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = Math.max(1, px * 0.06);
    }
    ctx.fillStyle = (s.color && s.color !== "transparent") ? s.color : "#fff";

    let baseY = h - bottomPad - (shown.length - 1) * lineHeight;
    for (const l of shown) {
      ctx.fillText(l, w / 2, baseY);
      baseY += lineHeight;
    }
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  // ===================== 入口 / 清理 ====================

  async function startPiP() {
    if (mode || starting) return;
    starting = true;
    try {
      sourceVideo = findVideo();
      if (!sourceVideo) throw new Error("没有找到正在播放的飞牛影音视频。请先打开视频并等待画面出现。");

      subtitleRoot = getSubtitleRoot();
      if (!subtitleRoot) {
        throw new Error("没有找到字幕容器 #trim-ui__player-subtitle-mount-point-wrapper。请确认正在飞牛影音播放页面。");
      }

      lastSourceVideo = sourceVideo;
      refreshSubtitle();

      const dpip = window.documentPictureInPicture;
      if (dpip && typeof dpip.requestWindow === "function") {
        try {
          await startDocumentPiP();
          return;
        } catch (e) {
          // 文档画中画失败（无用户激活、浏览器限制等）→ 降级到视频画中画
          console.warn("[FNOS Subtitle PiP] 文档画中画不可用，降级为视频画中画：", e);
          teardownDocumentPiP();
        }
      }
      try {
        await startCanvasPiP();
      } catch (e) {
        cleanup(); // 清理半成品状态（面板、定时器、画布等）
        throw e;
      }
    } finally {
      starting = false;
    }
  }

  function setModeMarker(value) {
    try {
      if (value) document.documentElement.setAttribute("data-fnos-pip-mode", value);
      else document.documentElement.removeAttribute("data-fnos-pip-mode");
    } catch (_) {}
  }

  function cleanup() {
    if (!mode || cleaningUp) return;
    cleaningUp = true;
    stopSeekHold();
    cancelAutoNext();
    clearTimeout(hintTimer);
    if (videoEventsAbort) { videoEventsAbort.abort(); videoEventsAbort = null; }
    lastSourceVideo = null;
    if (observer) { observer.disconnect(); observer = null; }
    stopCanvasTimers();
    stopSyncFallback();
    clearTimeout(controlsTimer);
    restoreSourceVideo();    // 恢复浏览器默认显示（原页面画面回来）
    teardownMediaSession();
    const epLayer = document.getElementById("fnos-pip-episodes");
    if (epLayer && epLayer.parentNode) epLayer.parentNode.removeChild(epLayer);
    if (canvasStream) {
      try { canvasStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      canvasStream = null;
    }
    if (pipVideo) {
      try { pipVideo.pause(); } catch (_) {}
      try { pipVideo.srcObject = null; } catch (_) {}
    }
    if (mode === "canvas" && document.pictureInPictureElement === pipVideo) {
      if (document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {});
    }
    if (mode === "document" && pipWindow) {
      try { pipWindow.close(); } catch (_) {}
    }
    if (sourceStream) {
      try { sourceStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      sourceStream = null;
    }
    if (mode === "canvas" && pipVideo && pipVideo.parentNode) {
      pipVideo.parentNode.removeChild(pipVideo);
    }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    canvas = null;
    canvasCtx = null;
    panel = null;
    pipWindow = null;
    pipVideo = null;
    subtitleLayer = null;
    statusNode = null;
    sourceVideo = null;
    subtitleCache.text = "";
    subtitleCache.style = null;
    mode = null;
    setModeMarker(null);
    cleaningUp = false;
  }

  function describeSupport() {
    return [
      "页面协议：" + location.protocol,
      "安全上下文：" + (window.isSecureContext ? "是" : "否（Document PiP 需要 HTTPS 或 localhost）"),
      "Document PiP：" + (("documentPictureInPicture" in window) ? "可用" : "不可用"),
      "captureStream：" + ((HTMLMediaElement.prototype.captureStream || HTMLMediaElement.prototype.mozCaptureStream) ? "可用" : "不可用"),
      "视频 PiP：" + (("requestPictureInPicture" in HTMLVideoElement.prototype) ? "可用" : "不可用")
    ].join("\n");
  }

  function showError(error) {
    const message = error && error.message ? error.message : String(error);
    console.error("[FNOS Subtitle PiP]", error);
    alert("飞牛字幕画中画：\n" + message + "\n\n—— 环境诊断 ——\n" + describeSupport());
  }
})();

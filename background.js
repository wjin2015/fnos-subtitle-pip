// FNOS Subtitle PiP 后台服务工作线程
//
// 职责只有一件：把用户的两种触发动作（点击工具栏图标 / 快捷键 Alt+P）
// 转发给正确的标签页里的 content.js，由它决定开启或关闭字幕画中画。
//
// 路由说明（已在 Edge 155 实测）：
// 画中画窗口是独立的浏览器窗口，焦点落在其中时
// chrome.tabs.query({ active: true, currentWindow: true }) 返回的是画中画窗口自己的
// about:blank 标签页，而不是原视频页，消息发过去必然 "Receiving end does not exist"。
// 另外未申请 "tabs" 权限时 query 结果里没有 url 字段，无法靠 url 过滤。
// 因此这里显式记住"承载画中画的标签页 id"，命令直接发给它；
// 没有记录时（首次开启）才回退到当前窗口的活动标签页。

let pipTabId = null; // 正在/最近承载字幕画中画的标签页 id

function sendToggle(tabId) {
  try {
    chrome.tabs.sendMessage(tabId, { type: "fnos-subtitle-pip-toggle" }, (resp) => {
      const err = chrome.runtime.lastError;
      void err; // 未注入 content.js 的页面（chrome:// 等）本就不能使用
      if (!err && resp && typeof resp.pipTabActive === "boolean") {
        pipTabId = resp.pipTabActive ? tabId : null;
      }
    });
  } catch (_) {}
}

function toggleActiveTab() {
  if (typeof pipTabId === "number") {
    sendToggle(pipTabId);
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== "number") return;
    sendToggle(tab.id);
  });
}

chrome.action.onClicked.addListener(toggleActiveTab);
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-subtitle-pip") toggleActiveTab();
});
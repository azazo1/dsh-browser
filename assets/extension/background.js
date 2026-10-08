// shared/protocol.ts
var PROTOCOL_VERSION = 1;
var NATIVE_HOST_NAME = "com.azazo1.dsh_browser";
var MAX_TEXT_CHARS = 12e4;

// shared/methods.ts
var BROWSER_METHODS = [
  "tabs.list",
  "tabs.activate",
  "tabs.open",
  "tabs.close",
  "page.snapshot",
  "page.navigate",
  "page.click",
  "page.fill",
  "page.pressKey",
  "page.scroll",
  "page.text",
  "page.waitFor"
];
function isBrowserMethod(value) {
  return BROWSER_METHODS.includes(value);
}

// extension/src/background/native.ts
var RECONNECT_ALARM = "dsh-browser-reconnect";
var BACKOFF_MS = [500, 1e3, 2e3, 5e3, 15e3, 3e4];
var NativeBridge = class {
  /**
   * @param onFrame 收到宿主帧时的回调; 返回的 Promise 表示处理完成.
   * @param onConnected 连接建立后回调, 用于补发握手.
   */
  constructor(onFrame, onConnected, log2) {
    this.onFrame = onFrame;
    this.onConnected = onConnected;
    this.log = log2;
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === RECONNECT_ALARM && this.port === null) this.connect();
    });
    chrome.runtime.onStartup.addListener(() => {
      this.connect();
    });
    chrome.runtime.onInstalled.addListener(() => {
      this.connect();
    });
  }
  port = null;
  timer = null;
  backoffIndex = 0;
  status = { hostConnected: false, linked: false, lastError: null, attempts: 0 };
  listeners = /* @__PURE__ */ new Set();
  /** 当前状态快照. */
  getStatus() {
    return { ...this.status };
  }
  /** 订阅状态变化, 返回取消订阅函数. */
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** 发起一次连接; 已经连着时是空操作. */
  connect() {
    if (this.port !== null) return;
    this.clearTimer();
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      this.fail(`\u65E0\u6CD5\u8FDE\u63A5 native host "${NATIVE_HOST_NAME}": ${String(error)}. \u901A\u5E38\u662F native messaging \u6E05\u5355\u8FD8\u6CA1\u88C5\u597D, \u8BF7\u5728 dsh \u7684\u63D2\u4EF6\u914D\u7F6E\u9875\u70B9"\u5B89\u88C5\u8FDE\u63A5\u7EC4\u4EF6".`);
      return;
    }
    this.port = port;
    port.onMessage.addListener((message) => {
      const frame = message;
      if (frame?.kind === "event" && frame.event === "link-ready") {
        this.status = { ...this.status, linked: true, lastError: null };
        this.emit();
        this.log("info", "native host \u5DF2\u8FDE\u4E0A dsh");
        this.onConnected();
        return;
      }
      if (frame?.kind === "event" && frame.event === "link-lost") {
        this.status = { ...this.status, linked: false, lastError: frame.payload?.reason ?? "dsh \u4FA7\u8FDE\u63A5\u5DF2\u65AD\u5F00" };
        this.emit();
        return;
      }
      void this.onFrame(message).catch((error) => {
        this.log("error", "\u5904\u7406\u5BBF\u4E3B\u5E27\u65F6\u51FA\u9519", error);
      });
    });
    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message ?? "\u5BBF\u4E3B\u8FDB\u7A0B\u5DF2\u65AD\u5F00";
      this.port = null;
      this.fail(`\u4E0E\u5BBF\u4E3B\u7684\u8FDE\u63A5\u65AD\u5F00: ${detail}`);
    });
    this.status = { ...this.status, hostConnected: true, linked: false, lastError: null };
    this.backoffIndex = 0;
    this.emit();
    this.log("info", `\u5DF2\u8FDE\u63A5 native host ${NATIVE_HOST_NAME}`);
    this.onConnected();
  }
  /** 主动断开; 用于调试或用户禁用. */
  disconnect() {
    this.clearTimer();
    const port = this.port;
    this.port = null;
    if (port !== null) {
      try {
        port.disconnect();
      } catch {
      }
    }
    this.status = { ...this.status, hostConnected: false, linked: false, lastError: null };
    this.emit();
  }
  /**
   * 向宿主发送一帧.
   * @param frame 要发送的帧.
   * @returns 是否成功送出; false 表示当前没连接.
   */
  send(frame) {
    if (this.port === null) return false;
    try {
      this.port.postMessage(frame);
      return true;
    } catch (error) {
      this.fail(`\u53D1\u9001\u5931\u8D25: ${String(error)}`);
      return false;
    }
  }
  /** 记录一次失败并安排重连. */
  fail(message) {
    this.status = { ...this.status, hostConnected: false, linked: false, lastError: message, attempts: this.status.attempts + 1 };
    this.emit();
    this.log("warn", message);
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (this.timer !== null) return;
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)];
    this.backoffIndex += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
  clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  emit() {
    const snapshot = this.getStatus();
    for (const listener of this.listeners) listener(snapshot);
  }
};

// extension/src/background/injected.ts
var SNAPSHOT_KEY = "__dshBrowserSnapshot";
function collectSnapshot(snapshotKey, maxTextChars, maxElements) {
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = globalThis.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity === "0") return false;
    return true;
  };
  const clip = (value, limit) => {
    const flat = value.replace(/\s+/gu, " ").trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit !== null && explicit !== "") return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "link-no-href";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "file") return "file";
      return "textbox";
    }
    return "generic";
  };
  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria !== null && aria.trim() !== "") return clip(aria, 160);
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled !== null && labelled !== "") {
      const target = el.ownerDocument.getElementById(labelled);
      if (target !== null) {
        const label = clip(target.textContent ?? "", 160);
        if (label !== "") return label;
      }
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const element = el;
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (tag === "input" && (type === "submit" || type === "button" || type === "reset")) {
        const value = element.value;
        if (value !== "") return clip(value, 160);
      }
      const id = el.getAttribute("id");
      if (id !== null && id !== "") {
        const owner = el.ownerDocument;
        const escaped = globalThis.CSS.escape(id);
        const label = owner.querySelector(`label[for="${escaped}"]`);
        if (label !== null) {
          const text3 = clip(label.textContent ?? "", 160);
          if (text3 !== "") return text3;
        }
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder !== null && placeholder.trim() !== "") return clip(placeholder, 160);
      const name = el.getAttribute("name");
      if (name !== null && name.trim() !== "") return clip(name, 160);
      return "";
    }
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt !== null && alt.trim() !== "") return clip(alt, 160);
    }
    const text2 = clip(el.innerText ?? el.textContent ?? "", 160);
    if (text2 !== "") return text2;
    const title = el.getAttribute("title");
    if (title !== null && title.trim() !== "") return clip(title, 160);
    return "";
  };
  const noteOf = (el) => {
    const parts = [];
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type !== "text") parts.push(type);
      const input = el;
      if (input.disabled) parts.push("disabled");
      if (input.readOnly) parts.push("readonly");
      if ((type === "checkbox" || type === "radio") && input.checked) parts.push("checked");
      if (input.value !== "" && type !== "submit" && type !== "button" && type !== "password") {
        parts.push(`value=${clip(input.value, 60)}`);
      }
    } else if (tag === "textarea") {
      const area = el;
      if (area.disabled) parts.push("disabled");
      if (area.value !== "") parts.push(`value=${clip(area.value, 60)}`);
    } else if (tag === "select") {
      const select = el;
      if (select.disabled) parts.push("disabled");
      if (select.multiple) parts.push("multiple");
      const chosen = [...select.selectedOptions].map((option) => option.text).join(", ");
      if (chosen !== "") parts.push(`selected=${clip(chosen, 60)}`);
    } else if (tag === "a") {
      const href = el.getAttribute("href");
      if (href !== null && href !== "") parts.push(`href=${clip(href, 120)}`);
    }
    if (el.hasAttribute("aria-expanded")) {
      parts.push(`expanded=${String(el.getAttribute("aria-expanded"))}`);
    }
    return parts.length === 0 ? void 0 : parts.join(" ");
  };
  const interactiveSelector = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=combobox]",
    "[contenteditable=true]",
    "[onclick]"
  ].join(",");
  const body = globalThis.document.body;
  const rawText = body === null ? "" : body.innerText ?? "";
  const text = rawText.length <= maxTextChars ? rawText : `${rawText.slice(0, maxTextChars)}
... \u6587\u672C\u5DF2\u622A\u65AD`;
  const textTruncated = rawText.length > maxTextChars;
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const elements = [];
  const kept = [];
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of globalThis.document.querySelectorAll(interactiveSelector)) {
    if (elements.length >= maxElements) break;
    if (seen.has(candidate)) continue;
    let ancestor = candidate.parentElement;
    let nested = false;
    while (ancestor !== null) {
      if (seen.has(ancestor)) {
        nested = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (nested) continue;
    if (!isVisible(candidate)) continue;
    const role = roleOf(candidate);
    const name = accessibleName(candidate);
    if (name === "" && (role === "generic" || role === "link-no-href")) continue;
    seen.add(candidate);
    kept.push(candidate);
    const note = noteOf(candidate);
    elements.push(note === void 0 ? { index: elements.length, role, name } : { index: elements.length, role, name, note });
  }
  ;
  globalThis[snapshotKey] = { token, elements: kept };
  return {
    url: globalThis.location.href,
    title: globalThis.document.title,
    token,
    text,
    elements,
    truncated: textTruncated || elements.length >= maxElements
  };
}
function clickElement(snapshotKey, token, index) {
  const table = globalThis[snapshotKey];
  if (table === void 0 || table.token !== token) {
    return { ok: false, code: "stale-target", message: "\u9875\u9762\u5DF2\u7ECF\u53D8\u5316, \u8BF7\u91CD\u65B0\u83B7\u53D6\u5FEB\u7167" };
  }
  const element = table.elements[index];
  if (element === void 0) {
    return { ok: false, code: "unknown-element", message: `\u7F16\u53F7 ${index} \u4E0D\u5728\u6700\u8FD1\u4E00\u6B21\u5FEB\u7167\u4E2D` };
  }
  if (!element.isConnected) {
    return { ok: false, code: "stale-target", message: "\u8BE5\u5143\u7D20\u5DF2\u4ECE\u9875\u9762\u79FB\u9664, \u8BF7\u91CD\u65B0\u83B7\u53D6\u5FEB\u7167" };
  }
  const clickableSelector = "a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[onclick]";
  let target = element;
  let ancestor = element;
  while (ancestor !== null) {
    if (ancestor.matches?.(clickableSelector) === true) {
      target = ancestor;
      break;
    }
    ancestor = ancestor.parentElement;
  }
  if (typeof target.scrollIntoView === "function") {
    ;
    target.scrollIntoView({ block: "center", inline: "center" });
  }
  const describe = (el) => {
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const label = (el.getAttribute("aria-label") ?? el.innerText ?? el.textContent ?? "").replace(/\s+/gu, " ").trim();
    const href = el.getAttribute("href");
    const suffix = href === null || href === "" ? "" : ` -> ${href}`;
    const short = label.length > 60 ? `${label.slice(0, 60)}...` : label;
    return `<${role}> ${short}${suffix}`.trim();
  };
  const before = globalThis.location.href;
  const tag = target.tagName.toLowerCase();
  const type = (target.getAttribute("type") ?? "").toLowerCase();
  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    ;
    target.click();
    const checked = target.checked;
    return { ok: true, note: `\u5DF2\u70B9\u51FB ${describe(target)}, \u5F53\u524D checked=${String(checked)} (\u70B9\u51FB\u524D url=${before})` };
  }
  const rect = target.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const view = globalThis;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view };
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 };
  target.dispatchEvent(new PointerEvent("pointerdown", pointer));
  target.dispatchEvent(new MouseEvent("mousedown", base));
  target.focus?.();
  target.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", base));
  target.dispatchEvent(new MouseEvent("click", { ...base, detail: 1 }));
  return { ok: true, note: `\u5DF2\u70B9\u51FB ${describe(target)} (\u70B9\u51FB\u524D url=${before})` };
}
function pressKeyInPage(key) {
  const active = globalThis.document.activeElement;
  const target = active === null || active === globalThis.document.body ? globalThis.document.body : active;
  const describe = target === globalThis.document.body ? "<body>" : `<${target.tagName.toLowerCase()}>`;
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const keyCode = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "Tab" ? 9 : 0;
  const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (key.length === 1 && key !== " ") {
    target.dispatchEvent(new KeyboardEvent("keypress", init));
  }
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true, note: `\u5DF2\u5411 ${describe} \u53D1\u9001\u6309\u952E ${key}` };
}
function scrollPage(direction, amount) {
  const before = globalThis.scrollY;
  const step = amount ?? Math.max(200, globalThis.innerHeight * 0.85);
  const delta = direction === "down" ? step : -step;
  globalThis.scrollBy({ top: delta, left: 0, behavior: "instant" });
  const after = globalThis.scrollY;
  const max = Math.max(0, globalThis.document.documentElement.scrollHeight - globalThis.innerHeight);
  const atEdge = direction === "down" ? after >= max - 1 : after <= 0;
  return {
    ok: true,
    note: `\u6EDA\u52A8 ${direction} ${delta}px: ${Math.round(before)} -> ${Math.round(after)} (\u53EF\u8FBE\u8303\u56F4 0..${Math.round(max)})${atEdge ? ", \u5DF2\u5230\u5C3D\u5934" : ""}`
  };
}
function fillElement(snapshotKey, token, index, text, submit) {
  const table = globalThis[snapshotKey];
  if (table === void 0 || table.token !== token) {
    return { ok: false, code: "stale-target", message: "\u9875\u9762\u5DF2\u7ECF\u53D8\u5316, \u8BF7\u91CD\u65B0\u83B7\u53D6\u5FEB\u7167" };
  }
  const element = table.elements[index];
  if (element === void 0) {
    return { ok: false, code: "unknown-element", message: `\u7F16\u53F7 ${index} \u4E0D\u5728\u6700\u8FD1\u4E00\u6B21\u5FEB\u7167\u4E2D` };
  }
  if (!element.isConnected) {
    return { ok: false, code: "stale-target", message: "\u8BE5\u5143\u7D20\u5DF2\u4ECE\u9875\u9762\u79FB\u9664, \u8BF7\u91CD\u65B0\u83B7\u53D6\u5FEB\u7167" };
  }
  const tag = element.tagName.toLowerCase();
  const isEditable = element.hasAttribute("contenteditable") && element.getAttribute("contenteditable") !== "false";
  if (tag !== "input" && tag !== "textarea" && !isEditable) {
    return { ok: false, code: "unknown-element", message: `\u7F16\u53F7 ${index} \u662F <${tag}>, \u4E0D\u80FD\u586B\u5165\u6587\u672C; \u8BF7\u6539\u7528\u70B9\u51FB` };
  }
  const field = element;
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  if (type === "file") {
    return { ok: false, code: "forbidden", message: "\u6587\u4EF6\u4E0A\u4F20\u6846\u4E0D\u80FD\u7528\u6587\u672C\u586B\u5165, \u8BE5\u64CD\u4F5C\u9700\u8981\u7528\u6237\u624B\u52A8\u5B8C\u6210" };
  }
  ;
  element.focus?.();
  if (isEditable) {
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    const range = globalThis.document.createRange();
    range.selectNodeContents(element);
    selection?.addRange(range);
    selection?.deleteFromDocument();
    const inserted = globalThis.document.execCommand("insertText", false, text);
    if (!inserted) {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" }));
    }
  } else {
    const prototype = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    field.focus();
    field.select?.();
    if (setter === void 0) {
      field.value = text;
    } else {
      setter.call(field, text);
    }
    field.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
  let note = `\u5DF2\u5411\u7F16\u53F7 ${index} \u586B\u5165 ${text.length} \u4E2A\u5B57\u7B26`;
  if (submit) {
    const form = element.form ?? null;
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    note += ", \u5DF2\u6309\u4E0B Enter";
    if (form !== null) note += " (\u8BE5\u8F93\u5165\u6846\u5C5E\u4E8E\u4E00\u4E2A\u8868\u5355)";
  }
  return { ok: true, note };
}

// extension/src/background/tabs.ts
function toTabInfo(tab) {
  return {
    id: tab.id ?? -1,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active === true,
    windowId: tab.windowId ?? -1
  };
}
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => typeof tab.id === "number").map(toTabInfo);
}
async function getTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return toTabInfo(tab);
  } catch (error) {
    throw new Error(`\u6807\u7B7E\u9875 ${tabId} \u4E0D\u5B58\u5728\u6216\u5DF2\u5173\u95ED: ${String(error)}`, { cause: error });
  }
}
async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  if (typeof tab.id !== "number") throw new Error("\u65B0\u5EFA\u6807\u7B7E\u9875\u6CA1\u6709\u8FD4\u56DE id");
  await waitForComplete(tab.id, 2e4);
  return getTab(tab.id);
}
async function activateTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== void 0) await chrome.windows.update(tab.windowId, { focused: true });
  return getTab(tabId);
}
async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
}
async function waitForComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch {
      return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// extension/src/background/page.ts
var MAX_ELEMENTS = 400;
var BLOCKED_SCHEMES = [
  "chrome://",
  "chrome-untrusted://",
  "chrome-extension://",
  "devtools://",
  "edge://",
  "about:",
  "view-source:",
  "https://chrome.google.com/webstore",
  "https://chromewebstore.google.com"
];
var PageError = class extends Error {
  /**
   * @param code 协议里的错误类别.
   * @param message 面向模型的中文说明.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PageError";
  }
};
function blockedReason(url) {
  for (const scheme of BLOCKED_SCHEMES) {
    if (url.startsWith(scheme)) {
      return `Chrome \u4E0D\u5141\u8BB8\u6269\u5C55\u5728 ${scheme} \u9875\u9762\u4E0A\u6CE8\u5165\u811A\u672C. \u8BF7\u6362\u4E00\u4E2A\u666E\u901A\u7F51\u9875, \u4F8B\u5982 https:// \u5F00\u5934\u7684\u7AD9\u70B9.`;
    }
  }
  return null;
}
async function runInTab(tabId, func, args) {
  const tab = await getTab(tabId);
  const reason = blockedReason(tab.url);
  if (reason !== null) throw new PageError("injection-blocked", reason);
  let first;
  try {
    const injected = chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func,
      args
    });
    first = (await injected)[0];
  } catch (error) {
    const message = String(error);
    if (message.includes("No tab with id")) {
      throw new PageError("stale-target", `\u6807\u7B7E\u9875 ${tabId} \u5DF2\u7ECF\u5173\u95ED, \u8BF7\u91CD\u65B0\u5217\u51FA\u6807\u7B7E\u9875`);
    }
    if (message.includes("Cannot access") || message.includes("The extensions gallery cannot be scripted")) {
      throw new PageError("injection-blocked", "\u8BE5\u9875\u9762\u7981\u6B62\u6269\u5C55\u6CE8\u5165\u811A\u672C, \u8BF7\u6362\u4E00\u4E2A\u666E\u901A\u7F51\u9875");
    }
    throw new PageError("injection-blocked", `\u6CE8\u5165\u9875\u9762\u5931\u8D25: ${message}`);
  }
  if (first === void 0) {
    throw new PageError("injection-blocked", "\u6CE8\u5165\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C, \u9875\u9762\u53EF\u80FD\u5904\u4E8E\u7279\u6B8A\u72B6\u6001 (\u4F8B\u5982\u6B63\u5728\u5BFC\u822A)");
  }
  return first.result;
}
function unwrap(value) {
  if (value.ok) return value;
  throw new PageError(value.code, value.message);
}
async function snapshotPage(tabId) {
  const raw = await runInTab(tabId, collectSnapshot, [SNAPSHOT_KEY, MAX_TEXT_CHARS, MAX_ELEMENTS]);
  return {
    url: raw.url,
    title: raw.title,
    token: raw.token,
    text: raw.text,
    elements: raw.elements,
    truncated: raw.truncated
  };
}
async function clickByIndex(tabId, token, index) {
  const value = await runInTab(tabId, clickElement, [SNAPSHOT_KEY, token, index]);
  return { note: unwrap(value).note };
}
async function fillByIndex(tabId, token, index, text, submit) {
  const value = await runInTab(tabId, fillElement, [SNAPSHOT_KEY, token, index, text, submit]);
  return { note: unwrap(value).note };
}
async function pressKeyInTab(tabId, key) {
  const value = await runInTab(tabId, pressKeyInPage, [key]);
  return { note: unwrap(value).note };
}
async function scrollInTab(tabId, direction, amount) {
  const value = await runInTab(tabId, scrollPage, [direction, amount]);
  return { note: unwrap(value).note };
}
async function readText(tabId) {
  const raw = await runInTab(tabId, collectSnapshot, [SNAPSHOT_KEY, MAX_TEXT_CHARS, 0]);
  return { url: raw.url, title: raw.title, text: raw.text, truncated: raw.truncated };
}
async function navigateTab(tabId, url, timeoutMs) {
  const tab = await getTab(tabId);
  const reason = blockedReason(url);
  if (reason !== null) throw new PageError("forbidden", reason);
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (error) {
    throw new PageError("stale-target", `\u5BFC\u822A\u5931\u8D25, \u6807\u7B7E\u9875 ${tabId} \u53EF\u80FD\u5DF2\u5173\u95ED: ${String(error)}`);
  }
  void tab;
  const completed = await waitForComplete(tabId, timeoutMs);
  const after = await getTab(tabId);
  return { url: after.url, title: after.title, completed };
}
async function waitForText(tabId, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  let lastTitle = "";
  for (; ; ) {
    try {
      const current = await readText(tabId);
      lastUrl = current.url;
      lastTitle = current.title;
      if (current.text.includes(needle)) {
        return { found: true, note: `\u5728 ${lastUrl} \u627E\u5230\u4E86 "${needle}"` };
      }
    } catch (error) {
      if (error instanceof PageError && error.code === "stale-target") throw error;
    }
    if (Date.now() >= deadline) {
      return {
        found: false,
        note: `\u7B49\u5F85 ${timeoutMs}ms \u540E\u4ECD\u672A\u5728 ${lastUrl} (${lastTitle}) \u627E\u5230 "${needle}"; \u53EF\u80FD\u662F\u52A0\u8F7D\u672A\u5B8C\u6210\u6216\u6587\u672C\u5728 iframe \u5185`
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// extension/src/background/index.ts
var LOG_PREFIX = "[dsh-browser]";
function log(level, message, detail) {
  const line = `${LOG_PREFIX} ${message}`;
  if (level === "error") console.error(line, detail ?? "");
  else if (level === "warn") console.warn(line, detail ?? "");
  else console.log(line, detail ?? "");
}
var boundTabId = null;
var extensionId = chrome.runtime.id;
function requireBinding() {
  if (boundTabId === null) {
    throw new PageError("no-binding", "\u5F53\u524D\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u6807\u7B7E\u9875. \u8BF7\u5148\u8C03\u7528 browser_tabs \u770B\u6E05\u5355, \u518D\u7528 browser_open \u6216 browser_select_tab \u9009\u4E2D\u4E00\u4E2A\u6807\u7B7E\u9875.");
  }
  return boundTabId;
}
async function ensureBoundTabAlive() {
  const tabId = requireBinding();
  try {
    await getTab(tabId);
    return tabId;
  } catch {
    boundTabId = null;
    throw new PageError("stale-target", `\u4E4B\u524D\u7ED1\u5B9A\u7684\u6807\u7B7E\u9875 ${tabId} \u5DF2\u7ECF\u5173\u95ED, \u8BF7\u91CD\u65B0\u5217\u51FA\u5E76\u9009\u62E9\u6807\u7B7E\u9875.`);
  }
}
async function dispatch(method, args) {
  switch (method) {
    case "tabs.list":
      return listTabs();
    case "tabs.activate": {
      const tabId = Number(args.tabId);
      const tab = await activateTab(tabId);
      boundTabId = tabId;
      return tab;
    }
    case "tabs.open": {
      const tab = await openTab(String(args.url));
      boundTabId = tab.id;
      return tab;
    }
    case "tabs.close": {
      const tabId = Number(args.tabId);
      await closeTab(tabId);
      if (boundTabId === tabId) boundTabId = null;
      return { closed: true };
    }
    case "page.snapshot":
      return snapshotPage(await ensureBoundTabAlive());
    case "page.navigate": {
      const tabId = await ensureBoundTabAlive();
      const result = await navigateTab(tabId, String(args.url), 25e3);
      if (!result.completed) {
        log("warn", `\u5BFC\u822A\u5230 ${result.url} \u672A\u5728 25s \u5185\u62A5\u544A\u52A0\u8F7D\u5B8C\u6210`);
      }
      return { url: result.url, title: result.title };
    }
    case "page.click":
      return clickByIndex(await ensureBoundTabAlive(), String(args.token), Number(args.index));
    case "page.fill":
      return fillByIndex(
        await ensureBoundTabAlive(),
        String(args.token),
        Number(args.index),
        String(args.text),
        args.submit === true
      );
    case "page.pressKey":
      return pressKeyInTab(await ensureBoundTabAlive(), String(args.key));
    case "page.scroll":
      return scrollInTab(
        await ensureBoundTabAlive(),
        args.direction === "up" ? "up" : "down",
        args.amount === void 0 ? void 0 : Number(args.amount)
      );
    case "page.text":
      return readText(await ensureBoundTabAlive());
    case "page.waitFor":
      return waitForText(await ensureBoundTabAlive(), String(args.text), Number(args.timeoutMs ?? 1e4));
    default:
      throw new PageError("internal", `\u672A\u77E5\u65B9\u6CD5 ${method}`);
  }
}
async function dispatchWithTimeout(frame) {
  const work = dispatch(frame.method, frame.args ?? {});
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new PageError("timeout", `\u64CD\u4F5C ${frame.method} \u8D85\u8FC7 ${frame.timeoutMs}ms \u4ECD\u672A\u8FD4\u56DE`));
    }, frame.timeoutMs);
  });
  return Promise.race([work, timeout]);
}
async function handleFrame(raw) {
  const frame = raw;
  if (frame.kind !== "call") {
    log("warn", "\u6536\u5230\u65E0\u6CD5\u8BC6\u522B\u7684\u5E27", raw);
    return;
  }
  const id = Number(frame.id);
  const method = String(frame.method);
  if (!isBrowserMethod(method)) {
    bridge.send(errorFrame(id, "internal", `\u4E0D\u652F\u6301\u7684\u8C03\u7528 ${method}, \u672C\u6269\u5C55\u534F\u8BAE\u7684\u7248\u672C\u53EF\u80FD\u548C\u5BBF\u4E3B\u4E0D\u4E00\u81F4`));
    return;
  }
  try {
    const value = await dispatchWithTimeout(frame);
    bridge.send(resultFrame(id, value));
  } catch (error) {
    if (error instanceof PageError) {
      bridge.send(errorFrame(id, error.code, error.message));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log("error", `\u8C03\u7528 ${method} \u5931\u8D25`, error);
    bridge.send(errorFrame(id, "internal", `\u6269\u5C55\u5185\u90E8\u9519\u8BEF: ${message}`));
  }
}
function resultFrame(id, value) {
  return { kind: "result", id, ok: true, value };
}
function errorFrame(id, code, message) {
  return { kind: "error", id, ok: false, error: { code, message } };
}
function greet() {
  bridge.send({
    kind: "event",
    event: "hello",
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      extensionId,
      version: chrome.runtime.getManifest().version,
      boundTabId
    }
  });
  if (boundTabId !== null) {
    void getTab(boundTabId).catch(() => {
      boundTabId = null;
    });
  }
}
var bridge = new NativeBridge(handleFrame, greet, log);
function statusSnapshot() {
  return { ...bridge.getStatus(), boundTabId, hostName: NATIVE_HOST_NAME };
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const request = message;
  if (request?.kind === "status") {
    respond(statusSnapshot());
    return true;
  }
  if (request?.kind === "reconnect") {
    bridge.connect();
    respond(statusSnapshot());
    return false;
  }
  return false;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (boundTabId === tabId) {
    boundTabId = null;
    bridge.send({ kind: "event", event: "detached", payload: { reason: "bound-tab-closed" } });
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === boundTabId && changeInfo.url !== void 0) {
    bridge.send({ kind: "event", event: "tab-changed", payload: { tabId, url: changeInfo.url } });
  }
});
log("info", `service worker \u542F\u52A8, \u6269\u5C55 id=${extensionId}, \u6B63\u5728\u8FDE\u63A5 native host ${NATIVE_HOST_NAME}`);
bridge.connect();

// shared/protocol.ts
var PROTOCOL_VERSION = 1;
var NATIVE_HOST_NAME = "com.azazo1.dsh_browser";
var MAX_TEXT_CHARS = 12e4;
var MAX_CONSOLE_READ_WAIT_MS = 1e4;

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
  "page.waitFor",
  "page.query",
  "page.hover",
  "page.uploadBegin",
  "page.uploadChunk",
  "page.uploadCommit",
  "page.uploadAbort",
  "page.screenshot",
  "page.evaluate",
  "console.start",
  "console.read",
  "console.stop"
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
  status = {
    hostConnected: false,
    linked: false,
    lastError: null,
    pairingError: null,
    attempts: 0
  };
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
        this.status = { ...this.status, linked: true, lastError: null, pairingError: null };
        this.emit();
        this.log("info", "native host \u5DF2\u8FDE\u4E0A dsh");
        this.onConnected();
        return;
      }
      if (frame?.kind === "event" && frame.event === "pairing-rejected") {
        this.status = { ...this.status, linked: false, pairingError: frame.payload?.reason ?? "dsh \u62D2\u7EDD\u4E86\u914D\u5BF9" };
        this.emit();
        this.log("warn", `dsh \u62D2\u7EDD\u914D\u5BF9: ${this.status.pairingError}`);
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

// extension/src/background/pairing.ts
var STORAGE_KEY = "dshBrowserPairingToken";
var cached = null;
var loading = null;
function newPairingToken() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function pairingToken() {
  if (cached !== null) return cached;
  loading ??= (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const existing = stored[STORAGE_KEY];
      if (typeof existing === "string" && existing !== "") {
        cached = existing;
        return existing;
      }
      const created = newPairingToken();
      await chrome.storage.local.set({ [STORAGE_KEY]: created });
      cached = created;
      return created;
    } finally {
      loading = null;
    }
  })();
  return await loading;
}
async function resetPairingToken() {
  const created = newPairingToken();
  await chrome.storage.local.set({ [STORAGE_KEY]: created });
  cached = created;
  return created;
}

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
var UPLOAD_KEY = "__dshBrowserUploads";
function queryElements(selector, limit, maxChars) {
  const clip = (value) => {
    const flat = value.replace(/\s+/gu, " ").trim();
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}...`;
  };
  let matched;
  try {
    matched = Array.from(globalThis.document.querySelectorAll(selector));
  } catch (error) {
    return {
      ok: false,
      code: "bad-selector",
      message: `\u9009\u62E9\u5668\u65E0\u6CD5\u89E3\u6790: ${selector} (${error instanceof Error ? error.message : String(error)})`
    };
  }
  const kept = matched.slice(0, limit);
  const items = kept.map((element, index) => {
    const attributes = {};
    for (const attribute of Array.from(element.attributes)) {
      attributes[attribute.name] = clip(attribute.value);
    }
    const candidate = element;
    const raw = typeof candidate.innerText === "string" ? candidate.innerText : element.textContent ?? "";
    return {
      index,
      tag: element.tagName.toLowerCase(),
      text: clip(raw),
      attributes
    };
  });
  return {
    ok: true,
    url: globalThis.location.href,
    title: globalThis.document.title,
    total: matched.length,
    truncated: matched.length > kept.length,
    items
  };
}
function hoverElement(snapshotKey, token, index) {
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
  const describe = (el) => {
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const label = (el.getAttribute("aria-label") ?? el.innerText ?? el.textContent ?? "").replace(/\s+/gu, " ").trim();
    const short = label.length > 60 ? `${label.slice(0, 60)}...` : label;
    return `<${role}> ${short}`.trim();
  };
  if (typeof element.scrollIntoView === "function") {
    ;
    element.scrollIntoView({ block: "center", inline: "center" });
  }
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const view = globalThis;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view };
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, button: -1, buttons: 0 };
  element.dispatchEvent(new PointerEvent("pointerover", pointer));
  element.dispatchEvent(new PointerEvent("pointerenter", { ...pointer, bubbles: false }));
  element.dispatchEvent(new MouseEvent("mouseover", base));
  element.dispatchEvent(new MouseEvent("mousemove", base));
  element.dispatchEvent(new MouseEvent("mouseenter", { ...base, bubbles: false }));
  return { ok: true, note: `\u5DF2\u60AC\u505C\u5230 ${describe(element)}; \u82E5\u4F9D\u8D56\u5B83\u51FA\u73B0\u83DC\u5355, \u8BF7\u7528 browser_snapshot \u786E\u8BA4\u662F\u5426\u51FA\u73B0\u65B0\u5143\u7D20` };
}
function uploadBegin(uploadKey, name, mime, bytes) {
  if (typeof bytes !== "number" || bytes < 0) {
    return { ok: false, code: "internal", message: `\u6587\u4EF6\u5B57\u8282\u6570\u65E0\u6548: ${String(bytes)}` };
  }
  const store = globalThis[uploadKey] ??= { sequence: 0, pending: {} };
  store.sequence += 1;
  const uploadId = `up-${String(store.sequence)}-${String(Date.now())}`;
  store.pending[uploadId] = { name, mime, bytes, chunks: [], received: 0 };
  return { ok: true, uploadId, note: `\u5DF2\u5F00\u59CB\u63A5\u6536 ${name} (${String(bytes)} \u5B57\u8282)` };
}
function uploadChunk(uploadKey, uploadId, data) {
  const store = globalThis[uploadKey];
  const entry = store?.pending[uploadId];
  if (entry === void 0) {
    return { ok: false, code: "internal", message: `\u6CA1\u6709\u627E\u5230\u4E0A\u4F20 ${uploadId} \u7684\u6682\u5B58\u533A, \u8BF7\u91CD\u65B0\u5F00\u59CB\u4E0A\u4F20` };
  }
  let binary;
  try {
    binary = globalThis.atob(data);
  } catch (error) {
    return { ok: false, code: "internal", message: `\u5206\u5757\u4E0D\u662F\u5408\u6CD5\u7684 base64: ${error instanceof Error ? error.message : String(error)}` };
  }
  const chunk = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) chunk[i] = binary.charCodeAt(i) & 255;
  entry.chunks.push(chunk);
  entry.received += chunk.length;
  if (entry.received > entry.bytes) {
    return { ok: false, code: "internal", message: `\u6536\u5230\u7684\u5185\u5BB9 (${String(entry.received)} \u5B57\u8282) \u8D85\u8FC7\u4E86\u58F0\u660E\u7684 ${String(entry.bytes)} \u5B57\u8282` };
  }
  return { ok: true, received: entry.received, note: `${entry.name} \u5DF2\u6536\u5230 ${String(entry.received)}/${String(entry.bytes)} \u5B57\u8282` };
}
function uploadCommit(uploadKey, selector, nth, uploadIds) {
  let candidates;
  try {
    candidates = Array.from(globalThis.document.querySelectorAll(selector));
  } catch (error) {
    return {
      ok: false,
      code: "bad-selector",
      message: `\u9009\u62E9\u5668\u65E0\u6CD5\u89E3\u6790: ${selector} (${error instanceof Error ? error.message : String(error)})`
    };
  }
  const inputs = candidates.filter((element) => element.tagName === "INPUT" && element.type === "file");
  if (inputs.length === 0) {
    return {
      ok: false,
      code: "unknown-element",
      message: `\u9009\u62E9\u5668 ${selector} \u6CA1\u6709\u5339\u914D\u5230 input[type=file]. \u9875\u9762\u4E0A\u73B0\u6709 ${String(candidates.length)} \u4E2A\u5143\u7D20\u5339\u914D\u8BE5\u9009\u62E9\u5668, \u4F46\u90FD\u4E0D\u662F\u6587\u4EF6\u8F93\u5165\u6846`
    };
  }
  const input = inputs[nth];
  if (input === void 0) {
    return { ok: false, code: "unknown-element", message: `\u9009\u62E9\u5668 ${selector} \u5339\u914D\u5230 ${String(inputs.length)} \u4E2A\u6587\u4EF6\u8F93\u5165\u6846, \u6CA1\u6709\u7B2C ${String(nth)} \u4E2A` };
  }
  const store = globalThis[uploadKey];
  if (store === void 0) {
    return { ok: false, code: "internal", message: "\u6682\u5B58\u533A\u4E0D\u89C1\u4E86, \u9875\u9762\u53EF\u80FD\u5DF2\u7ECF\u91CD\u65B0\u52A0\u8F7D, \u8BF7\u91CD\u65B0\u4E0A\u4F20" };
  }
  const built = [];
  for (const uploadId of uploadIds) {
    const entry = store.pending[uploadId];
    if (entry === void 0) {
      return { ok: false, code: "internal", message: `\u6CA1\u6709\u627E\u5230\u4E0A\u4F20 ${uploadId} \u7684\u5185\u5BB9, \u8BF7\u91CD\u65B0\u5F00\u59CB\u4E0A\u4F20` };
    }
    if (entry.received !== entry.bytes) {
      return {
        ok: false,
        code: "internal",
        message: `${entry.name} \u53EA\u6536\u5230 ${String(entry.received)}/${String(entry.bytes)} \u5B57\u8282, \u5185\u5BB9\u4E0D\u5B8C\u6574, \u672A\u88C5\u5165\u8F93\u5165\u6846`
      };
    }
    const merged = new Uint8Array(entry.received);
    let offset = 0;
    for (const chunk of entry.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    built.push(new File([merged], entry.name, { type: entry.mime }));
  }
  if (built.length > 1 && !input.multiple) {
    return {
      ok: false,
      code: "unknown-element",
      message: `\u8BE5\u8F93\u5165\u6846\u4E0D\u63A5\u53D7\u591A\u6587\u4EF6, \u4F46\u8FD9\u6B21\u51C6\u5907\u4E86 ${String(built.length)} \u4E2A; \u8BF7\u53EA\u4F20\u4E00\u4E2A\u6587\u4EF6`
    };
  }
  const transfer = new DataTransfer();
  for (const file of built) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  const actual = Array.from(input.files ?? []).map((file) => ({ name: file.name, bytes: file.size, mime: file.type }));
  if (actual.length !== built.length) {
    return {
      ok: false,
      code: "internal",
      message: `\u5DF2\u5C1D\u8BD5\u88C5\u5165 ${String(built.length)} \u4E2A\u6587\u4EF6, \u4F46\u8F93\u5165\u6846\u5F53\u524D\u53EA\u5269 ${String(actual.length)} \u4E2A, \u9875\u9762\u53EF\u80FD\u81EA\u884C\u91CD\u7F6E\u4E86\u9009\u62E9`
    };
  }
  for (const uploadId of uploadIds) delete store.pending[uploadId];
  const summary = actual.map((file) => `${file.name} (${String(file.bytes)} \u5B57\u8282)`).join(", ");
  return {
    ok: true,
    files: actual,
    note: `\u5DF2\u88C5\u5165 ${String(actual.length)} \u4E2A\u6587\u4EF6: ${summary}. \u82E5\u8868\u5355\u9700\u8981\u63D0\u4EA4, \u8BF7\u518D\u70B9\u63D0\u4EA4\u6309\u94AE`
  };
}
function uploadAbort(uploadKey, uploadIds) {
  const store = globalThis[uploadKey];
  let aborted = 0;
  for (const uploadId of uploadIds) {
    if (store !== void 0 && store.pending[uploadId] !== void 0) {
      delete store.pending[uploadId];
      aborted += 1;
    }
  }
  return { ok: true, aborted, note: `\u5DF2\u4E22\u5F03 ${String(aborted)} \u4E2A\u672A\u5B8C\u6210\u7684\u4E0A\u4F20` };
}

// extension/src/background/errors.ts
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
  const target = await getTab(tabId);
  const siblings = await chrome.tabs.query({ windowId: target.windowId });
  if (siblings.length <= 1) {
    throw new PageError(
      "last-tab",
      `\u6807\u7B7E\u9875 ${tabId} \u662F\u5B83\u6240\u5728\u7A97\u53E3\u7684\u6700\u540E\u4E00\u4E2A\u6807\u7B7E\u9875, \u5173\u6389\u5B83\u4F1A\u8FDE\u5E26\u5173\u95ED\u7A97\u53E3 (\u4EE5\u53CA\u53EF\u80FD\u9000\u51FA Chrome \u5E76\u65AD\u5F00\u6574\u6761\u94FE\u8DEF). \u8BF7\u5148\u5728\u540C\u4E00\u7A97\u53E3\u6253\u5F00\u4E00\u4E2A\u65B0\u6807\u7B7E\u9875 (browser_open \u4F20 url \u5373\u53EF), \u518D\u5173\u95ED\u8FD9\u4E00\u4E2A.`
    );
  }
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
function blockedReason(url) {
  for (const scheme of BLOCKED_SCHEMES) {
    if (url.startsWith(scheme)) {
      return `Chrome \u4E0D\u5141\u8BB8\u6269\u5C55\u5728 ${scheme} \u9875\u9762\u4E0A\u6CE8\u5165\u811A\u672C. \u8BF7\u6362\u4E00\u4E2A\u666E\u901A\u7F51\u9875, \u4F8B\u5982 https:// \u5F00\u5934\u7684\u7AD9\u70B9.`;
    }
  }
  return null;
}
function serializableArgs(args) {
  let end = args.length;
  while (end > 0 && args[end - 1] === void 0) end -= 1;
  const kept = args.slice(0, end);
  kept.forEach((value, index) => {
    if (value === void 0) {
      throw new PageError(
        "internal",
        `\u6CE8\u5165\u53C2\u6570\u7B2C ${String(index)} \u4E2A\u662F undefined (\u540E\u9762\u8FD8\u6709\u53C2\u6570), \u4F4D\u7F6E\u53C2\u6570\u4E0D\u5141\u8BB8\u7559\u7A7A; \u8BF7\u8BA9\u8BE5\u53C2\u6570\u6709\u5B9E\u9645\u53D6\u503C`
      );
    }
    const kind = typeof value;
    if (kind === "function" || kind === "symbol" || kind === "bigint") {
      throw new PageError("internal", `\u6CE8\u5165\u53C2\u6570\u7B2C ${String(index)} \u4E2A\u662F ${kind}, \u65E0\u6CD5\u4F20\u7ED9\u9875\u9762`);
    }
  });
  return kept;
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
      args: serializableArgs(args)
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
async function queryInTab(tabId, selector, limit, maxChars) {
  const value = await runInTab(tabId, queryElements, [selector, limit, maxChars]);
  const ok = unwrap(value);
  return {
    url: ok.url,
    title: ok.title,
    total: ok.total,
    truncated: ok.truncated,
    items: ok.items
  };
}
async function hoverByIndex(tabId, token, index) {
  return { note: unwrap(await runInTab(tabId, hoverElement, [SNAPSHOT_KEY, token, index])).note };
}
async function uploadBeginInTab(tabId, name, mime, bytes) {
  const value = await runInTab(tabId, uploadBegin, [UPLOAD_KEY, name, mime, bytes]);
  const ok = unwrap(value);
  return { uploadId: ok.uploadId, note: ok.note };
}
async function uploadChunkInTab(tabId, uploadId, data) {
  const value = await runInTab(tabId, uploadChunk, [UPLOAD_KEY, uploadId, data]);
  const ok = unwrap(value);
  return { received: ok.received, note: ok.note };
}
async function uploadCommitInTab(tabId, selector, nth, uploadIds) {
  const value = await runInTab(tabId, uploadCommit, [UPLOAD_KEY, selector, nth, uploadIds]);
  const ok = unwrap(value);
  return { files: ok.files, note: ok.note };
}
async function uploadAbortInTab(tabId, uploadIds) {
  const value = await runInTab(tabId, uploadAbort, [UPLOAD_KEY, uploadIds]);
  return { aborted: value.aborted, note: value.note };
}

// extension/src/background/screenshot.ts
async function readViewport(tabId) {
  const injected = chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (() => {
      return {
        width: Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1)),
        height: Math.round(globalThis.innerHeight * (globalThis.devicePixelRatio || 1)),
        url: globalThis.location.href
      };
    })
  });
  const first = (await injected)[0];
  const value = first?.result;
  if (value === void 0) {
    throw new PageError("injection-blocked", `\u65E0\u6CD5\u8BFB\u53D6 ${String(tabId)} \u53F7\u6807\u7B7E\u9875\u7684\u89C6\u53E3\u5C3A\u5BF8, \u8BE5\u9875\u9762\u53EF\u80FD\u4E0D\u5141\u8BB8\u811A\u672C\u6CE8\u5165`);
  }
  return value;
}
async function captureTab(tabId, format) {
  const tab = await getTab(tabId);
  const windowId = tab.windowId;
  await chrome.tabs.update(tabId, { active: true });
  if (typeof windowId === "number") {
    await chrome.windows.update(windowId, { focused: true }).catch(() => void 0);
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
  const viewport = await readViewport(tabId);
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PageError(
      "screenshot-failed",
      `\u622A\u56FE\u5931\u8D25: ${message}. \u5E38\u89C1\u539F\u56E0: \u76EE\u6807\u6807\u7B7E\u9875\u4E0D\u662F\u5F53\u524D\u53EF\u89C1\u7684\u90A3\u4E00\u4E2A, \u7A97\u53E3\u88AB\u6700\u5C0F\u5316, \u6216\u8005 Chrome \u7684\u5185\u90E8\u9875\u9762\u4E0D\u5141\u8BB8\u622A\u56FE; \u4E5F\u53EF\u80FD\u89E6\u53D1\u4E86 Chrome \u7684\u622A\u56FE\u9891\u7387\u9650\u5236 (\u6BCF\u79D2\u4E24\u6B21), \u7A0D\u540E\u91CD\u8BD5\u5373\u53EF`
    );
  }
  const prefix = `data:image/${format};base64,`;
  if (!dataUrl.startsWith(prefix)) {
    throw new PageError("screenshot-failed", `\u622A\u56FE\u8FD4\u56DE\u7684\u6570\u636E\u4E0D\u662F\u9884\u671F\u7684 ${format} data URL, \u5B9E\u9645\u5F00\u5934\u662F ${dataUrl.slice(0, 40)}`);
  }
  return {
    data: dataUrl.slice(prefix.length),
    format,
    width: viewport.width,
    height: viewport.height,
    url: viewport.url
  };
}

// extension/src/background/evaluate.ts
function userScriptsApi() {
  try {
    const chromeLike = chrome;
    return chromeLike.userScripts ?? null;
  } catch {
    return null;
  }
}
var TOGGLE_HINT = '\u8BF7\u5728 chrome://extensions \u6253\u5F00\u672C\u6269\u5C55\u7684\u8BE6\u60C5\u9875, \u6253\u5F00 "Allow User Scripts" \u5F00\u5173 (Chrome 138 \u4E4B\u524D\u662F\u6253\u5F00\u53F3\u4E0A\u89D2\u7684\u5F00\u53D1\u8005\u6A21\u5F0F), \u7136\u540E\u91CD\u65B0\u52A0\u8F7D\u6269\u5C55';
function buildEvaluateCode(expression) {
  return `(async () => {
  const MAX_DEPTH = 4;
  const MAX_ITEMS = 100;
  const MAX_STRING = 2000;
  const MAX_TOTAL = 20000;
  let truncated = false;
  const seen = new WeakSet();
  const clip = (text) => {
    if (text.length <= MAX_STRING) return text;
    truncated = true;
    return text.slice(0, MAX_STRING) + '...[\u5B57\u7B26\u4E32\u5DF2\u622A\u65AD]';
  };
  const describeNode = (node) => {
    const tag = (node.nodeName || 'node').toLowerCase();
    const id = node.id ? '#' + node.id : '';
    const cls = typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
    let text = '';
    try { text = (node.textContent || '').replace(/\\s+/g, ' ').trim(); } catch (e) { text = ''; }
    return '<' + tag + id + cls + '>' + (text ? ' ' + (text.length > 120 ? text.slice(0, 120) + '...' : text) : '');
  };
  const walk = (value, depth) => {
    const type = typeof value;
    if (value === null) return null;
    if (type === 'string') return clip(value);
    if (type === 'number') return Number.isFinite(value) ? value : String(value);
    if (type === 'boolean') return value;
    if (type === 'undefined') return '[undefined]';
    if (type === 'bigint') return value.toString() + 'n';
    if (type === 'symbol') return value.toString();
    if (type === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (depth >= MAX_DEPTH) { truncated = true; return '[\u5DF2\u8FBE\u6700\u5927\u6DF1\u5EA6 ' + MAX_DEPTH + ']'; }
    if (seen.has(value)) return '[\u5FAA\u73AF\u5F15\u7528]';
    seen.add(value);
    if (value instanceof Node) return describeNode(value);
    if (value instanceof Error) return '[Error ' + value.name + ': ' + value.message + ']';
    if (Array.isArray(value)) {
      const head = value.slice(0, MAX_ITEMS).map((item) => walk(item, depth + 1));
      if (value.length > MAX_ITEMS) {
        truncated = true;
        head.push('[\u8FD8\u6709 ' + (value.length - MAX_ITEMS) + ' \u9879]');
      }
      return head;
    }
    const out = {};
    let keys = [];
    try { keys = Object.keys(value); } catch (e) { return '[\u65E0\u6CD5\u8BFB\u53D6\u7684\u5BF9\u8C61]'; }
    for (const key of keys.slice(0, MAX_ITEMS)) {
      try { out[key] = walk(value[key], depth + 1); } catch (e) { out[key] = '[\u8BFB\u53D6\u65F6\u629B\u9519: ' + e.message + ']'; }
    }
    if (keys.length > MAX_ITEMS) {
      truncated = true;
      out['...'] = '[\u8FD8\u6709 ' + (keys.length - MAX_ITEMS) + ' \u4E2A\u5B57\u6BB5]';
    }
    return out;
  };
  const result = await (${expression});
  let text;
  try {
    text = JSON.stringify(walk(result, 0), null, 2);
  } catch (e) {
    return { value: '[\u7ED3\u679C\u65E0\u6CD5\u5E8F\u5217\u5316: ' + e.message + ']', truncated: true, valueType: typeof result };
  }
  if (typeof text !== 'string') text = String(text);
  if (text.length > MAX_TOTAL) {
    truncated = true;
    text = text.slice(0, MAX_TOTAL) + '\\n...[\u8F93\u51FA\u5DF2\u622A\u65AD]';
  }
  const valueType = result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result;
  return { value: text, truncated: truncated, valueType: valueType };
})()`;
}
function normalizeEvaluateResult(raw) {
  const value = raw;
  if (value === null || value === void 0 || typeof value !== "object") {
    throw new PageError("evaluate-failed", `\u6C42\u503C\u6CA1\u6709\u8FD4\u56DE\u9884\u671F\u7684\u7ED3\u679C\u5F62\u72B6: ${String(raw)}`);
  }
  return {
    value: typeof value.value === "string" ? value.value : String(value.value ?? ""),
    truncated: value.truncated === true,
    valueType: typeof value.valueType === "string" ? value.valueType : "unknown"
  };
}
async function evaluateInTab(tabId, expression, world) {
  const api = userScriptsApi();
  if (api === null) {
    throw new PageError(
      "evaluate-unavailable",
      `\u6D4F\u89C8\u5668\u6C42\u503C\u9700\u8981\u989D\u5916\u7684\u6743\u9650\u5F00\u5173, \u800C\u5B83\u73B0\u5728\u6CA1\u6253\u5F00. ${TOGGLE_HINT}. \u5982\u679C\u4E0D\u60F3\u5F00\u8FD9\u4E2A\u5F00\u5173, \u53EF\u4EE5\u6539\u7528 browser_query \u6309\u9009\u62E9\u5668\u53D6\u6570\u636E, \u6216\u8005\u7528 browser_text \u8BFB\u9875\u9762\u6B63\u6587`
    );
  }
  const code = buildEvaluateCode(expression);
  let results;
  try {
    results = await api.execute({
      target: { tabId },
      js: [{ code }],
      world: world === "main" ? "MAIN" : "USER_SCRIPT"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PageError("evaluate-failed", `\u6C42\u503C\u8C03\u7528\u5931\u8D25: ${message}. ${TOGGLE_HINT}`);
  }
  const first = results[0];
  if (first === void 0) {
    throw new PageError("evaluate-failed", "\u6C42\u503C\u6CA1\u6709\u8FD4\u56DE\u4EFB\u4F55\u7ED3\u679C, \u76EE\u6807\u6807\u7B7E\u9875\u53EF\u80FD\u6CA1\u6709\u53EF\u6CE8\u5165\u7684\u6587\u6863");
  }
  if (typeof first.error === "string" && first.error !== "") {
    throw new PageError("evaluate-threw", `\u9875\u9762\u91CC\u7684\u8868\u8FBE\u5F0F\u629B\u9519\u4E86: ${first.error}`);
  }
  return normalizeEvaluateResult(first.result);
}

// extension/src/background/console.ts
var MAX_ENTRIES = 1e3;
var MAX_ENTRY_CHARS = 2e3;
var READ_POLL_INTERVAL_MS = 200;
var STORAGE_KEY2 = "consoleCapture";
function formatRemoteObject(obj) {
  const preview = obj.preview;
  if (preview !== void 0) {
    const items = (preview.properties ?? []).map((property) => `${property.name}: ${property.value ?? formatRemoteObjectEmpty(property)}`);
    const body = items.join(", ") + (preview.overflow === true ? ", \u2026" : "");
    const open = preview.type === "array" ? "[" : "{";
    const close = preview.type === "array" ? "]" : "}";
    return `${open}${body}${close}`;
  }
  if (obj.type === "string") return JSON.stringify(obj.value);
  if (obj.value !== void 0) return String(obj.value);
  if (obj.unserializableValue !== void 0) return obj.unserializableValue;
  if (obj.description !== void 0) return obj.description;
  return `[${obj.type}]`;
}
function formatRemoteObjectEmpty(property) {
  if (property.subtype !== void 0) return `<${property.subtype}>`;
  if (property.type !== void 0) return `<${property.type}>`;
  return "<\u2026>";
}
function mapConsoleApiCalled(seq, params) {
  const frame = params.stackTrace?.[0];
  const text = truncateText((params.args ?? []).map(formatRemoteObject).join(" "));
  return {
    seq,
    level: levelOfType(params.type),
    type: params.type,
    text,
    url: frame?.url ? frame.url : null,
    line: typeof frame?.lineNumber === "number" ? frame.lineNumber + 1 : null,
    timestamp: params.timestamp ?? Date.now()
  };
}
function mapExceptionThrown(seq, params) {
  const details = params.exceptionDetails ?? {};
  const text = details.exception?.description ?? (details.exception?.value !== void 0 ? String(details.exception.value) : details.text ?? "Unknown error");
  return {
    seq,
    level: "error",
    type: "exception",
    text: truncateText(text),
    url: details.url ? details.url : null,
    line: typeof details.lineNumber === "number" ? details.lineNumber + 1 : null,
    timestamp: params.timestamp ?? Date.now()
  };
}
function levelOfType(type) {
  switch (type) {
    case "log":
      return "log";
    case "info":
      return "info";
    case "warning":
      return "warning";
    case "error":
    case "assert":
      return "error";
    case "debug":
      return "debug";
    default:
      return "other";
  }
}
function truncateText(text) {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}\u2026` : text;
}
function describeDetachReason(reason) {
  switch (reason) {
    case "canceled_by_user":
      return '\u7528\u6237\u70B9\u6389\u4E86"\u5DF2\u5F00\u59CB\u8C03\u8BD5\u6B64\u6D4F\u89C8\u5668"\u63D0\u793A\u6761';
    case "target_closed":
      return "\u76EE\u6807\u6807\u7B7E\u9875\u5DF2\u5173\u95ED";
    case "browser_forced":
      return "\u6D4F\u89C8\u5668\u5F3A\u5236\u5206\u79BB\u4E86\u8C03\u8BD5\u5668";
    case "injection_failed":
      return "\u8C03\u8BD5\u5668\u6CE8\u5165\u5931\u8D25";
    case "permission_denied":
      return "\u8C03\u8BD5\u6743\u9650\u88AB\u62D2\u7EDD";
    default:
      return `\u6D4F\u89C8\u5668\u5206\u79BB\u4E86\u8C03\u8BD5\u5668 (${reason})`;
  }
}
var state = null;
var loaded = false;
var intentionalDetach = false;
var persistChain = Promise.resolve();
async function restoreConsoleCapture() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY2);
    const restored = stored[STORAGE_KEY2];
    state = restored ?? null;
  } catch {
    state = null;
  }
  if (state?.capturing === true && state.tabId !== null) {
    try {
      await chrome.debugger.sendCommand({ tabId: state.tabId }, "Runtime.evaluate", { expression: "1" });
    } catch {
      state.capturing = false;
      state.interrupted ??= "\u6269\u5C55\u540E\u53F0\u88AB\u91CD\u542F, \u8C03\u8BD5\u5668\u8FDE\u63A5\u5DF2\u4E22\u5931";
      void persistState();
    }
  }
}
function consoleCaptureStatus() {
  return state?.capturing === true && state.tabId !== null ? { tabId: state.tabId } : null;
}
function persistState() {
  const chain = persistChain.then(async () => {
    if (state === null) await chrome.storage.session.remove(STORAGE_KEY2);
    else await chrome.storage.session.set({ [STORAGE_KEY2]: state });
  });
  persistChain = chain.catch(() => void 0);
  return chain;
}
function appendEntry(entry) {
  if (state === null) return;
  state.seq = Math.max(state.seq, entry.seq);
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  void persistState();
}
async function detachQuietly(tabId) {
  intentionalDetach = true;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    intentionalDetach = false;
  }
}
function installConsoleListeners() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    void handleDebuggerEvent(source, method, params);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    handleDetach(source, String(reason));
  });
}
async function handleDebuggerEvent(source, method, params) {
  if (!loaded) await restoreConsoleCapture();
  if (state === null || !state.capturing || source.tabId !== state.tabId) return;
  if (method === "Runtime.consoleAPICalled") {
    appendEntry(mapConsoleApiCalled(state.seq + 1, params));
    return;
  }
  if (method === "Runtime.exceptionThrown") {
    appendEntry(mapExceptionThrown(state.seq + 1, params));
  }
}
function handleDetach(source, reason) {
  if (intentionalDetach) {
    intentionalDetach = false;
    return;
  }
  if (state === null || !state.capturing || source.tabId !== state.tabId) return;
  state.capturing = false;
  state.interrupted = describeDetachReason(reason);
  void persistState();
}
async function startCapture(tabId) {
  await restoreConsoleCapture();
  if (state?.capturing === true && state.tabId !== null && state.tabId !== tabId) {
    await detachQuietly(state.tabId);
  }
  if (state?.capturing === true && state.tabId === tabId) {
    state.entries = [];
    state.interrupted = null;
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    void persistState();
    return { tabId, note: "\u8BE5\u6807\u7B7E\u9875\u5DF2\u7ECF\u5728\u6293\u53D6, \u7F13\u51B2\u5DF2\u6E05\u7A7A, \u4ECE\u73B0\u5728\u5F00\u59CB\u91CD\u65B0\u6536\u96C6." };
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cannot attach/i.test(message)) {
      throw new PageError(
        "injection-blocked",
        `\u65E0\u6CD5\u5BF9\u6807\u7B7E\u9875 ${String(tabId)} \u5F00\u542F console \u6293\u53D6: Chrome \u4E0D\u5141\u8BB8\u5728\u8FD9\u4E2A\u9875\u9762\u4E0A\u4F7F\u7528\u8C03\u8BD5\u5668, \u5E38\u89C1\u4E8E chrome:// \u7B49\u5185\u90E8\u9875\u9762. \u8BF7\u6362\u4E00\u4E2A\u666E\u901A\u7F51\u9875.`
      );
    }
    throw new PageError("internal", `\u5BF9\u6807\u7B7E\u9875 ${String(tabId)} \u9644\u52A0\u8C03\u8BD5\u5668\u5931\u8D25: ${message}`);
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  } catch (error) {
    await detachQuietly(tabId);
    const message = error instanceof Error ? error.message : String(error);
    throw new PageError("internal", `\u5F00\u542F Runtime \u57DF\u5931\u8D25, \u5DF2\u653E\u5F03\u6293\u53D6: ${message}`);
  }
  state = { tabId, capturing: true, seq: 0, entries: [], interrupted: null };
  void persistState();
  return {
    tabId,
    note: '\u5DF2\u5F00\u59CB\u6293\u53D6 console (\u53EA\u6536\u96C6\u4ECE\u73B0\u5728\u5F00\u59CB\u7684\u8F93\u51FA, \u4E0D\u542B\u5386\u53F2). \u6D4F\u89C8\u5668\u9876\u90E8\u4F1A\u51FA\u73B0"\u5DF2\u5F00\u59CB\u8C03\u8BD5\u6B64\u6D4F\u89C8\u5668"\u63D0\u793A\u6761, \u5C5E\u6B63\u5E38\u73B0\u8C61, \u9875\u9762\u68C0\u6D4B\u4E0D\u5230; \u5B8C\u6210\u6536\u96C6\u540E\u8BF7\u7528 action:"stop" \u7ED3\u675F, \u63D0\u793A\u6761\u968F\u4E4B\u6D88\u5931.'
  };
}
async function readEntries(waitMs) {
  await restoreConsoleCapture();
  if (state === null) {
    throw new PageError(
      "internal",
      '\u5F53\u524D\u6CA1\u6709 console \u6293\u53D6\u4F1A\u8BDD. \u8BF7\u5148\u7528 action:"start" \u5F00\u59CB\u6293\u53D6, \u518D\u6267\u884C\u60F3\u89C2\u5BDF\u7684\u9875\u9762\u64CD\u4F5C.'
    );
  }
  const deadline = Date.now() + waitMs;
  while (state.entries.length === 0 && state.capturing && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, READ_POLL_INTERVAL_MS));
  }
  const entries = state.entries;
  state.entries = [];
  const capturing = state.capturing;
  const interrupted = state.interrupted;
  void persistState();
  const note = buildReadNote(entries.length, capturing, interrupted, waitMs);
  return { entries, capturing, interrupted, note };
}
function buildReadNote(count, capturing, interrupted, waitMs) {
  const parts = [`\u8FD4\u56DE ${String(count)} \u6761`];
  if (capturing) {
    parts.push("\u6293\u53D6\u4ECD\u5728\u8FDB\u884C");
    if (count === 0 && waitMs > 0) parts.push(`\u5DF2\u7B49\u5F85 ${String(waitMs)}ms \u4ECD\u6CA1\u6709\u65B0\u8F93\u51FA`);
    else if (count === 0) parts.push("\u671F\u95F4\u6CA1\u6709\u65B0\u8F93\u51FA; \u53EF\u4EE5\u628A\u64CD\u4F5C\u518D\u6267\u884C\u4E00\u904D\u540E\u5E26\u4E0A wait_ms \u91CD\u8BFB, \u6216\u76F4\u63A5 stop \u7ED3\u675F");
  } else if (interrupted !== null) {
    parts.push(`\u6293\u53D6\u5DF2\u4E2D\u65AD (${interrupted}); \u7F13\u51B2\u91CC\u7684\u6761\u76EE\u4ECD\u53EF\u8BFB, \u9700\u8981\u7EE7\u7EED\u8BF7\u91CD\u65B0 action:"start"`);
  } else {
    parts.push("\u6293\u53D6\u5DF2\u505C\u6B62");
  }
  return parts.join("; ");
}
async function stopCapture() {
  await restoreConsoleCapture();
  if (state === null) {
    return { entries: [], capturing: false, interrupted: null, note: "\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684 console \u6293\u53D6." };
  }
  if (state.capturing && state.tabId !== null) await detachQuietly(state.tabId);
  state.capturing = false;
  state.interrupted = null;
  const entries = state.entries;
  state.entries = [];
  void persistState();
  return { entries, capturing: false, interrupted: null, note: `\u5DF2\u505C\u6B62\u6293\u53D6, \u8FD4\u56DE\u6700\u540E ${String(entries.length)} \u6761.` };
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
      notifyBound(tabId);
      return tab;
    }
    case "tabs.open": {
      const tab = await openTab(String(args.url));
      boundTabId = tab.id;
      notifyBound(tab.id);
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
    case "page.query":
      return queryInTab(
        await ensureBoundTabAlive(),
        String(args.selector),
        Number(args.limit ?? 50),
        Number(args.maxChars ?? 200)
      );
    case "page.hover":
      return hoverByIndex(await ensureBoundTabAlive(), String(args.token), Number(args.index));
    case "page.uploadBegin":
      return uploadBeginInTab(
        await ensureBoundTabAlive(),
        String(args.name),
        String(args.mime),
        Number(args.bytes)
      );
    case "page.uploadChunk":
      return uploadChunkInTab(await ensureBoundTabAlive(), String(args.uploadId), String(args.data));
    case "page.uploadCommit":
      return uploadCommitInTab(
        await ensureBoundTabAlive(),
        String(args.selector),
        Number(args.nth ?? 0),
        args.uploadIds
      );
    case "page.uploadAbort":
      return uploadAbortInTab(await ensureBoundTabAlive(), args.uploadIds);
    case "page.screenshot":
      return captureTab(await ensureBoundTabAlive(), args.format === "jpeg" ? "jpeg" : "png");
    case "page.evaluate":
      return evaluateInTab(
        await ensureBoundTabAlive(),
        String(args.expression),
        args.world === "main" ? "main" : "isolated"
      );
    case "console.start":
      return startCapture(await ensureBoundTabAlive());
    case "console.read":
      return readEntries(Math.min(Math.max(Number(args.waitMs ?? 0), 0), MAX_CONSOLE_READ_WAIT_MS));
    case "console.stop":
      return stopCapture();
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
var cachedPairingToken = "";
async function loadPairingToken() {
  try {
    cachedPairingToken = await pairingToken();
  } catch (error) {
    log("warn", `\u8BFB\u53D6\u914D\u5BF9\u4EE4\u724C\u5931\u8D25: ${String(error)}`);
  }
}
function greet() {
  bridge.send({
    kind: "event",
    event: "hello",
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      extensionId,
      version: chrome.runtime.getManifest().version,
      boundTabId,
      userScripts: userScriptsAvailable(),
      pairingToken: cachedPairingToken,
      consoleCapturing: consoleCaptureStatus()
    }
  });
  if (boundTabId !== null) {
    void getTab(boundTabId).catch(() => {
      boundTabId = null;
    });
  }
}
var bridge = new NativeBridge(handleFrame, greet, log);
function userScriptsAvailable() {
  try {
    return chrome.userScripts !== void 0;
  } catch {
    return false;
  }
}
function statusSnapshot() {
  return {
    ...bridge.getStatus(),
    boundTabId,
    hostName: NATIVE_HOST_NAME,
    userScripts: userScriptsAvailable(),
    pairingToken: cachedPairingToken,
    consoleCapturing: consoleCaptureStatus()
  };
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
  if (request?.kind === "reset-pairing") {
    void resetPairingToken().then(async (token) => {
      cachedPairingToken = token;
      bridge.disconnect();
      bridge.connect();
      log("info", "\u914D\u5BF9\u4EE4\u724C\u5DF2\u91CD\u65B0\u751F\u6210, \u9700\u8981\u5728 dsh \u914D\u7F6E\u91CC\u66F4\u65B0");
    });
    respond(statusSnapshot());
    return false;
  }
  return false;
});
function notifyBound(tabId) {
  bridge.send({ kind: "event", event: "bound", payload: { tabId } });
}
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
installConsoleListeners();
void restoreConsoleCapture();
void loadPairingToken().then(() => {
  bridge.connect();
});

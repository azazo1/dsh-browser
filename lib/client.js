// 由 scripts/build.mjs 生成, 请勿直接编辑; 改 src/client/ 后重新构建.
window.__ModuleLoader__.load({
  id: "dsh-browser",
  factory: (require) => {
var __dshBrowserClient = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/client/index.ts
  var index_exports = {};
  __export(index_exports, {
    NS: () => NS,
    apply: () => apply,
    inject: () => inject
  });

  // src/client/BrowserSettings.tsx
  var import_react = __require("react");
  var import_dsh_client_ui_primitives = __require("@deepseek-ai/dsh-client-ui-primitives");

  // src/client/api.ts
  var API = "/dsh-browser/api";
  async function request(path, init) {
    const response = await fetch(`${API}${path}`, {
      // 同源请求需要带上 dsh 的登录令牌 cookie, 否则会被 Host 的鉴权挡下.
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers }
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new Error(`\u63A5\u53E3 ${path} \u8FD4\u56DE\u4E86\u975E JSON \u5185\u5BB9 (HTTP ${String(response.status)}): ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const message = parsed.error;
      throw new Error(typeof message === "string" ? message : `\u63A5\u53E3 ${path} \u5931\u8D25, HTTP ${String(response.status)}`);
    }
    return parsed;
  }
  async function fetchStatus() {
    return request("/status");
  }
  async function installHost() {
    return request("/install", { method: "POST", body: "{}" });
  }
  async function uninstallHost() {
    return request("/uninstall", { method: "POST", body: "{}" });
  }

  // src/client/BrowserSettings.tsx
  var import_jsx_runtime = __require("react/jsx-runtime");
  var styles = {
    root: { display: "flex", flexDirection: "column", gap: 16, padding: "16px 0" },
    headline: { display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 14, fontWeight: 500 },
    checks: { display: "flex", flexDirection: "column" },
    check: {
      display: "grid",
      gridTemplateColumns: "auto 140px 1fr",
      alignItems: "center",
      gap: 8,
      padding: "12px 0",
      borderBottom: "0.5px solid var(--dsw-alias-border-l2)"
    },
    checkName: { fontSize: 13, fontWeight: 500 },
    checkDetail: {
      fontSize: 12,
      color: "var(--dsw-alias-label-tertiary)",
      overflowWrap: "anywhere"
    },
    actions: { display: "flex", gap: 8, flexWrap: "wrap" },
    manual: { display: "flex", flexDirection: "column", gap: 8 },
    sectionTitle: { margin: 0, fontSize: 13, fontWeight: 500 },
    path: { display: "flex", gap: 8, alignItems: "center" },
    steps: {
      margin: 0,
      paddingInlineStart: 18,
      fontSize: 12,
      color: "var(--dsw-alias-label-tertiary)",
      lineHeight: 1.7
    },
    hint: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6 },
    error: {
      margin: 0,
      fontSize: 12,
      color: "var(--dsw-alias-state-error-primary)",
      lineHeight: 1.6
    },
    details: { display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" },
    detailList: { display: "flex", flexDirection: "column", gap: 6, width: "100%" },
    detailRow: {
      display: "grid",
      gridTemplateColumns: "120px 1fr",
      gap: 8,
      fontSize: 12,
      alignItems: "baseline"
    },
    detailLabel: { color: "var(--dsw-alias-label-tertiary)" },
    detailValue: { overflowWrap: "anywhere", fontFamily: "var(--dsw-font-mono, monospace)" }
  };
  function checks(status) {
    return [
      {
        key: "checkChrome",
        ok: status.chromePath !== null,
        detail: status.chromePath ?? status.chromeError ?? ""
      },
      {
        key: "checkHost",
        ok: status.manifestReady,
        // manifestStale 说明装过但内容与当前配置不符 (换了数据目录或换了密钥), 需要重装.
        detail: status.manifestStale ? "\u6E05\u5355\u5185\u5BB9\u4E0E\u5F53\u524D\u914D\u7F6E\u4E0D\u4E00\u81F4" : status.manifestPath ?? ""
      },
      {
        key: "checkExtension",
        ok: status.bridgeConnected,
        detail: status.extensionVersion === null ? "\u6269\u5C55\u5C1A\u672A\u8FDE\u4E0A" : `\u6269\u5C55\u7248\u672C ${status.extensionVersion}`
      },
      {
        key: "checkEvaluate",
        // 求值不是必须的: 没开这个开关, 其余 16 个工具照常可用, 所以它不该让整行变红,
        // 只在未开启时说明怎么开.
        ok: status.userScriptsAvailable !== false,
        detail: status.userScriptsAvailable === null ? "\u6269\u5C55\u672A\u8FDE\u4E0A, \u72B6\u6001\u672A\u77E5" : status.userScriptsAvailable ? "browser_evaluate \u53EF\u7528" : "\u672A\u542F\u7528; \u5728\u6269\u5C55\u8BE6\u60C5\u9875\u6253\u5F00 Allow User Scripts \u540E browser_evaluate \u53EF\u7528"
      },
      {
        key: "checkBinding",
        ok: status.boundTabId !== null,
        detail: status.boundTabId === null ? "\u5C1A\u672A\u7ED1\u5B9A\u6807\u7B7E\u9875 (\u5728\u4F1A\u8BDD\u91CC\u8C03\u7528 browser_tabs \u540E\u9009\u62E9)" : `id=${String(status.boundTabId)}`
      }
    ];
  }
  function DetailRow(props) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.detailRow, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.detailLabel, children: props.label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { style: styles.detailValue, children: props.value === "" ? "-" : props.value })
    ] });
  }
  function BrowserSettings(props) {
    const [status, setStatus] = (0, import_react.useState)(null);
    const [error, setError] = (0, import_react.useState)(null);
    const [busy, setBusy] = (0, import_react.useState)(null);
    const [showDetails, setShowDetails] = (0, import_react.useState)(false);
    const [copied, setCopied] = (0, import_react.useState)(false);
    const load = (0, import_react.useCallback)(async () => {
      try {
        const next = await fetchStatus();
        setStatus(next);
        setError(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }, []);
    (0, import_react.useEffect)(() => {
      void load();
      const timer = setInterval(() => {
        void load();
      }, 3e3);
      return () => {
        clearInterval(timer);
      };
    }, [load]);
    const act = (0, import_react.useCallback)(async (kind) => {
      setBusy(kind);
      try {
        const next = kind === "install" ? await installHost() : await uninstallHost();
        setStatus(next);
        setError(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(null);
      }
    }, []);
    const rows = (0, import_react.useMemo)(() => status === null ? [] : checks(status), [status]);
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.root, children: [
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, role: "alert", children: error }),
      status === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.hint, children: props.t("loading") }),
      status !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.headline, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: status.ready ? "done" : "warning" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: props.t(status.ready ? "ready" : "notReady") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.checks, children: rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.check, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: row.ok ? "done" : "warning" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.checkName, children: props.t(row.key) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.checkDetail, children: row.detail })
        ] }, row.key)) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.actions, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: busy !== null, onClick: () => {
            void act("install");
          }, children: busy === "install" ? props.t("installing") : props.t("install") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            import_dsh_client_ui_primitives.Button,
            {
              variant: "outline",
              disabled: busy !== null || !status.manifestReady,
              onClick: () => {
                void act("uninstall");
              },
              children: props.t("uninstall")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy !== null, onClick: () => {
            void load();
          }, children: props.t("refresh") })
        ] }),
        status.manifestStale && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.hint, children: props.t("stale") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: styles.manual, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: styles.sectionTitle, children: props.t("manualTitle") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.hint, children: props.t("manualLoad") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.path, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { readOnly: true, value: status.extensionDir }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              import_dsh_client_ui_primitives.Button,
              {
                variant: "outline",
                onClick: () => {
                  void navigator.clipboard.writeText(status.extensionDir).then(() => {
                    setCopied(true);
                    setTimeout(() => {
                      setCopied(false);
                    }, 1500);
                  }, () => {
                  });
                },
                children: copied ? props.t("copied") : props.t("copy")
              }
            )
          ] }),
          status.manualSteps.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: styles.steps, children: status.manualSteps.map((step) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: step }, step)) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: styles.details, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: () => {
            setShowDetails((value) => !value);
          }, children: props.t("details") }),
          showDetails && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.detailList, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailRow, { label: props.t("chromePath"), value: status.chromePath ?? "" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailRow, { label: props.t("profileDir"), value: status.profileDir }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailRow, { label: props.t("extensionDir"), value: status.extensionDir }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailRow, { label: props.t("manifestPath"), value: status.manifestPath ?? "" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailRow, { label: props.t("extensionId"), value: status.extensionId ?? "" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailRow, { label: props.t("interpreter"), value: status.interpreter }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailRow, { label: props.t("launchArgs"), value: status.launchArgs?.join(" ") ?? "" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              DetailRow,
              {
                label: props.t("boundTab"),
                value: status.boundTabId === null ? props.t("none") : String(status.boundTabId)
              }
            )
          ] })
        ] })
      ] })
    ] });
  }

  // src/client/strings.ts
  var zh = {
    title: "\u6D4F\u89C8\u5668\u8FDE\u63A5",
    description: "\u4E0D\u4F7F\u7528 Chrome \u8C03\u8BD5\u534F\u8BAE, \u901A\u8FC7\u6D4F\u89C8\u5668\u6269\u5C55\u4E0E native messaging \u9A71\u52A8\u672C\u673A\u7684 Google Chrome.",
    loading: "\u6B63\u5728\u8BFB\u53D6\u72B6\u6001...",
    ready: "\u53EF\u4EE5\u5F00\u59CB\u4F7F\u7528",
    notReady: "\u8FD8\u6CA1\u6709\u5C31\u7EEA",
    checkChrome: "Chrome",
    checkHost: "\u8FDE\u63A5\u7EC4\u4EF6",
    checkExtension: "\u6269\u5C55\u8FDE\u63A5",
    checkBinding: "\u7ED1\u5B9A\u6807\u7B7E\u9875",
    checkEvaluate: "\u6D4F\u89C8\u5668\u6C42\u503C",
    install: "\u5B89\u88C5\u8FDE\u63A5\u7EC4\u4EF6",
    uninstall: "\u5378\u8F7D\u8FDE\u63A5\u7EC4\u4EF6",
    refresh: "\u5237\u65B0\u72B6\u6001",
    installing: "\u6B63\u5728\u5B89\u88C5...",
    manualTitle: "\u9700\u8981\u624B\u52A8\u5B8C\u6210\u7684\u4E00\u6B65",
    manualLoad: 'Chrome \u53EA\u5141\u8BB8\u7528\u6237\u672C\u4EBA\u52A0\u8F7D\u672A\u6253\u5305\u7684\u6269\u5C55. \u6253\u5F00 chrome://extensions, \u5F00\u542F\u53F3\u4E0A\u89D2\u7684\u5F00\u53D1\u8005\u6A21\u5F0F, \u70B9"\u52A0\u8F7D\u5DF2\u89E3\u538B\u7684\u6269\u5C55\u7A0B\u5E8F", \u7136\u540E\u9009\u4E2D\u4E0B\u9762\u8FD9\u4E2A\u76EE\u5F55. \u88C5\u4E00\u6B21\u5373\u53EF, \u4E4B\u540E\u91CD\u542F\u6D4F\u89C8\u5668\u90FD\u4F1A\u81EA\u52A8\u52A0\u8F7D.',
    copy: "\u590D\u5236\u8DEF\u5F84",
    copied: "\u5DF2\u590D\u5236",
    details: "\u67E5\u770B\u7EC6\u8282",
    chromePath: "Chrome \u8DEF\u5F84",
    profileDir: "\u6301\u4E45 profile",
    extensionDir: "\u6269\u5C55\u76EE\u5F55",
    manifestPath: "native \u6E05\u5355",
    extensionId: "\u6269\u5C55 id",
    interpreter: "\u89E3\u91CA\u5668",
    launchArgs: "\u542F\u52A8\u53C2\u6570",
    boundTab: "\u7ED1\u5B9A\u6807\u7B7E\u9875",
    none: "\u65E0",
    stale: '\u68C0\u6D4B\u5230\u5DF2\u88C5\u7684\u8FDE\u63A5\u7EC4\u4EF6\u4E0E\u5F53\u524D\u914D\u7F6E\u4E0D\u4E00\u81F4 (\u53EF\u80FD\u6362\u8FC7\u6570\u636E\u76EE\u5F55\u6216\u6269\u5C55\u5BC6\u94A5). \u70B9"\u5B89\u88C5\u8FDE\u63A5\u7EC4\u4EF6"\u5373\u53EF\u91CD\u88C5.'
  };
  var en = {
    title: "Browser connection",
    description: "Drives your local Google Chrome through a browser extension and native messaging. No Chrome DevTools Protocol.",
    loading: "Reading status...",
    ready: "Ready to use",
    notReady: "Not ready yet",
    checkChrome: "Chrome",
    checkHost: "Connection pieces",
    checkExtension: "Extension link",
    checkBinding: "Bound tab",
    checkEvaluate: "In-page evaluate",
    install: "Install connection pieces",
    uninstall: "Uninstall connection pieces",
    refresh: "Refresh",
    installing: "Installing...",
    manualTitle: "One manual step",
    manualLoad: 'Chrome only lets the user load an unpacked extension. Open chrome://extensions, turn on Developer mode, click "Load unpacked", and select the directory below. This is needed once; later browser restarts load it automatically.',
    copy: "Copy path",
    copied: "Copied",
    details: "Show details",
    chromePath: "Chrome path",
    profileDir: "Persistent profile",
    extensionDir: "Extension dir",
    manifestPath: "Native manifest",
    extensionId: "Extension id",
    interpreter: "Interpreter",
    launchArgs: "Launch args",
    boundTab: "Bound tab",
    none: "none",
    stale: 'The installed connection pieces do not match the current configuration (the data directory or extension key changed). Click "Install connection pieces" to reinstall.'
  };

  // src/client/index.ts
  var NS = "settings.dsh-browser";
  var PACKAGE_NAME = "dsh-browser";
  var inject = ["slots", "locale"];
  function apply(ctx) {
    const t = ctx.locale.bind(NS);
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-browser: dictionaries");
    ctx.effect(() => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
      name: "plugins.bundle.config",
      key: PACKAGE_NAME,
      // 组件从 props 读 t; 数据由组件自己经同源接口取, 不用 store 也不订阅外部快照.
      inject: () => ({ t: (key) => t(key) })
    }, BrowserSettings)), "dsh-browser: settings page");
  }
  return __toCommonJS(index_exports);
})();

    return __dshBrowserClient;
  },
});

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
    TAB_NS: () => TAB_NS,
    apply: () => apply,
    inject: () => inject
  });

  // src/client/BrowserSettings.tsx
  var import_react = __require("react");
  var import_dsh_client_ui_primitives = __require("@deepseek-ai/dsh-client-ui-primitives");

  // shared/status.ts
  function sameUserDataDir(left, right) {
    const normalize = (value) => value.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return normalize(left) === normalize(right);
  }
  function extensionLinkCounts(status) {
    if (!status.launchStandaloneChromeProfile) return status.bridgeConnected;
    if (!status.bridgeConnected) return false;
    const peer = status.peerUserDataDir;
    if (typeof peer === "string" && peer !== "") return sameUserDataDir(peer, status.profileDir);
    return status.launchArgs !== null;
  }

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
  async function acquireBrowser(sessionId) {
    return request("/acquire", { method: "POST", body: JSON.stringify({ sessionId }) });
  }
  async function releaseBrowser(sessionId) {
    return request("/release", { method: "POST", body: JSON.stringify({ sessionId }) });
  }

  // src/client/checks.ts
  function checks(status) {
    return [
      {
        key: "checkChrome",
        // 找不到 Chrome 就什么都做不了, 所以这是 error 而不是 warning.
        state: status.chromePath === null ? "error" : "done",
        detail: status.chromePath ?? status.chromeError ?? ""
      },
      {
        key: "checkHost",
        // manifestStale 说明装过但内容与当前配置不符 (换了数据目录或换了密钥), 需要重装.
        // 它可修 (旁边的按钮就是干这个的), 所以是 warning; 完全没装才是 error.
        state: status.manifestStale ? "warning" : status.manifestReady ? "done" : "error",
        detail: status.manifestStale ? "\u6E05\u5355\u5185\u5BB9\u4E0E\u5F53\u524D\u914D\u7F6E\u4E0D\u4E00\u81F4" : status.manifestPath ?? ""
      },
      {
        key: "checkExtension",
        ...extensionRow(status)
      },
      {
        key: "checkLaunch",
        // 这一项讲的是"用哪个浏览器", 本身没有对错: 允许 dsh 自己启动是一种用法, 只用用户
        // 现有的浏览器是另一种.
        state: status.launchStandaloneChromeProfile || status.bridgeConnected ? "done" : "warning",
        detail: status.launchStandaloneChromeProfile ? "\u4F1A\u542F\u52A8\u72EC\u7ACB profile \u7684 Chrome, \u4E0D\u590D\u7528\u65E5\u5E38\u7A97\u53E3 (\u8BE5 profile \u9700\u5355\u72EC\u52A0\u8F7D\u4E00\u6B21\u6269\u5C55)" : status.bridgeConnected ? "\u53EA\u7528\u4F60\u73B0\u6709\u7684\u6D4F\u89C8\u5668 (\u6269\u5C55\u5DF2\u8FDE\u4E0A), \u4E0D\u81EA\u884C\u542F\u52A8 Chrome" : "\u53EA\u7528\u4F60\u73B0\u6709\u7684\u6D4F\u89C8\u5668; \u8BF7\u6253\u5F00\u88C5\u4E86\u6269\u5C55\u7684\u90A3\u4E2A Chrome"
      },
      {
        key: "checkPairing",
        // 没配对令牌时整条链路都用不了, 所以是 error.
        state: status.pairingConfigured && status.pairingError === null ? "done" : "error",
        detail: status.pairingError !== null ? status.pairingError : status.pairingConfigured ? "\u5DF2\u914D\u7F6E; \u6269\u5C55\u63E1\u624B\u65F6\u4F1A\u6838\u5BF9" : "\u5C1A\u672A\u914D\u7F6E: \u6253\u5F00\u6D4F\u89C8\u5668\u6269\u5C55\u7684\u5F39\u51FA\u9762\u677F, \u590D\u5236\u5176\u4E2D\u7684\u914D\u5BF9\u4EE4\u724C\u586B\u5230\u672C\u63D2\u4EF6\u7684 pairingToken \u914D\u7F6E\u9879"
      },
      {
        key: "checkEvaluate",
        ...evaluateRow(status)
      },
      {
        key: "checkBinding",
        ...bindingRow(status)
      }
    ];
  }
  function standalonePending(status) {
    return status.launchStandaloneChromeProfile && !extensionLinkCounts(status) && status.launchArgs === null;
  }
  function extensionRow(status) {
    if (standalonePending(status)) {
      return {
        state: "idle",
        detail: status.bridgeConnected ? "\u5F53\u524D\u8FDE\u7740\u7684\u662F\u65E5\u5E38 Chrome, \u72EC\u7ACB profile \u5C1A\u672A\u542F\u52A8 (\u4E0D\u4F1A\u590D\u7528)" : "\u7B2C\u4E00\u6B21\u4F7F\u7528\u65F6\u4F1A\u542F\u52A8\u72EC\u7ACB profile; \u8BF7\u5728\u90A3\u4E2A\u7A97\u53E3\u52A0\u8F7D\u6269\u5C55"
      };
    }
    if (status.launchStandaloneChromeProfile && !status.bridgeConnected) {
      return {
        state: "warning",
        detail: "\u72EC\u7ACB profile \u5DF2\u542F\u52A8\u4F46\u6269\u5C55\u672A\u8FDE\u4E0A, \u8BF7\u5728\u90A3\u4E2A\u7A97\u53E3\u52A0\u8F7D\u6269\u5C55"
      };
    }
    return {
      state: extensionLinkCounts(status) ? "done" : "warning",
      detail: status.extensionVersion === null ? "\u6269\u5C55\u5C1A\u672A\u8FDE\u4E0A" : `\u6269\u5C55\u7248\u672C ${status.extensionVersion}`
    };
  }
  function evaluateRow(status) {
    if (standalonePending(status)) {
      return { state: "idle", detail: "\u72EC\u7ACB profile \u5C1A\u672A\u542F\u52A8, \u72B6\u6001\u672A\u77E5" };
    }
    if (status.userScriptsAvailable === null) {
      return { state: "idle", detail: "\u6269\u5C55\u672A\u8FDE\u4E0A, \u72B6\u6001\u672A\u77E5" };
    }
    return {
      state: status.userScriptsAvailable ? "done" : "warning",
      detail: status.userScriptsAvailable ? "browser_evaluate \u53EF\u7528" : "\u672A\u542F\u7528; \u5728\u6269\u5C55\u8BE6\u60C5\u9875\u6253\u5F00 Allow User Scripts \u540E browser_evaluate \u53EF\u7528"
    };
  }
  function bindingRow(status) {
    if (standalonePending(status)) {
      return { state: "idle", detail: "\u72EC\u7ACB profile \u5C1A\u672A\u542F\u52A8" };
    }
    if (status.boundTabId === null) {
      return { state: "idle", detail: "\u5C1A\u672A\u7ED1\u5B9A\u6807\u7B7E\u9875 (\u5728\u4F1A\u8BDD\u91CC\u8C03\u7528 browser_tabs \u540E\u9009\u62E9)" };
    }
    return { state: "done", detail: `id=${String(status.boundTabId)}` };
  }

  // src/client/BrowserSettings.tsx
  var import_jsx_runtime = __require("react/jsx-runtime");
  function formLabels(t) {
    return {
      unavailable: t("formUnavailable"),
      readOnly: t("formReadOnly"),
      saveFailed: t("formSaveFailed"),
      save: t("save"),
      saving: t("saving")
    };
  }
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
    detailValue: { overflowWrap: "anywhere", fontFamily: "var(--dsw-font-mono, monospace)" },
    switchRow: {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      padding: "12px 0",
      borderBottom: "0.5px solid var(--dsw-alias-border-l2)"
    },
    switchHead: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12
    },
    switchLabel: { fontSize: 13, fontWeight: 500 },
    switchMeta: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
    override: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }
  };
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
    const pairing = props.usePairingForm((snapshot) => snapshot);
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.root, children: [
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, role: "alert", children: error }),
      status === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.hint, children: props.t("loading") }),
      status !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.headline, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: status.ready ? "done" : "warning" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: props.t(status.ready ? "ready" : "notReady") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.checks, children: rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.check, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: row.state }),
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          import_dsh_client_ui_primitives.SettingsForm,
          {
            labels: formLabels(props.t),
            state: pairing,
            onSave: props.save,
            onDiscard: props.discard,
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.switchRow, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.switchHead, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.switchLabel, children: props.t("launchLabel") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.switchMeta, children: [
                    pairing.launchStandaloneChromeProfile.overridden && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.override, children: props.t("overridden") }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                        import_dsh_client_ui_primitives.Button,
                        {
                          variant: "ghost",
                          disabled: !pairing.writable,
                          onClick: () => {
                            props.resetField("launchStandaloneChromeProfile");
                          },
                          children: props.t("reset")
                        }
                      )
                    ] }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                      import_dsh_client_ui_primitives.Switch,
                      {
                        checked: pairing.launchStandaloneChromeProfile.text === "true",
                        disabled: !pairing.writable,
                        label: props.t("launchLabel"),
                        onChange: (next) => {
                          props.edit("launchStandaloneChromeProfile", next ? "true" : "false");
                        }
                      }
                    )
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.hint, children: props.t("launchHint") })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.switchRow, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.switchHead, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.switchLabel, children: props.t("installAutoLabel") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.switchMeta, children: [
                    pairing.installHostAutomatically.overridden && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.override, children: props.t("overridden") }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                        import_dsh_client_ui_primitives.Button,
                        {
                          variant: "ghost",
                          disabled: !pairing.writable,
                          onClick: () => {
                            props.resetField("installHostAutomatically");
                          },
                          children: props.t("reset")
                        }
                      )
                    ] }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                      import_dsh_client_ui_primitives.Switch,
                      {
                        checked: pairing.installHostAutomatically.text === "true",
                        disabled: !pairing.writable,
                        label: props.t("installAutoLabel"),
                        onChange: (next) => {
                          props.edit("installHostAutomatically", next ? "true" : "false");
                        }
                      }
                    )
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.hint, children: props.t("installAutoHint") })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                import_dsh_client_ui_primitives.SettingsValueField,
                {
                  id: "plugin-config-dsh-browser-pairing-token",
                  label: props.t("tokenLabel"),
                  hint: props.t("tokenHint"),
                  overriddenLabel: props.t("overridden"),
                  resetLabel: props.t("reset"),
                  invalidLabel: props.t("invalidToken"),
                  placeholder: props.t("tokenPlaceholder"),
                  disabled: !pairing.writable,
                  ...pairing.pairingToken,
                  onEdit: (text) => {
                    props.edit("pairingToken", text);
                  },
                  onReset: () => {
                    props.resetField("pairingToken");
                  }
                }
              )
            ]
          }
        ),
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
                value: !extensionLinkCounts(status) || status.boundTabId === null ? props.t("none") : String(status.boundTabId)
              }
            )
          ] })
        ] })
      ] })
    ] });
  }

  // src/client/tab/BrowserTab.tsx
  var import_react2 = __require("react");
  var import_dsh_client_ui_primitives2 = __require("@deepseek-ai/dsh-client-ui-primitives");
  var import_jsx_runtime2 = __require("react/jsx-runtime");
  var styles2 = {
    root: { display: "flex", flexDirection: "column", gap: 16, padding: 16, height: "100%", boxSizing: "border-box" },
    headline: { display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 14, fontWeight: 500 },
    rows: { display: "flex", flexDirection: "column" },
    row: {
      display: "grid",
      gridTemplateColumns: "120px 1fr",
      alignItems: "baseline",
      gap: 8,
      padding: "12px 0",
      borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
      fontSize: 13
    },
    label: { fontWeight: 500 },
    value: { color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" },
    actions: { display: "flex", gap: 8, flexWrap: "wrap" },
    hint: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6 },
    error: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)", lineHeight: 1.6 }
  };
  function holderKey(holderId, sessionId) {
    if (holderId === null) return "holderNone";
    if (holderId === sessionId) return "holderSelf";
    return "holderOther";
  }
  function BrowserTab(props) {
    const { sessionId, t } = props;
    const [status, setStatus] = (0, import_react2.useState)(null);
    const [error, setError] = (0, import_react2.useState)(null);
    const [busy, setBusy] = (0, import_react2.useState)(null);
    const load = (0, import_react2.useCallback)(async () => {
      try {
        const next = await fetchStatus();
        setStatus(next);
        setError(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }, []);
    (0, import_react2.useEffect)(() => {
      void load();
      const timer = setInterval(() => {
        void load();
      }, 3e3);
      return () => {
        clearInterval(timer);
      };
    }, [load]);
    const act = (0, import_react2.useCallback)(async (kind) => {
      setBusy(kind);
      try {
        const next = kind === "acquire" ? await acquireBrowser(sessionId) : await releaseBrowser(sessionId);
        setStatus(next);
        setError(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(null);
      }
    }, [sessionId]);
    const holderId = status?.holderId ?? null;
    const holdsHere = holderId === sessionId;
    const otherHolds = holderId !== null && holderId !== sessionId;
    const linked = status !== null && extensionLinkCounts(status);
    const canAcquire = status !== null && status.ready && !holdsHere && busy === null;
    const canRelease = holdsHere && busy === null;
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.root, children: [
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: styles2.error, role: "alert", children: error }),
      status === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: styles2.hint, children: t("loading") }),
      status !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { style: styles2.headline, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.StateDot, { state: holdsHere ? "done" : status.ready ? "warning" : "idle" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t(holderKey(holderId, sessionId)) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.rows, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.label, children: t("session") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { style: styles2.value, children: sessionId })
          ] }),
          otherHolds && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.label, children: t("holderOther") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { style: styles2.value, children: holderId })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.label, children: t(linked ? "connected" : "disconnected") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.value, children: linked ? status.extensionVersion ?? "" : status.launchStandaloneChromeProfile && status.launchArgs === null ? t("standalonePending") : "" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.label, children: t(linked && status.boundTabId !== null ? "bound" : "unbound") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.value, children: linked && status.boundTabId !== null ? String(status.boundTabId) : "" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.label, children: t(status.ready ? "ready" : "notReady") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.value, children: status.manualSteps[0] ?? "" })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.actions, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            import_dsh_client_ui_primitives2.Button,
            {
              variant: "primary",
              disabled: !canAcquire,
              onClick: () => {
                void act("acquire");
              },
              children: busy === "acquire" ? t("acquiring") : t(otherHolds ? "takeOver" : "acquire")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            import_dsh_client_ui_primitives2.Button,
            {
              variant: "outline",
              disabled: !canRelease,
              onClick: () => {
                void act("release");
              },
              children: busy === "release" ? t("releasing") : t("release")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            import_dsh_client_ui_primitives2.Button,
            {
              variant: "outline",
              disabled: busy !== null,
              onClick: () => {
                void load();
              },
              children: t("refresh")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: styles2.hint, children: t("hint") })
      ] })
    ] });
  }

  // src/client/entry.ts
  var ENTRY_ID = "dsh-browser";
  var PACKAGE_NAME = "dsh-browser";

  // src/client/pairing-form.ts
  var import_dsh_client_ui_primitives3 = __require("@deepseek-ai/dsh-client-ui-primitives");
  function settingsBooleanField(field) {
    return {
      field,
      format: (value) => value === true ? "true" : "false",
      parse: (text) => {
        if (text === "true") return { kind: "set", value: true };
        if (text === "false") return { kind: "set", value: false };
        return void 0;
      }
    };
  }
  var PairingFormController = class {
    form;
    store;
    /**
     * @param scope 条目 id 对应的共享配置表单.
     */
    constructor(scope) {
      this.form = new import_dsh_client_ui_primitives3.SettingsFormModel(scope, [
        (0, import_dsh_client_ui_primitives3.settingsTextField)("pairingToken"),
        settingsBooleanField("launchStandaloneChromeProfile"),
        settingsBooleanField("installHostAutomatically")
      ]);
      this.store = this.form.bind(() => ({
        ...this.form.shell(),
        pairingToken: this.form.field("pairingToken"),
        launchStandaloneChromeProfile: this.form.field("launchStandaloneChromeProfile"),
        installHostAutomatically: this.form.field("installHostAutomatically")
      }));
    }
    /**
     * 构造槽位注册要注入的面.
     *
     * @returns 卡片的状态快照与表单动作.
     */
    inject() {
      return { hooks: { pairingForm: this.store }, ...this.form.actions() };
    }
    /** 释放表单订阅. */
    dispose() {
      this.form.dispose();
    }
  };

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
    checkPairing: "\u914D\u5BF9\u4EE4\u724C",
    checkLaunch: "\u6D4F\u89C8\u5668\u542F\u52A8\u65B9\u5F0F",
    install: "\u5B89\u88C5\u8FDE\u63A5\u7EC4\u4EF6",
    uninstall: "\u5378\u8F7D\u8FDE\u63A5\u7EC4\u4EF6",
    refresh: "\u5237\u65B0\u72B6\u6001",
    installing: "\u6B63\u5728\u5B89\u88C5...",
    manualTitle: "\u9700\u8981\u624B\u52A8\u5B8C\u6210",
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
    stale: '\u68C0\u6D4B\u5230\u5DF2\u88C5\u7684\u8FDE\u63A5\u7EC4\u4EF6\u4E0E\u5F53\u524D\u914D\u7F6E\u4E0D\u4E00\u81F4 (\u53EF\u80FD\u6362\u8FC7\u6570\u636E\u76EE\u5F55\u6216\u6269\u5C55\u5BC6\u94A5). \u70B9"\u5B89\u88C5\u8FDE\u63A5\u7EC4\u4EF6"\u5373\u53EF\u91CD\u88C5.',
    tokenLabel: "\u914D\u5BF9\u4EE4\u724C",
    tokenHint: "\u70B9\u6D4F\u89C8\u5668\u5DE5\u5177\u680F\u4E0A\u7684 dsh Browser \u56FE\u6807, \u590D\u5236\u5F39\u51FA\u9762\u677F\u91CC\u7684\u914D\u5BF9\u4EE4\u724C, \u7C98\u8D34\u5230\u8FD9\u91CC\u518D\u70B9\u4FDD\u5B58. \u4FDD\u5B58\u540E\u63D2\u4EF6\u4F1A\u628A\u5B83\u8F6C\u79FB\u5230\u672C\u673A\u6570\u636E\u76EE\u5F55\u5E76\u6E05\u7A7A\u8FD9\u4E2A\u5B57\u6BB5, \u914D\u7F6E\u6587\u4EF6\u91CC\u4E0D\u4F1A\u7559\u4EE4\u724C. \u8FD9\u4E2A\u503C\u660E\u6587\u663E\u793A, \u56E0\u4E3A\u5B83\u9700\u8981\u548C\u6269\u5C55\u9762\u677F\u91CC\u90A3\u4E32\u6838\u5BF9.",
    tokenPlaceholder: "\u7C98\u8D34\u6269\u5C55\u9762\u677F\u91CC\u663E\u793A\u7684\u4EE4\u724C",
    invalidToken: "\u8FD9\u4E2A\u503C\u4E0D\u88AB\u63A5\u53D7",
    launchLabel: "\u542F\u52A8\u72EC\u7ACB profile \u7684 Chrome",
    launchHint: "\u5173\u95ED\u65F6\u6C38\u8FDC\u4E0D\u81EA\u884C\u6253\u5F00 Chrome, \u53EA\u7528\u6269\u5C55\u5DF2\u7ECF\u8FDE\u4E0A\u7684\u90A3\u4E2A\u6D4F\u89C8\u5668. \u6253\u5F00\u540E dsh \u4F1A\u7528\u4E00\u4EFD\u5168\u65B0\u7684\u72EC\u7ACB profile \u542F\u52A8 Chrome, \u4E0D\u518D\u590D\u7528\u4F60\u65E5\u5E38\u90A3\u4E2A\u7A97\u53E3; \u90A3\u4EFD profile \u6CA1\u6709\u767B\u5F55\u6001, \u9700\u8981\u5355\u72EC\u518D\u52A0\u8F7D\u4E00\u6B21\u6269\u5C55.",
    installAutoLabel: "\u81EA\u52A8\u540C\u6B65\u8FDE\u63A5\u7EC4\u4EF6",
    installAutoHint: '\u5F00\u542F\u540E, \u63D2\u4EF6\u6BCF\u6B21\u52A0\u8F7D\u548C\u6BCF\u4E2A\u4F1A\u8BDD\u5F00\u59CB\u4F7F\u7528\u6D4F\u89C8\u5668\u524D, \u90FD\u4F1A\u628A\u6269\u5C55\u4EA7\u7269\u4E0E native messaging \u7EC4\u4EF6\u540C\u6B65\u5230\u6570\u636E\u76EE\u5F55 (\u5E42\u7B49). \u63D2\u4EF6\u5347\u7EA7\u540E\u4F60\u53EA\u9700\u5728 chrome://extensions \u91CC\u5237\u65B0\u4E00\u6B21\u6269\u5C55; \u5173\u95ED\u5219\u8981\u624B\u52A8\u56DE\u6765\u70B9"\u5B89\u88C5\u8FDE\u63A5\u7EC4\u4EF6".',
    overridden: "\u5DF2\u8986\u76D6",
    reset: "\u6062\u590D\u9ED8\u8BA4",
    save: "\u4FDD\u5B58",
    saving: "\u6B63\u5728\u4FDD\u5B58...",
    formUnavailable: "\u8FD9\u4E2A\u914D\u7F6E\u9879\u5F53\u524D\u6CA1\u6709\u88AB\u4EFB\u4F55 profile \u6761\u76EE\u670D\u52A1, \u56E0\u6B64\u65E0\u6CD5\u7F16\u8F91.",
    formReadOnly: "\u5F53\u524D\u90E8\u7F72\u7684\u914D\u7F6E\u662F\u53EA\u8BFB\u7684, \u4FDD\u5B58\u4F1A\u88AB\u62D2\u7EDD.",
    formSaveFailed: "\u4FDD\u5B58\u6CA1\u6709\u751F\u6548, \u8349\u7A3F\u5DF2\u4FDD\u7559, \u8BF7\u4FEE\u6B63\u540E\u91CD\u8BD5."
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
    checkPairing: "Pairing token",
    checkLaunch: "Browser launch",
    install: "Install connection pieces",
    uninstall: "Uninstall connection pieces",
    refresh: "Refresh",
    installing: "Installing...",
    manualTitle: "Manual step",
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
    stale: 'The installed connection pieces do not match the current configuration (the data directory or extension key changed). Click "Install connection pieces" to reinstall.',
    tokenLabel: "Pairing token",
    tokenHint: "Open the dsh Browser popup from the toolbar, copy its pairing token, paste it here and save. After saving, the plugin moves it into the local data directory and clears this field; the token never stays in the config file. The value is shown in clear because it must be compared with the popup.",
    tokenPlaceholder: "Paste the token shown in the extension popup",
    invalidToken: "This value is not accepted",
    launchLabel: "Launch a standalone Chrome profile",
    launchHint: "Off: never open Chrome; only reuse the browser whose extension is already connected. On: dsh launches a fresh independent profile and will not reuse your daily Chrome. That profile has no login state and needs the extension loaded once.",
    installAutoLabel: "Sync connection pieces automatically",
    installAutoHint: 'On: every plugin load and every session re-syncs the extension build and native messaging pieces into the data directory (idempotent). After a plugin upgrade you only need to reload the extension once in chrome://extensions. Off: click "Install connection pieces" manually.',
    overridden: "Overridden",
    reset: "Reset",
    save: "Save",
    saving: "Saving...",
    formUnavailable: "No profile entry serves this configuration, so it cannot be edited.",
    formReadOnly: "This deployment stores settings read-only, so saving would be refused.",
    formSaveFailed: "The save did not land; your draft is kept, fix it and try again."
  };

  // src/client/tab/strings.ts
  var zh2 = {
    "tab.label": "\u6D4F\u89C8\u5668",
    loading: "\u6B63\u5728\u8BFB\u53D6\u72B6\u6001...",
    connected: "\u6269\u5C55\u5DF2\u8FDE\u63A5",
    disconnected: "\u6269\u5C55\u672A\u8FDE\u63A5",
    standalonePending: "\u72EC\u7ACB profile \u5C1A\u672A\u542F\u52A8, \u65E5\u5E38 Chrome \u91CC\u7684\u8FDE\u63A5\u4E0D\u7B97",
    holderSelf: "\u672C\u4F1A\u8BDD\u6301\u6709\u9A71\u52A8\u6743",
    holderNone: "\u5F53\u524D\u65E0\u4EBA\u6301\u6709\u9A71\u52A8\u6743",
    holderOther: "\u73B0\u5728\u7531\u53E6\u4E00\u4E2A\u4F1A\u8BDD\u5360\u7528",
    bound: "\u5DF2\u7ED1\u5B9A\u6807\u7B7E\u9875",
    unbound: "\u5C1A\u672A\u7ED1\u5B9A\u6807\u7B7E\u9875",
    ready: "\u94FE\u8DEF\u5C31\u7EEA, \u53EF\u4EE5\u4EA4\u7ED9\u672C\u4F1A\u8BDD",
    notReady: "\u94FE\u8DEF\u8FD8\u6CA1\u914D\u597D, \u5148\u53BB\u63D2\u4EF6\u914D\u7F6E\u9875\u5B8C\u6210\u5B89\u88C5\u4E0E\u914D\u5BF9",
    acquire: "\u83B7\u53D6\u672C\u4F1A\u8BDD\u9A71\u52A8\u6743",
    takeOver: "\u63A5\u7BA1\u5230\u672C\u4F1A\u8BDD",
    release: "\u91CA\u653E\u9A71\u52A8\u6743",
    refresh: "\u5237\u65B0",
    acquiring: "\u6B63\u5728\u83B7\u53D6...",
    releasing: "\u6B63\u5728\u91CA\u653E...",
    hint: "\u8FD9\u91CC\u7684\u83B7\u53D6\u7B49\u4E8E\u4F60\u672C\u4EBA\u540C\u610F\u628A\u6D4F\u89C8\u5668\u4EA4\u7ED9\u8FD9\u4E2A\u4F1A\u8BDD, \u4E0D\u4F1A\u518D\u5F39\u5BA1\u6279. \u91CA\u653E\u53EA\u4F5C\u7528\u4E8E\u672C\u4F1A\u8BDD\u5F53\u524D\u6301\u6709\u7684\u90A3\u4EFD\u9A71\u52A8\u6743.",
    session: "\u672C\u4F1A\u8BDD"
  };
  var en2 = {
    "tab.label": "Browser",
    loading: "Reading status...",
    connected: "Extension connected",
    disconnected: "Extension not connected",
    standalonePending: "Standalone profile not launched yet; a daily Chrome link does not count",
    holderSelf: "This session holds the browser",
    holderNone: "No session holds the browser",
    holderOther: "Another session currently holds the browser",
    bound: "A tab is bound",
    unbound: "No tab is bound yet",
    ready: "Ready to grant this session",
    notReady: "Not ready yet; finish install and pairing on the plugin settings page",
    acquire: "Acquire for this session",
    takeOver: "Take over for this session",
    release: "Release",
    refresh: "Refresh",
    acquiring: "Acquiring...",
    releasing: "Releasing...",
    hint: "Acquire here is your own consent to give this session the browser, so no approval prompt is shown. Release only drops the grant if this session currently holds it.",
    session: "This session"
  };

  // src/client/index.ts
  var NS = "settings.dsh-browser";
  var TAB_NS = "dsh-browser.tab";
  var inject = ["slots", "locale", "configForms"];
  function apply(ctx) {
    const t = ctx.locale.bind(NS);
    const tabT = ctx.locale.bind(TAB_NS);
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-browser: dictionaries");
    ctx.effect(() => ctx.locale.register(TAB_NS, { zh: zh2, en: en2 }), "dsh-browser: tab dictionaries");
    const pairing = new PairingFormController(ctx.configForms.get(ENTRY_ID));
    ctx.effect(() => () => {
      pairing.dispose();
    }, "dsh-browser: pairing form");
    ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject(
      "plugins.bundle.config",
      () => ctx.slots.register({
        name: "plugins.bundle.config",
        key: PACKAGE_NAME,
        locale: NS,
        // t 给文案; pairing 给令牌表单的状态与动作 (编辑 / 重置 / 保存 / 放弃).
        inject: () => ({ t: (key) => t(key), ...pairing.inject() })
      }, BrowserSettings)
    )), "dsh-browser: settings page");
    ctx.effect(() => registerTab(ctx, tabT), "dsh-browser: session tab");
  }
  function registerTab(ctx, t) {
    return ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "dsh-browser",
      order: 41,
      label: () => t("tab.label"),
      locale: TAB_NS,
      inject: (sessionId) => ({ t, sessionId })
    }, BrowserTab));
  }
  return __toCommonJS(index_exports);
})();

    return __dshBrowserClient;
  },
});

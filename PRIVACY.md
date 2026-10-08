# 隐私政策 / Privacy Policy

dsh Browser 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的配套 Chrome 扩展. 它把本机 Chrome 里的页面交给本机的 dsh 使用, **不会把网页内容发到我们的服务器**.

dsh Browser is the Chrome companion for DeepSeek Harness. It lets a local dsh process use tabs in your Google Chrome. **It does not send page content to our servers.**

生效日期 / Effective date: 2026-10-08

## 收集什么 / What is collected

扩展会读取当前标签页的 URL, 标题, 可见文本和可交互元素, 这是为了让 dsh 能操作那个页面. 配对令牌存在 `chrome.storage.local`, 只留在这台电脑上.

The extension reads the active tab's URL, title, visible text, and interactive elements so dsh can operate that page. The pairing token is stored in `chrome.storage.local` on this device only.

## 数据去哪 / Where it goes

页面内容只通过 Chrome native messaging 发到本机的 dsh 进程. 扩展自己不发起把页面内容上传到第三方的网络请求.

Page content is sent only to the local dsh process through Chrome native messaging. The extension does not upload page content to third parties.

## 不做什么 / What we do not do

不出售数据, 不做广告, 不跟踪跨站行为, 不远程加载或执行代码.

We do not sell data, show ads, track you across sites, or load/execute remote code.

## 联系 / Contact

问题请开 issue: https://github.com/azazo1/dsh-browser/issues

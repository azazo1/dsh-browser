# 列出可用的 recipe.
[private]
default:
    @just --list

# 安装依赖 (本仓库统一使用 pnpm).
install:
    pnpm install

# 从 SVG 源稿生成扩展 PNG 图标 (纯标准库, 不依赖图像库).
icons:
    python3 scripts/make-icons.py

# 打印由扩展公钥派生的扩展 id; native messaging 清单里的 allowed_origins 就是它.
extension-id:
    node scripts/extension-identity.mjs id extension/manifest.json

# 生成一把新的扩展密钥并给出要填入 manifest.json 的 key 字段.
# 注意: 换密钥等于换扩展 id, 已经装过扩展的机器需要重新加载.
extension-key:
    node scripts/extension-identity.mjs gen

# 类型检查 host / client / extension 三个 program.
typecheck:
    pnpm typecheck

# 清理后重建全部产物: lib/ 三个入口与 assets/extension.
build:
    pnpm build

# 运行测试 (注入函数纯净性, 连接组件生成, native host 双向转发).
test:
    pnpm test

# 依次类型检查, 构建, 跑测试; 给 CI 与发布前使用.
verify:
    just typecheck
    just build
    just test

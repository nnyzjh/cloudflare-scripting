# Cloudflare 检测 + Workers 部署（Scripting 脚本）

在 iPhone 的 **Scripting** App 里运行的脚本，带完整 UI：先检测令牌和账号，再部署 Worker。默认用“覆盖已有脚本”（单个 Worker 授权的令牌也能用，最安全）。

## 文件

- `index.tsx`：脚本本体，复制到 Scripting 新建脚本项目的 `index.tsx` 里替换掉原内容，然后运行。

## 导入方法

1. 打开 Scripting App，新建一个脚本项目
2. 把项目里的 `index.tsx` 内容替换成这个文件的内容
3. 点运行

## 用法

1. **API Token**：在 SecureField 里粘贴 Cloudflare API Token，点“保存令牌”（只存本机钥匙串，下次自动填入）。
   - 令牌获取：dash.cloudflare.com → 右上角头像 → API Tokens → Create Token。
   - 想**新建** Worker：选 **Edit Cloudflare Workers** 模板（账号级权限）。
   - 只想**覆盖已有的某个 Worker**（比如之前那个欢迎模板 Worker）：选 Individual Workers、只授权那一个 Worker 也行。
2. **开始检测**：依次验证 Token、读取账号、列出现有 Workers、查询 workers.dev 子域名，并给出结论。
   - 注意：个别作用域令牌在 `/user/tokens/verify` 上会返回 401，但只要账号和脚本列表能读出来，令牌就是有效的，脚本里已经按这个逻辑处理了。
3. **部署 Worker（默认覆盖已有，最安全）**：
   - 点一个已检测到的 Worker 填入名称（或手动填）。
   - 模式默认是 **覆盖已有脚本**（单个 Worker 授权的令牌也能用）；想建新的再切到 **新建脚本**（需要账号级 Workers 权限）。
   - 点“编辑代码”用带语法高亮的编辑器写代码，或“从剪贴板粘贴代码”。
   - 点“部署 Worker”，成功后会显示 `https://名称.子域名.workers.dev`，脚本还会实测访问一次，点“复制地址”就能拿走。

## v3.1 改动（2026-11-16）

- 主 App 里加了 **“从文件选择代码并部署”按钮**：点一下，从文件 App 里选一个 `.js` / `.mjs`，读出来直接部署到上面选好的 Worker，不用经过分享菜单。需要先检测并选好 Worker（点一个已检测到的 Worker 即可）。
- 分享部署（intent.tsx）还在：文件 App 里长按 `.js` 文件 → 分享 → 选这个 Intent，也能部署。两种方式用的是同一套钥匙串令牌和部署目标。

## v3 改动（2026-11-16）

- 默认模式改成 **覆盖已有脚本**（单个 Worker 授权的令牌也能用，最安全），不再默认新建。新建脚本仍可选，但要账号级 Workers 权限。
- 部署区标题改成“部署 Worker（覆盖已有，最安全）”，两个模式按钮顺序对调，覆盖在前。

## v2 新增（2026-11-14）

- 界面改成 iOS 原生分组列表（List + Section），不再是居中的纯文本
- **剪贴板提示**：创建区有一行“剪贴板：…”状态，点“检查剪贴板”会显示有文本（多少字符）还是空的；点“粘贴代码”时如果剪贴板是空的，会弹窗提示先去复制代码（状态行只显示长度，不显示内容，避免泄露令牌）
- **代码预览**：创建区直接显示代码前 12 行预览（行数/字符数），点“预览代码”用只读编辑器看全文；“编辑代码”才是可改的
- **部署后预览**：部署成功后除了复制地址，还能“应用内预览”（内嵌 Safari 打开）和“浏览器打开”
- **点选已有 Worker 覆盖**：检测后，创建区会列出账号下已有的 Workers，点一个就自动填入名称并切到“覆盖已有脚本”模式，不用记名字；适合先建好一批空 Worker（比如 hello 模板），以后有令牌就能直接粘贴代码覆盖部署

- 报错 `Module '"scripting"' has no exported member 'Keychain'/'Dialog'/'Pasteboard'/'EditorController'`：这四个是 App 运行时提供的**全局对象**，不能从 `scripting` 导入（2026-11-14 已修：只从 `scripting` 导入视图和 Hooks，其余直接用全局名）。如果你手里的还是旧版文件，请用新版 `index.tsx` 整体替换。
- 部署返回 403 `No access to the specified resource`：令牌权限不够。新建脚本需要账号级权限；或者改用“覆盖已有脚本”模式，写进令牌已授权的那个 Worker。
- 部署成功后，Token 过期也不会影响 Worker 继续运行。

## 昨天的实测经验（已写进脚本逻辑）

- 令牌验证 401 不代表令牌已死，账号/脚本列表 200 才是有效信号。
- Individual Workers 作用域的令牌建不了新脚本，但可以覆盖它已授权的那个 Worker。
- 部署用的是 Cloudflare API 的 multipart 上传（metadata + worker.js），和 Wrangler 走的是同一套接口。

// 分享部署到 Cloudflare Worker（intent.tsx）
// 用法：
//   1. 先打开主 App（index.tsx），点“开始检测”，再点一个 Worker，
//      把它存为部署目标（存在钥匙串 cf_deploy_worker 里）。
//   2. 在文件 App 里长按一个 .js / .mjs 文件 → 分享 → 选这个 Intent，
//      它会读取文件内容，部署到目标 Worker，返回部署地址。
// 令牌、账号、子域名都读主 App 存在钥匙串里的那一份（同一个项目，共用钥匙串）。
// 注意：要在 Intent 设置页里勾选支持“文件路径（File URL）”输入类型。

import { Intent, Script } from "scripting"

// 注意：Keychain、FormData、Data、fetch 是 App 运行时提供的全局对象，
// 不能从 "scripting" 导入。

const API_BASE = "https://api.cloudflare.com/client/v4"
const TOKEN_KEY = "cf_api_token"
const ACCOUNT_KEY = "cf_account_id"
const SUBDOMAIN_KEY = "cf_subdomain"
const TARGET_KEY = "cf_deploy_worker"

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

// file:// URL 转成本地文件路径（去掉 file:// 前缀，还原 %20 这类转义）
function urlToPath(u: string): string {
  let p = u
  if (p.startsWith("file://")) p = p.slice("file://".length)
  try {
    p = decodeURIComponent(p)
  } catch {
    // 解码失败就用原样
  }
  return p
}

async function runIntent() {
  const files = Intent.fileURLsParameter ?? []
  if (!files || files.length === 0) {
    Script.exit(Intent.text("没有收到文件。请分享一个 .js / .mjs 文件到这个 Intent。"))
    return
  }
  const raw = String(files[0])
  const path = urlToPath(raw)
  const lower = path.toLowerCase()
  if (!lower.endsWith(".js") && !lower.endsWith(".mjs")) {
    Script.exit(Intent.text("只支持 .js / .mjs 文件，你分享的是：" + path.split("/").pop()))
    return
  }

  const token = Keychain.get(TOKEN_KEY) || ""
  const accountId = Keychain.get(ACCOUNT_KEY) || ""
  const subdomain = Keychain.get(SUBDOMAIN_KEY) || ""
  const target = Keychain.get(TARGET_KEY) || ""
  if (!token || !accountId || !target) {
    Script.exit(
      Intent.text(
        "还没设置好。请先打开 Cloudflare Workers 主 App，保存令牌，点“开始检测”，再点一个 Worker 存为部署目标，然后重新分享文件。"
      )
    )
    return
  }

  let code = ""
  try {
    code = FileManager.readAsStringSync(path)
  } catch (e) {
    Script.exit(Intent.text("读取文件失败：" + String(e)))
    return
  }
  if (!code.trim()) {
    Script.exit(Intent.text("文件是空的，没有可部署的代码。"))
    return
  }

  try {
    const form = new FormData()
    form.append(
      "metadata",
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: todayDate(),
        bindings: [],
      })
    )
    const scriptData = Data.fromRawString(code)
    if (!scriptData) {
      Script.exit(Intent.text("代码转码失败。"))
      return
    }
    form.append("script", scriptData, "application/javascript+module", "worker.js")

    const res = await fetch(
      `${API_BASE}/accounts/${accountId}/workers/scripts/${target}`,
      { method: "PUT", headers: { Authorization: "Bearer " + token }, body: form, timeout: 60 }
    )
    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    if (res.status === 200 && json?.success) {
      const url = subdomain ? `https://${target}.${subdomain}.workers.dev` : target
      Script.exit(Intent.text(`✅ 已部署到 ${target}\n${url}`))
    } else {
      const msg =
        json && Array.isArray(json.errors) && json.errors.length > 0
          ? json.errors.map((e: any) => e.message || e.code || "").join("; ")
          : `HTTP ${res.status}`
      Script.exit(Intent.text(`❌ 部署失败：${msg}`))
    }
  } catch (e) {
    Script.exit(Intent.text("❌ 部署出错：" + String(e)))
  }
}

runIntent()

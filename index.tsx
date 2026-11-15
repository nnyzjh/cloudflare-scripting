// Cloudflare 检测 + Workers 部署 v3
// 运行环境：iOS Scripting App（TypeScript + TSX，index.tsx 为入口）
// 功能：
//   1. 检测：验证 API Token、读取账号、列出现有 Workers、查询 workers.dev 子域名，
//      并给出“这个令牌能不能新建脚本”的结论
//   2. 部署：默认“覆盖已有脚本”（单个 Worker 授权的令牌也能用，最安全）；
//      “新建脚本”仍可用，但需要账号级 Workers 权限。部署后实测 workers.dev 地址，
//      可一键复制、在应用内预览或用浏览器打开
//   3. 预览：代码可 inline 预览（前 12 行）或只读编辑器全览；剪贴板有状态提示
// 令牌只保存在本机钥匙串（Keychain，按脚本隔离），不会打印到日志，也不会上传到别处。

import {
  useState,
  useEffect,
  HStack,
  Text,
  TextField,
  SecureField,
  Button,
  List,
  Section,
  NavigationStack,
  Navigation,
  Script,
} from "scripting"

// 注意：Keychain、Dialog、Pasteboard、EditorController、Safari 是 App 运行时提供的
// 全局对象，不能从 "scripting" 导入（导入会报 has no exported member）。
// fetch、FormData、Data 同样是全局的。

const API_BASE = "https://api.cloudflare.com/client/v4"
const TOKEN_KEY = "cf_api_token"
const ACCOUNT_KEY = "cf_account_id"
const SUBDOMAIN_KEY = "cf_subdomain"
const TARGET_KEY = "cf_deploy_worker"
const CODE_PREVIEW_LINES = 12

const HELLO_WORKER = `export default {
  async fetch(request) {
    return new Response("Hello from Cloudflare Workers!", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  },
}
`

type CfResult = {
  status: number
  json: any | null
  text: string
}

async function cfCall(
  token: string,
  path: string,
  init?: RequestInit
): Promise<CfResult> {
  const res = await fetch(API_BASE + path, {
    ...(init ?? {}),
    headers: {
      Authorization: "Bearer " + token,
      ...(init?.headers ?? {}),
    },
    timeout: 30,
  })
  const text = await res.text()
  let json: any | null = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

function errText(r: CfResult): string {
  if (r.json && Array.isArray(r.json.errors) && r.json.errors.length > 0) {
    return r.json.errors.map((e: any) => e.message || e.code || "").join("; ")
  }
  return "HTTP " + r.status
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function codeLineCount(code: string): number {
  return code === "" ? 0 : code.split("\n").length
}

function codePreview(code: string): string {
  const lines = code.split("\n").slice(0, CODE_PREVIEW_LINES)
  const more = codeLineCount(code) - lines.length
  return lines.join("\n") + (more > 0 ? `\n…（还有 ${more} 行）` : "")
}

function App() {
  const [token, setToken] = useState("")
  const [tokenSaved, setTokenSaved] = useState(false)
  const [accountId, setAccountId] = useState("")
  const [accountName, setAccountName] = useState("")
  const [subdomain, setSubdomain] = useState("")
  const [scriptNames, setScriptNames] = useState<string[]>([])
  const [detectLines, setDetectLines] = useState<string[]>([])
  const [detecting, setDetecting] = useState(false)
  const [workerName, setWorkerName] = useState("")
  const [mode, setMode] = useState<"create" | "overwrite">("overwrite")
  const [code, setCode] = useState(HELLO_WORKER)
  const [clipStatus, setClipStatus] = useState("未检查")
  const [deploying, setDeploying] = useState(false)
  const [deployLines, setDeployLines] = useState<string[]>([])
  const [deployedUrl, setDeployedUrl] = useState("")

  // 启动时从钥匙串读回保存过的令牌和账号信息
  useEffect(() => {
    const savedToken = Keychain.get(TOKEN_KEY)
    if (savedToken) {
      setToken(savedToken)
      setTokenSaved(true)
    }
    const savedAccount = Keychain.get(ACCOUNT_KEY)
    if (savedAccount) setAccountId(savedAccount)
    const savedSubdomain = Keychain.get(SUBDOMAIN_KEY)
    if (savedSubdomain) setSubdomain(savedSubdomain)
  }, [])

  function pushDetect(line: string) {
    setDetectLines((prev) => [...prev, line])
  }

  function pushDeploy(line: string) {
    setDeployLines((prev) => [...prev, line])
  }

  async function saveToken() {
    const t = token.trim()
    if (!t) {
      await Dialog.alert({ title: "令牌为空", message: "请先输入 Cloudflare API Token。" })
      return
    }
    Keychain.set(TOKEN_KEY, t)
    setTokenSaved(true)
    await Dialog.alert({ title: "已保存", message: "令牌已存入本机钥匙串，下次打开自动填入。" })
  }

  function clearToken() {
    Keychain.remove(TOKEN_KEY)
    setToken("")
    setTokenSaved(false)
    setAccountId("")
    setAccountName("")
    setSubdomain("")
    setScriptNames([])
    setDetectLines([])
  }

  async function runDetect() {
    const t = token.trim()
    if (!t) {
      await Dialog.alert({ title: "缺少令牌", message: "请先输入并保存 API Token。" })
      return
    }
    setDetecting(true)
    setDetectLines([])
    setScriptNames([])
    try {
      // 1. Token 验证（注意：个别作用域令牌这里会 401，但账号接口仍能通，
      //    所以只把它当参考，不作为“令牌已死”的结论）
      const verify = await cfCall(t, "/user/tokens/verify")
      if (verify.status === 200 && verify.json?.result?.status === "active") {
        pushDetect("✅ Token 验证通过（active）")
      } else {
        pushDetect(`⚠️ Token 验证接口返回 ${verify.status}（${errText(verify)}），继续用账号接口判断`)
      }

      // 2. 账号列表
      const accounts = await cfCall(t, "/accounts")
      if (accounts.status !== 200 || !accounts.json?.result?.length) {
        pushDetect(`❌ 读取账号失败：${errText(accounts)}`)
        pushDetect("结论：令牌无效或无账号读取权限，请重新创建令牌。")
        return
      }
      const first = accounts.json.result[0]
      setAccountId(first.id)
      setAccountName(first.name ?? "")
      Keychain.set(ACCOUNT_KEY, first.id)
      pushDetect(`✅ 账号：${first.name ?? ""}（${first.id}）`)
      if (accounts.json.result.length > 1) {
        pushDetect(`ℹ️ 该令牌下有 ${accounts.json.result.length} 个账号，默认用第一个`)
      }

      // 3. 现有 Workers 脚本
      const scripts = await cfCall(t, `/accounts/${first.id}/workers/scripts`)
      if (scripts.status === 200 && Array.isArray(scripts.json?.result)) {
        const names = scripts.json.result.map((s: any) => String(s.id))
        setScriptNames(names)
        pushDetect(
          names.length > 0
            ? `✅ 现有 Workers（${names.length} 个）：${names.join("、")}`
            : "✅ 现有 Workers：0 个"
        )
      } else {
        pushDetect(`❌ 列出 Workers 失败：${errText(scripts)}`)
      }

      // 4. workers.dev 子域名
      const sub = await cfCall(t, `/accounts/${first.id}/workers/subdomain`)
      if (sub.status === 200 && sub.json?.result?.subdomain) {
        const sd = String(sub.json.result.subdomain)
        setSubdomain(sd)
        Keychain.set(SUBDOMAIN_KEY, sd)
        pushDetect(`✅ workers.dev 子域名：${sd}`)
      } else {
        pushDetect(`⚠️ 查不到子域名（${errText(sub)}），部署成功后仍可从返回里拿到地址`)
      }

      pushDetect("—— 结论 ——")
      pushDetect("令牌本身有效，能读账号和脚本列表。")
      pushDetect("新建脚本需要账号级 Workers Scripts:Edit 权限；如果创建时返回 403 “No access to the specified resource”，说明令牌只授权给了个别已有 Worker，请改用下方“覆盖已有脚本”模式，写进那个已有的 Worker。")
    } catch (e) {
      pushDetect(`❌ 检测出错：${String(e)}`)
    } finally {
      setDetecting(false)
    }
  }

  // 点一个已检测到的 Worker：填入名称、切到“覆盖已有脚本”模式，
  // 并把这个 Worker 存为分享部署的默认目标（intent.tsx 会读它）
  function selectWorker(name: string) {
    setWorkerName(name)
    setMode("overwrite")
    Keychain.set(TARGET_KEY, name)
  }

  // 检查剪贴板状态（只显示有没有文本和长度，不显示内容，避免泄露令牌）
  async function refreshClipStatus() {
    try {
      const has = await Pasteboard.hasStrings
      if (!has) {
        setClipStatus("剪贴板是空的")
        return
      }
      const s = await Pasteboard.getString()
      if (s && s.trim().length > 0) {
        setClipStatus(`剪贴板有文本（${s.length} 字符）`)
      } else {
        setClipStatus("剪贴板是空的")
      }
    } catch {
      setClipStatus("无法读取剪贴板")
    }
  }

  async function openEditor() {
    const editor = new EditorController({ content: code, ext: "js" })
    await editor.present({ navigationTitle: "编辑 Worker 代码" })
    if (editor.content.trim().length > 0) {
      setCode(editor.content)
    }
  }

  // 只读预览当前代码（不改内容）
  async function previewCode() {
    if (!code.trim()) {
      await Dialog.alert({ title: "代码为空", message: "当前没有代码可预览，请先粘贴或编写。" })
      return
    }
    const editor = new EditorController({ content: code, ext: "js", readOnly: true })
    await editor.present({ navigationTitle: "预览代码（只读）" })
  }

  async function pasteCode() {
    const text = await Pasteboard.getString()
    if (text && text.trim().length > 0) {
      setCode(text)
      setClipStatus(`剪贴板有文本（${text.length} 字符）`)
    } else {
      setClipStatus("剪贴板是空的")
      await Dialog.alert({
        title: "剪贴板是空的",
        message: "剪贴板里没有文本，请先去复制 Worker 代码，再回来点粘贴。",
      })
    }
  }

  // 从文件选择一个 .js / .mjs，读出来直接部署到当前选好的 Worker。
  // 需要先检测并选好 Worker（点一个已检测到的 Worker 即可）。
  async function pickFileAndDeploy() {
    if (!token.trim()) {
      await Dialog.alert({ title: "缺少令牌", message: "请先输入并保存 API Token。" })
      return
    }
    if (!accountId) {
      await Dialog.alert({ title: "请先检测", message: "请先点“开始检测”，拿到账号 ID 后再部署。" })
      return
    }
    if (!workerName.trim()) {
      await Dialog.alert({
        title: "还没选 Worker",
        message: "请先点一个已检测到的 Worker（或手动填名称），再选文件部署。",
      })
      return
    }
    let picked: string[] | null = null
    try {
      picked = await DocumentPicker.pickFiles()
    } catch (e) {
      await Dialog.alert({ title: "选文件失败", message: String(e) })
      return
    }
    if (!picked || picked.length === 0) return
    const path = picked[0]
    const lower = path.toLowerCase()
    if (!lower.endsWith(".js") && !lower.endsWith(".mjs")) {
      await Dialog.alert({
        title: "不是 JS 文件",
        message: "请选择 .js 或 .mjs 文件，你选的是：" + path.split("/").pop(),
      })
      return
    }
    let fileCode = ""
    try {
      fileCode = FileManager.readAsStringSync(path)
    } catch (e) {
      await Dialog.alert({ title: "读取文件失败", message: String(e) })
      return
    }
    if (!fileCode.trim()) {
      await Dialog.alert({ title: "文件是空的", message: "选中的文件没有代码。" })
      return
    }
    setCode(fileCode)
    setClipStatus(`已选文件：${path.split("/").pop()}（${fileCode.length} 字符）`)
    await deploy(fileCode)
  }

  async function deploy(codeOverride?: string) {
    const t = token.trim()
    if (!t) {
      await Dialog.alert({ title: "缺少令牌", message: "请先输入并保存 API Token。" })
      return
    }
    if (!accountId) {
      await Dialog.alert({ title: "请先检测", message: "请先点“开始检测”，拿到账号 ID 后再部署。" })
      return
    }
    const name = workerName.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      await Dialog.alert({
        title: "名称不对",
        message: "Worker 名称只能用小写字母、数字和连字符，且以字母或数字开头，例如 lesbian-mix。",
      })
      return
    }
    const useCode = (codeOverride ?? code).trim()
    if (!useCode) {
      await Dialog.alert({ title: "代码为空", message: "请先粘贴、编写或从文件选择 Worker 代码。" })
      return
    }
    if (mode === "create" && scriptNames.includes(name)) {
      const ok = await Dialog.confirm({
        title: "脚本已存在",
        message: `名为 ${name} 的 Worker 已存在，继续会覆盖它。确定覆盖吗？`,
        confirmLabel: "覆盖",
        cancelLabel: "取消",
      })
      if (!ok) return
    }
    if (mode === "overwrite" && !scriptNames.includes(name)) {
      await Dialog.alert({
        title: "找不到这个 Worker",
        message: `账号下没有名为 ${name} 的 Worker。请先点“开始检测”刷新列表，或改用“新建脚本”模式。`,
      })
      return
    }

    setDeploying(true)
    setDeployLines([])
    setDeployedUrl("")
    try {
      pushDeploy(`正在上传 ${name} …`)
      const form = new FormData()
      form.append(
        "metadata",
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: todayDate(),
          bindings: [],
        })
      )
      const scriptData = Data.fromRawString(useCode)
      if (!scriptData) {
        pushDeploy("❌ 代码转码失败")
        return
      }
      form.append("script", scriptData, "application/javascript+module", "worker.js")

      const res = await fetch(
        `${API_BASE}/accounts/${accountId}/workers/scripts/${name}`,
        { method: "PUT", headers: { Authorization: "Bearer " + t }, body: form, timeout: 60 }
      )
      const text = await res.text()
      let json: any = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      if (res.status === 200 && json?.success) {
        pushDeploy(`✅ 部署成功：${name}`)
        const url = subdomain ? `https://${name}.${subdomain}.workers.dev` : ""
        if (url) {
          setDeployedUrl(url)
          pushDeploy(`地址：${url}`)
          // 实测部署后的地址
          try {
            const check = await fetch(url, { timeout: 20 })
            const body = await check.text()
            pushDeploy(`✅ 实测访问：HTTP ${check.status}，返回 ${body.slice(0, 120)}`)
          } catch (e) {
            pushDeploy(`⚠️ 地址已生成，但实测访问失败：${String(e)}（稍后在浏览器里再试一次）`)
          }
        } else {
          pushDeploy("⚠️ 子域名未知，地址请到 Cloudflare 面板 Workers 列表里查看")
        }
      } else {
        const msg =
          json && Array.isArray(json.errors) && json.errors.length > 0
            ? json.errors.map((e: any) => e.message || e.code || "").join("; ")
            : `HTTP ${res.status}`
        pushDeploy(`❌ 部署失败：${msg}`)
        if (res.status === 403) {
          pushDeploy("提示：403 通常是令牌权限不足。如果令牌只授权给了个别已有 Worker，请改用“覆盖已有脚本”模式，写进那个 Worker；否则请用“Edit Cloudflare Workers”模板重建账号级令牌。")
        }
      }
    } catch (e) {
      pushDeploy(`❌ 部署出错：${String(e)}`)
    } finally {
      setDeploying(false)
    }
  }

  async function copyUrl() {
    if (!deployedUrl) return
    await Pasteboard.setString(deployedUrl)
    await Dialog.alert({ title: "已复制", message: deployedUrl })
  }

  async function previewDeployed() {
    if (!deployedUrl) return
    await Safari.present(deployedUrl)
  }

  async function openDeployed() {
    if (!deployedUrl) return
    const ok = await Safari.openURL(deployedUrl)
    if (!ok) {
      await Dialog.alert({ title: "打开失败", message: "无法用浏览器打开这个地址，请检查地址是否正确。" })
    }
  }

  return (
    <NavigationStack>
      <List navigationTitle="Cloudflare Workers">
        <Section header={<Text>1. API Token</Text>}>
          <SecureField
            title="API Token"
            value={token}
            onChanged={setToken}
            prompt="粘贴 Cloudflare API Token"
          />
          <HStack>
            <Button title="保存令牌" action={saveToken} />
            <Button title="清除令牌" action={clearToken} role="destructive" />
          </HStack>
          <Text font="caption">
            {tokenSaved ? "✅ 令牌已保存（下次自动填入）" : "未保存令牌"}
          </Text>
        </Section>

        <Section header={<Text>2. 检测</Text>}>
          <Button
            title={detecting ? "检测中…" : "开始检测"}
            action={runDetect}
          />
          <Text font="caption">
            {accountName ? `账号：${accountName}` : "尚未检测到账号"}
          </Text>
          {detectLines.map((line, i) => (
            <Text key={i} font="caption">{line}</Text>
          ))}
        </Section>

        <Section header={<Text>3. 部署 Worker（覆盖已有，最安全）</Text>}>
          {scriptNames.length > 0 ? (
            <Text font="caption">已检测到的 Workers（点一个填入名称）：</Text>
          ) : null}
          {scriptNames.map((name) => (
            <Button
              key={name}
              title={name}
              action={() => selectWorker(name)}
            />
          ))}
          <TextField
            title="Worker 名称"
            value={workerName}
            onChanged={setWorkerName}
            prompt="例如 lesbian-mix（小写字母、数字、连字符）"
          />
          <HStack>
            <Button
              title={mode === "overwrite" ? "● 覆盖已有脚本" : "覆盖已有脚本"}
              action={() => setMode("overwrite")}
            />
            <Button
              title={mode === "create" ? "● 新建脚本" : "新建脚本"}
              action={() => setMode("create")}
            />
          </HStack>
          <Text font="caption">
            {mode === "overwrite"
              ? "模式：覆盖已有脚本（默认，最安全。单个 Worker 授权的令牌也能用，写进已有的 Worker）"
              : "模式：新建脚本（需要账号级 Workers 权限，单个 Worker 授权的令牌建不了）"}
          </Text>
          <Text font="headline">代码预览</Text>
          <Text font="caption">
            {`共 ${codeLineCount(code)} 行 / ${code.length} 字符`}
          </Text>
          <Text font="caption">{codePreview(code)}</Text>
          <HStack>
            <Button title="编辑代码" action={openEditor} />
            <Button title="预览代码" action={previewCode} />
          </HStack>
          <HStack>
            <Button title="从剪贴板粘贴代码" action={pasteCode} />
            <Button title="检查剪贴板" action={refreshClipStatus} />
          </HStack>
          <Text font="caption">{`剪贴板：${clipStatus}`}</Text>
          <Button
            title="从文件选择代码并部署"
            action={pickFileAndDeploy}
          />
          <Text font="caption">点一下，从文件 App 里选一个 .js / .mjs，读出来直接部署到上面选好的 Worker。不用经过分享菜单。</Text>
          <Button
            title={deploying ? "部署中…" : "部署 Worker"}
            action={() => deploy()}
          />
        </Section>

        <Section header={<Text>4. 部署结果</Text>}>
          {deployLines.length === 0 ? (
            <Text font="caption">尚未部署</Text>
          ) : (
            deployLines.map((line, i) => (
              <Text key={i} font="caption">{line}</Text>
            ))
          )}
          {deployedUrl ? (
            <Text font="caption">{deployedUrl}</Text>
          ) : null}
          {deployedUrl ? (
            <HStack>
              <Button title="复制地址" action={copyUrl} />
              <Button title="应用内预览" action={previewDeployed} />
              <Button title="浏览器打开" action={openDeployed} />
            </HStack>
          ) : null}
        </Section>

        <Section header={<Text>提示</Text>}>
          <Text font="caption">部署成功后，Worker 即使令牌过期也会继续运行。</Text>
        </Section>
      </List>
    </NavigationStack>
  )
}

async function run() {
  await Navigation.present({
    element: <App />,
    modalPresentationStyle: "pageSheet",
  })
  Script.exit()
}

run()

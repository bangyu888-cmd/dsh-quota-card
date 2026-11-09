/**
 * dsh-quota-card — host half.
 *
 * Owns a loopback Connection RPC channel (`/dsh-quota-card`) that the Client
 * card calls. The browser never sees an API key or a local login token:
 * every upstream request happens here over the Host's network stack.
 *
 * P1 adapters:
 *  - DeepSeek: the logged-in DSH account balance via the `deepseekAccount`
 *    service (wallet + bonus wallets, no credential leaves the Host).
 *  - ChatGPT: `~/.codex/auth.json` OAuth token → `chatgpt.com/backend-api/
 *    wham/usage`; 5h / weekly windows with reset timestamps. Expired access
 *    tokens are refreshed in memory only — the login file is never written.
 *  - Gemini / Grok: reported as pending until P2/P3.
 *
 * Wire credit: the prefix RPC carrier and the ChatGPT usage normalization
 * are adapted from @sunshaobei/dsh-balance-panel (MIT).
 */
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

export const inject = ['connection', 'webServer']

const RPC_CHANNEL = '/dsh-quota-card'
const CACHE_MS = 30_000
const HTTP_TIMEOUT_MS = 15_000
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** In-memory ChatGPT grant; never written back to disk. */
let chatgptGrant = null
let fetchCache = null
let inflight = null

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function clientMeta() {
  return {
    version: '0.1.0',
    locale: 'zh',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

function qcError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/* ── HTTPS with the system trust store ───────────────────────── */

/**
 * Node's bundled CA list fails `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` in some
 * macOS/Electron environments. Combine the bundled roots with the system
 * bundle so provider calls verify against the OS trust store as well.
 */
let caListCache = null

async function caList() {
  if (caListCache) return caListCache
  const extra = []
  for (const candidate of [
    '/etc/ssl/cert.pem',
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
  ]) {
    try {
      const pem = await fsp.readFile(candidate, 'utf8')
      extra.push(...(pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []))
      break
    } catch {
      /* try the next bundle */
    }
  }
  caListCache = [...tls.rootCertificates, ...extra]
  return caListCache
}

/**
 * Open a CONNECT tunnel through an HTTP(S) proxy and complete TLS to the target.
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
function openProxyTunnel(proxyUrl, host, port, ca) {
  return new Promise((resolve, reject) => {
    let proxy
    try {
      proxy = new URL(proxyUrl)
    } catch {
      reject(qcError('proxy-invalid', '代理地址无效'))
      return
    }
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
      reject(qcError('proxy-invalid', '仅支持 http:// 或 https:// 代理'))
      return
    }
    const lib = proxy.protocol === 'https:' ? https : http
    const req = lib.request({
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      ...(proxy.username
        ? { auth: `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` }
        : {}),
      ...(proxy.protocol === 'https:' ? { ca } : {}),
    })
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('代理连接超时')))
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(qcError('proxy-failed', `代理连接失败（HTTP ${res.statusCode}）`))
        return
      }
      const tlsSocket = tls.connect({ socket, servername: host, ca })
      tlsSocket.once('secureConnect', () => resolve(tlsSocket))
      tlsSocket.once('error', () => reject(qcError('proxy-tls', '代理隧道 TLS 握手失败')))
    })
    req.on('error', () => reject(qcError('proxy-failed', '无法连接代理服务器')))
    req.end()
  })
}

/**
 * Minimal JSON HTTPS request (no dependency, explicit CA list); optional HTTP(S) proxy.
 * @returns {Promise<{status:number, ok:boolean, json:any}>}
 */
async function requestJson(urlString, options = {}) {
  const url = new URL(urlString)
  const ca = await caList()
  const headers = { ...(options.headers ?? {}) }
  const body = options.body
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : HTTP_TIMEOUT_MS
  let agent
  if (typeof options.proxy === 'string' && options.proxy) {
    const socket = await openProxyTunnel(options.proxy, url.hostname, Number(url.port) || 443, ca)
    agent = new https.Agent({ keepAlive: false })
    agent.createConnection = () => socket
  }
  return await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers,
      ca,
      servername: url.hostname,
      ...(agent ? { agent } : {}),
    }, (res) => {
      const chunks = []
      let total = 0
      res.on('data', (chunk) => {
        total += chunk.length
        if (total > 2_000_000) {
          req.destroy(new Error('响应体过大'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        const status = res.statusCode ?? 0
        resolve({ status, ok: status >= 200 && status < 300, json })
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/* ── DeepSeek balance ────────────────────────────────────────── */

async function fetchDeepSeek(ctx) {
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
  if (!account) {
    return {
      id: 'deepseek',
      kind: 'balance',
      status: 'error',
      error: { code: 'service-missing', message: '账号服务不可用' },
    }
  }
  let balance
  try {
    balance = await account.getBalance(clientMeta())
  } catch (error) {
    return { id: 'deepseek', kind: 'balance', status: 'error', error: { code: 'balance-failed', message: messageOf(error) } }
  }
  if (balance === null || balance === undefined) {
    return { id: 'deepseek', kind: 'balance', status: 'auth', error: { code: 'signed-out', message: '未登录 DeepSeek 账号' } }
  }
  if (balance.status !== 'ready') {
    return { id: 'deepseek', kind: 'balance', status: 'error', error: { code: 'balance-failed', message: '余额查询失败' } }
  }
  const wallets = Array.isArray(balance.value) ? balance.value : []
  const bonuses = Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []
  const wallet = wallets.find((item) => item.currency === 'CNY') ?? wallets.find((item) => item.currency === 'USD')
  const amount = wallet ? Number(wallet.balance) : Number.NaN
  const bonus = bonuses
    .filter((item) => wallet === undefined || item.currency === wallet.currency)
    .reduce((sum, item) => {
      const value = Number(item.balance)
      return Number.isFinite(value) ? sum + value : sum
    }, 0)
  return {
    id: 'deepseek',
    kind: 'balance',
    status: Number.isFinite(amount) ? 'ok' : 'error',
    currency: wallet?.currency,
    amount: Number.isFinite(amount) ? amount : undefined,
    bonus: bonus > 0 ? bonus : undefined,
    updatedAt: new Date().toISOString(),
    error: Number.isFinite(amount) ? undefined : { code: 'balance-failed', message: '余额数据异常' },
  }
}

/* ── ChatGPT subscription usage ──────────────────────────────── */

function codexAuthPath() {
  return path.join(os.homedir(), '.codex', 'auth.json')
}

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

async function readCodexAuth() {
  const file = codexAuthPath()
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    throw qcError('chatgpt-no-auth', '未找到 Codex 登录态，请先运行 codex login')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw qcError('chatgpt-bad-auth', 'Codex 登录态文件不是合法 JSON')
  }
  const tokens = parsed?.tokens
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw qcError('chatgpt-no-auth', 'Codex 登录态缺少 access_token，请重新登录')
  }
  const expiresAt =
    typeof tokens.expires_at === 'number' && tokens.expires_at > 0
      ? tokens.expires_at > 1e12
        ? tokens.expires_at
        : tokens.expires_at * 1000
      : jwtExpiryMs(tokens.access_token)
  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : undefined,
    expiresAt,
  }
}

async function refreshChatGPT(refreshToken, proxy) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CHATGPT_CLIENT_ID,
  }).toString()
  const response = await requestJson(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    proxy,
  })
  const json = response.json
  if (!response.ok || !json || typeof json.access_token !== 'string') {
    throw qcError('chatgpt-auth', 'ChatGPT 登录已过期，请运行 codex login')
  }
  const expiresIn = Number(json.expires_in)
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  }
}

async function resolveChatGPTGrant() {
  if (chatgptGrant && (!chatgptGrant.expiresAt || chatgptGrant.expiresAt - Date.now() > 30_000)) {
    return chatgptGrant
  }
  const disk = await readCodexAuth()
  if (!disk.expiresAt || disk.expiresAt - Date.now() > 30_000) {
    chatgptGrant = disk
    return chatgptGrant
  }
  if (!disk.refreshToken) {
    throw qcError('chatgpt-auth', 'ChatGPT 登录已过期，请运行 codex login')
  }
  const refreshed = await refreshChatGPT(disk.refreshToken)
  chatgptGrant = {
    ...refreshed,
    accountId: disk.accountId,
  }
  return chatgptGrant
}

async function fetchChatGPTUsage(grant, proxy) {
  const headers = {
    authorization: `Bearer ${grant.accessToken}`,
    accept: 'application/json',
  }
  if (grant.accountId) headers['ChatGPT-Account-Id'] = grant.accountId
  const response = await requestJson(CHATGPT_USAGE_URL, { headers, proxy })
  const body = response.json
  if (response.status === 401) throw qcError('chatgpt-auth', 'ChatGPT 登录已失效，请运行 codex login')
  if (!response.ok) throw qcError('chatgpt-http', `ChatGPT 返回 HTTP ${response.status}`)
  if (!body) throw qcError('chatgpt-http', 'ChatGPT 返回了非 JSON 响应')
  return body
}

/** `used_percent` → remaining percent, clamped and rounded. */
function remainingOf(window) {
  const used = Number(window?.used_percent)
  if (!Number.isFinite(used)) return null
  return Math.min(100, Math.max(0, Math.round(100 - used)))
}

function resetsOf(window) {
  const epoch = Number(window?.reset_at)
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch > 1e12 ? epoch : epoch * 1000).toISOString()
  const after = Number(window?.reset_after_seconds)
  if (Number.isFinite(after) && after > 0) return new Date(Date.now() + after * 1000).toISOString()
  return undefined
}

function laneOf(window, fallback) {
  const seconds = Number(window?.limit_window_seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback
  const near = (target) => seconds >= target * 0.95 && seconds <= target * 1.05
  if (near(5 * 3600)) return 'rolling'
  if (near(7 * 24 * 3600)) return 'weekly'
  if (near(30 * 24 * 3600)) return 'monthly'
  return fallback
}

function normalizeWindows(rateLimit) {
  const windows = {}
  const primary = rateLimit?.primary_window
  const secondary = rateLimit?.secondary_window
  const primaryLane = laneOf(primary, 'rolling')
  const secondaryLane = laneOf(secondary, primaryLane === 'rolling' ? 'weekly' : 'rolling')
  if (primary && remainingOf(primary) !== null) {
    windows[primaryLane] = { remaining: remainingOf(primary), resetsAt: resetsOf(primary) }
  }
  if (secondary && remainingOf(secondary) !== null && secondaryLane !== primaryLane) {
    windows[secondaryLane] = { remaining: remainingOf(secondary), resetsAt: resetsOf(secondary) }
  }
  return windows
}

async function fetchChatGPT(proxy) {
  try {
    const grant = await resolveChatGPTGrant()
    let body
    try {
      body = await fetchChatGPTUsage(grant, proxy)
    } catch (error) {
      if (error?.code !== 'chatgpt-auth' || !grant.refreshToken) throw error
      chatgptGrant = null
      const fresh = await refreshChatGPT(grant.refreshToken, proxy)
      chatgptGrant = { ...fresh, accountId: grant.accountId }
      body = await fetchChatGPTUsage(chatgptGrant, proxy)
    }
    const windows = normalizeWindows(body?.rate_limit)
    if (Object.keys(windows).length === 0) {
      return { id: 'chatgpt', kind: 'usage', status: 'error', error: { code: 'chatgpt-shape', message: '额度数据格式已变化' } }
    }
    return {
      id: 'chatgpt',
      kind: 'usage',
      status: 'ok',
      plan: typeof body?.plan_type === 'string' ? body.plan_type : undefined,
      windows,
      updatedAt: new Date().toISOString(),
    }
  } catch (error) {
    const code = error?.code ?? 'chatgpt-failed'
    const status = code === 'chatgpt-no-auth' || code === 'chatgpt-auth' || code === 'chatgpt-bad-auth' ? 'auth' : 'error'
    return { id: 'chatgpt', kind: 'usage', status, error: { code, message: messageOf(error) } }
  }
}

/* ── Grok Bot (Cursor weekly usage) ─────────────────────────── */

const CURSOR_TOKEN_EXCHANGE_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key'
const CURSOR_GROKBOT_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'
const CURSOR_USER_AGENT = 'dsh-quota-card/0.1.0'

/** Resolve the Cursor user API key: DSH credential store, then launch env. */
async function resolveCursorKey(ctx) {
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.resolve === 'function') {
    for (const ref of ['CURSOR_API_KEY', 'CURSOR_USER_API_KEY']) {
      try {
        const hit = await credentials.resolve(ref)
        const value = hit && typeof hit.value === 'string' ? hit.value.trim() : ''
        if (value) return value
      } catch {
        /* try the next ref */
      }
    }
  }
  const env = process.env.CURSOR_API_KEY
  if (typeof env === 'string' && env.trim()) return env.trim()
  // The credentials service snapshots the launch environment; a key added to
  // the harness-home .env after launch is not in that snapshot yet, so read
  // the file directly as the last fallback.
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const text = await fsp.readFile(path.join(dshHome, '.env'), 'utf8')
    const match = text.match(/^\s*CURSOR_API_KEY\s*=\s*(.+)$/m)
    if (match) {
      const value = match[1].trim().replace(/^['"]|['"]$/g, '')
      if (value) return value
    }
  } catch {
    /* no harness-home .env */
  }
  return undefined
}

async function cursorPost(url, credential, proxy) {
  const response = await requestJson(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': CURSOR_USER_AGENT,
    },
    body: '{}',
    proxy,
  })
  if (response.status === 401) throw qcError('grokbot-auth', 'Cursor API Key 无效，请重新生成')
  if (response.status === 403) throw qcError('grokbot-forbidden', 'Cursor API Key 无权读取用量')
  if (response.status === 429) throw qcError('grokbot-rate', 'Cursor 用量接口暂时被限流')
  if (!response.ok) throw qcError('grokbot-http', `Cursor 返回 HTTP ${response.status}`)
  if (!response.json) throw qcError('grokbot-shape', 'Cursor 返回了非 JSON 响应')
  return response.json
}

function pickNumber(object, names) {
  for (const name of names) {
    if (object && object[name] !== undefined && object[name] !== null) {
      const value = Number(object[name])
      if (Number.isFinite(value)) return value
    }
  }
  return undefined
}

function pickTime(object, names) {
  for (const name of names) {
    const raw = object?.[name]
    if (raw === undefined || raw === null) continue
    if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
      const number = Number(raw)
      if (Number.isFinite(number) && number > 0) return new Date(number > 1e12 ? number : number * 1000).toISOString()
      continue
    }
    const parsed = Date.parse(String(raw))
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return undefined
}

async function fetchGrokBot(ctx, proxy) {
  const key = await resolveCursorKey(ctx)
  if (!key) {
    return {
      id: 'grok',
      kind: 'usage',
      status: 'setup',
      error: { code: 'grokbot-no-key', message: '在 cursor.com/dashboard 生成用户 API Key，写入 CURSOR_API_KEY 后显示 Grok Bot 周用量' },
    }
  }
  try {
    const exchange = await cursorPost(CURSOR_TOKEN_EXCHANGE_URL, key, proxy)
    const token = typeof exchange.accessToken === 'string' ? exchange.accessToken : undefined
    if (!token) throw qcError('grokbot-shape', 'Cursor Key 交换未返回访问令牌')
    const usage = await cursorPost(CURSOR_GROKBOT_USAGE_URL, token, proxy)
    const used = pickNumber(usage, ['usagePercent', 'usage_percent', 'usagePercentage'])
    if (!Number.isFinite(used)) {
      return { id: 'grok', kind: 'usage', status: 'error', error: { code: 'grokbot-shape', message: 'Grok Bot 用量数据格式已变化' } }
    }
    const remaining = Math.min(100, Math.max(0, Math.round(100 - used)))
    const start = pickTime(usage, ['currentPeriodStart', 'current_period_start', 'periodStart'])
    const reset = pickTime(usage, ['nextResetTimestampUtc', 'next_reset_timestamp_utc', 'nextReset', 'next_reset'])
    const plan = typeof usage.cursorPlanName === 'string' && usage.cursorPlanName
      ? 'Grok Bot · ' + usage.cursorPlanName
      : 'Grok Bot'
    return {
      id: 'grok',
      kind: 'usage',
      status: 'ok',
      plan,
      periodStart: start,
      windows: { weekly: { remaining, resetsAt: reset } },
      updatedAt: new Date().toISOString(),
    }
  } catch (error) {
    const code = error?.code ?? 'grokbot-failed'
    const auth = code === 'grokbot-auth' || code === 'grokbot-forbidden'
    return {
      id: 'grok',
      kind: 'usage',
      status: auth ? 'auth' : 'error',
      error: { code, message: messageOf(error) },
    }
  }
}

/* ── Gemini (Antigravity subscription quota) ─────────────────── */

const CODE_ASSIST_BASE = 'https://daily-cloudcode-pa.googleapis.com/v1internal'
const ANTIGRAVITY_ACP_TOKEN = path.join(os.homedir(), '.gemini', 'antigravity-acp', 'acp_token.json')
const ANTIGRAVITY_CLI_TOKEN = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')

async function readJsonFile(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}

/** Prefer the ACP credential document (client id/secret + refresh token), then the CLI login state. */
async function readAntigravityAuth() {
  try {
    const doc = await readJsonFile(ANTIGRAVITY_ACP_TOKEN)
    if (doc && typeof doc.refresh_token === 'string' && doc.refresh_token) {
      return {
        source: 'acp',
        accessToken: typeof doc.token === 'string' ? doc.token : undefined,
        refreshToken: doc.refresh_token,
        clientId: typeof doc.client_id === 'string' ? doc.client_id : undefined,
        clientSecret: typeof doc.client_secret === 'string' ? doc.client_secret : undefined,
        tokenUri: typeof doc.token_uri === 'string' ? doc.token_uri : 'https://oauth2.googleapis.com/token',
        projectId: typeof doc.project_id === 'string' ? doc.project_id : undefined,
        expiry: typeof doc.expiry === 'string' ? doc.expiry : undefined,
      }
    }
  } catch {
    /* no ACP credential document */
  }
  try {
    const doc = await readJsonFile(ANTIGRAVITY_CLI_TOKEN)
    const token = doc?.token && typeof doc.token === 'object' ? doc.token : doc
    const accessToken = token?.access_token ?? token?.AccessToken
    const refreshToken = token?.refresh_token
    if (accessToken || refreshToken) {
      return {
        source: 'cli',
        accessToken: typeof accessToken === 'string' ? accessToken : undefined,
        refreshToken: typeof refreshToken === 'string' ? refreshToken : undefined,
        clientId: typeof doc?.client_id === 'string' ? doc.client_id : process.env.AGY_OAUTH_CLIENT_ID,
        clientSecret: typeof doc?.client_secret === 'string' ? doc.client_secret : process.env.AGY_OAUTH_CLIENT_SECRET,
        tokenUri: typeof doc?.token_uri === 'string' ? doc.token_uri : 'https://oauth2.googleapis.com/token',
        projectId: typeof doc?.project_id === 'string' ? doc.project_id : undefined,
        expiry: typeof token?.expiry === 'string'
          ? token.expiry
          : typeof token?.expiry_date === 'number'
            ? new Date(token.expiry_date).toISOString()
            : typeof doc?.expiry_date === 'number'
              ? new Date(doc.expiry_date).toISOString()
              : undefined,
      }
    }
  } catch {
    /* no CLI login state */
  }
  return null
}

function tokenUsable(state) {
  if (!state.accessToken) return false
  if (!state.expiry) return true
  const at = Date.parse(state.expiry)
  return Number.isFinite(at) ? at - Date.now() > 60_000 : true
}

async function refreshGoogleAuth(state, proxy) {
  if (!state.refreshToken || !state.clientId || !state.clientSecret) {
    throw qcError('gemini-auth', 'Antigravity 登录已过期，请在设置中重新登录')
  }
  const body = new URLSearchParams({
    client_id: state.clientId,
    client_secret: state.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: state.refreshToken,
  }).toString()
  const response = await requestJson(state.tokenUri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    proxy,
  })
  const json = response.json
  if (!response.ok || !json || typeof json.access_token !== 'string') {
    throw qcError('gemini-auth', 'Antigravity 登录已过期，请在设置中重新登录')
  }
  return {
    ...state,
    accessToken: json.access_token,
    expiry: new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000).toISOString(),
  }
}

/** Antigravity client identity; the backend attributes quota requests to ANTIGRAVITY by this UA. */
function antigravityUserAgent() {
  const osType = process.platform === 'darwin' ? 'darwin' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  return `antigravity/acp/1.4.0 (aidev_client; os_type=${osType}; arch=${arch}; host_path=dsh/0.1.0; proxy_client=antigravity/sdk)`
}

async function codeAssist(method, payload, accessToken, proxy) {
  const response = await requestJson(`${CODE_ASSIST_BASE}:${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': antigravityUserAgent(),
    },
    body: JSON.stringify(payload),
    proxy,
  })
  if (response.status === 401 || response.status === 403) {
    throw qcError('gemini-auth', 'Antigravity 登录已被拒绝，请在设置中重新登录')
  }
  if (!response.ok) throw qcError('gemini-http', `Cloud Code 返回 HTTP ${response.status}`)
  if (!response.json) throw qcError('gemini-shape', 'Cloud Code 返回了非 JSON 响应')
  return response.json
}

function geminiLane(label) {
  const text = String(label ?? '').toLowerCase()
  if (/5\s*h|rolling|session|5小时/.test(text)) return 'rolling'
  if (/week|7\s*d|周/.test(text)) return 'weekly'
  if (/month|30\s*d|月/.test(text)) return 'monthly'
  return 'weekly'
}

async function fetchGemini(options = {}) {
  try {
    let state = await readAntigravityAuth()
    if (!state) {
      return {
        id: 'gemini',
        kind: 'usage',
        status: 'setup',
        error: {
          code: 'gemini-no-auth',
          message: '未找到 Antigravity 登录令牌：请导出到 ~/.gemini/antigravity-cli/antigravity-oauth-token（见 README），然后点刷新。',
        },
      }
    }
    if (!tokenUsable(state)) state = await refreshGoogleAuth(state, options.proxy)
    let projectId = state.projectId
    let plan
    if (!projectId) {
      const loaded = await codeAssist('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, state.accessToken, options.proxy)
      projectId = typeof loaded?.cloudaicompanionProject === 'string' ? loaded.cloudaicompanionProject : undefined
      plan = [loaded?.paidTier, loaded?.currentTier]
        .map((tier) => (tier && typeof tier.name === 'string' ? tier.name : undefined))
        .find(Boolean)
      if (!projectId) throw qcError('gemini-shape', '未取得 Cloud Code 项目 ID')
    }
    const summary = await codeAssist('retrieveUserQuotaSummary', { project: projectId }, state.accessToken, options.proxy)
    const buckets = []
    for (const group of Array.isArray(summary?.groups) ? summary.groups : []) {
      for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
        if (bucket?.disabled === true) continue
        const fraction = Number(bucket?.remainingFraction)
        if (!Number.isFinite(fraction)) continue
        buckets.push({
          lane: geminiLane(bucket?.window ?? group?.displayName),
          remaining: Math.max(0, Math.min(100, Math.round(fraction * 100))),
          resetsAt: bucket?.resetTime ? new Date(bucket.resetTime).toISOString() : undefined,
        })
      }
    }
    if (buckets.length === 0) throw qcError('gemini-shape', '额度响应中没有可用窗口')
    const windows = {}
    for (const bucket of buckets) {
      const current = windows[bucket.lane]
      if (!current || bucket.remaining < current.remaining) {
        windows[bucket.lane] = { remaining: bucket.remaining, resetsAt: bucket.resetsAt }
      }
    }
    return {
      id: 'gemini',
      kind: 'usage',
      status: 'ok',
      plan: plan ?? 'Antigravity',
      windows,
      updatedAt: new Date().toISOString(),
    }
  } catch (error) {
    const code = error?.code ?? 'gemini-failed'
    const auth = code === 'gemini-auth'
    return {
      id: 'gemini',
      kind: 'usage',
      status: auth ? 'auth' : 'error',
      error: { code, message: messageOf(error) },
    }
  }
}

/* ── Pending providers ──────────────────────────────────────── */

function pendingRow(id, kind, note) {
  return { id, kind, status: 'pending', error: { code: 'not-wired', message: note } }
}

/* ── RPC channel ────────────────────────────────────────────── */

function quotaEndpoint(pathname) {
  const prefix = RPC_CHANNEL + '/'
  if (!pathname.startsWith(prefix)) return undefined
  const endpoint = pathname.slice(prefix.length)
  if (!endpoint || endpoint.split('/').some((segment) => !/^[A-Za-z0-9_$.-]+$/.test(segment))) return undefined
  return endpoint
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(body))
}

function rpcFailure(rpcId, code, message) {
  return { type: 'server-response', rpcId, result: { ok: false, error: { code, message } } }
}

/**
 * Provider registry: the only Host registration for a provider. Each adapter
 * returns one normalized row ({ id, kind, status, windows|amount, plan, error }).
 * Adding a provider = write its fetch function + append one entry here.
 */
const PROVIDER_ADAPTERS = [
  { id: 'chatgpt', fetch: (ctx, options) => fetchChatGPT(options.proxy) },
  { id: 'gemini', fetch: (ctx, options) => fetchGemini({ force: options.force, proxy: options.proxy }) },
  { id: 'grok', fetch: (ctx, options) => fetchGrokBot(ctx, options.proxy) },
  { id: 'deepseek', fetch: (ctx) => fetchDeepSeek(ctx) },
]
const PROVIDER_IDS = PROVIDER_ADAPTERS.map((provider) => provider.id)

export async function collectRows(ctx, options = {}) {
  const enabled = Array.isArray(options.enabled) ? new Set(options.enabled) : null
  const proxyRaw = options.proxy && typeof options.proxy === 'object' ? options.proxy : {}
  const proxyFor = (id) => {
    const own = typeof proxyRaw[id] === 'string' ? proxyRaw[id].trim() : ''
    if (own) return own
    const globalProxy = typeof proxyRaw.global === 'string' ? proxyRaw.global.trim() : ''
    return globalProxy || undefined
  }
  return await Promise.all(
    PROVIDER_ADAPTERS
      .filter((provider) => !enabled || enabled.has(provider.id))
      .map((provider) => provider.fetch(ctx, {
        force: options.force === true,
        proxy: proxyFor(provider.id),
      })),
  )
}

function registerRpc(ctx, handler) {
  const route = {
    kind: 'prefix',
    path: RPC_CHANNEL,
    handler: async (req, res) => {
      const rejection = typeof ctx.connection?.requestRejection === 'function' ? ctx.connection.requestRejection(req) : undefined
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = quotaEndpoint(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
      if (req.method !== 'POST' || endpoint === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      let message
      try {
        message = await readJsonBody(req)
      } catch (error) {
        writeJson(res, 400, rpcFailure('invalid-request', 'gateway/bad-request', messageOf(error)))
        return
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
        writeJson(res, 200, rpcFailure(rpcId, 'gateway/bad-request', 'invalid client-request message'))
        return
      }
      if (message.method !== endpoint) {
        writeJson(res, 200, rpcFailure(rpcId, 'gateway/bad-request', `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`))
        return
      }
      try {
        writeJson(res, 200, { type: 'server-response', rpcId, result: await handler(endpoint, message.payload) })
      } catch (error) {
        writeJson(res, 200, rpcFailure(rpcId, 'handler-failed', messageOf(error)))
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'dsh-quota-card: rpc channel')
}

export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}
  const refreshMs = Number.isFinite(raw.refreshMs) && raw.refreshMs >= 5000 ? raw.refreshMs : 60_000
  const cacheMs = Number.isFinite(raw.cacheMs) && raw.cacheMs >= 5000 ? raw.cacheMs : CACHE_MS

  registerRpc(ctx, async (endpoint, payload) => {
    if (endpoint !== 'fetch-all') {
      return { ok: false, error: { code: 'unknown-endpoint', message: `unknown endpoint ${endpoint}` } }
    }
    const force = payload?.force === true
    const enabled = Array.isArray(payload?.providers)
      ? payload.providers.filter((id) => PROVIDER_IDS.includes(id))
      : null
    const proxy = payload?.proxy && typeof payload.proxy === 'object' ? payload.proxy : null
    const key = JSON.stringify({ enabled, proxy })
    const now = Date.now()
    if (!force && fetchCache && fetchCache.key === key && now - fetchCache.at < cacheMs) {
      return { ok: true, value: { rows: fetchCache.rows, fetchedAt: fetchCache.at, stale: false, refreshMs } }
    }
    if (inflight && inflight.key === key) {
      const shared = await inflight.promise
      return { ok: true, value: { ...shared, refreshMs } }
    }
    const run = { key, promise: null }
    run.promise = (async () => {
      try {
        const rows = await collectRows(ctx, {
          force,
          enabled: enabled ?? undefined,
          proxy: proxy ?? undefined,
        })
        const fetchedAt = Date.now()
        fetchCache = { at: fetchedAt, rows, key }
        return { rows, fetchedAt, stale: false }
      } finally {
        if (inflight === run) inflight = null
      }
    })()
    inflight = run
    try {
      const value = await run.promise
      return { ok: true, value: { ...value, refreshMs } }
    } catch (error) {
      return { ok: false, error: { code: 'fetch-failed', message: messageOf(error) } }
    }
  })
}

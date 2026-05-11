import qrcodeTerminal from 'qrcode-terminal'
import type { IMAdapter, ImProvider } from '@/im/IMAdapter.ts'
import type { Logger } from '@/logger/logger.ts'
import type { InboundMessage } from '@/im/types.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { SessionStore } from '@/store/SessionStore.ts'
import type { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import type { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import type { WechatApi, WechatCredentials } from './WechatApi.ts'
import type { CredentialsStore } from './CredentialsStore.ts'
import type { WechatRenderer } from './WechatRenderer.ts'
import { createWechatEventSink } from './WechatEventSink.ts'
import {
  ERRCODE_SESSION_EXPIRED,
  WeixinItemType,
  WeixinMessageType,
  type InboundWeixinMessage,
} from './protocol.ts'
import { runScheduledWechatSession } from './scheduled.ts'

export interface WechatAdapterDeps {
  api: WechatApi
  credentialsStore: CredentialsStore
  credentialsFile: string
  orchestrator: ConversationOrchestrator
  sessionStore: SessionStore
  runQueue: SessionRunQueue
  abortRegistry: AbortRegistry<string>
  rendererFactory: () => WechatRenderer
  logger: Logger
}

const QR_LOGIN_TIMEOUT_MS = 480_000
const QR_POLL_INTERVAL_MS = 1_000
const QR_MAX_REFRESHES = 10

const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const MAX_CONSECUTIVE_FAILURES = 3
const DEDUP_TTL_MS = 7 * 60 * 60 * 1_000 // 7 小时

export interface WechatScheduledHookArgs {
  taskId: string
  to: string
  prompt: string
}

export interface WechatScheduledHook {
  run: (args: WechatScheduledHookArgs) => Promise<void>
}

export class MissingWechatCredentialsError extends Error {
  constructor(file: string) {
    super(`未找到微信凭证文件 ${file}；请先用 'agent-slack daemon start' 完成扫码登录`)
    this.name = 'MissingWechatCredentialsError'
  }
}

export interface WechatAdapterHandle {
  adapter: IMAdapter
  /**
   * daemon 模式下定时任务的回调入口：闭包绑定 WechatApi 与本次装配的依赖。
   * CLI 模式不经此 hook，自己 prepareForManualRun + scheduledHook.run。
   */
  scheduledHook: WechatScheduledHook
  /**
   * CLI 模式专用：仅读取凭证文件并 setToken，不触发 QR 登录。
   * 缺失则抛 MissingWechatCredentialsError，调用方据此 exit 3。
   * 凭证里如带 baseUrl，调用方应先 api.baseUrl = creds.baseUrl 再 setToken。
   */
  loadCredentialsOnly: (file: string) => Promise<WechatCredentials>
  /**
   * CLI scheduled-tasks run 前的 preflight：
   *   loadCredentialsOnly → 同步 deps.api.baseUrl (如 creds.baseUrl 与配置不同) → deps.api.setToken
   * 失败抛 MissingWechatCredentialsError，调用方按 spec §5.3 exit 3。
   */
  prepareForManualRun: (credentialsFile: string) => Promise<void>
}

export function createWechatAdapter(deps: WechatAdapterDeps): WechatAdapterHandle {
  const log = deps.logger.withTag('wechat')
  let stopRequested = false
  let stopCtl: AbortController | undefined

  const adapter: IMAdapter = {
    id: 'wechat' as ImProvider,

    async start() {
      let creds = await deps.credentialsStore.load(deps.credentialsFile)
      if (!creds) {
        log.info('未找到凭证，开始扫码登录...')
        creds = await qrLogin(deps, () => stopRequested)
        if (!creds) {
          throw new Error('扫码登录被中止或失败')
        }
        await deps.credentialsStore.save(deps.credentialsFile, creds)
        log.info(`扫码登录成功，凭证已写入 ${deps.credentialsFile}`)
      }
      deps.api.setToken(creds.token)
      log.info(`Wechat adapter 已就绪 botId=${creds.botId}`)
      // 启动 long-poll 异步循环（不 await，让 start() 返回）
      stopCtl = new AbortController()
      void runLongPollLoop(deps, stopCtl.signal, () => stopRequested)
    },

    async stop() {
      stopRequested = true
      stopCtl?.abort()
    },
  }

  const scheduledHook: WechatScheduledHook = {
    async run(args) {
      // daemon 模式下 api 已在 start() setToken；定时任务调用方仅传 taskId/to/prompt。
      await runScheduledWechatSession({
        taskId: args.taskId,
        to: args.to,
        prompt: args.prompt,
        api: deps.api,
        deps: {
          orchestrator: deps.orchestrator,
          rendererFactory: deps.rendererFactory,
          logger: deps.logger,
        },
      })
    },
  }

  async function loadCredentialsOnly(file: string): Promise<WechatCredentials> {
    const creds = await deps.credentialsStore.load(file)
    if (!creds) throw new MissingWechatCredentialsError(file)
    return creds
  }

  async function prepareForManualRun(file: string): Promise<void> {
    const creds = await loadCredentialsOnly(file)
    // 凭证里的 baseUrl 可能与配置 baseUrl 不同（spec §5.3 引用 WechatApi.ts:115 的扫码主域切换）。
    // 必须保留与 WechatApi 构造时一致的"补 trailing /"归一化，否则 `baseUrl + endpoint` 会拼成
    // 不存在的主机名（例如 `...comilink/bot/sendmessage`），node fetch 报 TypeError: fetch failed。
    if (creds.baseUrl) {
      deps.api.baseUrl = creds.baseUrl.endsWith('/') ? creds.baseUrl : creds.baseUrl + '/'
    }
    deps.api.setToken(creds.token)
  }

  return { adapter, scheduledHook, loadCredentialsOnly, prepareForManualRun }
}

/**
 * 扫码登录主循环。返回拿到的 credentials 或 undefined（被 stop 中止 / 超时）。
 */
export async function qrLogin(
  deps: WechatAdapterDeps,
  isStopped: () => boolean,
): Promise<WechatCredentials | undefined> {
  const log = deps.logger.withTag('wechat:qr')
  const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS
  let refreshCount = 0
  let qr = await deps.api.fetchQrCode()
  printQrToTerminal(qr.qrcode_img_content)
  log.info(`扫码 URL: ${qr.qrcode_img_content}`)

  while (!isStopped()) {
    if (Date.now() >= deadline) {
      log.warn(`扫码登录超时 ${QR_LOGIN_TIMEOUT_MS}ms`)
      return undefined
    }
    const status = await deps.api.pollQrStatus(qr.qrcode)
    if (status.status === 'wait') {
      // 继续轮询
    } else if (status.status === 'scaned') {
      log.info('已扫码，请在手机上确认...')
    } else if (status.status === 'expired') {
      refreshCount++
      if (refreshCount >= QR_MAX_REFRESHES) {
        log.warn(`二维码刷新 ${QR_MAX_REFRESHES} 次仍未扫码，放弃`)
        return undefined
      }
      log.info(`二维码已过期，刷新（${refreshCount}/${QR_MAX_REFRESHES}）`)
      qr = await deps.api.fetchQrCode()
      printQrToTerminal(qr.qrcode_img_content)
    } else if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id) {
        log.error('扫码 confirmed 但服务端未返回 token/bot_id')
        return undefined
      }
      log.info(`扫码登录成功 bot_id=${status.ilink_bot_id}`)
      return {
        token: status.bot_token,
        baseUrl: status.baseurl ?? deps.api.baseUrl,
        botId: status.ilink_bot_id,
        userId: status.ilink_user_id ?? '',
      }
    }

    await sleep(QR_POLL_INTERVAL_MS)
  }

  log.info('扫码登录被 stop 中止')
  return undefined
}

function printQrToTerminal(qrUrl: string): void {
  console.log('\n' + '='.repeat(60))
  console.log('  请使用微信扫描二维码登录（约 8 分钟内有效）')
  console.log('='.repeat(60))
  qrcodeTerminal.generate(qrUrl, { small: true }, (qr) => {
    try {
      console.log(qr)
    } catch {
      /* 终端不支持 unicode 时静默 */
    }
  })
  console.log(`  二维码 URL: ${qrUrl}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

/** 可被 abort signal 提前唤醒的 sleep；abort 时 resolve（不 throw） */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function runLongPollLoop(
  deps: WechatAdapterDeps,
  signal: AbortSignal,
  isStopped: () => boolean,
): Promise<void> {
  const log = deps.logger.withTag('wechat:poll')
  let buf = ''
  let consecutiveFailures = 0
  // 入站消息去重：msgId → expireAt
  const dedup = new Map<string, number>()
  // context_token 缓存：userId → contextToken
  const contextTokens = new Map<string, string>()

  while (!signal.aborted && !isStopped()) {
    try {
      const resp = await deps.api.getUpdates(buf, signal)
      if (signal.aborted || isStopped()) break

      if (resp.errcode === ERRCODE_SESSION_EXPIRED) {
        log.warn('session 过期 (errcode -14)，触发 relogin...')
        await deps.credentialsStore.clear(deps.credentialsFile)
        const newCreds = await qrLogin(deps, isStopped)
        if (!newCreds) {
          log.error('relogin 失败，5 分钟后重试（可被 stop signal 提前唤醒）')
          await interruptibleSleep(300_000, signal)
          continue
        }
        await deps.credentialsStore.save(deps.credentialsFile, newCreds)
        deps.api.setToken(newCreds.token)
        buf = ''
        consecutiveFailures = 0
        continue
      }

      const isError = (resp.ret ?? 0) !== 0 || (resp.errcode ?? 0) !== 0
      if (isError) {
        consecutiveFailures++
        log.error('getUpdates 错误', {
          ret: resp.ret,
          errcode: resp.errcode,
          errmsg: resp.errmsg,
          consecutiveFailures,
          max: MAX_CONSECUTIVE_FAILURES,
        })
        await interruptibleSleep(
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
          signal,
        )
        continue
      }

      consecutiveFailures = 0
      if (resp.get_updates_buf) buf = resp.get_updates_buf

      // 清理过期 dedup
      const now = Date.now()
      for (const [mid, expireAt] of dedup) {
        if (expireAt < now) dedup.delete(mid)
      }

      for (const raw of resp.msgs ?? []) {
        try {
          await processMessage(deps, raw, dedup, contextTokens)
        } catch (err) {
          log.error('processMessage 异常', { err })
        }
      }
    } catch (err) {
      if (signal.aborted || isStopped()) break
      consecutiveFailures++
      log.error('getUpdates 异常', { err, consecutiveFailures })
      await interruptibleSleep(
        consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
        signal,
      )
    }
  }
  log.info('long-poll loop 退出')
}

async function processMessage(
  deps: WechatAdapterDeps,
  raw: InboundWeixinMessage,
  dedup: Map<string, number>,
  contextTokens: Map<string, string>,
): Promise<void> {
  const log = deps.logger.withTag('wechat:msg')
  if (raw.message_type !== WeixinMessageType.USER) return // 仅处理用户消息

  const msgId = String(raw.message_id ?? raw.seq ?? '')
  if (!msgId) return
  if (dedup.has(msgId)) return
  dedup.set(msgId, Date.now() + DEDUP_TTL_MS)

  const fromUserId = raw.from_user_id
  // 1. 先更新 contextToken 缓存（spec §7.3 顺序保证：媒体提示也能拿到 token）
  if (raw.context_token) contextTokens.set(fromUserId, raw.context_token)
  const contextToken = contextTokens.get(fromUserId) ?? ''

  // 2. 解析 item_list
  let textBody = ''
  let hasMedia = false
  for (const item of raw.item_list ?? []) {
    if (item.type === WeixinItemType.TEXT) {
      const ti = (item as { text_item?: { text?: string } }).text_item
      if (ti?.text) textBody += (textBody ? '\n' : '') + ti.text
    } else {
      hasMedia = true
    }
  }

  // 3. 媒体消息提示（MVP 不支持）
  if (hasMedia) {
    log.info('收到媒体消息（MVP 阶段不支持，已忽略）', { fromUserId })
    try {
      await deps.api.sendText(
        fromUserId,
        '目前暂不支持图片/语音/文件/视频，请发送文字消息',
        contextToken,
      )
    } catch (err) {
      log.warn('媒体不支持提示发送失败', { err })
    }
    if (!textBody) return // 纯媒体消息丢弃
    // 文本+媒体混合：文本继续走 orchestrator
  }

  if (!textBody) return // 没文本不进 orchestrator

  // 4. 构造 InboundMessage 并送入 orchestrator（fire-and-forget：单条消息处理失败不阻塞下一条入站）
  void runWechatSession({
    inbound: {
      imProvider: 'wechat',
      channelId: fromUserId,
      channelName: fromUserId,
      threadTs: fromUserId,
      messageTs: msgId,
      userId: fromUserId,
      userName: fromUserId,
      text: textBody,
      // confirmSender 留空：wechat 不注入 confirm tool
    },
    api: deps.api,
    rendererFactory: deps.rendererFactory,
    contextToken,
    orchestrator: deps.orchestrator,
    logger: deps.logger,
  }).catch((err) => log.error('orchestrator.handle 失败', { err }))
}

export { processMessage }

// 共享会话执行 helper：构造 sink + 调 orchestrator.handle。
// inbound 路径（processMessage）和 scheduled 路径都走它，避免 sink 构造多处漂移。
export interface RunWechatSessionArgs {
  inbound: InboundMessage
  api: WechatApi
  rendererFactory: () => WechatRenderer
  orchestrator: ConversationOrchestrator
  logger: Logger
  /** scheduled 模式无对方入站消息可锚，传 ''（spec §6.4 风险条目，filehelper 可用） */
  contextToken: string
}

export async function runWechatSession(args: RunWechatSessionArgs): Promise<void> {
  const sink = createWechatEventSink({
    api: args.api,
    renderer: args.rendererFactory(),
    toUserId: args.inbound.channelId,
    contextToken: args.contextToken,
    logger: args.logger,
  })
  await args.orchestrator.handle(args.inbound, sink)
}

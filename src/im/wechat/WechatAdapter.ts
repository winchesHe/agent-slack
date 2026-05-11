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

export function createWechatAdapter(deps: WechatAdapterDeps): IMAdapter {
  const log = deps.logger.withTag('wechat')
  let stopRequested = false
  let stopCtl: AbortController | undefined

  return {
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

  // 4. 构造 InboundMessage 并送入 orchestrator
  const inbound: InboundMessage = {
    imProvider: 'wechat',
    channelId: fromUserId,
    channelName: fromUserId,
    threadTs: fromUserId,
    messageTs: msgId,
    userId: fromUserId,
    userName: fromUserId,
    text: textBody,
    // confirmSender 留空：wechat 不注入 confirm tool
  }

  const sink = createWechatEventSink({
    api: deps.api,
    renderer: deps.rendererFactory(),
    toUserId: fromUserId,
    contextToken,
    logger: deps.logger,
  })

  // fire-and-forget：单条消息处理失败不阻塞下一条入站
  void deps.orchestrator
    .handle(inbound, sink)
    .catch((err) => log.error('orchestrator.handle 失败', { err }))
}

export { processMessage }

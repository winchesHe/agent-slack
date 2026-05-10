// 腾讯 ilink bot HTTP 协议类型定义
// 反向工程自 CowAgent channel/weixin/weixin_api.py

/** 消息 item 类型（CowAgent 的 ITEM_* 常量） */
export enum WeixinItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

/** 消息发送方类型 */
export enum WeixinMessageType {
  USER = 1, // 用户发给 bot
  BOT = 2, // bot 发给用户
}

export enum WeixinMessageState {
  /** sendmessage 必须传 2 = FINISH，CowAgent 同设计 */
  FINISH = 2,
}

export interface WeixinTextItem {
  type: WeixinItemType.TEXT
  text_item: { text: string }
}

export interface WeixinMediaItem {
  type: WeixinItemType.IMAGE | WeixinItemType.VOICE | WeixinItemType.FILE | WeixinItemType.VIDEO
  // MVP 不解析，保留字段以便日志
  [key: string]: unknown
}

export type WeixinItem = WeixinTextItem | WeixinMediaItem

export interface InboundWeixinMessage {
  message_type: WeixinMessageType
  message_id?: string
  seq?: string | number
  from_user_id: string
  to_user_id: string
  context_token: string
  create_time_ms?: number
  item_list: WeixinItem[]
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  /** 同步游标，下次 getUpdates 透传 */
  get_updates_buf?: string
  msgs?: InboundWeixinMessage[]
}

export interface QrStatusResp {
  /** wait | scaned | expired | confirmed */
  status: string
  qrcode?: string
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
}

export interface FetchQrCodeResp {
  qrcode: string
  qrcode_img_content: string
}

/** errcode -14 = session 过期，触发 relogin */
export const ERRCODE_SESSION_EXPIRED = -14

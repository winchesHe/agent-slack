interface SlackApiSuccessResponse {
  ok: true
  response_metadata?: {
    warnings?: string[]
  }
}

interface SlackApiErrorResponse {
  error: string
  ok: false
}

type SlackApiResponse<T> = SlackApiSuccessResponse & T

export interface SlackAuthTestResponse {
  team: string
  team_id: string
  url: string
  user: string
  user_id: string
}

export interface SlackPostedMessageResponse {
  channel: string
  message?: {
    app_id?: string
    bot_id?: string
    text?: string
    thread_ts?: string
    ts?: string
    user?: string
  }
  ts: string
}

export interface SlackConversationRepliesResponse {
  has_more?: boolean
  messages?: Array<{
    blocks?: Array<{ type?: string } & Record<string, unknown>>
    app_id?: string
    bot_id?: string
    text?: string
    thread_ts?: string
    ts?: string
    user?: string
  }>
}

export interface SlackReactionsGetResponse {
  channel: string
  message?: {
    reactions?: Array<{
      count: number
      name: string
      users: string[]
    }>
    text?: string
    ts?: string
  }
  type: string
}

export class SlackApiClient {
  constructor(private readonly token: string) {}

  async authTest(): Promise<SlackAuthTestResponse> {
    return this.call<SlackAuthTestResponse>('auth.test', undefined, 'GET')
  }

  async postMessage(args: {
    channel: string
    text: string
    thread_ts?: string
    unfurl_links?: boolean
    unfurl_media?: boolean
  }): Promise<SlackPostedMessageResponse> {
    return this.call<SlackPostedMessageResponse>('chat.postMessage', args, 'POST')
  }

  async conversationReplies(args: {
    channel: string
    inclusive?: boolean
    limit?: number
    ts: string
  }): Promise<SlackConversationRepliesResponse> {
    return this.call<SlackConversationRepliesResponse>('conversations.replies', args, 'GET')
  }

  async getReactions(args: {
    channel: string
    timestamp: string
  }): Promise<SlackReactionsGetResponse> {
    return this.call<SlackReactionsGetResponse>('reactions.get', { ...args, full: true }, 'GET')
  }

  private async call<T extends object>(
    method: string,
    params?: Record<string, unknown>,
    httpMethod: 'GET' | 'POST' = 'POST',
  ): Promise<SlackApiResponse<T>> {
    const searchParams = new URLSearchParams()
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) {
        searchParams.set(key, String(value))
      }
    }

    const url =
      httpMethod === 'GET' && searchParams.size > 0
        ? `https://slack.com/api/${method}?${searchParams.toString()}`
        : `https://slack.com/api/${method}`

    const response = await fetch(url, {
      method: httpMethod,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(httpMethod === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }
          : {}),
      },
      ...(httpMethod === 'POST' ? { body: searchParams.toString() } : {}),
    })

    if (!response.ok) {
      throw new Error(`Slack API ${method} failed with HTTP ${response.status}`)
    }

    const data = (await response.json()) as SlackApiResponse<T> | SlackApiErrorResponse
    if (!data.ok) {
      throw new Error(`Slack API ${method} error: ${data.error}`)
    }

    return data
  }
}

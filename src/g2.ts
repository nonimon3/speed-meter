/**
 * Even G2 Bridge の薄いラッパ。
 *
 * レイアウト (576×288) — 4 TextContainer:
 *   - time (左上)
 *   - speed-digits (中央, ドット絵 5 行)
 *   - unit (数字直下の右寄り、独立コンテナなので桁が変わっても動かない)
 *   - stats (左下)
 *
 * 行数は 5 行固定。line-height が制御不能なので各コンテナ高は余裕を持たせている。
 */

import {
  CreateStartUpPageContainer,
  EvenHubEvent,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

const CID = { time: 1, speed: 2, stats: 3 } as const
const CNAME = {
  time: 'sm-time',
  speed: 'sm-speed',
  stats: 'sm-stats',
} as const

const SCREEN_W = 576
const SCREEN_H = 288
const BRIDGE_TIMEOUT_MS = 4000

export type G2Event =
  | { kind: 'click' }
  | { kind: 'doubleClick' }
  | { kind: 'scrollUp' }
  | { kind: 'scrollDown' }
  | { kind: 'foregroundExit' }

export type G2EventListener = (e: G2Event) => void

export interface G2Handle {
  connected: boolean
  updateTime(s: string): Promise<void>
  updateSpeed(s: string): Promise<void>
  updateStats(s: string): Promise<void>
  onEvent(fn: G2EventListener): () => void
  shutdown(): Promise<void>
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

function resolveEventType(
  raw: number | undefined,
  container: unknown,
): OsEventTypeList | null {
  if (typeof raw === 'number') return raw
  if (container && typeof container === 'object') return OsEventTypeList.CLICK_EVENT
  return null
}

export async function connectG2(): Promise<G2Handle> {
  const b = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
  if (!b) return makeMockHandle()
  const bridge = b

  const eventListeners = new Set<G2EventListener>()
  bridge.onEvenHubEvent((event: EvenHubEvent) => {
    const ev = normalizeEvent(event)
    if (ev) for (const fn of eventListeners) fn(ev)
  })

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [
        new TextContainerProperty({
          containerID: CID.time,
          containerName: CNAME.time,
          xPosition: 8,
          yPosition: 0,
          width: 240,
          height: 32,
          paddingLength: 0,
          content: '--/-- --:--',
        }),
        new TextContainerProperty({
          containerID: CID.speed,
          containerName: CNAME.speed,
          xPosition: 0,
          yPosition: 64,          // 以前は 32。ユーザー要望で 1 行分下げる
          width: SCREEN_W,
          height: 180,             // 5 行 (line-height ~32-36px) 入る高さ
          paddingLength: 0,
          content: '',
        }),
        new TextContainerProperty({
          containerID: CID.stats,
          containerName: CNAME.stats,
          xPosition: 8,
          yPosition: SCREEN_H - 32,
          width: SCREEN_W - 16,
          height: 30,
          paddingLength: 0,
          content: 'MAX --  AVG --',
          isEventCapture: 1,
        }),
      ],
    }),
  )

  if (result !== StartUpPageCreateResult.success) {
    console.error('[g2] startup failed:', result)
    throw new Error(`G2 startup failed (code ${result})`)
  }

  async function pushText(containerID: number, containerName: string, content: string) {
    try {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID,
        containerName,
        contentOffset: 0,
        contentLength: 2000,
        content,
      }))
    } catch (e) {
      console.warn('[g2] textContainerUpgrade failed', containerName, e)
    }
  }

  return {
    connected: true,
    updateTime: (s) => pushText(CID.time, CNAME.time, s),
    updateSpeed: (s) => pushText(CID.speed, CNAME.speed, s),
    updateStats: (s) => pushText(CID.stats, CNAME.stats, s),
    onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn) },
    async shutdown() {
      try { await bridge.shutDownPageContainer(0) } catch (e) { console.warn('[g2] shutdown failed', e) }
    },
  }
}

function normalizeEvent(event: EvenHubEvent): G2Event | null {
  const { textEvent, listEvent, sysEvent } = event
  const carrier = textEvent ?? listEvent
  const rawType = carrier?.eventType ?? sysEvent?.eventType
  const resolved = resolveEventType(rawType, carrier)
  if (resolved == null) return null
  switch (resolved) {
    case OsEventTypeList.CLICK_EVENT: return { kind: 'click' }
    case OsEventTypeList.DOUBLE_CLICK_EVENT: return { kind: 'doubleClick' }
    case OsEventTypeList.SCROLL_TOP_EVENT: return { kind: 'scrollUp' }
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: return { kind: 'scrollDown' }
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return { kind: 'foregroundExit' }
    default: return null
  }
}

function makeMockHandle(): G2Handle {
  console.info('[g2] bridge unavailable, running in browser-mock mode')
  const listeners = new Set<G2EventListener>()
  return {
    connected: false,
    async updateTime() {}, async updateSpeed() {}, async updateStats() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async shutdown() {},
  }
}

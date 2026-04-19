/**
 * Chrome で動作する companion.html が ntfy.sh にポストした速度情報を
 * Even Hub WebView 側から polling で拾うアダプタ。
 *
 * なぜこの迂回路か:
 *   - Even Hub v0.0.10 の WebView は Web Geolocation を実装レベルで silent deny
 *     する (HTTP/HTTPS 問わず確定)
 *   - そのためアプリ側から直接 GPS は取れない
 *   - しかし普通の Android Chrome ブラウザは geolocation を許可できる
 *   - ntfy.sh を公開メッセージキューとして挟めば:
 *     [Chrome] GPS → ntfy.sh → [Even Hub WebView] fetch → G2
 *
 * 使い方:
 *   const remote = new RemoteSpeedSource()
 *   remote.start('ABCD1234')  // セッションコード
 *   remote.onSample((s) => gps.injectExternal(s.speed))
 */

export interface RemoteSpeedSample {
  speed: number   // m/s
  accuracy: number // m
  lat?: number
  lng?: number
  ts: number
}

export type RemoteSpeedListener = (s: RemoteSpeedSample) => void

const NTFY_BASE = 'https://ntfy.sh'

export class RemoteSpeedSource {
  private readonly listeners = new Set<RemoteSpeedListener>()
  private abort: AbortController | null = null
  private pollTimer: number | null = null
  private code: string | null = null
  private lastReceivedAt = 0
  private lastMessageId: string | null = null

  onSample(fn: RemoteSpeedListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * ntfy.sh のトピックを購読。SSE で繋ぎっぱなしにするのが本筋だが
   * WebView が長時間接続を切ることがあるので ~500ms 間隔でポーリング方式にする。
   */
  start(code: string): void {
    this.stop()
    this.code = code.trim().toLowerCase()
    if (!this.code) return
    this.abort = new AbortController()
    // 少し遡ってラストメッセージから取り始める
    this.lastReceivedAt = Date.now() - 3000
    this.pollLoop()
  }

  stop(): void {
    if (this.abort) { this.abort.abort(); this.abort = null }
    if (this.pollTimer != null) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }

  private topicUrl(): string {
    return `${NTFY_BASE}/speedmeter-g2-${encodeURIComponent(this.code!)}/json?poll=1&since=${Math.floor(this.lastReceivedAt / 1000)}`
  }

  private async pollLoop(): Promise<void> {
    if (!this.code || !this.abort) return
    try {
      const res = await fetch(this.topicUrl(), { signal: this.abort.signal })
      if (!res.ok) throw new Error(`ntfy ${res.status}`)
      const text = await res.text()
      // 1 行 1 JSON (NDJSON)
      const lines = text.split('\n').filter((l) => l.trim().length > 0)
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as { id?: string; time?: number; message?: string }
          if (!msg.message) continue
          if (msg.id && msg.id === this.lastMessageId) continue
          this.lastMessageId = msg.id ?? null
          const payload = JSON.parse(msg.message) as Partial<RemoteSpeedSample>
          if (typeof payload.speed === 'number') {
            const sample: RemoteSpeedSample = {
              speed: Math.max(0, payload.speed),
              accuracy: Math.max(0, payload.accuracy ?? 0),
              lat: payload.lat,
              lng: payload.lng,
              ts: payload.ts ?? (msg.time ? msg.time * 1000 : Date.now()),
            }
            this.lastReceivedAt = sample.ts
            for (const fn of this.listeners) fn(sample)
          }
        } catch {/* skip malformed line */}
      }
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') {
        console.warn('[remote] poll failed:', (e as Error).message)
      }
    }
    if (this.abort && !this.abort.signal.aborted) {
      this.pollTimer = window.setTimeout(() => this.pollLoop(), 700)
    }
  }
}

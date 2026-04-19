/**
 * GPS ベースの速度計。
 * - navigator.geolocation.watchPosition で位置を購読
 * - position.coords.speed (m/s) を使う。null の時は haversine で前回位置との差分から推定
 * - 軽い指数平滑 (EMA) と停止判定
 */

export interface SpeedSample {
  /** 平滑後の速度 (m/s) */
  speed: number
  /** 生の速度 (m/s) */
  rawSpeed: number
  /** 水平精度 (m) */
  accuracy: number
  /** ソース: 'native' = coords.speed / 'derived' = 2点間距離から推定 */
  source: 'native' | 'derived' | 'idle'
  /** タイムスタンプ (ms) */
  ts: number
  /** 累積最大速度 (m/s) */
  maxSpeed: number
  /** 走行距離 (m) */
  distance: number
  /** 有効サンプル数 */
  samples: number
  /** 平均速度 (m/s) = 距離 / 時間 */
  avgSpeed: number
}

export type SpeedListener = (s: SpeedSample) => void
export type GpsErrorListener = (err: GeolocationPositionError) => void

function codeName(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED: return 'PERMISSION_DENIED'
    case err.POSITION_UNAVAILABLE: return 'POSITION_UNAVAILABLE'
    case err.TIMEOUT: return 'TIMEOUT'
    default: return `UNKNOWN(${err.code})`
  }
}

interface TrackState {
  lastPos: GeolocationPosition | null
  lastSpeed: number
  ema: number
  max: number
  distance: number
  totalActiveMs: number
  samples: number
  firstActiveTs: number | null
  lastIngestTs: number | null
}

const EMA_ALPHA = 0.35
/** 精度がこれより悪い (=数値大) 測位は捨てる (m) */
const MAX_ACCEPTABLE_ACCURACY_M = 50
/** これ未満は停止扱い (m/s ≒ 1.8 km/h) */
const IDLE_THRESHOLD_MS = 0.5

function haversine(
  a: GeolocationCoordinates,
  b: GeolocationCoordinates,
): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const s1 = Math.sin(dLat / 2)
  const s2 = Math.sin(dLon / 2)
  const c =
    s1 * s1 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * s2 * s2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)))
}

export class GpsSpeedometer {
  private state: TrackState = {
    lastPos: null,
    lastSpeed: 0,
    ema: 0,
    max: 0,
    distance: 0,
    totalActiveMs: 0,
    samples: 0,
    firstActiveTs: null,
    lastIngestTs: null,
  }
  private watchId: number | null = null
  private mockTimer: number | null = null
  private mockPhase = 0
  private readonly listeners = new Set<SpeedListener>()
  private readonly errorListeners = new Set<GpsErrorListener>()

  get isMocking(): boolean {
    return this.mockTimer != null
  }

  onSample(fn: SpeedListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onError(fn: GpsErrorListener): () => void {
    this.errorListeners.add(fn)
    return () => this.errorListeners.delete(fn)
  }

  reset(): void {
    this.state = {
      lastPos: null,
      lastSpeed: 0,
      ema: 0,
      max: 0,
      distance: 0,
      totalActiveMs: 0,
      samples: 0,
      firstActiveTs: null,
      lastIngestTs: null,
    }
    this.emit({
      speed: 0,
      rawSpeed: 0,
      accuracy: 0,
      source: 'idle',
      ts: Date.now(),
      maxSpeed: 0,
      distance: 0,
      samples: 0,
      avgSpeed: 0,
    })
  }

  start(): boolean {
    if (!('geolocation' in navigator)) {
      console.warn('[gps] navigator.geolocation is unavailable')
      return false
    }
    if (this.watchId != null) return true
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handlePosition(pos),
      (err) => this.handleError(err),
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15000,
      },
    )
    return true
  }

  /** 権限ダイアログを明示的に出すために getCurrentPosition を 1 回呼ぶ。 */
  requestPermission(): Promise<{ ok: boolean; info: string }> {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) {
        resolve({ ok: false, info: 'navigator.geolocation が無効 (WebView が対応してない可能性)' })
        return
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            ok: true,
            info: `許可取得成功 (${pos.coords.latitude.toFixed(4)},${pos.coords.longitude.toFixed(4)}, ±${Math.round(pos.coords.accuracy)}m)`,
          })
        },
        (err) => {
          resolve({
            ok: false,
            info: `code=${err.code} ${codeName(err)} / msg="${err.message || '(空)'}"`,
          })
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
      )
    })
  }

  /** permissions API で現在の位置情報許可状態を問い合わせる。対応していなければ null。 */
  async queryPermissionState(): Promise<PermissionState | null> {
    const p = (navigator as Navigator & { permissions?: Permissions }).permissions
    if (!p?.query) return null
    try {
      const status = await p.query({ name: 'geolocation' as PermissionName })
      return status.state
    } catch {
      return null
    }
  }

  /**
   * Bridge の裏口 (callEvenApp) に location 系メソッドが居ないか総当たりで叩く。
   * 見つかれば戻り値を使って位置が取れる可能性がある。
   */
  async probeNativeBridgeLocation(bridge: { callEvenApp?: (m: string, p?: unknown) => Promise<unknown> }): Promise<string> {
    if (!bridge?.callEvenApp) return 'bridge.callEvenApp が無い'
    const methods = [
      'getLocation', 'getCurrentLocation', 'getGPS', 'getGeolocation',
      'getPosition', 'getCurrentPosition', 'location', 'geolocation',
      'requestLocation', 'fetchLocation', 'getLatLng', 'getCoords',
    ]
    const results: string[] = []
    for (const m of methods) {
      try {
        const r = await bridge.callEvenApp(m)
        const str = typeof r === 'object' ? JSON.stringify(r) : String(r)
        results.push(`${m} → ${str.slice(0, 120)}`)
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e)
        // "method not supported" 系は省略、それ以外は記録
        if (!/not\s*(support|found)|unknown method|invalid method/i.test(msg)) {
          results.push(`${m} ✗ ${msg.slice(0, 80)}`)
        }
      }
    }
    return results.length ? results.join('\n') : 'location 系メソッドは見つからず'
  }

  stop(): void {
    if (this.watchId != null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.watchId)
    }
    this.watchId = null
    if (this.mockTimer != null) {
      clearInterval(this.mockTimer)
      this.mockTimer = null
    }
  }

  /** 外部ソース (IMU等) から速度値を注入する。EMA/最大/積算距離のパイプラインに流れる。 */
  injectExternal(raw: number, accuracy = 5, source: SpeedSample['source'] = 'derived'): void {
    this.ingest(Math.max(0, raw), accuracy, source)
  }

  /**
   * ブラウザ/Simulator で permission が取れない時などに使う疑似ドライブ。
   * - 市街地走行風の変動: 停止→加速→巡航→減速を繰り返す
   * - profile で基調を変えられる
   */
  startMock(profile: 'city' | 'highway' | 'walk' = 'city'): void {
    this.stop()
    this.mockPhase = 0
    const tickMs = 500
    this.mockTimer = window.setInterval(() => {
      this.mockPhase += 1
      const t = this.mockPhase
      let mps: number
      switch (profile) {
        case 'highway':
          mps = 28 + 6 * Math.sin(t / 20) + (Math.random() - 0.5) * 1.5
          break
        case 'walk':
          mps = 1.3 + 0.4 * Math.sin(t / 4) + (Math.random() - 0.5) * 0.3
          break
        case 'city':
        default: {
          const cycle = t % 80
          if (cycle < 10) mps = 0 // 信号停止
          else if (cycle < 25) mps = ((cycle - 10) / 15) * 13 // 加速 0→47km/h
          else if (cycle < 55) mps = 12 + Math.sin((cycle - 25) / 6) * 2 // 巡航
          else if (cycle < 70) mps = 12 * (1 - (cycle - 55) / 15) // 減速
          else mps = 0.2 // 徐行
          mps += (Math.random() - 0.5) * 0.6
          break
        }
      }
      const raw = Math.max(0, mps)
      this.ingest(raw, 5, 'native')
    }, tickMs)
  }

  private handlePosition(pos: GeolocationPosition): void {
    const coords = pos.coords
    const accuracy = coords.accuracy ?? 9999
    if (accuracy > MAX_ACCEPTABLE_ACCURACY_M && this.state.samples > 0) {
      // 初回は精度が悪くても通す。以降は捨てる。
      return
    }

    let raw: number
    let source: SpeedSample['source']

    if (typeof coords.speed === 'number' && !Number.isNaN(coords.speed) && coords.speed >= 0) {
      raw = coords.speed
      source = 'native'
    } else if (this.state.lastPos) {
      const dtMs = pos.timestamp - this.state.lastPos.timestamp
      if (dtMs > 50) {
        const d = haversine(this.state.lastPos.coords, coords)
        raw = d / (dtMs / 1000)
        source = 'derived'
      } else {
        raw = this.state.lastSpeed
        source = 'derived'
      }
    } else {
      raw = 0
      source = 'idle'
    }

    this.state.lastPos = pos
    this.ingest(raw, accuracy, source)
  }

  private ingest(raw: number, accuracy: number, source: SpeedSample['source']): void {
    const now = Date.now()
    // 実経過時間ベースの積算。mock (startMock) / 実 GPS (watchPosition) 両方で共通動作。
    const dtMs = this.state.lastIngestTs != null
      ? Math.min(5000, Math.max(0, now - this.state.lastIngestTs))
      : 0
    this.state.lastIngestTs = now

    const smoothed = this.state.samples === 0
      ? raw
      : EMA_ALPHA * raw + (1 - EMA_ALPHA) * this.state.ema

    const active = smoothed >= IDLE_THRESHOLD_MS
    if (active) {
      if (this.state.firstActiveTs == null) this.state.firstActiveTs = now
      if (dtMs > 0) {
        this.state.totalActiveMs += dtMs
        // distance: 平滑後の速度で近似 (dt が小さいので直線で十分)
        this.state.distance += smoothed * (dtMs / 1000)
      }
    }

    this.state.ema = smoothed
    this.state.lastSpeed = raw
    this.state.samples += 1
    if (smoothed > this.state.max) this.state.max = smoothed

    const avg = this.state.totalActiveMs > 0
      ? this.state.distance / (this.state.totalActiveMs / 1000)
      : 0

    this.emit({
      speed: active ? smoothed : 0,
      rawSpeed: raw,
      accuracy,
      source: active ? source : 'idle',
      ts: now,
      maxSpeed: this.state.max,
      distance: this.state.distance,
      samples: this.state.samples,
      avgSpeed: avg,
    })
  }

  private handleError(err: GeolocationPositionError): void {
    console.warn('[gps] error', err.code, err.message)
    for (const fn of this.errorListeners) fn(err)
  }

  private emit(s: SpeedSample): void {
    for (const fn of this.listeners) fn(s)
  }
}

export function mpsToKmh(mps: number): number {
  return mps * 3.6
}

export function mpsToMph(mps: number): number {
  return mps * 2.2369362920544
}

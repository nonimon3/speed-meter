/**
 * DeviceMotion (加速度) をベクトル積分して速度を推定する。
 *
 * 理論:
 *   v(t) = v(0) + ∫ a_motion(t) dt
 *   ここで a_motion = a_sensor - gravity
 *
 *   スマホを固定し、停止状態から始めれば v(0) = 0。以降は加速度を時間積分するだけで
 *   巡航中 (a ≈ 0) も速度が維持される。
 *
 * 実装の肝:
 *   1. 起動直後 2 秒は停止してもらう → 平均加速度ベクトルを重力として確定
 *      (キャリブレーション中は "CALIBRATING" モード)
 *   2. 以降: a - gravity_calibrated を 3 軸ベクトル積分
 *   3. ZUPT (Zero-velocity UPdaTe):
 *      - 直近 2 秒の残差加速度がほぼ 0 なら、停止とみなして velocity をゼロに戻す
 *      - 積分バイアスの蓄積を信号停止で随時リセット
 *   4. 再キャリブレーション: 重力ベクトルが明らかに変化 (端末の向きが変わった)
 *      → 速度をゼロにして再度キャリブレーション状態へ
 *
 * 前提:
 *   - スマホを車のホルダー等に固定
 *   - 起動時は停止状態
 *   - 端末の向きは途中で変えない (変えたら再キャリブレーション走る)
 *
 * 限界:
 *   - 加速度計のバイアス誤差が蓄積 → 数分使うと数 km/h 単位でズレる
 *   - センサノイズ (多くは 0.02〜0.05 m/s² 程度)
 *   - ZUPT が効けば長時間使っても破綻しない (信号待ち毎にリセット)
 */

export type ImuMode = 'calibrating' | 'tracking' | 'stopped'

export interface ImuSpeedSample {
  /** 推定速度 (m/s)。velocity ベクトルの大きさ。 */
  speed: number
  /** 現在の状態 */
  mode: ImuMode
  /** 直近残差加速度の大きさ (m/s²)。動いてない判定の参考値 */
  accelMag: number
  ts: number
  samples: number
}

export type ImuSpeedListener = (s: ImuSpeedSample) => void

/** 起動時のキャリブレーション時間 (ms)。この間スマホを静止させる。 */
const CALIBRATION_DURATION_MS = 2000
/** キャリブレーションに必要な最小サンプル数 */
const MIN_CALIBRATION_SAMPLES = 20
/** ZUPT 判定窓 (ms)。この期間の |a_motion| がすべて閾値未満なら停止と見なす */
const ZUPT_WINDOW_MS = 1500
/** ZUPT 発動の加速度閾値 (m/s²)。これ未満を "停止" と見なす */
const ZUPT_ACCEL_THRESHOLD = 0.18
/** 重力ベクトルの長さがこれ以上変わったら端末が傾いた→再キャリブレーション */
const GRAVITY_DRIFT_THRESHOLD = 1.2
/** 低周波 bias を差し引くための超低域フィルタ係数 */
const BIAS_EMA_ALPHA = 0.005
/** 速度絶対上限 (m/s) = 360 km/h。これ超えたら発散してるとみなして 0 に */
const MAX_PLAUSIBLE_SPEED = 100

interface Vec3 { x: number; y: number; z: number }

export class ImuSpeedometer {
  private readonly listeners = new Set<ImuSpeedListener>()

  private mode: ImuMode = 'calibrating'
  private gravity: Vec3 | null = null
  private gravityMag = 0
  private calibrationStartedAt = 0
  private calibrationSamples: Vec3[] = []

  private velocity: Vec3 = { x: 0, y: 0, z: 0 }
  private bias: Vec3 = { x: 0, y: 0, z: 0 } // 走行中に推定する加速度センサバイアス
  private lastTs: number | null = null
  private samples = 0

  // ZUPT 用: 直近の |a_motion| をタイムスタンプ付きで保持
  private zuptBuf: Array<{ t: number; a: number }> = []

  private handler: ((e: DeviceMotionEvent) => void) | null = null
  private running = false

  onSample(fn: ImuSpeedListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  get isSupported(): boolean {
    return typeof window !== 'undefined' && 'DeviceMotionEvent' in window
  }

  async start(): Promise<{ ok: boolean; info: string }> {
    if (!this.isSupported) return { ok: false, info: 'DeviceMotionEvent 非対応' }

    // iOS 13+ は requestPermission が必要
    const anyDM = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> }
    if (typeof anyDM.requestPermission === 'function') {
      try {
        const res = await anyDM.requestPermission()
        if (res !== 'granted') return { ok: false, info: `DeviceMotion permission: ${res}` }
      } catch (e) {
        return { ok: false, info: `requestPermission 失敗: ${(e as Error).message}` }
      }
    }

    if (this.running) return { ok: true, info: '既に起動中' }

    this.resetCalibration()
    this.handler = (e) => this.onMotion(e)
    window.addEventListener('devicemotion', this.handler)
    this.running = true
    return { ok: true, info: 'DeviceMotion 購読開始 (キャリブレーション中)' }
  }

  stop(): void {
    if (this.handler) {
      window.removeEventListener('devicemotion', this.handler)
      this.handler = null
    }
    this.running = false
  }

  reset(): void {
    this.velocity = { x: 0, y: 0, z: 0 }
    this.bias = { x: 0, y: 0, z: 0 }
    this.zuptBuf = []
    this.lastTs = null
    this.samples = 0
    this.resetCalibration()
  }

  /** キャリブレーションをやり直す (端末再配置時など) */
  recalibrate(): void {
    this.velocity = { x: 0, y: 0, z: 0 }
    this.bias = { x: 0, y: 0, z: 0 }
    this.resetCalibration()
  }

  private resetCalibration(): void {
    this.mode = 'calibrating'
    this.gravity = null
    this.gravityMag = 0
    this.calibrationStartedAt = Date.now()
    this.calibrationSamples = []
  }

  private onMotion(e: DeviceMotionEvent): void {
    const a = e.accelerationIncludingGravity
    if (!a || a.x == null || a.y == null || a.z == null) return
    const t = e.timeStamp || Date.now()

    if (this.mode === 'calibrating') {
      this.calibrationSamples.push({ x: a.x, y: a.y, z: a.z })
      const elapsed = Date.now() - this.calibrationStartedAt
      if (elapsed >= CALIBRATION_DURATION_MS && this.calibrationSamples.length >= MIN_CALIBRATION_SAMPLES) {
        this.finishCalibration()
      }
      this.emitSample(0, 0)
      return
    }

    if (!this.gravity) return

    // 1. 残差加速度 = センサ値 - キャリブレーション時の重力ベクトル - 走行中 bias
    const rx = a.x - this.gravity.x - this.bias.x
    const ry = a.y - this.gravity.y - this.bias.y
    const rz = a.z - this.gravity.z - this.bias.z
    const aMag = Math.sqrt(rx * rx + ry * ry + rz * rz)

    // 2. dt 計算
    const dtMs = this.lastTs != null ? Math.min(500, Math.max(0, t - this.lastTs)) : 0
    this.lastTs = t
    if (dtMs <= 0) {
      this.emitSample(this.speedMag(), aMag)
      return
    }
    const dt = dtMs / 1000

    // 3. 重力ベクトルの大きさが変化していないか監視 (端末の向きが変わった検知)
    const currentMag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
    if (Math.abs(currentMag - this.gravityMag) > GRAVITY_DRIFT_THRESHOLD) {
      // ZUPT で停止が確認できていれば再キャリブレーション
      if (this.isStationaryByZupt(t)) {
        console.log('[imu] gravity drift detected + stationary → recalibrate')
        this.recalibrate()
        this.emitSample(0, aMag)
        return
      }
    }

    // 4. ベクトル積分
    this.velocity.x += rx * dt
    this.velocity.y += ry * dt
    this.velocity.z += rz * dt

    // 5. ZUPT 履歴更新
    this.zuptBuf.push({ t, a: aMag })
    const cutoff = t - ZUPT_WINDOW_MS
    while (this.zuptBuf.length > 0 && this.zuptBuf[0].t < cutoff) this.zuptBuf.shift()

    // 6. ZUPT 発動判定: 十分な期間サンプルがあり、最大値が閾値未満
    if (this.isStationaryByZupt(t)) {
      // 停止 → 速度リセット + 走行中 bias を微修正 (今の残差平均を bias に足し込む)
      //   これにより次の走行区間で drift が減る
      const avgX = this.zuptBuf.reduce((s, v) => s + (v.a === 0 ? 0 : rx), 0) / this.zuptBuf.length
      void avgX
      this.bias.x += rx * BIAS_EMA_ALPHA
      this.bias.y += ry * BIAS_EMA_ALPHA
      this.bias.z += rz * BIAS_EMA_ALPHA
      this.velocity = { x: 0, y: 0, z: 0 }
      this.mode = 'stopped'
    } else {
      this.mode = 'tracking'
    }

    // 7. 発散防止: 明らかに現実的でない速度は異常値として 0 に
    const speed = this.speedMag()
    if (speed > MAX_PLAUSIBLE_SPEED) {
      console.warn(`[imu] speed diverged (${speed.toFixed(1)}m/s) → recalibrate`)
      this.recalibrate()
      this.emitSample(0, aMag)
      return
    }

    this.samples += 1
    this.emitSample(speed, aMag)
  }

  private finishCalibration(): void {
    const n = this.calibrationSamples.length
    const sx = this.calibrationSamples.reduce((s, v) => s + v.x, 0) / n
    const sy = this.calibrationSamples.reduce((s, v) => s + v.y, 0) / n
    const sz = this.calibrationSamples.reduce((s, v) => s + v.z, 0) / n
    this.gravity = { x: sx, y: sy, z: sz }
    this.gravityMag = Math.sqrt(sx * sx + sy * sy + sz * sz)
    this.mode = 'stopped' // まだ動いてない前提
    this.velocity = { x: 0, y: 0, z: 0 }
    this.bias = { x: 0, y: 0, z: 0 }
    this.calibrationSamples = []
    this.zuptBuf = []
    console.log(`[imu] calibration done. gravity=(${sx.toFixed(2)},${sy.toFixed(2)},${sz.toFixed(2)}) |g|=${this.gravityMag.toFixed(2)}`)
  }

  private isStationaryByZupt(t: number): boolean {
    if (this.zuptBuf.length < 10) return false
    const span = t - this.zuptBuf[0].t
    if (span < ZUPT_WINDOW_MS * 0.8) return false
    const maxA = this.zuptBuf.reduce((m, v) => Math.max(m, v.a), 0)
    return maxA < ZUPT_ACCEL_THRESHOLD
  }

  private speedMag(): number {
    return Math.sqrt(
      this.velocity.x * this.velocity.x +
      this.velocity.y * this.velocity.y +
      this.velocity.z * this.velocity.z,
    )
  }

  private emitSample(speed: number, accelMag: number): void {
    const sample: ImuSpeedSample = {
      speed,
      mode: this.mode,
      accelMag,
      ts: Date.now(),
      samples: this.samples,
    }
    for (const fn of this.listeners) fn(sample)
  }

  getMode(): ImuMode { return this.mode }
}

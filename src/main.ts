/**
 * SpeedMeter エントリポイント。
 * 新方針: 画像を使わずテキストのドット絵で大きい数字を表示。
 *   - textContainerUpgrade は 1 BLE パケットで収まるため毎秒更新でも詰まらない
 *   - 値は整数丸め (最大 3 桁)。0.5 m/s 未満は "0" 表示
 */

import { connectG2, type G2Handle } from './g2'
import {
  GpsSpeedometer,
  type SpeedSample,
  mpsToKmh,
  mpsToMph,
} from './gps'
import { ImuSpeedometer } from './imuSpeed'
import { RemoteSpeedSource } from './remoteSource'
import { bigDigits, bigDigitsRightAlignIndent, padAllRows, FW_SPACE } from './bigText'

type Unit = 'kmh' | 'mph'
type MockProfile = 'city' | 'highway' | 'walk'

interface AppState {
  unit: Unit
  latest: SpeedSample | null
  mock: boolean
  mockProfile: MockProfile
  lastSpeedText: string
  lastStatsText: string
  lastTimeText: string
}

function readUrlFlags(): { mock: boolean; profile: MockProfile } {
  const params = new URLSearchParams(window.location.search)
  const mock = params.get('mock') === '1' || params.has('mock')
  const raw = (params.get('profile') ?? 'city').toLowerCase()
  const profile: MockProfile = raw === 'highway' ? 'highway' : raw === 'walk' ? 'walk' : 'city'
  return { mock, profile }
}

const flags = readUrlFlags()

const state: AppState = {
  unit: 'kmh',
  latest: null,
  mock: flags.mock,
  mockProfile: flags.profile,
  lastSpeedText: '',
  lastStatsText: '',
  lastTimeText: '',
}

const dom = {
  speedValue: document.getElementById('speedValue')!,
  speedUnit: document.getElementById('speedUnit')!,
  max: document.getElementById('maxVal')!,
  avg: document.getElementById('avgVal')!,
  acc: document.getElementById('accVal')!,
  fix: document.getElementById('fixVal')!,
  status: document.getElementById('status')!,
  unitBtn: document.getElementById('unitBtn') as HTMLButtonElement,
  resetBtn: document.getElementById('resetBtn') as HTMLButtonElement,
  mockBtn: document.getElementById('mockBtn') as HTMLButtonElement,
  profileSel: document.getElementById('mockProfile') as HTMLSelectElement | null,
  retryBtn: document.getElementById('retryBtn') as HTMLButtonElement | null,
  remoteCode: document.getElementById('remoteCode') as HTMLInputElement | null,
  remoteConnectBtn: document.getElementById('remoteConnectBtn') as HTMLButtonElement | null,
  remoteDisconnectBtn: document.getElementById('remoteDisconnectBtn') as HTMLButtonElement | null,
}

function setStatus(msg: string): void {
  console.log('[speedmeter]', msg)
  dom.status.textContent = msg
}

/** すべて整数で表示 (小数点は使わない)。停止時/未確定は "--" */
function formatIntSpeed(mps: number | null, unit: Unit): string {
  if (mps == null || !Number.isFinite(mps)) return '--'
  const v = unit === 'kmh' ? mpsToKmh(mps) : mpsToMph(mps)
  if (v < 0.5) return '0'
  return String(Math.min(999, Math.round(v)))
}

function unitLabel(unit: Unit): string {
  return unit === 'kmh' ? 'km/h' : 'mph'
}

function formatTime(d: Date = new Date()): string {
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${mo}/${da} ${hh}:${mm}`
}

function renderDom(sample: SpeedSample | null, unit: Unit): void {
  dom.speedUnit.textContent = unitLabel(unit)
  if (!sample) {
    dom.speedValue.textContent = '--'
    dom.max.textContent = '--'; dom.avg.textContent = '--'
    dom.acc.textContent = '--'; dom.fix.textContent = '--'
    return
  }
  dom.speedValue.textContent = formatIntSpeed(sample.speed, unit)
  dom.max.textContent = `${formatIntSpeed(sample.maxSpeed, unit)} ${unitLabel(unit)}`
  dom.avg.textContent = `${formatIntSpeed(sample.avgSpeed, unit)} ${unitLabel(unit)}`
  dom.acc.textContent = sample.accuracy ? `±${Math.round(sample.accuracy)} m` : '--'
  dom.fix.textContent = sample.source === 'idle'
    ? '停止判定' : sample.source === 'derived' ? '位置差分から推定' : 'GPS 直接'
}

/**
 * G2 へ速度 + 統計 + 時計を push。
 *   - 各コンテナは「前回と同一テキストならスキップ」
 *   - 同時送信は避けるためシーケンシャルに await
 *   - 単位ラベルは数字と別行・固定インデントで、桁数が変わっても動かない
 */
let pushInFlight = false
let pushQueued = false
async function pushToG2(g2: G2Handle): Promise<void> {
  if (!g2.connected) return
  if (pushInFlight) { pushQueued = true; return }
  pushInFlight = true
  try {
    // 時計
    const t = formatTime()
    if (t !== state.lastTimeText) {
      state.lastTimeText = t
      await g2.updateTime(t)
    }

    // 大きい数字 (5 行、右端固定)。最終行に " km/h" を付ける → 数字と同じラインに単位が並ぶ
    const speedStr = state.latest ? formatIntSpeed(state.latest.speed, state.unit) : '--'
    const digits = bigDigits(speedStr)
    const rows = padAllRows(digits, bigDigitsRightAlignIndent(speedStr)).split('\n')
    // 末尾行に全角スペース1つ + 単位ラベル (ASCII) を追加
    rows[rows.length - 1] = rows[rows.length - 1] + FW_SPACE + unitLabel(state.unit)
    const full = rows.join('\n')
    if (full !== state.lastSpeedText) {
      state.lastSpeedText = full
      await g2.updateSpeed(full)
    }

    // 統計
    if (state.latest) {
      const stats = `MAX ${formatIntSpeed(state.latest.maxSpeed, state.unit)}   AVG ${formatIntSpeed(state.latest.avgSpeed, state.unit)}`
      if (stats !== state.lastStatsText) {
        state.lastStatsText = stats
        await g2.updateStats(stats)
      }
    }
  } finally {
    pushInFlight = false
    if (pushQueued) { pushQueued = false; void pushToG2(g2) }
  }
}

function toggleUnit(): void {
  state.unit = state.unit === 'kmh' ? 'mph' : 'kmh'
  setStatus(`単位を ${unitLabel(state.unit)} に切替`)
}

async function boot() {
  setStatus('G2 ブリッジに接続中...')
  let g2: G2Handle
  try {
    g2 = await connectG2()
  } catch (e) {
    console.error(e)
    setStatus(`G2 起動失敗: ${(e as Error).message} — ブラウザのみで動作します`)
    g2 = {
      connected: false,
      async updateTime() {}, async updateSpeed() {}, async updateStats() {},
      onEvent() { return () => {} },
      async shutdown() {},
    }
  }

  const gps = new GpsSpeedometer()

  gps.onSample((sample) => {
    state.latest = sample
    renderDom(sample, state.unit)
    void pushToG2(g2)
  })

  let diagnosedOnce = false
  async function runDiagnostic(reason: string) {
    const permState = await gps.queryPermissionState()
    const probe = await gps.requestPermission()
    // Bridge の裏口を叩いて location 系の undocumented メソッドがないか探る
    let bridgeProbe = '(not probed — g2 未接続)'
    try {
      const w = window as unknown as { EvenAppBridge?: unknown }
      const ctor = w.EvenAppBridge as { getInstance?: () => unknown } | undefined
      const inst = ctor?.getInstance?.() as { callEvenApp?: (m: string, p?: unknown) => Promise<unknown> } | undefined
      if (inst?.callEvenApp) {
        bridgeProbe = await gps.probeNativeBridgeLocation(inst)
      }
    } catch (e) {
      bridgeProbe = `bridge probe 失敗: ${(e as Error).message}`
    }
    const lines = [
      `[${reason}]`,
      `permissions.query: ${permState ?? 'unsupported'}`,
      `getCurrentPosition: ${probe.ok ? 'OK' : 'NG'} — ${probe.info}`,
      `protocol: ${window.location.protocol}  (secure: ${window.isSecureContext})`,
      `UA: ${navigator.userAgent.slice(0, 100)}`,
      `bridge probe:`,
      bridgeProbe,
    ]
    const msg = lines.join('\n')
    setStatus(msg)
    console.log('[speedmeter] GPS diag:\n' + msg)
    if (probe.ok) {
      gps.start()
    }
  }

  // IMU ベクトル積分は車載固定用。手持ち歩行では腕振りで発散するので
  // 自動フォールバックからは外した。コードは残してあるので将来必要なら手動有効化可。
  const imu = new ImuSpeedometer()
  void imu; void tryStartImuManual

  // Chrome 経由 GPS ブリッジ (ntfy.sh 中継)
  const remote = new RemoteSpeedSource()
  remote.onSample((s) => {
    // 離脱防止: mock を止めてリモートを優先する
    if (state.mock) {
      state.mock = false
      updateMockButton()
      gps.stop()
    }
    gps.injectExternal(s.speed, s.accuracy || 5, 'native')
  })
  const savedCode = localStorage.getItem('speedmeter-remote-code') ?? ''
  if (dom.remoteCode) dom.remoteCode.value = savedCode
  dom.remoteConnectBtn?.addEventListener('click', () => {
    const code = (dom.remoteCode?.value ?? '').trim()
    if (!code) { setStatus('セッションコードを入力してください'); return }
    localStorage.setItem('speedmeter-remote-code', code)
    remote.start(code)
    setStatus(`Remote (Chrome 経由 GPS) を接続: code=${code}\n` +
      'Android Chrome で companion.html を開き、同じコードで開始してください。')
  })
  dom.remoteDisconnectBtn?.addEventListener('click', () => {
    remote.stop()
    setStatus('Remote 切断')
  })

  gps.onError(async (err) => {
    if (err.code === err.PERMISSION_DENIED) {
      // 2026-04-19 実機確認済: Even Hub v0.0.10 の WebView は HTTP/HTTPS どちらでも
      // Web Geolocation を silent deny する。SDK 側にも location 取得 API が無い。
      // → アプリ側からの直接 GPS 取得は不可能。Mock で UI は動かす。
      gps.stop()
      setStatus(
        'Even Hub WebView が位置情報をブロック (実機検証済、HTTP/HTTPS 問わず発生)。\n'
        + 'SDK に location bridge も無いため、本アプリからの GPS 取得は現状不可能。\n'
        + 'Even Hub のアップデートで Web Geolocation 対応 or location API 追加を待つ必要あり。\n\n'
        + '→ Mock モードで動作継続。',
      )
      if (!state.mock) {
        state.mock = true
        gps.startMock(state.mockProfile)
        updateMockButton()
      }
      if (!diagnosedOnce) {
        diagnosedOnce = true
        void runDiagnostic('watchPosition PERMISSION_DENIED (info only)')
      }
      return
    }
    // POSITION_UNAVAILABLE / TIMEOUT は Simulator・屋内でよく出るので mock に自動フォールバック
    const codeText = err.code === err.POSITION_UNAVAILABLE
      ? 'GPS 信号を取得できません — Mock モードに切替 (Simulator/屋内では通常これ)'
      : err.code === err.TIMEOUT
        ? 'GPS 測位タイムアウト — Mock モードに切替'
        : `GPS エラー: ${err.message} — Mock モードに切替`
    setStatus(codeText)
    if (!state.mock) {
      state.mock = true
      gps.startMock(state.mockProfile)
      updateMockButton()
    }
  })

  function updateMockButton() {
    if (!dom.mockBtn) return
    dom.mockBtn.textContent = state.mock ? `Mock: ON (${state.mockProfile})` : 'Mock: OFF'
    dom.mockBtn.setAttribute('aria-pressed', String(state.mock))
  }

  const startGps = () => {
    if (state.mock) {
      setStatus(`Mock モード (${state.mockProfile}) で動作中`)
      gps.startMock(state.mockProfile)
      return
    }
    setStatus(g2.connected ? 'G2 に接続済み。GPS を起動します…' : 'G2 未接続。GPS を起動します…')
    const started = gps.start()
    if (!started) {
      setStatus('このブラウザでは geolocation が使えません。Mock モードに切替')
      state.mock = true
      gps.startMock(state.mockProfile)
      updateMockButton()
    }
  }

  startGps()
  updateMockButton()

  if (dom.profileSel) {
    dom.profileSel.value = state.mockProfile
    dom.profileSel.addEventListener('change', () => {
      state.mockProfile = dom.profileSel!.value as MockProfile
      if (state.mock) { gps.stop(); gps.startMock(state.mockProfile) }
      updateMockButton()
    })
  }

  dom.mockBtn?.addEventListener('click', () => {
    state.mock = !state.mock
    gps.stop(); gps.reset(); startGps(); updateMockButton()
  })

  // G2 側 (R1 / タッチバー) のタップ・スクロール操作は使わない方針。
  // 終了検知 (FOREGROUND_EXIT / ABNORMAL_EXIT) だけは受けて cleanup する。
  g2.onEvent((e) => {
    if (e.kind === 'foregroundExit') {
      gps.stop()
      clearInterval(clockTimer)
    }
  })

  dom.unitBtn.addEventListener('click', () => {
    toggleUnit()
    state.lastSpeedText = ''; state.lastStatsText = ''
    if (state.latest) renderDom(state.latest, state.unit)
    void pushToG2(g2)
  })

  dom.resetBtn.addEventListener('click', () => {
    gps.reset(); setStatus('統計をリセットしました')
  })

  dom.retryBtn?.addEventListener('click', async () => {
    setStatus('GPS 再試行中…')
    imu.stop()
    gps.stop()
    gps.reset()
    state.mock = false
    updateMockButton()
    await runDiagnostic('retry button')
  })

  /** 固定マウント用の IMU フォールバック (ボタンやパラメータで opt-in) */
  async function tryStartImuManual(): Promise<boolean> {
    const r = await imu.start()
    if (!r.ok) return false
    imu.onSample((s) => gps.injectExternal(s.speed, 5, 'derived'))
    return true
  }

  // 時計は毎分しか変わらないが、1 分の境目が確実に反映されるよう 1 秒間隔で push
  // (前回と同じなら updateTime は内部でスキップ)
  const clockTimer = window.setInterval(() => { void pushToG2(g2) }, 1000)

  renderDom(null, state.unit)
  void pushToG2(g2)
}

void boot().catch((e) => {
  console.error('[speedmeter] boot failed', e)
  setStatus(`起動失敗: ${(e as Error).message}`)
})

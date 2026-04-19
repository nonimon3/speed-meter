#!/usr/bin/env node
// Vite dev サーバが立ち上がったら、LAN で到達可能な URL を指す Even Hub QR を表示する。
//
//   node scripts/qr.mjs               -> HTTP QR
//   USE_HTTPS=1 node scripts/qr.mjs   -> HTTPS QR

import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = 5273
const HTTPS = process.env.USE_HTTPS === '1' || process.env.USE_HTTPS === 'true'
// --url <url> で任意 URL を QR 化 (公開 HTTPS を指したい時用)
const urlArgIdx = process.argv.indexOf('--url')
const OVERRIDE_URL = urlArgIdx >= 0 ? process.argv[urlArgIdx + 1] : null

function pickLanIp() {
  if (process.env.LAN_IP) return process.env.LAN_IP
  const interfaces = os.networkInterfaces()
  const virtualNameHints = /vEthernet|VirtualBox|VMware|Docker|WSL|Hyper-V|Loopback|Npcap/i
  const scored = []
  for (const [name, list] of Object.entries(interfaces)) {
    if (!list) continue
    const virtualPenalty = virtualNameHints.test(name) ? 10 : 0
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      let base
      if (iface.address.startsWith('192.168.')) base = 0
      else if (iface.address.startsWith('10.')) base = 1
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)) base = 2
      else base = 5
      scored.push({ name, address: iface.address, score: base + virtualPenalty })
    }
  }
  scored.sort((a, b) => a.score - b.score)
  return scored[0]?.address ?? 'localhost'
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.createConnection({ port, host })
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`dev server did not open ${host}:${port} within ${timeoutMs}ms`))
        else setTimeout(tryOnce, 400)
      })
    }
    tryOnce()
  })
}

async function main() {
  let url
  if (OVERRIDE_URL) {
    url = OVERRIDE_URL
    process.stdout.write(`\n[speed-meter] 外部 URL モード: ${url}\n`)
  } else {
    const ip = pickLanIp()
    const scheme = HTTPS ? 'https' : 'http'
    url = `${scheme}://${ip}:${PORT}/`

    process.stdout.write(`\n[speed-meter] waiting for dev server on ${ip}:${PORT}...\n`)
    try { await waitForPort(PORT) } catch (err) {
      console.error('[speed-meter] ' + err.message)
      process.exit(1)
    }
  }

  process.stdout.write('\n========================================\n')
  process.stdout.write(`  Even Hub アプリでこの QR をスキャン\n`)
  process.stdout.write(`  URL: ${url}\n`)
  process.stdout.write('========================================\n\n')

  // PNG ファイルとして保存 (画像として見たい時用)
  const pngPath = path.resolve(__dirname, '..', 'speed-meter-qr.png')
  try {
    await QRCode.toFile(pngPath, url, { scale: 10, margin: 2, errorCorrectionLevel: 'M' })
    process.stdout.write(`[speed-meter] QR PNG 保存: ${pngPath}\n`)
  } catch (e) {
    process.stdout.write(`[speed-meter] PNG 生成失敗: ${e.message}\n`)
  }

  // ターミナル用 ASCII 表示 (--url を明示して MSYS パス変換バグ回避)
  const args = ['evenhub', 'qr', '--url', url]
  const child = spawn('npx', args, { stdio: 'inherit', shell: true })
  await new Promise((resolve) => child.on('exit', resolve))

  process.stdout.write(`\n[speed-meter] QR 表示完了。画像ファイル: ${pngPath}\n`)
  process.stdout.write('[speed-meter] サーバはこのまま稼働中。\n')
  process.stdin.resume()
}

main().catch((err) => {
  console.error('[speed-meter] qr script failed:', err)
  process.exit(1)
})

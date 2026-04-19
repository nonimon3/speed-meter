#!/usr/bin/env node
// Vite dev サーバの起動を待ち、evenhub-simulator を起動して G2 画面をエミュレート。
//
//   node scripts/sim.mjs            -> http://localhost:5173/?mock=1 を Simulator で開く
//   SIM_PROFILE=highway node scripts/sim.mjs  -> プロファイル指定

import { spawn } from 'node:child_process'
import net from 'node:net'

const PORT = Number(process.env.PORT ?? 5273)
const PROFILE = process.env.SIM_PROFILE ?? 'city'
// デフォルトは mock OFF。SIM_MOCK=1 (または any truthy) で明示的に有効化。
const MOCK = process.env.SIM_MOCK === '1' || process.env.SIM_MOCK === 'true'

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
  process.stdout.write(`[speed-meter] waiting for vite on :${PORT}...\n`)
  await waitForPort(PORT)

  const query = MOCK ? `?mock=1&profile=${PROFILE}` : ''
  const url = `http://localhost:${PORT}/${query}`
  process.stdout.write(`[speed-meter] launching evenhub-simulator -> ${url}\n`)

  // Windows は shell:true で URL を渡すと cmd が "&" をコマンド区切りと解釈するので
  // URL 全体をダブルクォートで囲む必要がある。
  const urlArg = process.platform === 'win32' ? `"${url}"` : url
  const child = spawn(
    'npx',
    ['@evenrealities/evenhub-simulator', urlArg],
    { stdio: 'inherit', shell: true },
  )

  await new Promise((resolve) => child.on('exit', resolve))
}

main().catch((err) => {
  console.error('[speed-meter] sim launcher failed:', err)
  process.exit(1)
})

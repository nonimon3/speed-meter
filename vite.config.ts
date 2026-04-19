import { defineConfig, loadEnv } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const useHttps = env.VITE_HTTPS === '1' || env.VITE_HTTPS === 'true'

  return {
    // GitHub Pages は `https://<user>.github.io/<repo>/` のサブパス配信なのでビルド時に prefix を付ける。
    base: command === 'build' ? '/speed-meter/' : '/',
    plugins: useHttps ? [basicSsl()] : [],
    server: {
      host: true,
      port: 5273,
      strictPort: true,
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
    },
  }
})

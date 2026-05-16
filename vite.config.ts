import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // /docs/ 配下はService Workerを経由せずサーバーから直接取得（PDF等の静的ファイル）
        navigateFallbackDenylist: [/^\/docs\//],
        // JSバンドル・CSS・画像をキャッシュ（初回以降は即時表示）
        globPatterns: ['**/*.{js,css,html,ico,svg,png,woff2}'],
        // pdfjs等の大きなチャンクもキャッシュ対象
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
        runtimeCaching: [
          {
            // Supabase APIはネットワーク優先（データは常に最新）
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              networkTimeoutSeconds: 10,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 5 },
            },
          },
        ],
      },
      manifest: {
        name: 'AkiNavi HR-AI',
        short_name: 'HR-AI',
        description: '人材×案件マッチングAI',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})

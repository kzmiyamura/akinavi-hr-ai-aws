import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// 永続キャッシュ（localStorage）の buster に使う ID（src/lib/queryPersist.ts）。
//
// **コミットごとに変える。ビルドごとではない。**
// Date.now() にしていたため、同じコミットでもビルドのたびに値が変わり、
// バンドルの内容が変わってチャンク名のハッシュまで変わっていた。
// Vercel はプロジェクトが2つある（akinavi-hr-ai / akinavi-hr-ai-aws）ので、
// 同じコミットでも別々のハッシュが生成され、**再デプロイのたびに開いている
// タブが全部「読み込みに失敗」になる**状態だった（2026-09-12）。
// コミットSHAなら中身が変わったときだけハッシュが変わる。
const buildId = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? `dev-${Date.now()}`

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // /docs/ 配下はService Workerを経由せずサーバーから直接取得（PDF等の静的ファイル）
        navigateFallbackDenylist: [/^\/docs\//],
        // JSバンドル・CSS・画像をキャッシュ（初回以降は即時表示）。
        // json を入れているのは人材マップの地図データ（japan.topojson・425KB）のため。
        // 漏れていたので開くたびに再検証が走っていた（2026-09-12 実測）
        globPatterns: ['**/*.{js,css,html,ico,svg,png,woff2,json}'],
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

import { build } from 'esbuild'
import { readdirSync, existsSync, mkdirSync } from 'fs'

// ビルド対象: 引数で指定 or 全関数
const target = process.argv[2]
const functionsDir = './functions'
const functions = readdirSync(functionsDir).filter(f =>
  existsSync(`${functionsDir}/${f}/index.ts`)
)

for (const fn of functions) {
  if (target && fn !== target) continue

  const entryPoint = `${functionsDir}/${fn}/index.ts`
  const outdir = `./dist/${fn}`
  mkdirSync(outdir, { recursive: true })

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    outfile: `${outdir}/index.js`,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: false,      // デバッグしやすいよう非minify
    sourcemap: false,
    // pdfjs-dist の canvas/worker 依存を除外（Lambda では不要）
    external: ['canvas'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  })

  console.log(`✅ Built: lambda/dist/${fn}/index.js`)
}

export type DataEnv = 'prod' | 'demo'

const STORAGE_UNLOCK_KEY = 'akinavi.demoUnlock.v1'
const STORAGE_DATA_ENV_KEY = 'akinavi.dataEnv.v1'

export function isDataEnv(v: string | null | undefined): v is DataEnv {
  return v === 'prod' || v === 'demo'
}

/** UI で選択中のデータ環境（demo はデモ解除後のみ） */
export function readStoredDataEnv(): DataEnv | null {
  try {
    const raw = localStorage.getItem(STORAGE_DATA_ENV_KEY)
    return isDataEnv(raw) ? raw : null
  } catch {
    return null
  }
}

export function writeStoredDataEnv(env: DataEnv) {
  try {
    localStorage.setItem(STORAGE_DATA_ENV_KEY, env)
  } catch {
    /* ignore */
  }
}

export function readStoredDemoUnlock(): boolean {
  try {
    return localStorage.getItem(STORAGE_UNLOCK_KEY) === '1'
  } catch {
    return false
  }
}

export function writeStoredDemoUnlock(on: boolean) {
  try {
    if (on) localStorage.setItem(STORAGE_UNLOCK_KEY, '1')
    else localStorage.removeItem(STORAGE_UNLOCK_KEY)
  } catch {
    /* ignore */
  }
}

export function parseDemoKeyFromLocation(): string | null {
  try {
    const q = new URLSearchParams(window.location.search)
    const k = q.get('demo') ?? q.get('demoKey') ?? q.get('demo_key')
    const s = (k ?? '').trim()
    return s.length > 0 ? s : null
  } catch {
    return null
  }
}

export function expectedDemoKey(): string {
  return String(import.meta.env.VITE_DEMO_KEY ?? '').trim()
}

export function isDemoKeyValid(key: string): boolean {
  const expected = expectedDemoKey()
  if (!expected) return false
  return key.trim() === expected
}

/** `?demo=`（または旧 `demoKey` / `demo_key`）が無い・空 */
export type DemoKeyUrlResult = 'absent' | 'invalid' | 'unlocked' | 'locked'

/**
 * 正しい鍵が URL クエリにあるときだけ処理する（推奨: `?demo=鍵`）。
 * - 未解除 → 解除（デモ／本番を選べるようになる）
 * - 解除済み → ロック（本番のみ・デモは選べない）
 * トグルは同一ブラウザの localStorage と連動。
 */
export function applyDemoKeyFromUrlToggle(): DemoKeyUrlResult {
  const key = parseDemoKeyFromLocation()
  if (!key) return 'absent'
  if (!isDemoKeyValid(key)) return 'invalid'
  if (readStoredDemoUnlock()) {
    clearDemoUiEnabled()
    return 'locked'
  }
  writeStoredDemoUnlock(true)
  return 'unlocked'
}

export function getDemoUiEnabled(): boolean {
  return readStoredDemoUnlock()
}

export function clearDemoUiEnabled() {
  writeStoredDemoUnlock(false)
}

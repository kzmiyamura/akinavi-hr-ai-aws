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
    const k = q.get('demoKey') ?? q.get('demo_key')
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

export function applyDemoKeyFromUrlOnce(): boolean {
  const key = parseDemoKeyFromLocation()
  if (!key) return false
  if (!isDemoKeyValid(key)) return false
  writeStoredDemoUnlock(true)
  return true
}

export function getDemoUiEnabled(): boolean {
  return readStoredDemoUnlock()
}

export function clearDemoUiEnabled() {
  writeStoredDemoUnlock(false)
}

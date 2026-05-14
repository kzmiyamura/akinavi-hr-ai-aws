import { useState } from 'react'

const STORAGE_KEY = 'akinavi_nickname'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1年

function getCookieNickname(): string {
  const match = document.cookie.match(/(?:^|;\s*)akinavi_nickname=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function setCookieNickname(name: string) {
  document.cookie = `akinavi_nickname=${encodeURIComponent(name)}; max-age=${COOKIE_MAX_AGE}; path=/; SameSite=Lax`
}

function removeCookieNickname() {
  document.cookie = 'akinavi_nickname=; max-age=0; path=/'
}

function readNickname(): string {
  // クッキーを優先（iOSはlocalStorageをストレージ逼迫時に削除するため）
  return getCookieNickname() || localStorage.getItem(STORAGE_KEY) || ''
}

export function useNickname() {
  const [nickname, setNicknameState] = useState<string>(() => readNickname())

  function saveNickname(name: string) {
    localStorage.setItem(STORAGE_KEY, name)
    setCookieNickname(name)
    setNicknameState(name)
  }

  function clearNickname() {
    localStorage.removeItem(STORAGE_KEY)
    removeCookieNickname()
    setNicknameState('')
  }

  return { nickname, saveNickname, clearNickname }
}

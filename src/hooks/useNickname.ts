import { useState } from 'react'

const STORAGE_KEY = 'akinavi_nickname'

export function useNickname() {
  const [nickname, setNicknameState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? '',
  )

  function saveNickname(name: string) {
    localStorage.setItem(STORAGE_KEY, name)
    setNicknameState(name)
  }

  function clearNickname() {
    localStorage.removeItem(STORAGE_KEY)
    setNicknameState('')
  }

  return { nickname, saveNickname, clearNickname }
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// iOS Safari: キーボード閉じた後にviewportが戻らないバグの対策
// focusout時にscrollToを呼ぶとiOSがviewportを再計算して元のサイズに戻る
document.addEventListener('focusout', () => {
  setTimeout(() => { window.scrollTo(0, window.scrollY) }, 100)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

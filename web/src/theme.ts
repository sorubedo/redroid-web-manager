import { useCallback, useEffect, useRef, useState } from "react"

export type Theme = "light" | "dark"

// 这个键名在 index.html 的防闪烁脚本里也出现了一次,改要一起改。
const STORAGE_KEY = "redroid-theme"

const stored = (): Theme | null => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === "light" || value === "dark" ? value : null
  } catch {
    // 隐私模式下 localStorage 可能直接抛异常,那就当没存过。
    return null
  }
}

const systemTheme = (): Theme =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

/**
 * 主题就两档,选中之后写进 localStorage。
 * 第一次来的人跟着系统走;没手动选过的话,系统切了也跟着切。
 */
export const useTheme = (): {
  readonly theme: Theme
  readonly toggle: () => void
} => {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? systemTheme())
  const firstRun = useRef(true)

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    // 第一次渲染出来的主题是"系统给的",不算用户选择,所以不写盘 ——
    // 写了就变成"永远跟着第一次的系统设置",系统再换就不跟了。
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* 存不了就存不了,这次会话还是对的 */
    }
  }, [theme])

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const follow = () => {
      if (stored() === null) setTheme(media.matches ? "dark" : "light")
    }
    media.addEventListener("change", follow)
    return () => media.removeEventListener("change", follow)
  }, [])

  return {
    theme,
    toggle: useCallback(
      () => setTheme((current) => (current === "dark" ? "light" : "dark")),
      []
    ),
  }
}

import { useCallback, useEffect, useState } from "react"
import { ApiFailure } from "./api"

export interface Failure {
  readonly message: string
  readonly hint: string
}

export interface Remote<T> {
  readonly data: T | null
  readonly failure: Failure | null
  readonly busy: boolean
  readonly reload: () => void
}

// 两个面板要做的事一模一样:加载、显示错误、刷新。
// 抽出来之后,面板里就只剩"怎么显示"。
export const useRemote = <T>(load: () => Promise<T>): Remote<T> => {
  const [data, setData] = useState<T | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    setFailure(null)
    try {
      setData(await load())
    } catch (error) {
      setData(null)
      setFailure(
        error instanceof ApiFailure
          ? { message: error.message, hint: error.hint }
          : { message: String(error), hint: "" }
      )
    } finally {
      setBusy(false)
    }
  }, [load])

  useEffect(() => {
    void run()
  }, [run])

  return {
    data,
    failure,
    busy,
    reload: useCallback(() => void run(), [run]),
  }
}

import { useState } from "react"
import { ContainersPanel } from "./ContainersPanel"
import { ImagesPanel } from "./ImagesPanel"

type Tab = "containers" | "images"

export const App = () => {
  const [tab, setTab] = useState<Tab>("containers")

  return (
    <main>
      <header>
        <h1>redroid-web-manager</h1>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={tab === "containers" ? "active" : undefined}
          onClick={() => setTab("containers")}
        >
          容器
        </button>
        <button
          type="button"
          className={tab === "images" ? "active" : undefined}
          onClick={() => setTab("images")}
        >
          镜像
        </button>
      </nav>

      {tab === "containers" ? <ContainersPanel /> : <ImagesPanel />}
    </main>
  )
}

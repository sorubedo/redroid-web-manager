import { useState } from "react"
import { ComposePanel } from "./ComposePanel"
import { ContainersPanel } from "./ContainersPanel"
import { ImagesPanel } from "./ImagesPanel"

type Tab = "containers" | "images" | "compose"

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: "containers", label: "容器" },
  { id: "images", label: "镜像" },
  { id: "compose", label: "合成台" },
]

export const App = () => {
  const [tab, setTab] = useState<Tab>("containers")

  return (
    <main>
      <header>
        <h1>redroid-web-manager</h1>
      </header>

      <nav className="tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "active" : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === "containers" && <ContainersPanel />}
      {tab === "images" && <ImagesPanel />}
      {tab === "compose" && <ComposePanel />}
    </main>
  )
}

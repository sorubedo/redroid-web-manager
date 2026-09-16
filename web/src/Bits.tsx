import type { ReactNode } from "react"
import type { Failure } from "./useRemote"

export const Toolbar = (props: {
  readonly busy: boolean
  readonly reload: () => void
  readonly children?: ReactNode
}) => (
  <div className="toolbar">
    <span className="muted">{props.children}</span>
    <button type="button" onClick={props.reload} disabled={props.busy}>
      {props.busy ? "读取中…" : "重新读取"}
    </button>
  </div>
)

export const FailureBox = ({ failure }: { readonly failure: Failure }) => (
  <div className="failure">
    <strong>{failure.message}</strong>
    {failure.hint !== "" && <p>{failure.hint}</p>}
  </div>
)

export const EmptyBox = ({ children }: { readonly children: ReactNode }) => (
  <div className="empty">{children}</div>
)

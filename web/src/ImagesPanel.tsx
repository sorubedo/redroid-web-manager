import { useState } from "react"
import {
  fetchRedroidParams,
  fetchUsableImages,
  formatSize,
  shortId,
  type CreatedContainer,
  type RedroidImage,
  type RedroidParameter,
} from "./api"
import { EmptyBox, FailureBox, Toolbar } from "./Bits"
import { CreateContainerForm } from "./CreateContainerForm"
import { useRemote } from "./useRemote"

export const ImagesPanel = () => {
  const { data, failure, busy, reload } = useRemote<ReadonlyArray<RedroidImage>>(
    fetchUsableImages
  )
  // 创建表单是照着官方参数表生成的,所以这张表也得从后端拿 —— 前端不能
  // 自己写一份,不然两边会跑偏。
  const parameters = useRemote<ReadonlyArray<RedroidParameter>>(
    fetchRedroidParams
  )

  const [creating, setCreating] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedContainer | null>(null)

  const selected =
    creating === null ? null : (data?.find((i) => i.reference === creating) ?? null)

  return (
    <>
      <Toolbar busy={busy} reload={reload}>
        {data === null
          ? "本机 Docker 里能用的 redroid 镜像"
          : `共 ${data.length} 个`}
      </Toolbar>

      {created !== null && (
        <div className="success">
          <strong>已经创建 {created.name}</strong>
          <p>
            adb 端口是 {created.adbPort},连它:
            <code>adb connect localhost:{created.adbPort}</code>
          </p>
          <p>切到上面「容器」那一页就能管它了。</p>
        </div>
      )}

      {selected !== null && parameters.data !== null && (
        <CreateContainerForm
          image={selected}
          parameters={parameters.data}
          onCreated={(justCreated) => {
            setCreating(null)
            setCreated(justCreated)
            reload()
          }}
          onCancel={() => setCreating(null)}
        />
      )}

      {failure !== null && <FailureBox failure={failure} />}

      {failure === null && data !== null && data.length === 0 && (
        <EmptyBox>
          <p>没有找到能用的 redroid 镜像。</p>
          <p>
            先拉一个官方的:
            <code>docker pull redroid/redroid:14.0.0_64only-latest</code>
          </p>
          <p>
            标签的格式是 <code>&lt;Android 版本&gt;[_64only]-latest</code>,
            <code>_64only</code> 是只有 64 位运行库的精简版。
          </p>
        </EmptyBox>
      )}

      {data !== null && data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>镜像</th>
              <th>类型</th>
              <th>架构</th>
              <th>大小</th>
              <th>ID</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((image) => (
              <tr key={image.reference}>
                <td className="mono">{image.reference}</td>
                <td>
                  <span className={`badge ${image.kind}`}>
                    {image.kind === "official" ? "原版" : "派生"}
                  </span>
                </td>
                <td>{image.architecture}</td>
                <td className="number">{formatSize(image.size)}</td>
                <td className="mono muted">{shortId(image.id)}</td>
                <td>
                  <button
                    type="button"
                    disabled={creating !== null}
                    onClick={() => {
                      setCreated(null)
                      setCreating(image.reference)
                    }}
                  >
                    创建容器
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

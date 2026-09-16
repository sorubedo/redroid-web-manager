// 下拉框。原生 <select> 的弹层由系统画,样式跟页面搭不上,而且没法给选项
// 加第二行说明(镜像的架构/大小、重启策略的解释都塞不进去)。
//
// 这里用 Headless UI 的 Listbox:键盘操作、aria、点外面关闭这些它都管了,
// 我们只负责画。想要别的零件(Switch、Dialog…)也从这儿拿,不用自己造。

import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from "@headlessui/react"
import { Check, ChevronDown } from "./icons"
import { cx } from "./ui"

export interface SelectOption<T extends string> {
  readonly value: T
  /** 主行,通常就是选项名 */
  readonly label: string
  /** 副行,可以省。写点"这是什么"的补充信息。 */
  readonly hint?: string
}

export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder = "请选择…",
  size = "md",
  mono = false,
  disabled = false,
  id,
  label,
  className,
}: {
  /** 空字符串表示还什么都没选,这时显示 placeholder */
  readonly value: T | ""
  readonly options: ReadonlyArray<SelectOption<T>>
  readonly onChange: (next: T) => void
  readonly placeholder?: string
  readonly size?: "sm" | "md"
  /** 选项是镜像名、参数值这类"不像代码就怪了"的东西时打开 */
  readonly mono?: boolean
  readonly disabled?: boolean
  readonly id?: string
  /** 给读屏用的名字(视觉上已有标签时留空,由外部 label 关联) */
  readonly label?: string
  readonly className?: string
}) => {
  const selected = options.find((option) => option.value === value) ?? null

  return (
    <Listbox
      value={selected}
      onChange={(option) => {
        if (option !== null) onChange(option.value)
      }}
      disabled={disabled}
    >
      <ListboxButton
        id={id}
        aria-label={label}
        className={cx(
          "group flex w-full items-center gap-2 rounded-lg border border-line bg-panel text-left transition outline-none",
          "hover:border-line-strong focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/25",
          "data-open:border-brand data-open:ring-2 data-open:ring-brand/25",
          "disabled:pointer-events-none disabled:opacity-50",
          size === "sm" ? "h-8 px-2.5 text-[12px]" : "px-3 py-2 text-sm",
          className
        )}
      >
        <span
          className={cx(
            "min-w-0 flex-1 truncate",
            mono && "font-mono",
            selected === null ? "text-faint" : "text-fg"
          )}
        >
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 text-faint transition-transform duration-150 group-data-open:rotate-180" />
      </ListboxButton>

      <ListboxOptions
        anchor="bottom start"
        transition
        modal={false}
        className={cx(
          "scroll-slim z-50 max-h-72 w-[var(--button-width)] overflow-y-auto rounded-xl border border-line bg-panel p-1 shadow-xl",
          "[--anchor-gap:6px] [--anchor-padding:10px]",
          "transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0"
        )}
      >
        {options.map((option) => (
          <ListboxOption
            key={option.value}
            value={option}
            className="group/option flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-sm text-muted transition select-none data-focus:bg-panel-2 data-focus:text-fg data-selected:text-brand"
          >
            <span className="min-w-0 flex-1">
              <span className={cx("block break-all", mono && "font-mono")}>
                {option.label}
              </span>
              {option.hint !== undefined && (
                <span className="mt-0.5 block text-[11px] text-faint">
                  {option.hint}
                </span>
              )}
            </span>
            <Check className="mt-0.5 size-3.5 shrink-0 opacity-0 group-data-selected/option:opacity-100" />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  )
}

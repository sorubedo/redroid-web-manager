// 这个标签表示"这个镜像/容器是 redroid 助手程序管着的"。
//
// 名字是**故意和 redroid-helper(Rust 那个)保持一致的**,不是笔误:
// 它描述的是"这个东西是什么"(程序管理的派生镜像 / 程序创建的容器),
// 而不是"它是哪个程序弄的"。两个工具共用同一套标签,已有的镜像不用重建,
// 读标签的逻辑也只写一份。
//
// 造镜像时还会写另外两个,以后这个程序用到再说:
//   io.github.redroid-helper.magisk-version   用了哪个版本的 Magisk
//   io.github.redroid-helper.base-image       从哪张基础镜像派生的
export const MANAGED_LABEL = "io.github.redroid-helper.managed"

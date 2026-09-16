// redroid 官方文档里列出的启动参数。
//
// 来源:https://github.com/remote-android/redroid-doc 的 Configuration 一节。
// 这张表是照抄的,不要凭记忆往里加东西 —— 文档里没有的,就是 redroid 不认的。

export interface RedroidParameter {
  /** 文档里写的名字。带 <1..N> 的表示是一族参数(见下面的 pattern)。 */
  readonly name: string
  /** 一句话说明 */
  readonly summary: string
  /** 文档里写的默认值。没写就是 undefined,表示"由 Android 那边决定"。 */
  readonly defaultValue?: string
  /** 文档里写了可选值的,列在这里 */
  readonly allowedValues?: ReadonlyArray<string>
  /**
   * 这一族参数用什么正则匹配(正则源码,字符串形式)。
   * 只有 <1..N> 和 ro.xxx 这两族需要,普通参数不用写。
   */
  readonly pattern?: string
}

// 一台容器上实际设的一个参数。读(列出容器时解析命令行)和写(创建容器时
// 拼命令行)用的是同一个形状,免得两边跑偏。
export interface BootParam {
  readonly name: string
  readonly value: string
}

export const REDROID_PARAMETERS: ReadonlyArray<RedroidParameter> = [
  {
    name: "androidboot.redroid_width",
    summary: "屏幕宽度",
    defaultValue: "720",
  },
  {
    name: "androidboot.redroid_height",
    summary: "屏幕高度",
    defaultValue: "1280",
  },
  {
    name: "androidboot.redroid_fps",
    summary: "屏幕刷新率",
    defaultValue: "30(开 GPU)/ 15(不开 GPU)",
  },
  {
    name: "androidboot.redroid_dpi",
    summary: "屏幕 DPI",
    defaultValue: "320",
  },
  {
    name: "androidboot.use_memfd",
    summary: "用 memfd 替代已废弃的 ashmem",
    defaultValue: "false",
  },
  {
    name: "androidboot.use_redroid_overlayfs",
    summary:
      "用 overlayfs 共享 data 分区(/data-base 共享,/data-diff 私有)",
    defaultValue: "0",
  },
  {
    name: "androidboot.redroid_net_ndns",
    summary: "DNS 服务器个数;一个都没指定时用 8.8.8.8",
    defaultValue: "0",
  },
  {
    name: "androidboot.redroid_net_dns<1..N>",
    summary: "DNS 服务器地址,可写多个",
    pattern: "^androidboot\\.redroid_net_dns[0-9]+$",
  },
  {
    name: "androidboot.redroid_net_proxy_type",
    summary: "代理类型",
    allowedValues: ["static", "pac", "none", "unassigned"],
  },
  {
    name: "androidboot.redroid_net_proxy_host",
    summary: "代理主机",
  },
  {
    name: "androidboot.redroid_net_proxy_port",
    summary: "代理端口",
    defaultValue: "3128",
  },
  {
    name: "androidboot.redroid_net_proxy_exclude_list",
    summary: "不走代理的地址,逗号分隔",
  },
  {
    name: "androidboot.redroid_net_proxy_pac",
    summary: "PAC 地址",
  },
  {
    name: "androidboot.redroid_gpu_mode",
    summary: "渲染方式:guest 用软件渲染,host 用 GPU 加速,auto 自动判断",
    defaultValue: "guest",
    allowedValues: ["auto", "host", "guest"],
  },
  {
    name: "androidboot.redroid_gpu_node",
    summary: "GPU 设备节点",
    defaultValue: "自动探测",
  },
  {
    name: "ro.*",
    summary: "调试用:覆盖任意 ro.xxx 属性(例如 ro.secure=0 让 adb 直接是 root)",
    pattern: "^ro\\.",
  },
]

/**
 * 查一个参数在文档里的定义。查不到返回 undefined ——
 * 那说明它是自定义的,或者 redroid 更新了文档而这张表还没跟上。
 */
export const findRedroidParameter = (
  name: string
): RedroidParameter | undefined => {
  for (const parameter of REDROID_PARAMETERS) {
    if (parameter.name === name) return parameter
    if (parameter.pattern !== undefined && new RegExp(parameter.pattern).test(name)) {
      return parameter
    }
  }
  return undefined
}

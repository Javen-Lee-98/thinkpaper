/** 草稿纸连接状态：面板和 /ink 命令读它。 */
export type InkpadStatus = {
  /** 中转服务连得上 */
  online: boolean
  /** 平板打开的地址（含访问码） */
  url?: string
  /** 上面地址的二维码（SVG） */
  qr?: string
  /** 平板最近 30 秒内连过 */
  tabletOnline?: boolean
  /** 平板上开着的那本发到这个对话（每本记住自己的对话） */
  isTarget?: boolean
  /** 那本发往的对话名 */
  targetLabel?: string
  /** 平板上开着的本子 */
  targetNb?: string
  /** 连着的对话数 */
  sessions?: number
  /** 用电脑名访问的固定地址（电脑名.local），IP 变了也能用 */
  stableUrl?: string
  /** 最近一次收到草稿纸投递的时间（毫秒） */
  lastSubmission?: number
}

declare module 'claude-code' {
  interface PluginState {
    inkpad: { status: InkpadStatus }
  }
}

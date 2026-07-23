export interface OAuthLoginState {
  ready: boolean
  pending: boolean
  error?: string
}

const TERMINAL_ERRORS: Record<string, string> = {
  denied: 'Kimi 授权已被拒绝，请重新登录',
  expired: 'Kimi 授权码已过期，请重新登录',
  cancelled: 'Kimi 授权流程已结束，请重新登录'
}

/** 账号凭据是最终事实；设备码状态只描述当前授权流程。 */
export function resolveOAuthLoginState(
  flowStatus: string | undefined,
  authReady: boolean
): OAuthLoginState {
  if (authReady || flowStatus === 'authenticated') {
    return { ready: true, pending: false }
  }
  if (flowStatus === 'pending') {
    return { ready: false, pending: true }
  }
  return {
    ready: false,
    pending: false,
    error: flowStatus
      ? (TERMINAL_ERRORS[flowStatus] ?? 'Kimi 登录状态无效，请重新登录')
      : 'Kimi 授权流程不存在或已结束，请重新登录'
  }
}

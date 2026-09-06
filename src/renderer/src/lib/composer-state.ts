import type { Attachment, ModelId, PermissionMode } from '@shared/types'

/**
 * Composer 会话态的持久化与合并逻辑，自 store.ts 抽出的纯函数层。
 * 存储以 KeyValueStorage 注入：渲染层默认用 localStorage，测试注入内存实现。
 * 附件二进制有意不落盘（见 persistSessionComposer），只持久化轻量字段。
 */

export interface SessionComposerState {
  draft: string
  attachments: Attachment[]
  model: ModelId
  permissionMode: PermissionMode
  planMode: boolean
  swarmMode: boolean
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

/** 与 FarsideState 相关字段结构对齐；用结构类型避免为类型而拉起 store 运行时。 */
export interface ComposerHostState {
  activeSessionId: string | null
  sessions: { id: string; model?: ModelId }[]
  composerBySession: Record<string, SessionComposerState>
  draft: string
  attachments: Attachment[]
  model: ModelId
  permissionMode: PermissionMode
  planMode: boolean
  swarmMode: boolean
}

const COMPOSER_KEY_PREFIX = 'farside:session-composer:'

function defaultStorage(): KeyValueStorage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null
}

const PERMISSION_MODES: PermissionMode[] = ['manual', 'auto', 'yolo']

export function readSessionComposer(
  sessionId: string,
  fallbackModel: ModelId,
  storage: KeyValueStorage | null = defaultStorage()
): SessionComposerState {
  const fallback: SessionComposerState = {
    draft: '',
    attachments: [],
    model: fallbackModel,
    permissionMode: 'manual',
    planMode: false,
    swarmMode: false
  }
  if (!storage) return fallback
  try {
    const raw = JSON.parse(storage.getItem(`${COMPOSER_KEY_PREFIX}${sessionId}`) || 'null') as Partial<SessionComposerState> | null
    if (!raw) return fallback
    return {
      ...fallback,
      draft: typeof raw.draft === 'string' ? raw.draft : '',
      model: typeof raw.model === 'string' && raw.model ? raw.model : fallbackModel,
      permissionMode: PERMISSION_MODES.includes(raw.permissionMode ?? 'manual')
        ? raw.permissionMode as PermissionMode
        : 'manual',
      planMode: raw.planMode === true,
      swarmMode: raw.swarmMode === true
    }
  } catch {
    return fallback
  }
}

export function persistSessionComposer(
  sessionId: string,
  composer: SessionComposerState,
  storage: KeyValueStorage | null = defaultStorage()
): void {
  if (!storage) return
  try {
    // 附件二进制只保留在当前进程内，避免把图片写入 localStorage。
    storage.setItem(`${COMPOSER_KEY_PREFIX}${sessionId}`, JSON.stringify({
      draft: composer.draft,
      model: composer.model,
      permissionMode: composer.permissionMode,
      planMode: composer.planMode,
      swarmMode: composer.swarmMode
    }))
  } catch {
    // localStorage 不可用时仍保留内存态。
  }
}

export function composerPatch<T extends ComposerHostState>(
  state: T,
  patch: Partial<SessionComposerState>,
  storage: KeyValueStorage | null = defaultStorage()
): Partial<T> {
  const id = state.activeSessionId
  if (!id) return patch as Partial<T>
  return composerPatchForSession(state, id, patch, storage)
}

export function composerPatchForSession<T extends ComposerHostState>(
  state: T,
  id: string,
  patch: Partial<SessionComposerState>,
  storage: KeyValueStorage | null = defaultStorage()
): Partial<T> {
  const stored = state.composerBySession[id]
  const current: SessionComposerState = stored
    ? stored
    : {
        ...readSessionComposer(id, state.sessions.find((session) => session.id === id)?.model ?? state.model, storage),
        ...(state.activeSessionId === id ? {
          draft: state.draft,
          attachments: state.attachments,
          model: state.model,
          permissionMode: state.permissionMode,
          planMode: state.planMode,
          swarmMode: state.swarmMode
        } : {})
      }
  const next = { ...current, ...patch }
  persistSessionComposer(id, next, storage)
  return {
    ...(state.activeSessionId === id ? patch : {}),
    composerBySession: { ...state.composerBySession, [id]: next }
  } as Partial<T>
}

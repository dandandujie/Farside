import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AgentUpdate,
  type ConfigurationSnapshot,
  type FarsideApi,
  type PtyDataPayload
} from '@shared/ipc'

const api: FarsideApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.AppGetInfo),
  update: {
    check: () => ipcRenderer.invoke(IPC.AppCheckUpdate),
    open: () => ipcRenderer.invoke(IPC.AppOpenUpdate)
  },
  detectCli: () => ipcRenderer.invoke(IPC.CliDetect),
  window: {
    minimize: () => ipcRenderer.invoke(IPC.WindowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.WindowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.WindowClose),
    isMaximized: () => ipcRenderer.invoke(IPC.WindowIsMaximized)
  },
  discoverSessions: () => ipcRenderer.invoke(IPC.SessionsDiscover),
  pty: {
    create: (cwd) => ipcRenderer.invoke(IPC.PtyCreate, cwd),
    write: (id, data) => ipcRenderer.invoke(IPC.PtyWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke(IPC.PtyResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(IPC.PtyKill, id),
    onData: (id, cb) => {
      // 所有终端共用一个 pty:data 通道，按 id 过滤后回调；返回取消订阅函数
      const listener = (_event: IpcRendererEvent, payload: PtyDataPayload): void => {
        if (payload.id === id) cb(payload.data)
      }
      ipcRenderer.on(IPC.PtyData, listener)
      return () => {
        ipcRenderer.removeListener(IPC.PtyData, listener)
      }
    }
  },
  server: {
    status: () => ipcRenderer.invoke(IPC.ServerStatus),
    start: () => ipcRenderer.invoke(IPC.ServerStart),
    stop: () => ipcRenderer.invoke(IPC.ServerStop)
  },
  account: {
    get: () => ipcRenderer.invoke(IPC.AccountGet),
    configure: (input) => ipcRenderer.invoke(IPC.AccountConfigure, input),
    refresh: () => ipcRenderer.invoke(IPC.AccountRefresh),
    logout: () => ipcRenderer.invoke(IPC.AccountLogout)
  },
  workspace: {
    list: () => ipcRenderer.invoke(IPC.WorkspaceList),
    create: () => ipcRenderer.invoke(IPC.WorkspaceCreate),
    rename: (input) => ipcRenderer.invoke(IPC.WorkspaceRename, input),
    remove: (input) => ipcRenderer.invoke(IPC.WorkspaceRemove, input),
    open: (root) => ipcRenderer.invoke(IPC.WorkspaceOpen, root)
  },
  configuration: {
    get: () => ipcRenderer.invoke(IPC.ConfigurationGet),
    save: (input) => ipcRenderer.invoke(IPC.ConfigurationSave, input),
    open: (target) => ipcRenderer.invoke(IPC.ConfigurationOpen, target),
    manage: (input) => ipcRenderer.invoke(IPC.ConfigurationManage, input),
    onChanged: (cb) => {
      const listener = (_event: IpcRendererEvent, snapshot: ConfigurationSnapshot): void => cb(snapshot)
      ipcRenderer.on(IPC.ConfigurationChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.ConfigurationChanged, listener)
      }
    }
  },
  agent: {
    initialize: () => ipcRenderer.invoke(IPC.AgentInitialize),
    loadSession: (sessionId) => ipcRenderer.invoke(IPC.AgentSessionLoad, sessionId),
    createSession: (input) => ipcRenderer.invoke(IPC.AgentSessionCreate, input),
    renameSession: (input) => ipcRenderer.invoke(IPC.AgentSessionRename, input),
    forkSession: (sessionId) => ipcRenderer.invoke(IPC.AgentSessionFork, sessionId),
    exportSession: (sessionId) => ipcRenderer.invoke(IPC.AgentSessionExport, sessionId),
    archiveSession: (sessionId) => ipcRenderer.invoke(IPC.AgentSessionArchive, sessionId),
    runSessionAction: (input) => ipcRenderer.invoke(IPC.AgentSessionAction, input),
    submitPrompt: (input) => ipcRenderer.invoke(IPC.AgentPromptSubmit, input),
    resolveApproval: (input) => ipcRenderer.invoke(IPC.AgentApprovalResolve, input),
    controlGoal: (input) => ipcRenderer.invoke(IPC.AgentGoalControl, input),
    resolveQuestion: (input) => ipcRenderer.invoke(IPC.AgentQuestionResolve, input),
    listWorkspace: (sessionId, path, depth) =>
      ipcRenderer.invoke(IPC.AgentWorkspaceList, sessionId, path, depth),
    searchWorkspace: (sessionId, query) =>
      ipcRenderer.invoke(IPC.AgentWorkspaceSearch, sessionId, query),
    readWorkspaceFile: (sessionId, path) =>
      ipcRenderer.invoke(IPC.AgentWorkspaceRead, sessionId, path),
    getGitChanges: (sessionId) => ipcRenderer.invoke(IPC.AgentGitChanges, sessionId),
    getGitDiff: (sessionId, path) => ipcRenderer.invoke(IPC.AgentGitDiff, sessionId, path),
    listMcpServers: () => ipcRenderer.invoke(IPC.AgentMcpList),
    listSkills: (sessionId) => ipcRenderer.invoke(IPC.AgentSkillList, sessionId),
    startLogin: () => ipcRenderer.invoke(IPC.AgentAuthStart),
    pollLogin: () => ipcRenderer.invoke(IPC.AgentAuthPoll),
    onUpdate: (cb) => {
      const listener = (_event: IpcRendererEvent, update: AgentUpdate): void => cb(update)
      ipcRenderer.on(IPC.AgentUpdate, listener)
      return () => {
        ipcRenderer.removeListener(IPC.AgentUpdate, listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

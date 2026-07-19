import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { app, ipcMain, BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { IPC, type AppInfo, type ConfigurationSnapshot } from '@shared/ipc'
import { detectCli } from './services/cli-detect'
import { discoverSessions } from './services/sessions'
import { PtyService } from './services/pty'
import { ServerService } from './services/server'
import { KimiClientService } from './services/kimi-client'
import { ConfigurationService, CONFIGURATION_PATHS } from './services/configuration'
import { UpdateService } from './services/update'

const ptyService = new PtyService()
const serverService = new ServerService()
const kimiClient = new KimiClientService(serverService)
const configurationService = new ConfigurationService()
const updateService = new UpdateService()
let configurationWatchStarted = false

/** 注册全部 IPC handler。窗口控制按事件来源定位窗口，避免持有窗口引用。 */
export function registerIpcHandlers(): void {
  if (!configurationWatchStarted) {
    configurationWatchStarted = true
    void configurationService.watch((snapshot) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.ConfigurationChanged, snapshot)
      }
    })
  }
  ipcMain.handle(IPC.AppGetInfo, (): AppInfo => {
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      platform: process.platform,
      arch: process.arch
    }
  })
  ipcMain.handle(IPC.AppCheckUpdate, () => updateService.check(app.getVersion()))
  ipcMain.handle(IPC.AppOpenUpdate, () => updateService.open())

  ipcMain.handle(IPC.WindowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle(IPC.WindowToggleMaximize, (event): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) {
      win.unmaximize()
      return false
    }
    win.maximize()
    return true
  })

  ipcMain.handle(IPC.WindowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(IPC.WindowIsMaximized, (event): boolean => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  ipcMain.handle(IPC.CliDetect, () => detectCli())

  // ── 二期追加：会话发现 / PTY / kimi server ──
  ipcMain.handle(IPC.SessionsDiscover, () => discoverSessions())

  ipcMain.handle(IPC.PtyCreate, (event, cwd?: string) => ptyService.create(event.sender, cwd))
  ipcMain.handle(IPC.PtyWrite, (_event, id: string, data: string) => ptyService.write(id, data))
  ipcMain.handle(IPC.PtyResize, (_event, id: string, cols: number, rows: number) =>
    ptyService.resize(id, cols, rows)
  )
  ipcMain.handle(IPC.PtyKill, (_event, id: string) => ptyService.kill(id))

  ipcMain.handle(IPC.ServerStatus, () => serverService.status())
  ipcMain.handle(IPC.ServerStart, () => serverService.start())
  ipcMain.handle(IPC.ServerStop, () => serverService.stop())

  // ── 真实 Kimi Agent 链路 ──
  ipcMain.handle(IPC.AgentInitialize, (event) => kimiClient.initialize(event.sender))
  ipcMain.handle(IPC.AgentSessionLoad, (_event, sessionId: string) =>
    kimiClient.loadSession(sessionId)
  )
  ipcMain.handle(IPC.AgentSessionCreate, (_event, input) => kimiClient.createSession(input))
  ipcMain.handle(IPC.AgentSessionRename, (_event, input) => kimiClient.renameSession(input))
  ipcMain.handle(IPC.AgentSessionFork, (_event, sessionId: string) =>
    kimiClient.forkSession(sessionId)
  )
  ipcMain.handle(IPC.AgentSessionAction, (_event, input) => kimiClient.runSessionAction(input))
  ipcMain.handle(IPC.AgentSessionArchive, (_event, sessionId: string) =>
    kimiClient.archiveSession(sessionId)
  )
  ipcMain.handle(IPC.AgentSessionExport, async (event, sessionId: string) => {
    try {
      const exported = await kimiClient.exportSession(sessionId)
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: '导出 Kimi 会话',
        defaultPath: exported.fileName,
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
      }
      const selected = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options)
      if (selected.canceled || !selected.filePath) return { ok: true }
      await fs.writeFile(selected.filePath, exported.data)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '会话导出失败' }
    }
  })
  ipcMain.handle(IPC.AgentPromptSubmit, (_event, input) => kimiClient.submitPrompt(input))
  ipcMain.handle(IPC.AgentApprovalResolve, (_event, input) => kimiClient.resolveApproval(input))
  ipcMain.handle(IPC.AgentGoalControl, (_event, input) => kimiClient.controlGoal(input))
  ipcMain.handle(IPC.AgentQuestionResolve, (_event, input) => kimiClient.resolveQuestion(input))
  ipcMain.handle(
    IPC.AgentWorkspaceList,
    (_event, sessionId: string, path?: string, depth?: number) =>
      kimiClient.listWorkspace(sessionId, path, depth)
  )
  ipcMain.handle(IPC.AgentWorkspaceSearch, (_event, sessionId: string, query: string) =>
    kimiClient.searchWorkspace(sessionId, query)
  )
  ipcMain.handle(IPC.AgentWorkspaceRead, (_event, sessionId: string, path: string) =>
    kimiClient.readWorkspaceFile(sessionId, path)
  )
  ipcMain.handle(IPC.AgentGitChanges, (_event, sessionId: string) =>
    kimiClient.getGitChanges(sessionId)
  )
  ipcMain.handle(IPC.AgentGitDiff, (_event, sessionId: string, path: string) =>
    kimiClient.getGitDiff(sessionId, path)
  )
  ipcMain.handle(IPC.AgentMcpList, () => kimiClient.listMcpServers())
  ipcMain.handle(IPC.AgentSkillList, (_event, sessionId: string) => kimiClient.listSkills(sessionId))
  ipcMain.handle(IPC.AgentAuthStart, () => kimiClient.startLogin())
  ipcMain.handle(IPC.AgentAuthPoll, () => kimiClient.pollLogin())
  ipcMain.handle(IPC.AccountGet, () => kimiClient.getAccount(false))
  ipcMain.handle(IPC.AccountRefresh, () => kimiClient.getAccount(true))
  ipcMain.handle(IPC.AccountConfigure, (_event, input) => kimiClient.configureAccount(input))
  ipcMain.handle(IPC.AccountLogout, () => kimiClient.logoutAccount())

  ipcMain.handle(IPC.WorkspaceList, () => kimiClient.listWorkspaces())
  ipcMain.handle(IPC.WorkspaceCreate, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择或创建项目目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (selected.canceled || !selected.filePaths[0]) return { ok: true }
    return kimiClient.createWorkspace(selected.filePaths[0])
  })
  ipcMain.handle(IPC.WorkspaceRename, (_event, input) => kimiClient.renameWorkspace(input.id, input.name))
  ipcMain.handle(IPC.WorkspaceRemove, (_event, input) => kimiClient.removeWorkspace(input.id))
  ipcMain.handle(IPC.WorkspaceOpen, async (_event, root: string) => {
    const error = await shell.openPath(root)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle(IPC.ConfigurationGet, () => configurationService.get())
  ipcMain.handle(IPC.ConfigurationSave, async (_event, input) => {
    const result = await configurationService.save(input)
    if (result.ok && input.target === 'config') {
      // Kimi Core 自身也监听 config.toml；显式 reload 让设置页保存后的生效时点确定。
      await kimiClient.reloadRuntimeConfiguration()
    }
    return result
  })
  ipcMain.handle(IPC.ConfigurationManage, async (_event, input) => {
    if (input.kind !== 'plugin') return configurationService.manage(input)
    const action = await kimiClient.managePlugin(input)
    if (!action.ok) return action
    return configurationService.get()
  })
  ipcMain.handle(
    IPC.ConfigurationOpen,
    async (_event, target: keyof ConfigurationSnapshot['paths']) => {
      const path = CONFIGURATION_PATHS[target]
      if (target === 'skills' || target === 'plugins') await fs.mkdir(path, { recursive: true })
      else {
        await fs.mkdir(dirname(path), { recursive: true })
        await fs.appendFile(path, '')
      }
      const error = await shell.openPath(path)
      return error ? { ok: false, error } : { ok: true }
    }
  )

  // 退出前清场：杀掉所有终端进程与本 App 拉起的 server
  app.once('before-quit', () => {
    ptyService.disposeAll()
    kimiClient.dispose()
    serverService.dispose()
    configurationService.dispose()
  })
}

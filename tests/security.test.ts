import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  isAllowedApiBaseUrl,
  isAllowedExternalUrl,
  isAllowedPreviewUrl,
  normalizePreviewUrl
} from '../src/shared/security'
import {
  isPathWithin,
  isSafeOpenTarget,
  isTrustedRendererUrl,
  sanitizeZipFileName
} from '../src/main/security'

test('开发预览只接受无凭据的回环 HTTP(S) 地址', () => {
  assert.equal(normalizePreviewUrl('localhost:5173'), 'http://localhost:5173/')
  assert.equal(isAllowedPreviewUrl('http://127.0.0.1:3000/app'), true)
  assert.equal(isAllowedPreviewUrl('https://[::1]:8443'), true)
  assert.equal(isAllowedPreviewUrl('https://localhost.evil.test'), false)
  assert.equal(isAllowedPreviewUrl('http://user:pass@localhost:3000'), false)
  assert.equal(isAllowedPreviewUrl('https://example.com'), false)
})

test('系统外链禁用远程明文 HTTP，API Base URL 禁用凭据和查询参数', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/path'), true)
  assert.equal(isAllowedExternalUrl('http://example.com/path'), false)
  assert.equal(isAllowedExternalUrl('http://localhost:5173'), true)
  assert.equal(isAllowedApiBaseUrl('https://api.example.com/v1'), true)
  assert.equal(isAllowedApiBaseUrl('http://127.0.0.1:8080/v1'), true)
  assert.equal(isAllowedApiBaseUrl('http://api.example.com/v1'), false)
  assert.equal(isAllowedApiBaseUrl('https://token@example.com/v1'), false)
  assert.equal(isAllowedApiBaseUrl('https://api.example.com/v1?key=value'), false)
})

test('工作区路径边界不能被父目录或相邻前缀绕过', () => {
  const root = resolve('fixtures', 'workspace')
  assert.equal(isPathWithin(root, root), true)
  assert.equal(isPathWithin(root, join(root, 'src', 'index.ts')), true)
  assert.equal(isPathWithin(root, resolve(root, '..', 'workspace-evil', 'payload.exe')), false)
  assert.equal(isPathWithin(root, resolve(root, '..', 'payload.exe')), false)
})

test('本地打开阻止可执行脚本并清洗导出文件名', () => {
  assert.equal(isSafeOpenTarget(join('project', 'README.md')), true)
  assert.equal(isSafeOpenTarget(join('project', 'run.ps1')), false)
  assert.equal(isSafeOpenTarget(join('project', 'tool.exe')), false)
  assert.equal(isSafeOpenTarget(join('project', 'Payload.app')), false)
  assert.equal(isSafeOpenTarget(join('project', 'report.xlsm')), false)
  assert.equal(isSafeOpenTarget(join('project', 'scripts')), true)
  assert.equal(sanitizeZipFileName('../../escape.exe', 'session'), 'escape.exe.zip')
  assert.equal(sanitizeZipFileName('report.zip', 'session'), 'report.zip')
})

test('IPC 仅信任预期渲染入口', () => {
  const entry = pathToFileURL(resolve('out', 'renderer', 'index.html')).href
  assert.equal(isTrustedRendererUrl(`${entry}?shot=1#preview`, entry), true)
  assert.equal(isTrustedRendererUrl(pathToFileURL(resolve('out', 'renderer', 'other.html')).href, entry), false)
  assert.equal(isTrustedRendererUrl('http://localhost:5173/settings', 'http://localhost:5173/'), true)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/', 'http://localhost:5173/'), false)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseRuntimeManifest, readAndVerifyRuntimeManifest } from '../src/main/services/runtime-manifest'

function fixture(sha256 = 'a'.repeat(64)): Record<string, unknown> {
  return {
    schemaVersion: 1,
    channel: 'current',
    kind: 'official',
    version: '0.27.0',
    upstreamVersion: '0.27.0',
    apiVersion: 1,
    wsProtocolVersion: 2,
    observedVersion: 'kimi-code 0.27.0',
    target: 'win32-x64',
    executable: 'kimi.exe',
    sha256,
    lockedSha256: sha256,
    source: 'https://github.com/MoonshotAI/kimi-code',
    revision: '@moonshot-ai/kimi-code@0.27.0',
    manifestUrl: 'https://code.kimi.com/kimi-code/binaries/0.27.0/manifest.json',
    artifactUrl: 'https://code.kimi.com/kimi-code/binaries/0.27.0/kimi-code-win32-x64.exe',
    provenance: 'locked-download'
  }
}

test('runtime manifest 固定目标、API 版本与锁定校验值', () => {
  assert.equal(parseRuntimeManifest(fixture(), 'win32-x64', 'kimi.exe').version, '0.27.0')
  assert.throws(() => parseRuntimeManifest({ ...fixture(), apiVersion: 2 }, 'win32-x64', 'kimi.exe'), /API 版本/)
  assert.throws(() => parseRuntimeManifest({ ...fixture(), wsProtocolVersion: 3 }, 'win32-x64', 'kimi.exe'), /WebSocket 协议版本/)
  assert.throws(() => parseRuntimeManifest({ ...fixture(), target: 'linux-x64' }, 'win32-x64', 'kimi.exe'), /目标不匹配/)
  assert.throws(() => parseRuntimeManifest({ ...fixture(), lockedSha256: 'b'.repeat(64) }, 'win32-x64', 'kimi.exe'), /校验信息不完整/)
  assert.equal(parseRuntimeManifest({ ...fixture(), provenance: 'locked-copy' }, 'win32-x64', 'kimi.exe').provenance, 'locked-copy')
})

test('随包 runtime 文件被修改后完整性校验失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'farside-runtime-test-'))
  const command = join(root, 'kimi.exe')
  const content = Buffer.from('trusted runtime fixture')
  const sha256 = createHash('sha256').update(content).digest('hex')
  try {
    await writeFile(command, content)
    await writeFile(join(root, 'manifest.json'), JSON.stringify(fixture(sha256)))
    assert.equal((await readAndVerifyRuntimeManifest(command, 'win32-x64', 'kimi.exe')).sha256, sha256)
    await writeFile(command, 'tampered runtime fixture')
    await assert.rejects(readAndVerifyRuntimeManifest(command, 'win32-x64', 'kimi.exe'), /完整性校验失败/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

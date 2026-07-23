import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  isFarsideRuntimeEndpoint,
  kimiServerOrigin,
  parseKimiServerInstance,
  parseKimiServerLock,
  readKimiServerInstances
} from '../src/main/services/kimi-server-endpoint'

test('读取官方 daemon 实际端口而不是假定首选端口', () => {
  const endpoint = parseKimiServerLock({ host: '127.0.0.1', port: 58629 })
  assert.deepEqual(endpoint, { host: '127.0.0.1', port: 58629 })
  assert.equal(kimiServerOrigin(endpoint!), 'http://127.0.0.1:58629')
})

test('拒绝 lock 文件把服务 token 引向非回环地址或非法端口', () => {
  assert.equal(parseKimiServerLock({ host: '192.0.2.1', port: 58627 }), null)
  assert.equal(parseKimiServerLock({ host: '127.0.0.1', port: 0 }), null)
  assert.equal(parseKimiServerLock({ host: '127.0.0.1', port: 65_536 }), null)
})

test('兼容官方 lock 省略 host 与 IPv6 回环地址', () => {
  assert.deepEqual(parseKimiServerLock({ port: 58627 }), { host: '127.0.0.1', port: 58627 })
  const ipv6 = parseKimiServerLock({ host: '::1', port: 58627 })
  assert.equal(kimiServerOrigin(ipv6!), 'http://[::1]:58627')
})

test('仅将旧 Farside 随包 runtime 识别为可自动替换实例', () => {
  const bundled = parseKimiServerLock({
    host: '127.0.0.1',
    port: 58629,
    entry: 'C:\\Users\\test\\AppData\\Local\\Programs\\Farside-app\\resources\\runtime\\win32-x64\\kimi.exe'
  })
  const userCli = parseKimiServerLock({
    host: '127.0.0.1',
    port: 58629,
    entry: 'C:\\Users\\test\\.kimi-code\\bin\\kimi.exe'
  })
  assert.equal(isFarsideRuntimeEndpoint(bundled!), true)
  assert.equal(isFarsideRuntimeEndpoint(userCli!), false)
})

test('解析 Kimi Code 0.28 多实例注册文件', () => {
  assert.deepEqual(parseKimiServerInstance({
    server_id: '01KINSTANCE',
    pid: 1234,
    host: '127.0.0.1',
    port: 58628,
    started_at: 1_721_000_000_000,
    heartbeat_at: 1_721_000_015_000,
    host_version: '0.28.0'
  }), {
    host: '127.0.0.1',
    port: 58628,
    serverId: '01KINSTANCE',
    pid: 1234,
    startedAt: 1_721_000_000_000
  })
})

test('拒绝会把 token 引向外部主机或缺少身份字段的实例注册文件', () => {
  assert.equal(parseKimiServerInstance({
    server_id: '01KINSTANCE', pid: 1234, host: '0.0.0.0', port: 58627, started_at: 1
  }), null)
  assert.equal(parseKimiServerInstance({
    pid: 1234, host: '127.0.0.1', port: 58627, started_at: 1
  }), null)
})

test('按启动时间读取 0.28 实例注册表并忽略损坏文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'farside-kimi-instances-'))
  const previousHome = process.env.KIMI_CODE_HOME
  process.env.KIMI_CODE_HOME = home
  try {
    const directory = join(home, 'server', 'instances')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'later.json'), JSON.stringify({
      server_id: 'later', pid: 2, host: '127.0.0.1', port: 58628, started_at: 20
    }))
    await writeFile(join(directory, 'earlier.json'), JSON.stringify({
      server_id: 'earlier', pid: 1, host: '127.0.0.1', port: 58627, started_at: 10
    }))
    await writeFile(join(directory, 'broken.json'), '{')
    const instances = await readKimiServerInstances()
    assert.deepEqual(instances.map((instance) => instance.serverId), ['earlier', 'later'])
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME
    else process.env.KIMI_CODE_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

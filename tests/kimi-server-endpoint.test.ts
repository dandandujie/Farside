import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isFarsideRuntimeEndpoint,
  kimiServerOrigin,
  parseKimiServerLock
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

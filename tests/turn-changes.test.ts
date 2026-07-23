import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { TurnChangesService } from '../src/main/services/turn-changes'

test('只统计并恢复本轮 AI 修改，保留捕获前的用户内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'farside-turn-'))
  try {
    await mkdir(join(root, 'src'))
    const path = join(root, 'src', 'app.ts')
    await writeFile(path, 'const userDraft = true\n')
    const service = new TurnChangesService()
    service.bindSession('session-1', root)
    service.begin('session-1')
    service.capture('session-1', ['src/app.ts'])
    await writeFile(path, 'const userDraft = true\nconst aiChange = true\n')

    const result = await service.get('session-1')
    assert.equal(result.ok, true)
    assert.deepEqual(result.changes, [{
      path: 'src/app.ts',
      status: 'Modified',
      additions: 1,
      deletions: 0
    }])

    const undone = await service.resolve('session-1', 'undo')
    assert.equal(undone.ok, true)
    assert.equal(await readFile(path, 'utf8'), 'const userDraft = true\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('撤销本轮新建文件时删除该文件，且拒绝工作区外路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'farside-turn-'))
  try {
    const service = new TurnChangesService()
    service.bindSession('session-2', root)
    service.begin('session-2')
    service.capture('session-2', ['new-file.ts', '../escape.ts'])
    await writeFile(join(root, 'new-file.ts'), 'export const created = true\n')

    const result = await service.get('session-2')
    assert.deepEqual(result.changes.map((change) => change.path), ['new-file.ts'])
    await service.resolve('session-2', 'undo', 'new-file.ts')
    await assert.rejects(readFile(join(root, 'new-file.ts')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('跨多轮撤销时按逆序恢复同一文件的每一层基线', async () => {
  const root = await mkdtemp(join(tmpdir(), 'farside-turn-'))
  try {
    const path = join(root, 'state.txt')
    await writeFile(path, '初始\n')
    const service = new TurnChangesService()
    service.bindSession('session-3', root)

    service.begin('session-3')
    service.capture('session-3', ['state.txt'])
    await writeFile(path, '第一轮\n')

    service.begin('session-3')
    service.capture('session-3', ['state.txt'])
    await writeFile(path, '第二轮\n')

    await service.resolve('session-3', 'undo', undefined, 2)
    assert.equal(await readFile(path, 'utf8'), '初始\n')
    assert.equal((await service.get('session-3')).tracked, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('重复行数量变化也会计入增删统计', async () => {
  const root = await mkdtemp(join(tmpdir(), 'farside-turn-'))
  try {
    const path = join(root, 'duplicates.txt')
    await writeFile(path, 'same\nsame\n')
    const service = new TurnChangesService()
    service.bindSession('session-4', root)
    service.begin('session-4')
    service.capture('session-4', ['duplicates.txt'])
    await writeFile(path, 'same\n')

    const result = await service.get('session-4')
    assert.equal(result.changes[0]?.additions, 0)
    assert.equal(result.changes[0]?.deletions, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KIMI_UPSTREAM_REVISION,
  KIMI_PATCH_FILES,
  KIMI_UPSTREAM_VERSION,
  parseArgs
} from '../scripts/farside-runtime-patch.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(resolve(root, 'runtime.lock.json'), 'utf8'))
const patchScript = await readFile(resolve(root, 'scripts', 'farside-runtime-patch.mjs'), 'utf8')
const toolResultPatch = await readFile(
  resolve(root, 'patches', 'kimi-code', KIMI_UPSTREAM_VERSION, '0001-tool-result-token-budget.patch'),
  'utf8'
)
const harnessControlsPatch = await readFile(
  resolve(root, 'patches', 'kimi-code', KIMI_UPSTREAM_VERSION, '0002-rest-harness-controls.patch'),
  'utf8'
)
const progressiveToolsPatch = await readFile(
  resolve(root, 'patches', 'kimi-code', KIMI_UPSTREAM_VERSION, '0003-progressive-builtin-tools.patch'),
  'utf8'
)
const addedToolResultLines = toolResultPatch
  .split(/\r?\n/)
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n')

test('runtime 补丁固定到已审计的 Kimi Code 0.28 候选基线', () => {
  assert.equal(KIMI_UPSTREAM_VERSION, '0.28.0')
  assert.equal(lock.runtime.upstreamVersion, '0.27.0')
  assert.equal(lock.runtime.source.revision, '@moonshot-ai/kimi-code@0.27.0')
  assert.equal(KIMI_UPSTREAM_REVISION, 'a05228c67122c8233dc87226ce0ca7414780b680')
})

test('runtime 补丁同时覆盖 v1/v2，并使用 2048 estimated-token 预算', () => {
  assert.deepEqual(KIMI_PATCH_FILES, [
    '0001-tool-result-token-budget.patch',
    '0002-rest-harness-controls.patch',
    '0003-progressive-builtin-tools.patch'
  ])
  assert.match(toolResultPatch, /packages\/agent-core\/src\/agent\/turn\/tool-result-budget\.ts/)
  assert.match(toolResultPatch, /packages\/agent-core-v2\/src\/agent\/toolResultTruncation\/toolResultTruncationService\.ts/)
  assert.equal((toolResultPatch.match(/TOOL_RESULT_MAX_ESTIMATED_TOKENS = 2_048/g) || []).length, 2)
  assert.equal((toolResultPatch.match(/output_estimated_tokens/g) || []).length >= 4, true)
  assert.match(toolResultPatch, /the full output was archived/)
  assert.doesNotMatch(addedToolResultLines, /TOOL_RESULT_PREVIEW_CHARS/)
  assert.doesNotMatch(toolResultPatch, /system\.md/)
  assert.doesNotMatch(toolResultPatch, /AGENT_TOOLS/)
})

test('REST harness 控制补丁应用公开的 system_prompt 与 tools 字段', () => {
  assert.match(harnessControlsPatch, /agentConfig\.system_prompt/)
  assert.match(harnessControlsPatch, /agentConfig\.tools/)
  assert.match(harnessControlsPatch, /activeToolNames/)
  assert.match(harnessControlsPatch, /packages\/kap-server\/src\/routes\/sessions\.ts/)
  assert.match(harnessControlsPatch, /body\.agent_config/)
  assert.match(harnessControlsPatch, /updateProfile\(handle\.id/)
  assert.doesNotMatch(harnessControlsPatch, /system\.md/)
  assert.doesNotMatch(harnessControlsPatch, /AGENT_TOOLS/)
})

test('渐进工具披露保留六个核心工具并按组加载低频能力', () => {
  for (const name of ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']) {
    assert.match(progressiveToolsPatch, new RegExp(`'${name}'`))
  }
  for (const group of ['planning', 'goals', 'agents', 'automation', 'web']) {
    assert.match(progressiveToolsPatch, new RegExp(`${group}:`))
  }
  assert.match(progressiveToolsPatch, /preloadForCurrentPrompt/)
  assert.match(progressiveToolsPatch, /default: true/)
  assert.match(progressiveToolsPatch, /profileName === 'agent'/)
  assert.match(progressiveToolsPatch, /kimi-code\/k3/)
  assert.match(progressiveToolsPatch, /starts the default agent with six core builtins plus select_tools/)
  assert.doesNotMatch(progressiveToolsPatch, /system\.md/)
  assert.doesNotMatch(progressiveToolsPatch, /AGENT_TOOLS/)
})

test('runtime 补丁参数要求显式模式与源码目录', () => {
  assert.deepEqual(parseArgs(['--check', '.']), { mode: '--check', sourceDir: root })
  assert.throws(() => parseArgs(['--apply']), /用法/)
  assert.throws(() => parseArgs(['--unknown', '.']), /用法/)
  assert.match(patchScript, /'--ignore-space-change'/)
})

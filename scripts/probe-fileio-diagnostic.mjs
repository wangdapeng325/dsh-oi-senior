/**
 * 验证「输出文件名由变量/拼接构造、源码探测不到」时的诊断线索。
 *
 * 期望：仍判 WA（fail-loud，绝不读残留或未知文件冒充本点输出），
 * 但 stderr 要列出目录里实际出现的 .out 文件名，供人工判断。
 *
 * 用法：node scripts/probe-fileio-diagnostic.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const { judgeCpp } = await import(pathToFileURL(join(ROOT, 'dist', 'judge.js')).href)

// 输出名由字符串拼接构造：静态探测不到 "result.out"，只能探测到字面量无关的候选
const code = [
  '#include <fstream>',
  '#include <string>',
  'int main(){',
  '  std::string n = std::string("res") + "ult.out";',
  '  std::ofstream o(n.c_str());',
  '  o << 7 << std::endl;',
  '  return 0;',
  '}',
  '',
].join('\n')

const workDir = await mkdtemp(join(tmpdir(), 'oi-senior-fileio-diag-'))
try {
  const result = await judgeCpp({
    code,
    tests: [{ name: '样例1', input: '', expected: '7' }],
    compiler: 'g++',
    fileIo: true,
    workDir,
  })
  const first = result.results[0]
  console.log('判定 = ' + first.verdict + '（期望 WA：不能拿非候选文件冒充输出）')
  console.log('stdout = ' + JSON.stringify(first.stdout))
  console.log('stderr = ' + first.stderr)
  const hasHint = /目录内实际出现的 \.out/.test(first.stderr)
  console.log('\n是否给出「实际出现的 .out」线索: ' + hasHint)
  if (first.verdict !== 'WA') {
    console.error('失败：应判 WA')
    process.exit(1)
  }
  if (!hasHint) {
    console.error('失败：应给出实际 .out 文件名线索')
    process.exit(1)
  }
  console.log('通过 ✅')
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => {})
}

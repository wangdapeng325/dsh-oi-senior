/**
 * 为「树状数组 - 单点修改 + 区间和」（P3374 格式）生成随机对拍数据。
 *
 * 输入格式：
 *   n m
 *   a1 a2 ... an          ← 初始数组（我第一次漏了这行，对拍立刻判 WA）
 *   m 行：1 x k（a[x] += k）或 2 l r（输出 sum(l..r)）
 *
 * 期望输出用暴力 O(n) 逐操作计算，输出成 oi_judge 需要的 tests JSON。
 * 用法：node scripts/gen-bit-tests.mjs
 */

const TESTS = []

function brute(a0, ops) {
  const a = [0, ...a0]
  const out = []
  for (const op of ops) {
    if (op[0] === 1) {
      a[op[1]] += op[2]
    } else {
      let sum = 0
      for (let i = op[1]; i <= op[2]; i += 1) sum += a[i]
      out.push(String(sum))
    }
  }
  return out
}

// 固定种子 xorshift32，保证可复现且低位分布均匀
let seed = 20261020 >>> 0
function rnd(mod) {
  seed ^= (seed << 13) >>> 0
  seed >>>= 0
  seed ^= seed >>> 17
  seed ^= (seed << 5) >>> 0
  seed >>>= 0
  return seed % mod
}

for (let t = 0; t < 6; t += 1) {
  const n = 4 + rnd(5)          // 4..8
  const m = 8 + rnd(6)          // 8..13
  const init = Array.from({ length: n }, () => 1 + rnd(20))
  const ops = []
  let queries = 0
  for (let k = 0; k < m; k += 1) {
    if (rnd(2) === 0 && queries < m - 2) {
      ops.push([1, 1 + rnd(n), 1 + rnd(20)])
    } else {
      const l = 1 + rnd(n)
      const r = l + rnd(n - l + 1)
      ops.push([2, l, r])
      queries += 1
    }
  }
  // 至少两次查询，覆盖多区间相减
  while (queries < 2) {
    const l = 1 + rnd(n)
    const r = l + rnd(n - l + 1)
    ops.push([2, l, r])
    queries += 1
  }

  const input = [
    `${n} ${ops.length}`,
    init.join(' '),
    ...ops.map(op => op.join(' ')),
  ].join('\n') + '\n'
  const expected = brute(init, ops).join('\n') + '\n'
  TESTS.push({ name: `随机${t + 1}`, input, expected })
}

console.log(JSON.stringify({ tests: TESTS }, null, 2))

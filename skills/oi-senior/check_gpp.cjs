#!/usr/bin/env node
'use strict';
// oi-senior 随包脚本：一键检测本地 g++ 是否就绪（支持 C++14），缺失则打印分平台安装指引。
// 退出码：0=就绪；1=未安装；2=版本过低。

const { execSync } = require('child_process');
const os = require('os');

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

function detectGpp() {
  const probe = os.type().indexOf('Windows') !== -1 ? 'where g++' : 'which g++';
  const where = run(probe);
  if (!where) return { ok: false, reason: 'not_found' };
  const ver = run('g++ --version');
  if (!ver) return { ok: false, reason: 'not_runnable' };
  const m = ver.match(/(\d+)\.(\d+)\.(\d+)/);
  const major = m ? parseInt(m[1], 10) : 0;
  return { ok: true, path: where.split(/\r?\n/)[0], versionLine: ver.split(/\r?\n/)[0], supportsCpp14: major >= 5 };
}

const r = detectGpp();

if (r.ok && r.supportsCpp14) {
  console.log('[check_gpp] OK: ' + r.versionLine);
  console.log('[check_gpp] g++ 路径: ' + r.path);
  console.log('[check_gpp] 已支持 C++14，真实评测就绪。');
  process.exit(0);
} else if (r.ok && !r.supportsCpp14) {
  console.log('[check_gpp] 警告: 检测到 g++ 但版本过低 (< 5)，可能不支持完整 C++14。');
  console.log('[check_gpp] 版本: ' + r.versionLine);
  console.log('[check_gpp] 请升级到 GCC >= 5（推荐 >= 7）后重试。');
  process.exit(2);
} else {
  console.log('[check_gpp] 未检测到 g++，无法真实评测 C++14 代码。');
  console.log('');
  console.log('请按你的系统安装 C++ 编译器（需支持 C++14）：');
  console.log('  Windows : winget install -e --id Mingw-w64   (或装 TDM-GCC)');
  console.log('            装完后把其 bin\\ 目录(含 g++.exe) 加入系统 PATH，重开终端确认 g++ --version');
  console.log('  Linux   : sudo apt-get install -y g++        (Debian/Ubuntu)');
  console.log('            或 sudo dnf install -y gcc-c++      (Fedora/RHEL)');
  console.log('  macOS   : brew install gcc                   (装出 g++-<ver>，PATH 建软链或调用写全名)');
  console.log('');
  console.log('装好后再跑一次 node check_gpp.cjs 确认就绪。');
  process.exit(1);
}

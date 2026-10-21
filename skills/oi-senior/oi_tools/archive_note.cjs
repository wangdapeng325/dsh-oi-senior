#!/usr/bin/env node
'use strict';
/*
 * oi-senior 随包工具：通用归档脚本。
 *
 * 用法：node oi_tools/archive_note.cjs <folder_id> <md_file>
 *   folder_id  ima 笔记本「信奥学长-题解复盘」的 folder_id（用 list_notebook 查）
 *   md_file    要归档的 markdown 文件路径（正文含 Step 4 全部字段）
 *
 * 行为：
 *   1. 自动定位 ima_api.cjs（环境变量 IMA_API_CJS → 否则在 ~/.workbuddy/skills 下搜）；
 *   2. 读取 ~/.config/ima/client_id 与 api_key 作为权威凭证（显式传给 options，压过陈旧环境变量，避免 200002）；
 *   3. 调 import_doc 写入，成功打印 note_id。
 *
 * 不写死任何本机绝对路径；跨平台（Windows 亦可）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function die(msg) {
  console.error('[archive] ' + msg);
  process.exit(1);
}

const folderId = process.argv[2];
const mdFile = process.argv[3];
if (!folderId || !mdFile) {
  console.error('用法: node oi_tools/archive_note.cjs <folder_id> <md_file>');
  process.exit(64);
}
if (!fs.existsSync(mdFile)) die('markdown 文件不存在: ' + mdFile);
const content = fs.readFileSync(mdFile, 'utf8');

// ---- 1. 定位 ima_api.cjs ----
function findImaCli() {
  if (process.env.IMA_API_CJS && fs.existsSync(process.env.IMA_API_CJS)) {
    return process.env.IMA_API_CJS;
  }
  const roots = [
    path.join(os.homedir(), '.workbuddy', 'skills'),
    path.join(os.homedir(), '.workbuddy', 'plugins'),
  ];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'ima_api.cjs') return full;
      if (e.isDirectory()) {
        const r = walk(full);
        if (r) return r;
      }
    }
    return null;
  }
  for (const r of roots) {
    if (fs.existsSync(r)) {
      const found = walk(r);
      if (found) return found;
    }
  }
  return null;
}

const imaCli = findImaCli();
if (!imaCli) {
  die('未找到 ima_api.cjs。请先安装 ima-skill，或设置环境变量 IMA_API_CJS 指向它。');
}

// ---- 2. 读取权威凭证 ----
function readCred(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return ''; }
}
const cfgDir = path.join(os.homedir(), '.config', 'ima');
const clientId = readCred(path.join(cfgDir, 'client_id'));
const apiKey = readCred(path.join(cfgDir, 'api_key'));
const opts = {};
if (clientId) opts.clientId = clientId;
if (apiKey) opts.apiKey = apiKey;

// ---- 3. 调 import_doc ----
// 具体 apiPath / body 结构以 ima-skill 的 ima_api.cjs 约定为准；此处调用其 import_doc。
const body = JSON.stringify({
  folder_id: folderId,
  content: content,
  content_format: 1,
});

const args = [imaCli, '/openapi/wiki/import_doc', body];
if (Object.keys(opts).length > 0) args.push(JSON.stringify(opts));

try {
  const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
  let noteId = '';
  try {
    const j = JSON.parse(out);
    noteId = (j && (j.note_id || (j.data && j.data.note_id))) || '';
  } catch (e) { /* 非 JSON 输出，原样打印 */ }
  if (noteId) {
    console.log('[归档：成功 note_id=' + noteId + ']');
  } else {
    console.log('[归档：成功]');
    console.log(out);
  }
} catch (e) {
  const msg = (e && (e.stdout || e.message)) || String(e);
  console.error('[归档：失败] ' + msg);
  process.exit(1);
}

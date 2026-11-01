#!/usr/bin/env node
/**
 * 管理员账号命令行工具
 *
 * 用法：
 *   node scripts/create-admin.js <账号> [密码] [选项]
 *
 * 选项：
 *   --role=superadmin|admin   角色，默认 admin
 *   --reset                   账号已存在时重置密码（默认会报错）
 *
 * 示例：
 *   node scripts/create-admin.js alice "Abc123456" --role=superadmin
 *   node scripts/create-admin.js alice --reset      # 随机生成新密码
 *
 * 不传密码时会自动生成一个 12 位随机密码并打印一次。
 */

const crypto = require('crypto');
const path = require('path');

const db = require(path.join(__dirname, '..', 'db'));
const { hashPassword, passwordProblem } = require(path.join(__dirname, '..', 'auth'));

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      flags[key] = value === undefined ? true : value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const username = (positional[0] || '').trim();
let password = positional[1] || '';
const role = flags.role === 'superadmin' ? 'superadmin' : 'admin';

if (!username) {
  console.log('用法：node scripts/create-admin.js <账号> [密码] [--role=superadmin] [--reset]');
  process.exit(1);
}
if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(username)) {
  console.error('账号需为 3-20 位字母、数字、下划线或点');
  process.exit(1);
}

const generated = !password;
if (generated) password = randomPassword();

const problem = passwordProblem(password);
if (problem) {
  console.error('密码不符合要求：' + problem);
  process.exit(1);
}

const existing = db.findAdminByUsername(username);
if (existing && !flags.reset) {
  console.error(`账号「${username}」已存在。如需重置密码请加 --reset`);
  process.exit(1);
}

if (existing) {
  if (existing.role === 'superadmin' && role === 'admin') {
    // 保留原角色，避免手滑把超管降级
  }
  db.updateAdminPassword(existing.id, hashPassword(password), { mustChange: generated });
  console.log(`✔ 已重置管理员「${username}」的密码`);
} else {
  db.createAdmin({
    username,
    passwordHash: hashPassword(password),
    role,
    mustChangePassword: generated ? 1 : 0,
    createdBy: 'cli'
  });
  console.log(`✔ 已创建管理员「${username}」（角色：${role === 'superadmin' ? '超级管理员' : '普通管理员'}）`);
}

if (generated) {
  console.log(`  初始密码：${password}`);
  console.log('  该密码仅显示一次，登录后请立即修改。');
}

console.log(`  当前管理员数量：${db.countAdmins()}`);

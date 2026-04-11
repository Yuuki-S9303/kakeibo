/**
 * login.js — MoneyForward ME セッション初期化スクリプト
 *
 * 使い方:
 *   node src/login.js
 *
 * ブラウザが開くので、手動でログイン（二段階認証含む）する。
 * ログイン完了後 Enter を押すとセッションが auth.json に保存される。
 * 以降 scraper.js はこの auth.json を使って動作する。
 *
 * セッション期限が切れたら再度このスクリプトを実行する。
 */

'use strict';

try { require('dotenv').config(); } catch {}

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const readline     = require('readline');

const AUTH_FILE    = path.join(__dirname, '..', 'auth.json');
const MF_TOP_URL   = 'https://ssnb.x.moneyforward.com/';

async function main() {
  console.log('ブラウザを起動します...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale:     'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();

  await page.goto(MF_TOP_URL);
  console.log('\n========================================');
  console.log('ブラウザでMoneyForward MEにログインしてください。');
  console.log('二段階認証も完了させてください。');
  console.log('ログイン完了後、ここで Enter を押してください。');
  console.log('========================================\n');

  // ユーザーが Enter を押すまで待機
  await waitForEnter();

  // ログイン状態を確認（ssnb.x.moneyforward.com のトップにいればOK）
  const url = page.url();
  if (!url.includes('ssnb.x.moneyforward.com') || url.includes('login') || url.includes('sign_in')) {
    console.log(`⚠️  まだログインページにいます（現在URL: ${url}）`);
    console.log('ログインを完了してから Enter を押してください。');
    process.exit(1);
  }

  // セッション（Cookie + localStorage）を保存
  await context.storageState({ path: AUTH_FILE });
  await browser.close();

  console.log(`\nセッションを保存しました: ${AUTH_FILE}`);
  console.log('このファイルの中身をGitHub Secret "MF_AUTH_STATE" に設定してください。');
  console.log('\n中身を表示するには:');
  console.log(`  type "${AUTH_FILE}"`);
}

function waitForEnter() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});

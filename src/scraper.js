/**
 * scraper.js
 * MoneyForward ME (住信SBIネット銀行版) → Google Sheets 自動同期
 *
 * CSVダウンロードが有料機能のため、HTMLテーブル（#cf-detail-table）をスクレイピング。
 *
 * 環境変数（GitHub Secrets から注入）:
 *   MF_AUTH_STATE              : auth.json の中身（login.js で生成）
 *   SPREADSHEET_ID             : 書き込み先 Google スプレッドシート ID
 *   GOOGLE_SERVICE_ACCOUNT_JSON: サービスアカウント JSON（文字列）
 *
 * ローカルテスト用:
 *   事前に `node src/login.js` を実行して auth.json を生成しておく
 *
 * オプション:
 *   --dry-run  : Sheetsへの書き込みをスキップ、追加予定データをコンソール出力
 *   --headed   : ブラウザを表示して動作確認
 *   --debug    : ステップごとにスクリーンショット保存
 *
 * Google Sheets の transactions シート列構成:
 *   A: id  B: date  C: amount  D: type  E: category  F: subcategory
 *   G: payment_method  H: memo  I: source  J: external_id  K: created_at
 */

'use strict';

try { require('dotenv').config(); } catch {}

const { chromium } = require('playwright');
const { google }   = require('googleapis');
const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');

// ============================================================
// 定数
// ============================================================
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME     = 'transactions';
const AUTH_FILE      = path.join(__dirname, '..', 'auth.json');
const MF_BASE        = 'https://ssnb.x.moneyforward.com';

const DRY_RUN = process.argv.includes('--dry-run');
const HEADED  = process.argv.includes('--headed');
const DEBUG   = process.argv.includes('--debug');

// ============================================================
// エントリーポイント
// ============================================================
async function main() {
  console.log(`[${now()}] スクレイピング開始 ${DRY_RUN ? '(dry-run)' : ''}`);

  const rows = await scrapeMFTransactions();
  console.log(`[${now()}] 取得: ${rows.length}件（振替・計算対象外除く）`);

  if (rows.length === 0) {
    console.log('データなし。終了。');
    return;
  }

  if (DRY_RUN) {
    console.log('\n── dry-run: 追加・更新予定データ ──');
    for (const r of rows) {
      console.log(`  ${r.date}  ${r.type === 'expense' ? '-' : '+'}${r.amount.toLocaleString()}円  ${r.payment_method}  ${r.memo}  [${r.external_id}]`);
    }
    console.log(`\n合計 ${rows.length} 件（実際には書き込まれません）`);
    return;
  }

  const sheets       = await buildSheetsClient();
  const existingRows = await fetchExistingRows(sheets);
  console.log(`[${now()}] 既存レコード: ${existingRows.size}件`);

  const newRows     = [];
  const updateRows  = [];

  for (const r of rows) {
    const existing = existingRows.get(r.external_id);
    if (!existing) {
      newRows.push(r);
    } else if (existing.category !== r.category || existing.subcategory !== r.subcategory) {
      updateRows.push({ ...r, sheetRowIndex: existing.sheetRowIndex });
    }
  }

  console.log(`[${now()}] 新規追加対象: ${newRows.length}件`);
  console.log(`[${now()}] カテゴリ更新対象: ${updateRows.length}件`);

  if (updateRows.length > 0) {
    await updateCategoryRows(sheets, updateRows);
    console.log(`[${now()}] カテゴリ更新完了`);
  }

  if (newRows.length > 0) {
    await appendRows(sheets, newRows);
    console.log(`[${now()}] 新規追加完了`);
  }

  if (newRows.length === 0 && updateRows.length === 0) {
    console.log('変更なし。スキップ。');
  }

  // 日付昇順ソート（変更の有無に関わらず常に実行）
  await sortByDate(sheets);
  console.log(`[${now()}] 日付昇順ソート完了`);

  console.log(`[${now()}] 完了`);
}

// ============================================================
// デバッグ用スクリーンショット
// ============================================================
async function screenshot(page, label) {
  if (!DEBUG) return;
  const filePath = path.join(process.cwd(), `debug_${label}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`[DEBUG] スクリーンショット保存: ${filePath}`);
}

// ============================================================
// セッション状態の読み込み
// ============================================================
function loadStorageState() {
  if (process.env.MF_AUTH_STATE) {
    return JSON.parse(process.env.MF_AUTH_STATE);
  }
  if (fs.existsSync(AUTH_FILE)) {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  }
  throw new Error(
    'セッション情報が見つかりません。\n' +
    'まず `node src/login.js` を実行してログインしてください。'
  );
}

// ============================================================
// MoneyForward ME HTMLテーブルスクレイピング
// ============================================================
async function scrapeMFTransactions() {
  const storageState = loadStorageState();
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    locale:       'ja-JP',
    timezoneId:   'Asia/Tokyo',
    storageState,
  });
  const page = await context.newPage();

  try {
    // ログイン確認
    console.log(`[${now()}] セッション確認中...`);
    await page.goto(`${MF_BASE}/`, { waitUntil: 'networkidle' });
    await screenshot(page, '01_top');

    const url = page.url();
    if (!url.includes('ssnb.x.moneyforward.com') || url.includes('login') || url.includes('sign_in')) {
      throw new Error('セッションが切れています。`node src/login.js` を再実行してください。');
    }
    console.log(`[${now()}] ログイン確認OK`);

    // 今月のみ取得
    // ※URLパラメータでの月切替はJSレンダリングのため効かないため、
    //   デフォルト表示（今月）だけ取得する。週1+月末毎日のスケジュールで十分カバーできる。
    const today  = new Date();
    const year   = today.getFullYear();
    const month  = today.getMonth() + 1;
    const months = [{ year, month }];

    const allRows = [];
    for (const { year, month } of months) {
      console.log(`[${now()}] スクレイピング中: ${year}年${month}月`);

      await page.goto(`${MF_BASE}/cf`, { waitUntil: 'networkidle' });
      await screenshot(page, `cf_${year}_${month}`);

      const rows = await page.evaluate((ym) => {
        const table = document.getElementById('cf-detail-table');
        if (!table) return [];

        return Array.from(table.querySelectorAll('tbody tr')).map(tr => {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length < 8) return null;

          // 計算対象チェックボックス（0列目）
          const calcCb   = tr.querySelector('td:nth-child(1) input[type=checkbox]');
          const calcFlag = calcCb ? (calcCb.checked ? '1' : '0') : tds[0].textContent.trim();

          // 振替チェックボックス（9列目）
          const transCb   = tr.querySelector('td:nth-child(9) input[type=checkbox]');
          const transFlag = transCb ? (transCb.checked ? '1' : '0') : tds[8]?.textContent.trim() || '0';

          return {
            calcFlag,
            dateRaw:     tds[1]?.textContent.trim() || '',
            content:     tds[2]?.textContent.trim().replace(/\s+/g, ' ') || '',
            amountRaw:   tds[3]?.textContent.trim() || '',
            institution: tds[4]?.textContent.trim() || '',
            category:    tds[5]?.textContent.trim() || '',
            subcategory: tds[6]?.textContent.trim() || '',
            memo:        tds[7]?.textContent.trim() || '',
            transFlag,
            year:        ym.year,
            month:       ym.month,
          };
        }).filter(Boolean);
      }, { year, month });

      console.log(`[${now()}] ${year}年${month}月: ${rows.length}行取得`);
      allRows.push(...rows);
    }

    return parseRows(allRows);

  } finally {
    await browser.close();
  }
}

// ============================================================
// 取得データをトランザクション形式に変換
// ============================================================
function parseRows(rawRows) {
  const results = [];

  for (const r of rawRows) {
    // 計算対象外をスキップ
    if (r.calcFlag === '0') continue;
    if (!r.dateRaw || !r.amountRaw) continue;

    // 振替フラグ（チェックボックスがない場合は内容テキストで判定）
    const isTransfer = r.transFlag === '1'
      || r.content.startsWith('振替 ')
      || r.content.startsWith('振替　');
    if (isTransfer) continue;

    // プライベート口座は除外
    const EXCLUDED_INSTITUTIONS = ['住信SBIネット銀行'];
    if (EXCLUDED_INSTITUTIONS.includes(r.institution)) continue;

    // 金額パース（例: "-209,030" → -209030）
    const amount = parseInt(r.amountRaw.replace(/,/g, '').replace(/[^\-\d]/g, ''), 10);
    if (isNaN(amount) || amount === 0) continue;

    const type = amount < 0 ? 'expense' : 'income';

    // 日付パース: "04/09(木)" → "2026-04-09"
    const dateStr = parseMFDate(r.dateRaw, r.year, r.month);
    if (!dateStr) continue;

    // 重複防止ID: 日付+内容+金額のハッシュ
    const external_id = 'mf_' + crypto
      .createHash('sha256')
      .update(`${dateStr}|${r.content}|${amount}`)
      .digest('hex')
      .slice(0, 16);

    results.push({
      id:             generateId(),
      date:           dateStr,
      amount:         Math.abs(amount),
      type,
      category:       r.category  === '未分類' ? '' : r.category,
      subcategory:    r.subcategory === '未分類' ? '' : r.subcategory,
      payment_method: r.institution,
      memo:           [r.content, r.memo].filter(Boolean).join(' / '),
      source:         'mf_scraper',
      external_id,
      created_at:     new Date().toISOString(),
    });
  }

  return results;
}

/**
 * MF 日付文字列 "04/09(木)" → "2026-04-09"
 * テーブルの日付は月/日 形式なので year と month で補完
 */
function parseMFDate(dateRaw, year, month) {
  // "04/09(木)" または "04/09" 形式
  const m = dateRaw.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const mm  = String(m[1]).padStart(2, '0');
  const dd  = String(m[2]).padStart(2, '0');
  const yy  = String(year);
  return `${yy}-${mm}-${dd}`;
}

// ============================================================
// Google Sheets API クライアント
// ============================================================
async function buildSheetsClient() {
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  return google.sheets({ version: 'v4', auth });
}

/**
 * 既存レコードを external_id → { sheetRowIndex, category, subcategory } のMapで返す
 * sheetRowIndex は1始まり（ヘッダー行=1、データ行=2〜）
 */
async function fetchExistingRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         `${SHEET_NAME}!E2:J`,  // E:category F:subcategory J:external_id
  });
  const values = res.data.values || [];
  const map = new Map();
  values.forEach((row, i) => {
    const externalId = row[5]; // J列（E〜Jの6列目、0始まりで5）
    if (externalId) {
      map.set(externalId, {
        sheetRowIndex: i + 2,   // ヘッダー1行 + 0始まりインデックス
        category:    row[0] || '',  // E列
        subcategory: row[1] || '',  // F列
      });
    }
  });
  return map;
}

/** transactionsシートをB列（date）で昇順ソート */
async function sortByDate(sheets) {
  // シートIDを取得
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  if (!sheet) throw new Error(`シート "${SHEET_NAME}" が見つかりません`);
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        sortRange: {
          range: {
            sheetId,
            startRowIndex: 1, // ヘッダー行(0)を除く
          },
          sortSpecs: [{
            dimensionIndex: 1, // B列（0始まり）
            sortOrder: 'ASCENDING',
          }],
        },
      }],
    },
  });
}

/** 既存行のカテゴリ・サブカテゴリを一括更新 */
async function updateCategoryRows(sheets, rows) {
  const data = rows.map(r => ({
    range:  `${SHEET_NAME}!E${r.sheetRowIndex}:F${r.sheetRowIndex}`,
    values: [[r.category, r.subcategory]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });
}

async function appendRows(sheets, rows) {
  const values = rows.map(r => [
    r.id, r.date, r.amount, r.type, r.category, r.subcategory,
    r.payment_method, r.memo, r.source, r.external_id, r.created_at,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${SHEET_NAME}!A:K`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values },
  });
}

// ============================================================
// ユーティリティ
// ============================================================
function generateId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function now() {
  return new Date().toISOString();
}

// ============================================================
// 実行
// ============================================================
main().catch(err => {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
});

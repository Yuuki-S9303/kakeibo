/**
 * scraper.js
 * MoneyForward ME (住信SBIネット銀行版) → Google Sheets 自動同期
 *
 * CSVダウンロードが有料機能のため、HTMLテーブルをスクレイピング。
 *   収支: /cf の #cf-detail-table
 *   資産: /bs の 口座ごと残高リスト
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
 *
 * Google Sheets の assets シート列構成:
 *   A: id  B: date  C: type  D: amount  E: created_at
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
const SPREADSHEET_ID    = process.env.SPREADSHEET_ID;
const SHEET_NAME        = 'transactions';
const ASSETS_SHEET_NAME = 'assets';
const AUTH_FILE         = path.join(__dirname, '..', 'auth.json');
const MF_BASE           = 'https://ssnb.x.moneyforward.com';

const DRY_RUN = process.argv.includes('--dry-run');
const HEADED  = process.argv.includes('--headed');
const DEBUG   = process.argv.includes('--debug');

// ============================================================
// エントリーポイント
// ============================================================
async function main() {
  console.log(`[${now()}] スクレイピング開始 ${DRY_RUN ? '(dry-run)' : ''}`);

  const storageState = loadStorageState();
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    locale:     'ja-JP',
    timezoneId: 'Asia/Tokyo',
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

    // ── 収支スクレイプ ──────────────────────────────────────────
    const rows = await scrapeMFTransactions(page);
    console.log(`[${now()}] 収支取得: ${rows.length}件（振替・計算対象外除く）`);

    // ── 資産スクレイプ ──────────────────────────────────────────
    const assetRows = await scrapeMFAssets(page);
    console.log(`[${now()}] 資産取得: ${assetRows.length}件`);

    if (DRY_RUN) {
      console.log('\n── dry-run: 収支追加・更新予定データ ──');
      for (const r of rows) {
        console.log(`  ${r.date}  ${r.type === 'expense' ? '-' : '+'}${r.amount.toLocaleString()}円  ${r.payment_method}  ${r.memo}  [${r.external_id}]`);
      }
      console.log(`\n── dry-run: 資産スナップショット ──`);
      for (const r of assetRows) {
        console.log(`  ${r.date}  ${r.type}  ${r.amount.toLocaleString()}円`);
      }
      console.log(`\n合計 収支${rows.length}件 / 資産${assetRows.length}件（実際には書き込まれません）`);
      return;
    }

    const sheets = await buildSheetsClient();

    // 収支: 差分検出して追加・更新
    if (rows.length > 0) {
      const existingRows = await fetchExistingRows(sheets);
      console.log(`[${now()}] 既存収支レコード: ${existingRows.size}件`);

      const newRows    = [];
      const updateRows = [];

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
        console.log('収支: 変更なし。スキップ。');
      }

      // 日付昇順ソート
      await sortByDate(sheets);
      console.log(`[${now()}] 収支 日付昇順ソート完了`);
    }

    // 資産: 常にappend
    if (assetRows.length > 0) {
      await appendAssetRows(sheets, assetRows);
      console.log(`[${now()}] 資産スナップショット追加完了`);
    }

    console.log(`[${now()}] 完了`);

  } finally {
    await browser.close();
  }
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
// MoneyForward ME 収支スクレイピング（pageを引数で受け取る）
// ============================================================
async function scrapeMFTransactions(page) {
  // 今月のみ取得
  // ※URLパラメータでの月切替はJSレンダリングのため効かないため、
  //   デフォルト表示（今月）だけ取得する。週1+月末毎日のスケジュールで十分カバーできる。
  const today  = new Date();
  const year   = today.getFullYear();
  const month  = today.getMonth() + 1;
  const months = [{ year, month }];

  const allRows = [];
  for (const { year, month } of months) {
    console.log(`[${now()}] 収支スクレイピング中: ${year}年${month}月`);

    await page.goto(`${MF_BASE}/cf`, { waitUntil: 'networkidle' });
    await screenshot(page, `cf_${year}_${month}`);

    const rows = await page.evaluate((ym) => {
      const table = document.getElementById('cf-detail-table');
      if (!table) return [];

      return Array.from(table.querySelectorAll('tbody tr')).map(tr => {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length < 8) return null;

        // 計算対象フラグ（hidden input の value で判定）
        const isTargetInput = tr.querySelector('input[name="user_asset_act[is_target]"]');
        const calcFlag = isTargetInput ? isTargetInput.value : '1';

        // 振替フラグ（disable_transfer = 現在振替状態）
        const transFlag = tr.querySelector('.js-switch-transfer[data-link*="disable_transfer"]') ? '1' : '0';

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
}

// ============================================================
// MoneyForward ME 資産スクレイピング（/accounts ページ）
// ============================================================
async function scrapeMFAssets(page) {
  console.log(`[${now()}] 資産ページ取得中...`);
  await page.goto(`${MF_BASE}/accounts`, { waitUntil: 'networkidle' });
  await screenshot(page, 'accounts_assets');

  const today   = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const rawAssets = await page.evaluate(() => {
    const results = [];

    // MF /accounts ページの構造:
    //   <table id="account-table">
    //     <tr><th class="service">金融機関</th><th class="asset">資産</th>...</tr>  ← ヘッダー
    //     <tr id="[hash]"><td><a href="/accounts/show/[hash]">口座名</a></td>...   ← データ行
    //   </table>
    const rows = document.querySelectorAll('#account-table tr[id]');

    const EXCLUDED_ACCOUNTS = ['住信SBIネット銀行'];

    // SBI証券の詳細URL（元本取得用）
    let sbiDetailPath = null;

    rows.forEach(row => {
      const nameEl   = row.querySelector('td:first-child a');
      const assetTd  = row.querySelector('td.asset') || row.querySelector('td:nth-child(2)');
      if (!nameEl || !assetTd) return;

      const name      = nameEl.textContent.trim().replace(/\s+/g, ' ');
      const amountTxt = assetTd.textContent.trim();
      if (!name || !amountTxt) return;
      if (EXCLUDED_ACCOUNTS.includes(name)) return;

      // SBI証券の詳細ページパスを記録
      if (name === 'SBI証券' && nameEl.getAttribute('href')) {
        sbiDetailPath = nameEl.getAttribute('href');
      }

      const amount = parseInt(amountTxt.replace(/[^\-\d]/g, ''), 10);
      if (isNaN(amount)) return;

      results.push({ type: name, amount });
    });

    const bodyPreview = document.body.innerHTML.slice(0, 4000);
    return { results, sbiDetailPath, bodyPreview };
  });

  if (DEBUG || rawAssets.results.length === 0) {
    console.log(`[DEBUG] /accounts ページHTML先頭4000文字:\n${rawAssets.bodyPreview}`);
  }

  if (rawAssets.results.length === 0) {
    console.warn(`[WARN] 資産データが取得できませんでした。--debug フラグで構造を確認してください。`);
    return [];
  }

  console.log(`[${now()}] 取得口座: ${rawAssets.results.map(r => r.type).join(', ')}`);

  const assetRows = rawAssets.results.map(r => ({
    id:         generateId(),
    date:       dateStr,
    type:       r.type,
    amount:     r.amount,
    created_at: new Date().toISOString(),
  }));

  // SBI証券の詳細ページから元本を取得
  if (rawAssets.sbiDetailPath) {
    const motokin = await scrapeSBIMotoken(page, rawAssets.sbiDetailPath, dateStr);
    if (motokin !== null) {
      assetRows.push({
        id:         generateId(),
        date:       dateStr,
        type:       'SBI証券元本',
        amount:     motokin,
        created_at: new Date().toISOString(),
      });
      console.log(`[${now()}] SBI証券元本: ${motokin.toLocaleString()}円`);
    }
  }

  return assetRows;
}

// ============================================================
// /bs/portfolio ページから取得原価合計（SBI証券元本）を取得
// ============================================================
async function scrapeSBIMotoken(page, detailPath, dateStr) {
  console.log(`[${now()}] ポートフォリオページから元本取得中...`);
  await page.goto(`${MF_BASE}/bs/portfolio`, { waitUntil: 'networkidle' });
  // 動的コンテンツの描画を待つ
  await page.waitForTimeout(2000);
  await screenshot(page, 'bs_portfolio');

  const result = await page.evaluate(() => {
    // /bs/portfolio の保有資産テーブル構造（確認済み）:
    //   列: 銘柄名(0) | 保有数(1) | 平均取得単価(2) | 基準価額(3) | 評価額(4)
    //       | 前日比(5) | 評価損益(6) | 評価損益率(7) | 保有金融機関(8) | 取得日(9)...
    //
    // 元本 = Σ(評価額 - 評価損益) で SBI証券行を合算

    let total = null;

    document.querySelectorAll('table').forEach(table => {
      if (total !== null) return;

      // ヘッダー行を取得（thead または最初の tr）
      const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
      if (!headerRow) return;
      const headers = Array.from(headerRow.querySelectorAll('th, td')).map(th => th.textContent.trim());

      const evalIdx  = headers.findIndex(h => h.includes('評価額'));
      const gainIdx  = headers.findIndex(h => h.includes('評価損益') && !h.includes('率'));
      const instIdx  = headers.findIndex(h => h.includes('保有金融機関'));
      if (evalIdx === -1 || gainIdx === -1) return;

      let sum = 0;
      let rowCount = 0;

      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length <= Math.max(evalIdx, gainIdx)) return;

        // 保有金融機関列でSBI証券に絞る（列がなければ全行対象）
        if (instIdx !== -1) {
          const inst = cells[instIdx]?.textContent.trim() || '';
          if (inst && !inst.includes('SBI証券')) return;
        }

        const evalAmt = parseInt((cells[evalIdx]?.textContent || '').replace(/[^\-\d]/g, ''), 10);
        const gainAmt = parseInt((cells[gainIdx]?.textContent || '').replace(/[^\-\d]/g, ''), 10);
        if (isNaN(evalAmt) || isNaN(gainAmt)) return;

        sum += evalAmt - gainAmt;
        rowCount++;
      });

      if (rowCount > 0) {
        total = sum;
      }
    });

    return { total };
  });

  if (result.total === null) {
    console.warn('[WARN] SBI証券元本が取得できませんでした。--debug フラグで構造を確認してください。');
  }

  return result.total;
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

async function appendAssetRows(sheets, rows) {
  const values = rows.map(r => [
    r.id, r.date, r.type, r.amount, r.created_at,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${ASSETS_SHEET_NAME}!A:E`,
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

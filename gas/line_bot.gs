/**
 * line_bot.gs
 * 家計・資産管理システム v2.1
 *
 * 機能:
 *   1. LINE Webhook 受信（doPost）
 *   2. テキスト解析: 残高記録 / 手入力支出 / 資産記録
 *   3. 月次レポート送信 sendMonthlyReport()
 *   4. 入力リマインダー送信 sendInputReminder()
 *
 * スクリプトプロパティ（必須）:
 *   SPREADSHEET_ID           : スプレッドシートID
 *   LINE_CHANNEL_ACCESS_TOKEN: LINE Messaging API アクセストークン
 *   LINE_CHANNEL_SECRET      : LINE Messaging API チャネルシークレット
 *   LINE_USER_ID             : 夫のLINE User ID
 */

// ============================================================
// 定数
// ============================================================
const LINE_CONFIG = {
  REPLY_URL:   'https://api.line.me/v2/bot/message/reply',
  PUSH_URL:    'https://api.line.me/v2/bot/message/push',
  CONTENT_URL: 'https://api-data.line.me/v2/bot/message/{messageId}/content',
};

const SHEETS = {
  TRANSACTIONS: 'transactions',
  CASH_BALANCE: 'cash_balance',
  ASSETS:       'assets',
  MAIL_LOG:     'mail_log',
  SUMMARY:      'summary',
};

// 現金残高が急減したと判断する閾値（円）
const CASH_DROP_THRESHOLD = 5000;

// ============================================================
// LINE Webhook エントリーポイント
// ============================================================

function doPost(e) {
  // LINE Webhook検証用（postDataなしのリクエストに200を返す）
  if (!e || !e.postData) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    // 署名検証
    if (!verifyLineSignature(e)) {
      Logger.log('署名検証失敗');
      return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const body   = JSON.parse(e.postData.contents);
    const events = body.events || [];

    for (const event of events) {
      try {
        handleEvent(event);
      } catch (err) {
        Logger.log(`イベント処理エラー [${event.type}]: ${err.message}`);
      }
    }
  } catch (err) {
    // 予期せぬエラーが起きても必ず200を返す
    Logger.log(`doPostエラー: ${err.message}`);
  }

  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// イベントルーター
// ============================================================
function handleEvent(event) {
  Logger.log('userId: ' + event.source.userId);
  if (event.type !== 'message') return;

  const replyToken = event.replyToken;
  const userId     = event.source.userId;
  const msg        = event.message;

  switch (msg.type) {
    case 'text':
      handleTextMessage(replyToken, userId, msg.text.trim());
      break;
    default:
      replyText(replyToken, 'テキストで入力してください。\n例: 1500 ランチ 食費');
  }
}

// ============================================================
// テキストメッセージ処理
// 複数行をまとめて送っても1回のreplyで返す
// ============================================================
function handleTextMessage(replyToken, userId, text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const replies = [];

  for (const line of lines) {
    const reply = processLine(userId, line);
    if (reply) replies.push(reply);
  }

  if (replies.length === 0) return; // 認識できない入力は無視（LINE無料枠節約）

  replyText(replyToken, replies.join('\n─────────────\n'));
}

/** 1行を解析してDB書き込み＋返信文字列を返す。認識できなければ null */
function processLine(userId, text) {
  const INCOME_CATEGORIES_WITH_PERSON    = ['給与', '賞与', '副業'];
  const INCOME_CATEGORIES_WITHOUT_PERSON = ['臨時収入', '補助金', '還付金', '投資収入'];
  const ALL_INCOME_CATEGORIES = [...INCOME_CATEGORIES_WITH_PERSON, ...INCOME_CATEGORIES_WITHOUT_PERSON];

  const EXPENSE_CATEGORIES = [
    '食費', '日用品', '衣服', '美容', '医療費', '住居費',
    '交通費', '通信費', '光熱費', '交際費', '教育費',
    '家具・家電', '旅行・娯楽', 'プレゼント', 'その他',
  ];

  // 1. 残高記録: 「残高 ¥8000」「残高8000」「balance 8000」
  const balanceMatch = text.match(/^(?:残高|balance)\s*[¥￥]?\s*([\d,]+)/i);
  if (balanceMatch) return handleCashBalance(parseAmount(balanceMatch[1]));

  // 2. 収入記録: 「給与 400000」「給与 400000 残業代」
  const incomeCategoryPattern = new RegExp(`^(${ALL_INCOME_CATEGORIES.join('|')})\\s+([\\d,]+)\\s*(.*)`, 'i');
  const incomeCategoryMatch = text.match(incomeCategoryPattern);
  if (incomeCategoryMatch) {
    const categoryName = incomeCategoryMatch[1];
    const amount       = parseAmount(incomeCategoryMatch[2]);
    const extraMemo    = incomeCategoryMatch[3].trim();
    const withPerson   = INCOME_CATEGORIES_WITH_PERSON.includes(categoryName);
    const person       = withPerson ? resolvePersonName(userId) : null;
    const memo         = [person ? `${categoryName}（${person}）` : categoryName, extraMemo]
                           .filter(Boolean).join(' ');
    return handleIncome(amount, memo);
  }

  // 収入コマンド（汎用）: 「収入 250000 メモ」
  const incomeMatch = text.match(/^(?:収入|income)\s+([\d,]+)\s*(.+)?/i);
  if (incomeMatch) return handleIncome(parseAmount(incomeMatch[1]), (incomeMatch[2] || '').trim());

  // 3. 資産記録: 「資産 SBI 1500000」「資産 現金 50000」
  const assetMatch = text.match(/^(?:資産|asset)\s+(\S+)\s+([\d,]+)/i);
  if (assetMatch) return handleAssetRecord(assetMatch[1], parseAmount(assetMatch[2]));

  // 4. カテゴリ指定支出: 「食費 1500 ランチ」「交通費 280」
  const expenseCategoryPattern = new RegExp(`^(${EXPENSE_CATEGORIES.join('|')})\\s+([\\d,]+)\\s*(.*)`, 'i');
  const expenseCategoryMatch = text.match(expenseCategoryPattern);
  if (expenseCategoryMatch) {
    return handleManualExpense(
      parseAmount(expenseCategoryMatch[2]),
      expenseCategoryMatch[3].trim(),
      expenseCategoryMatch[1],
    );
  }

  // 5. 数字始まりの旧形式（後方互換）: 「1500 ランチ」
  const expenseMatch = text.match(/^-?([\d,]+)\s+(.+)/);
  if (expenseMatch) return handleManualExpense(parseAmount(expenseMatch[1]), expenseMatch[2].trim(), '');

  // 6. ヘルプ
  if (/^(help|ヘルプ|使い方)$/i.test(text)) return getHelpText();

  return null; // 認識できない行は無視
}

// ============================================================
// 現金残高記録
// ============================================================
function handleCashBalance(newBalance) {
  const ss    = openSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.CASH_BALANCE);
  const now   = new Date();

  // 前回残高を取得
  const prevBalance = getLastCashBalance(sheet);
  const diff        = prevBalance !== null ? newBalance - prevBalance : null;

  // cash_balance に記録
  sheet.appendRow([generateId(), formatDate(now), newBalance, '', nowJSTString()]);

  // 差分を現金支出として transactions に登録
  if (diff !== null && diff < 0) {
    const txSheet = ss.getSheetByName(SHEETS.TRANSACTIONS);
    txSheet.appendRow([
      generateId(),
      formatDate(now),
      Math.abs(diff),    // amount（正の数で記録）
      'expense',
      '現金支出',
      '',
      '現金',
      '現金残高差分',
      'line_cash',
      '',
      nowJSTString(),
    ]);
  }

  // 返信メッセージ組み立て
  let reply = `残高を記録しました。\n現在残高: ¥${newBalance.toLocaleString()}`;
  if (diff !== null) {
    const sign = diff >= 0 ? '+' : '';
    reply += `\n前回比: ${sign}¥${diff.toLocaleString()}`;
  }

  // 急減チェック（-5000円以上の減少）
  if (diff !== null && diff <= -CASH_DROP_THRESHOLD) {
    reply += `\n\n⚠️ 残高が¥${Math.abs(diff).toLocaleString()}減少しました。支出の登録はお済みですか？`;
  }

  return reply;
}

/** cash_balance シートから最新残高を取得 */
function getLastCashBalance(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  // C列(balance)の最終行
  const val = sheet.getRange(lastRow, 3).getValue();
  return val !== '' ? Number(val) : null;
}

// ============================================================
// 手入力支出登録
// ============================================================
function handleManualExpense(amount, memo, category) {
  const ss    = openSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.TRANSACTIONS);
  const now   = new Date();

  sheet.appendRow([
    generateId(),
    formatDate(now),
    amount,
    'expense',
    category || '',
    '',
    '手入力',
    memo,
    'line_manual',
    '',
    nowJSTString(),
  ]);

  let reply = `支出を登録しました。\nカテゴリ: ${category || '未設定'}\n金額: ¥${amount.toLocaleString()}`;
  if (memo) reply += `\nメモ: ${memo}`;
  return reply;
}

// ============================================================
// 送信者名解決（USER IDから夫/妻を判定）
// ============================================================
function resolvePersonName(userId) {
  const husbandId = getProperty('LINE_USER_ID');
  const wifeId    = getProperty('LINE_USER_ID_WIFE');
  if (userId === husbandId) return '夫';
  if (wifeId && userId === wifeId) return '妻';
  return null;
}

// ============================================================
// 収入記録
// ============================================================
function handleIncome(amount, memo) {
  const ss    = openSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.TRANSACTIONS);
  const now   = new Date();

  sheet.appendRow([
    generateId(),
    formatDate(now),
    amount,
    'income',
    '収入',
    '',
    '振込',
    memo || '収入',
    'line_manual',
    '',
    nowJSTString(),
  ]);

  return `収入を登録しました ✅\n金額: ¥${amount.toLocaleString()}\nメモ: ${memo || '収入'}`;
}

// ============================================================
// 資産記録
// ============================================================
function handleAssetRecord(assetType, amount) {
  const ss    = openSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.ASSETS);
  const now   = new Date();

  sheet.appendRow([
    generateId(),
    formatDate(now),
    assetType,
    amount,
    '',
    nowJSTString(),
  ]);

  return `資産を記録しました。\n種類: ${assetType}\n金額: ¥${amount.toLocaleString()}`;
}

// ============================================================
// 月次レポート送信（トリガーから呼び出す）
// ============================================================
function sendMonthlyReport() {
  const ss      = openSpreadsheet();
  const userId  = getProperty('LINE_USER_ID'); // 送信先ユーザーID
  if (!userId) {
    Logger.log('LINE_USER_ID が未設定のためスキップ');
    return;
  }

  const now       = new Date();
  const year      = now.getFullYear();
  const month     = now.getMonth() + 1; // 今月（送信タイミングは月初を想定）
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  const monthStr  = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;

  const report = buildMonthlyReport(ss, monthStr);
  sendPushMessage(userId, report);
}

/** 指定月の集計テキストを生成 */
function buildMonthlyReport(ss, monthStr) {
  const sheet   = ss.getSheetByName(SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return `${monthStr} のデータがありません。`;

  const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();

  let totalExpense = 0;
  let totalIncome  = 0;
  const byCategory = {};

  for (const row of data) {
    const [id, date, amount, type, category] = row;
    if (!date || String(date).slice(0, 7) !== monthStr) continue;

    const amt = Number(amount) || 0;
    if (type === 'expense') {
      totalExpense += amt;
      const cat = category || 'その他';
      byCategory[cat] = (byCategory[cat] || 0) + amt;
    } else if (type === 'income') {
      totalIncome += amt;
    }
  }

  const saving = totalIncome - totalExpense;
  let report = `📊 ${monthStr} 月次レポート\n`;
  report += `━━━━━━━━━━━━━━\n`;
  report += `収入合計: ¥${totalIncome.toLocaleString()}\n`;
  report += `支出合計: ¥${totalExpense.toLocaleString()}\n`;
  report += `収支: ${saving >= 0 ? '+' : ''}¥${saving.toLocaleString()}\n`;
  report += `━━━━━━━━━━━━━━\n`;
  report += `【カテゴリ別支出】\n`;

  const sortedCats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, amt] of sortedCats) {
    report += `${cat}: ¥${amt.toLocaleString()}\n`;
  }

  return report.trim();
}

// ============================================================
// 入力リマインダー送信（トリガーから呼び出す）
// ============================================================
function sendInputReminder() {
  const userId = getProperty('LINE_USER_ID');
  if (!userId) return;

  const ss      = openSpreadsheet();
  const sheet   = ss.getSheetByName(SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();
  const today   = formatDate(new Date());

  // 直近3日間の登録件数を確認
  let recentCount = 0;
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    for (const [, date] of data) {
      if (date && new Date(date) >= threeDaysAgo) recentCount++;
    }
  }

  if (recentCount === 0) {
    sendPushMessage(userId, '💡 直近3日間の支出登録がありません。\nレシートや現金残高の記録をお忘れではないですか？');
  }
}

// ============================================================
// LINE Messaging API ヘルパー
// ============================================================

/** Reply API で返信 */
function replyText(replyToken, text) {
  const token = getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  UrlFetchApp.fetch(LINE_CONFIG.REPLY_URL, {
    method:      'post',
    contentType: 'application/json',
    headers:     { Authorization: `Bearer ${token}` },
    payload:     JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
    muteHttpExceptions: true,
  });
}

/** Push API でメッセージ送信 */
function sendPushMessage(userId, text) {
  const token = getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  UrlFetchApp.fetch(LINE_CONFIG.PUSH_URL, {
    method:      'post',
    contentType: 'application/json',
    headers:     { Authorization: `Bearer ${token}` },
    payload:     JSON.stringify({
      to:       userId,
      messages: [{ type: 'text', text }],
    }),
    muteHttpExceptions: true,
  });
}

/** LINE署名検証 */
function verifyLineSignature(e) {
  const secret = getProperty('LINE_CHANNEL_SECRET');
  if (!secret || secret === 'dummy') return true;

  try {
    const body      = e.postData.contents;
    const signature = e.parameter['X-Line-Signature'];
    if (!signature) return true; // Verify時はスキップ

    const digest   = Utilities.computeHmacSha256Signature(
      Utilities.newBlob(body).getBytes(),
      Utilities.newBlob(secret).getBytes()
    );
    const expected = Utilities.base64Encode(digest);
    return signature === expected;
  } catch (err) {
    Logger.log('署名検証エラー: ' + err.message);
    return true;
  }
}

// ============================================================
// ユーティリティ（line_bot.gs 内で独立して動作するよう再定義）
// ============================================================

function openSpreadsheet() {
  const id = getProperty('SPREADSHEET_ID') || '1BzRyEA-sdxmD_BMcmkVIaM54Sk6guhatQP5M0jdew9s';
  return SpreadsheetApp.openById(id);
}

function getProperty(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function generateId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 日付を JST の YYYY-MM-DD 形式で返す */
function formatDate(date) {
  const jst = toJST(new Date(date));
  const y   = jst.getFullYear();
  const m   = String(jst.getMonth() + 1).padStart(2, '0');
  const day = String(jst.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 現在時刻を JST の ISO 8601 文字列で返す（created_at 用） */
function nowJSTString() {
  const jst = toJST(new Date());
  const y   = jst.getFullYear();
  const m   = String(jst.getMonth() + 1).padStart(2, '0');
  const d   = String(jst.getDate()).padStart(2, '0');
  const h   = String(jst.getHours()).padStart(2, '0');
  const min = String(jst.getMinutes()).padStart(2, '0');
  const s   = String(jst.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}+09:00`;
}

/** UTC の Date を JST（UTC+9）に変換した Date を返す */
function toJST(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}

function parseAmount(str) {
  return parseInt(String(str).replace(/,/g, ''), 10) || 0;
}

function getHelpText() {
  return [
    '【使い方】',
    '',
    '💰 現金残高の記録:',
    '  残高 8000',
    '  残高 ¥8,000',
    '',
    '🛍️ 支出の手入力:',
    '  1500 ランチ 食費',
    '  800 コンビニ 日用品',
    '  ※ 金額 メモ の形式',
    '  ※ カード明細はMoneyForwardから自動取込',
    '',
    '💴 収入の記録:',
    '  給与 400000',
    '  賞与 200000',
    '  副業 50000',
    '  臨時収入 30000',
    '  補助金 50000',
    '  還付金 20000',
    '',
    '📈 資産の記録:',
    '  資産 SBI証券 1500000',
    '  資産 現金 50000',
    '',
    'カテゴリの設定はLIFFアプリで行えます。',
    '',
  ].join('\n');
}

// ============================================================
// デバッグ用: 手動実行でテスト
// ============================================================
function testDoPost() {
  const mockEvent = {
    postData: {
      contents: JSON.stringify({events: []}),
      type: 'application/json'
    },
    parameter: {}
  };
  const result = doPost(mockEvent);
  Logger.log('result: ' + result.getContent());
}

/**
 * liff_app.gs
 * 家計・資産管理システム v2.0
 *
 * 機能:
 *   - LIFF HTML配信（doGet）
 *   - データAPI（action パラメータで処理を分岐）
 *
 * アクション一覧:
 *   monthly_summary  : 月次収支サマリー
 *   budget_status    : カテゴリ別予算残高
 *   savings_trend    : 貯蓄額月次推移
 *   assets_trend     : 資産・NISA推移
 */

const LIFF_ID = '2009696996-oWmXdu5w';

const LIFF_SHEETS = {
  TRANSACTIONS: 'transactions',
  BUDGETS:      'budgets',
  ASSETS:       'assets',
  CATEGORIES:   'categories',
  CASH_BALANCE: 'cash_balance',
};

// ============================================================
// エントリーポイント
// ============================================================

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;

  // アクション指定あり → JSON APIとして動作
  if (action) {
    return handleApiRequest(e);
  }

  // アクションなし → LIFFアプリHTMLを配信（テンプレートとして処理）
  const html = HtmlService.createTemplateFromFile('liff').evaluate()
    .setTitle('家計管理')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return html;
}

function handleApiRequest(e) {
  const action = e.parameter.action;
  const year   = parseInt(e.parameter.year)  || new Date().getFullYear();
  const month  = parseInt(e.parameter.month) || new Date().getMonth() + 1;

  let result;
  try {
    switch (action) {
      case 'monthly_summary':       result = getMonthlySummary(year, month);                                    break;
      case 'budget_status':         result = getBudgetStatus(year, month);                                      break;
      case 'savings_trend':         result = getSavingsTrend();                                                  break;
      case 'assets_trend':          result = getAssetsTrend();                                                   break;
      case 'category_transactions': result = getCategoryTransactions(year, month, e.parameter.category || ''); break;
      default: result = { error: '不明なアクション: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// API: 月次収支サマリー
// ============================================================
function getMonthlySummary(year, month) {
  const ss        = openLiffSpreadsheet();
  const sheet     = ss.getSheetByName(LIFF_SHEETS.TRANSACTIONS);
  const lastRow   = sheet.getLastRow();
  const monthStr  = `${year}-${String(month).padStart(2, '0')}`;

  let totalIncome  = 0;
  let totalExpense = 0;
  const byCategory = {};

  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    for (const [id, date, amount, type, category] of data) {
      if (!date) continue;
      const dateStr = date instanceof Date
        ? Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM')
        : String(date).slice(0, 7);
      if (dateStr !== monthStr) continue;
      const amt = Number(amount) || 0;
      if (isIncomeType(type)) {
        totalIncome += amt;
      } else if (isExpenseType(type)) {
        totalExpense += amt;
        const cat = category || 'その他';
        byCategory[cat] = (byCategory[cat] || 0) + amt;
      }
    }
  }

  return {
    year,
    month,
    income:     totalIncome,
    expense:    totalExpense,
    saving:     totalIncome - totalExpense,
    byCategory: byCategory,
  };
}

// ============================================================
// API: カテゴリ別予算残高
// ============================================================
function getBudgetStatus(year, month) {
  const ss       = openLiffSpreadsheet();
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  // 予算取得
  const budgetSheet = ss.getSheetByName(LIFF_SHEETS.BUDGETS);
  const budgetData  = budgetSheet.getLastRow() >= 2
    ? budgetSheet.getRange(2, 1, budgetSheet.getLastRow() - 1, 3).getValues()
    : [];

  const budgets = {};
  for (const [bMonth, category, amount] of budgetData) {
    if (String(bMonth).slice(0, 7) === monthStr) {
      budgets[category] = Number(amount) || 0;
    }
  }

  // 実績取得
  const txSheet  = ss.getSheetByName(LIFF_SHEETS.TRANSACTIONS);
  const lastRow  = txSheet.getLastRow();
  const actuals  = {};

  if (lastRow >= 2) {
    const data = txSheet.getRange(2, 1, lastRow - 1, 5).getValues();
    for (const [id, date, amount, type, category] of data) {
      if (!date) continue;
      const dateStr = date instanceof Date
        ? Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM')
        : String(date).slice(0, 7);
      if (dateStr !== monthStr) continue;
      if (!isExpenseType(type)) continue;
      const cat = category || 'その他';
      actuals[cat] = (actuals[cat] || 0) + (Number(amount) || 0);
    }
  }

  // 予算・実績・残高をまとめる
  const categories = Object.keys({ ...budgets, ...actuals });
  const items = categories.map(cat => ({
    category: cat,
    budget:   budgets[cat]  || 0,
    actual:   actuals[cat]  || 0,
    remaining: (budgets[cat] || 0) - (actuals[cat] || 0),
    rate:     budgets[cat] ? Math.round((actuals[cat] || 0) / budgets[cat] * 100) : null,
  }));

  return { year, month, items };
}

// ============================================================
// API: 貯蓄額月次推移（直近12ヶ月）
// ============================================================
function getSavingsTrend() {
  const ss      = openLiffSpreadsheet();
  const sheet   = ss.getSheetByName(LIFF_SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();

  // 直近12ヶ月のラベルを生成
  const months = [];
  const now    = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const income  = Object.fromEntries(months.map(m => [m, 0]));
  const expense = Object.fromEntries(months.map(m => [m, 0]));

  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (const [id, date, amount, type] of data) {
      if (!date) continue;
      const m = date instanceof Date
        ? Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM')
        : String(date).slice(0, 7);
      if (!income.hasOwnProperty(m)) continue;
      if (isIncomeType(type))  income[m]  += Number(amount) || 0;
      if (isExpenseType(type)) expense[m] += Number(amount) || 0;
    }
  }

  return {
    labels:  months.map(m => m.slice(0, 7)),
    income:  months.map(m => income[m]),
    expense: months.map(m => expense[m]),
    saving:  months.map(m => income[m] - expense[m]),
  };
}

// ============================================================
// API: 資産推移（直近12ヶ月）
// ============================================================
function getAssetsTrend() {
  const ss      = openLiffSpreadsheet();
  const sheet   = ss.getSheetByName(LIFF_SHEETS.ASSETS);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return { records: [] };

  const data    = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const records = data
    .filter(([id, date, type, amount]) => date && amount)
    .map(([id, date, type, amount]) => ({
      date: date instanceof Date
        ? Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd')
        : String(date).slice(0, 10),
      type:   String(type),
      amount: Number(amount) || 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { records };
}

// ============================================================
// ユーティリティ
// ============================================================
function openLiffSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
    || '1BzRyEA-sdxmD_BMcmkVIaM54Sk6guhatQP5M0jdew9s';
  return SpreadsheetApp.openById(id);
}

// ============================================================
// API: カテゴリ別明細（月×カテゴリ）
// ============================================================
function getCategoryTransactions(year, month, category) {
  const ss       = openLiffSpreadsheet();
  const sheet    = ss.getSheetByName(LIFF_SHEETS.TRANSACTIONS);
  const lastRow  = sheet.getLastRow();
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  if (lastRow < 2) return { transactions: [] };

  const data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const transactions = [];

  for (const [, date, amount, type, cat, , payment_method, memo] of data) {
    if (!date) continue;
    const dateStr = date instanceof Date
      ? Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM')
      : String(date).slice(0, 7);
    if (dateStr !== monthStr) continue;
    if (!isExpenseType(type)) continue;
    if ((cat || 'その他') !== category) continue;

    transactions.push({
      date:           date instanceof Date
                        ? Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd')
                        : String(date).slice(0, 10),
      amount:         Number(amount) || 0,
      payment_method: String(payment_method || ''),
      memo:           String(memo || ''),
    });
  }

  transactions.sort((a, b) => b.date.localeCompare(a.date));
  return { year, month, category, transactions };
}

/** type列の表記揺れ吸収（英語・日本語どちらも対応） */
function isExpenseType(type) {
  return type === 'expense' || type === '支出';
}
function isIncomeType(type) {
  return type === 'income' || type === '収入';
}

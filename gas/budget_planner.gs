/**
 * budget_planner.gs
 * 家計・資産管理システム v2.0 - Phase 5: Gemini 予算策定
 *
 * 機能:
 *   1. buildAnalysisData()      - transactionsを集計して分析JSONを生成
 *   2. generateBudgetPlan()     - Geminiに渡して予算案生成・保存・通知
 *   3. runMonthlyBudgetPlanning() - 毎月1日トリガーエントリーポイント
 *   4. handleBudgetCommand()    - LINEコマンド処理（line_bot.gsから呼び出す）
 *
 * LINEコマンド:
 *   月収 280000        → base_income 更新
 *   貯金目標 50000     → savings_goal 更新
 *   調整 +12000        → income_adjustment 更新（残業・精算など）
 *   予算提案           → 即時予算案生成
 */

const BUDGET_GEMINI_MODEL = 'gemini-3-flash-preview';
const SEASONAL_FLAG_THRESHOLD = 1.5; // 月平均の150%超で季節フラグ

// ============================================================
// settings シートのCRUD
// ============================================================

function getSetting(key) {
  const ss    = openSpreadsheet();
  const sheet = ss.getSheetByName('settings');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) return data[i][1];
  }
  return null;
}

function setSetting(key, value) {
  const ss    = openSpreadsheet();
  const sheet = ss.getSheetByName('settings');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
}

// ============================================================
// 集計ロジック
// ============================================================

/**
 * transactionsシートから分析データを生成
 * @param {string} targetYM - 対象年月 "2026-05"
 * @returns {Object} 分析データ
 */
function buildAnalysisData(targetYM) {
  const ss      = openSpreadsheet();
  const sheet   = ss.getSheetByName('transactions');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const [targetYear, targetMonth] = targetYM.split('-').map(Number);

  // カテゴリ別 × 年月別 集計 { category: { "YYYY-MM": total } }
  const catMonthTotals = {};

  for (const row of data) {
    const [, dateRaw, amountRaw, type, category] = row;
    if (!dateRaw || !amountRaw) continue;

    // type判定（MoneyNote: 支出 / LINE Bot: expense どちらも対応）
    const isExpense = type === '支出' || type === 'expense';
    if (!isExpense) continue;

    const amount = Number(amountRaw) || 0;
    if (amount <= 0) continue;

    const cat = String(category || 'その他').trim();

    // 日付パース（YYYY-MM-DD / YYYY/MM/DD / Date オブジェクト 対応）
    let ym;
    if (dateRaw instanceof Date) {
      const jst = new Date(dateRaw.getTime() + 9 * 60 * 60 * 1000);
      ym = `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}`;
    } else {
      const s = String(dateRaw).replace(/\//g, '-');
      ym = s.slice(0, 7);
    }

    const [y, m] = ym.split('-').map(Number);
    if (isNaN(y) || isNaN(m)) continue;

    // 対象月は集計から除外（まだ確定していない）
    if (y === targetYear && m === targetMonth) continue;

    if (!catMonthTotals[cat]) catMonthTotals[cat] = {};
    catMonthTotals[cat][ym] = (catMonthTotals[cat][ym] || 0) + amount;
  }

  // 直近3ヶ月平均
  const recent3Months = getRecentMonths(targetYM, 3);
  const recentAvg = {};
  for (const [cat, monthData] of Object.entries(catMonthTotals)) {
    let total = 0, count = 0;
    for (const ym of recent3Months) {
      if (monthData[ym]) { total += monthData[ym]; count++; }
    }
    if (count > 0) recentAvg[cat] = Math.round(total / count);
  }

  // 全期間月平均（季節比較ベースライン）
  const overallAvg = {};
  for (const [cat, monthData] of Object.entries(catMonthTotals)) {
    const vals = Object.values(monthData);
    if (vals.length > 0) {
      overallAvg[cat] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }

  // 対象月と同じ月番号の過去データ平均（季節平均）
  const seasonalAvg = {};
  for (const [cat, monthData] of Object.entries(catMonthTotals)) {
    const sameMonthVals = Object.entries(monthData)
      .filter(([ym]) => Number(ym.split('-')[1]) === targetMonth)
      .map(([, v]) => v);
    if (sameMonthVals.length > 0) {
      seasonalAvg[cat] = Math.round(sameMonthVals.reduce((a, b) => a + b, 0) / sameMonthVals.length);
    }
  }

  // 季節フラグ: 季節平均が全体月平均の THRESHOLD 倍超
  const seasonalFlags = [];
  for (const [cat, avg] of Object.entries(seasonalAvg)) {
    const base = overallAvg[cat] || 0;
    if (base > 0 && avg > base * SEASONAL_FLAG_THRESHOLD) {
      seasonalFlags.push({
        category:     cat,
        seasonal_avg: avg,
        overall_avg:  base,
        ratio:        Math.round(avg / base * 10) / 10,
      });
    }
  }

  return {
    target_month:       targetYM,
    recent_3month_avg:  recentAvg,
    overall_monthly_avg: overallAvg,
    seasonal_flags:     seasonalFlags,
  };
}

/** 指定年月からNヶ月前の年月リストを返す ["2026-03", "2026-02", "2026-01"] */
function getRecentMonths(targetYM, n) {
  const [y, m] = targetYM.split('-').map(Number);
  const result = [];
  for (let i = 1; i <= n; i++) {
    let mm = m - i, yy = y;
    while (mm <= 0) { mm += 12; yy--; }
    result.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return result;
}

// ============================================================
// Gemini API 呼び出し
// ============================================================

function callGeminiForBudget(prompt) {
  const apiKey = getProperty('GEMINI_API_KEY');
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${BUDGET_GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const payload = {
    contents:         [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 },
  };

  const response = UrlFetchApp.fetch(apiUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  const json = JSON.parse(response.getContentText());
  if (statusCode !== 200 || !json.candidates || !json.candidates[0]) {
    throw new Error(`Gemini API エラー (${statusCode}) model=${BUDGET_GEMINI_MODEL}: ` + response.getContentText().slice(0, 200));
  }

  const text = json.candidates[0].content.parts[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('予算JSONのパース失敗: ' + text.slice(0, 200));
  return JSON.parse(jsonMatch[0]);
}

// ============================================================
// Gemini へ渡すプロンプト生成
// ============================================================

function buildBudgetPrompt(analysisData, discretionary, fixedCosts) {
  const { target_month, recent_3month_avg, seasonal_flags } = analysisData;
  const [, month] = target_month.split('-').map(Number);

  const recentLines = Object.entries(recent_3month_avg).length > 0
    ? Object.entries(recent_3month_avg)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, amt]) => `  ${cat}: ${amt.toLocaleString()}円`)
        .join('\n')
    : '  データなし';

  const seasonalLines = seasonal_flags.length > 0
    ? seasonal_flags
        .map(f => `  ${f.category}: 過去${month}月平均 ${f.seasonal_avg.toLocaleString()}円（通常比${f.ratio}倍）`)
        .join('\n')
    : '  特になし';

  return `あなたは家計予算アドバイザーです。以下のデータをもとに${target_month}の予算案を作成してください。

【予算の構造】
- 固定費（ローン・管理費など）: ${fixedCosts.toLocaleString()}円 ← 毎月確定で変更不可
- 変動費予算（配分対象）: ${discretionary.toLocaleString()}円 ← あなたが配分する予算

【直近3ヶ月のカテゴリ別支出平均】
${recentLines}

【${month}月の季節的な特別支出（過去データより）】
${seasonalLines}

【ルール】
- 変動費の全カテゴリ合計が${discretionary.toLocaleString()}円を超えないこと
- 固定費はすでに確保済みなので予算案には含めない
- 以下の優先順位で配分すること：
  1. 生活必需費（食費・日用品・光熱費・交通費・通信費）を直近平均に近い額で確保
  2. 季節フラグのあるカテゴリに上乗せ（ただし1カテゴリ最大でも変動費予算の25%まで）
  3. 残りを娯楽・交際費などに配分
- 食費は直近平均を下回らないよう優先すること
- イレギュラーな高額支出（プレゼント・医療費など）は季節フラグがある場合のみ上乗せし、過去平均の50%を上限とする
- データにないカテゴリは省略してよい

【出力形式】JSONのみ・説明文不要:
{
  "summary": "一言コメント（30文字以内）",
  "budgets": [
    {"category": "食費", "amount": 35000, "note": "直近平均ベース"},
    ...
  ],
  "special_note": "今月の注意点（なければ空文字）"
}`;
}

// ============================================================
// 予算案生成 → 保存 → LINE通知 メイン
// ============================================================

/**
 * 予算案を生成してbudgetsシートに保存・LINE通知する
 * @param {string|null} targetYM - "2026-05" or null（翌月自動）
 */
function generateBudgetPlan(targetYM) {
  // 対象月が未指定なら翌月
  if (!targetYM) {
    const jst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
    const y = jst.getFullYear();
    const m = jst.getMonth() + 2; // 翌月
    const yr = m > 12 ? y + 1 : y;
    const mr = m > 12 ? m - 12 : m;
    targetYM = `${yr}-${String(mr).padStart(2, '0')}`;
  }

  const baseIncome   = Number(getSetting('base_income'))        || 0;
  const savingsGoal  = Number(getSetting('savings_goal'))       || 0;
  const adjustment   = Number(getSetting('income_adjustment'))  || 0;
  const fixedCosts   = Number(getSetting('fixed_costs'))        || 0;
  const available    = baseIncome + adjustment - savingsGoal;
  const discretionary = available - fixedCosts; // 固定費を引いた変動費予算
  const userId       = getProperty('LINE_USER_ID');

  if (baseIncome === 0) {
    if (userId) sendPushMessage(userId,
      '⚠️ 月収が未設定です。\nLINEで「月収 280000」と送って設定してください。');
    return;
  }

  if (discretionary <= 0) {
    if (userId) sendPushMessage(userId,
      `⚠️ 固定費(¥${fixedCosts.toLocaleString()})を引くと変動費予算が¥${discretionary.toLocaleString()}です。\n設定を確認してください。`);
    return;
  }

  const analysisData = buildAnalysisData(targetYM);
  if (!analysisData) {
    Logger.log('集計データなし');
    return;
  }

  Logger.log('分析データ: ' + JSON.stringify(analysisData));

  const prompt = buildBudgetPrompt(analysisData, discretionary, fixedCosts);
  Logger.log('Geminiプロンプト:\n' + prompt);

  let budgetResult;
  try {
    budgetResult = callGeminiForBudget(prompt);
  } catch (err) {
    Logger.log('Geminiエラー: ' + err.message);
    if (userId) sendPushMessage(userId, '予算生成中にエラーが発生しました。\n' + err.message);
    return;
  }

  Logger.log('Gemini結果: ' + JSON.stringify(budgetResult));

  // budgetsシートに保存
  saveBudgetPlan(budgetResult.budgets || [], targetYM);

  // income_adjustment をリセット・生成日時を記録
  setSetting('income_adjustment', 0);
  setSetting('last_budget_generated', nowJSTString());

  // LINE通知
  if (userId) {
    const msg = formatBudgetMessage(budgetResult, targetYM, baseIncome, savingsGoal, adjustment, fixedCosts, available, discretionary);
    sendPushMessage(userId, msg);
  }
}

/** budgetsシートに予算を保存（同月の既存データは上書き） */
function saveBudgetPlan(budgets, targetYM) {
  const ss    = openSpreadsheet();
  const sheet = ss.getSheetByName('budgets');
  const now   = nowJSTString();

  // 同月の既存行を削除
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const existing = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    for (let i = existing.length - 1; i >= 0; i--) {
      if (String(existing[i][1]).slice(0, 7) === targetYM) {
        sheet.deleteRow(i + 2);
      }
    }
  }

  if (budgets.length === 0) return;

  const rows = budgets.map(b => [
    generateId(),
    targetYM,
    b.category,
    Number(b.amount) || 0,
    now,
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
}

/** LINE通知用メッセージ整形 */
function formatBudgetMessage(result, targetYM, baseIncome, savingsGoal, adjustment, fixedCosts, available, discretionary) {
  const [year, month] = targetYM.split('-').map(Number);
  let msg = `📋 ${year}年${month}月 予算案\n`;
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `月収: ¥${baseIncome.toLocaleString()}`;
  if (adjustment !== 0) msg += ` (${adjustment > 0 ? '+' : ''}¥${adjustment.toLocaleString()})`;
  msg += `\n貯金目標: -¥${savingsGoal.toLocaleString()}`;
  msg += `\n固定費:   -¥${fixedCosts.toLocaleString()}`;
  msg += `\n変動費予算: ¥${discretionary.toLocaleString()}\n`;
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `【固定費】\n`;
  msg += `ローン・管理費など: ¥${fixedCosts.toLocaleString()}\n`;
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `【変動費】\n`;

  const budgets = result.budgets || [];
  const sorted  = [...budgets].sort((a, b) => Number(b.amount) - Number(a.amount));
  for (const b of sorted) {
    msg += `${b.category}: ¥${Number(b.amount).toLocaleString()}\n`;
  }

  const varTotal = budgets.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `変動費合計: ¥${varTotal.toLocaleString()} / ¥${discretionary.toLocaleString()}\n`;
  msg += `総支出合計: ¥${(varTotal + fixedCosts).toLocaleString()} / ¥${available.toLocaleString()}\n`;

  if (result.summary)      msg += `\n💬 ${result.summary}`;
  if (result.special_note) msg += `\n⚠️ ${result.special_note}`;

  return msg.trim();
}

// ============================================================
// 月次トリガーエントリーポイント
// トリガー設定: 日ベースのタイマー → 毎日 午前8時〜9時
// 毎日実行されるが、1日のみ予算生成する
// ============================================================

function runMonthlyBudgetPlanning() {
  const jst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
  if (jst.getDate() !== 1) return; // 1日以外はスキップ
  generateBudgetPlan(null);
}

// ============================================================
// LINEコマンドハンドラ（line_bot.gs の handleTextMessage から呼び出す）
// 複数コマンドを改行区切りでまとめて送っても処理できる
// @returns {boolean} 予算関連コマンドが1つでもあればtrue
// ============================================================

function handleBudgetCommand(replyToken, text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const responses    = [];
  let generateBudget = false;
  let hasBudgetCmd   = false;

  for (const line of lines) {
    // 月収設定: 「月収 280000」
    const incomeMatch = line.match(/^月収\s*([\d,]+)/);
    if (incomeMatch) {
      const income = parseInt(incomeMatch[1].replace(/,/g, ''), 10);
      setSetting('base_income', income);
      responses.push(`月収を更新 ✅  ¥${income.toLocaleString()}`);
      hasBudgetCmd = true;
      continue;
    }

    // 貯金目標: 「貯金目標 60000」
    const savingsMatch = line.match(/^貯金目標\s*([\d,]+)/);
    if (savingsMatch) {
      const goal = parseInt(savingsMatch[1].replace(/,/g, ''), 10);
      setSetting('savings_goal', goal);
      responses.push(`貯金目標を更新 ✅  ¥${goal.toLocaleString()}`);
      hasBudgetCmd = true;
      continue;
    }

    // 収入調整: 「調整 +12000」「調整 -5000」
    const adjustMatch = line.match(/^調整\s*([+\-]?[\d,]+)/);
    if (adjustMatch) {
      const diff = parseInt(adjustMatch[1].replace(/,/g, ''), 10);
      setSetting('income_adjustment', diff);
      responses.push(`収入調整を更新 ✅  ${diff >= 0 ? '+' : ''}¥${diff.toLocaleString()}`);
      hasBudgetCmd = true;
      continue;
    }

    // 固定費更新: 「固定費 128779」
    const fixedMatch = line.match(/^固定費\s*([\d,]+)/);
    if (fixedMatch) {
      const fixed = parseInt(fixedMatch[1].replace(/,/g, ''), 10);
      setSetting('fixed_costs', fixed);
      responses.push(`固定費を更新 ✅  ¥${fixed.toLocaleString()}`);
      hasBudgetCmd = true;
      continue;
    }

    // 予算提案: 「予算提案」「予算確認」「予算」
    if (/^予算(提案|確認)?$/.test(line)) {
      generateBudget = true;
      hasBudgetCmd   = true;
    }
  }

  if (!hasBudgetCmd) return false;

  // 設定更新があれば使える予算を末尾に表示
  if (responses.length > 0) {
    const base = Number(getSetting('base_income'))       || 0;
    const goal = Number(getSetting('savings_goal'))      || 0;
    const adj  = Number(getSetting('income_adjustment')) || 0;
    if (base > 0) responses.push(`─────────────\n使える予算: ¥${(base + adj - goal).toLocaleString()}`);
  }

  // 予算生成が含まれる場合は「生成中」を末尾に追加（replyは1回のみ）
  if (generateBudget) responses.push('予算案を生成中です...');

  if (responses.length > 0) replyText(replyToken, responses.join('\n'));

  // 予算生成は reply 後に実行（結果は pushMessage で届く）
  if (generateBudget) generateBudgetPlan(null);

  return true;
}

/**
 * rich_menu.gs
 * LINEリッチメニューの作成・設定
 *
 * 使い方:
 *   1. createRichMenu() を手動実行
 *   2. 再作成する場合は deleteRichMenus() を先に実行してから createRichMenu()
 */

const RICH_MENU_IMAGE_FILE_ID = '1nxIEm-1FeSNXLqqfVZejZHE4l-CzyhZs';
const LIFF_URL = 'https://liff.line.me/2009696996-oWmXdu5w';
const HELP_URL = 'https://script.google.com/macros/s/AKfycbzXBFNNd3xerdN194nRQNPzpV6JwWprEsD6LYcyGFbJAjpsPCaYTQqplgEovD4KddkvrA/exec?page=help';

// ============================================================
// リッチメニュー作成・設定（メイン）
// ============================================================
function createRichMenu() {
  const token = getProperty('LINE_CHANNEL_ACCESS_TOKEN');

  // 1. リッチメニュー構造を作成
  const richMenu = {
    size: { width: 1776, height: 592 },
    selected: true,
    name: '家計管理メニュー',
    chatBarText: 'メニュー',
    areas: [
      {
        // 左: 使い方 → 使い方ページを開く
        bounds: { x: 0, y: 0, width: 888, height: 592 },
        action: { type: 'uri', uri: HELP_URL },
      },
      {
        // 右: ダッシュボード → LIFFを開く
        bounds: { x: 888, y: 0, width: 888, height: 592 },
        action: { type: 'uri', uri: LIFF_URL },
      },
    ],
  };

  const createRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
    method:             'post',
    contentType:        'application/json',
    headers:            { Authorization: `Bearer ${token}` },
    payload:            JSON.stringify(richMenu),
    muteHttpExceptions: true,
  });

  if (createRes.getResponseCode() !== 200) {
    throw new Error('リッチメニュー作成失敗: ' + createRes.getContentText());
  }

  const richMenuId = JSON.parse(createRes.getContentText()).richMenuId;
  Logger.log('作成したリッチメニューID: ' + richMenuId);

  // 2. Google DriveからPNG画像を取得してアップロード
  const imageBlob = DriveApp.getFileById(RICH_MENU_IMAGE_FILE_ID).getBlob();

  const uploadRes = UrlFetchApp.fetch(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    {
      method:             'post',
      contentType:        'image/png',
      headers:            { Authorization: `Bearer ${token}` },
      payload:            imageBlob.getBytes(),
      muteHttpExceptions: true,
    }
  );

  if (uploadRes.getResponseCode() !== 200) {
    throw new Error('画像アップロード失敗: ' + uploadRes.getContentText());
  }
  Logger.log('画像アップロード完了');

  // 3. デフォルトリッチメニューとして設定
  const setRes = UrlFetchApp.fetch(
    `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
    {
      method:             'post',
      headers:            { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true,
    }
  );

  if (setRes.getResponseCode() !== 200) {
    throw new Error('デフォルト設定失敗: ' + setRes.getContentText());
  }

  Logger.log('リッチメニューを設定しました: ' + richMenuId);
}

// ============================================================
// 既存リッチメニューを全削除（再作成時に使用）
// ============================================================
function deleteRichMenus() {
  const token = getProperty('LINE_CHANNEL_ACCESS_TOKEN');

  const listRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/list', {
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  });

  const menus = JSON.parse(listRes.getContentText()).richmenus || [];
  Logger.log(`既存メニュー数: ${menus.length}`);

  for (const menu of menus) {
    UrlFetchApp.fetch(`https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`, {
      method:  'delete',
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true,
    });
    Logger.log('削除: ' + menu.richMenuId);
  }

  Logger.log('全削除完了');
}

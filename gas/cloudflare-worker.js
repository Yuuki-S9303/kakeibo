/**
 * cloudflare-worker.js
 * 家計・資産管理システム v2.0
 *
 * LINE Webhook → Cloudflare Worker → GAS 転送スクリプト
 *
 * 役割:
 *   LINEからのWebhookを受け取り、即座に200を返しつつ
 *   バックグラウンドでGASへPOST転送する。
 *   GASのデプロイURLは302リダイレクトを返すため redirect: 'follow' で追従する。
 *
 * デプロイ手順:
 *   1. Cloudflare Dashboard > Workers & Pages > Create Worker
 *   2. このファイルの内容をエディタに貼り付けてデプロイ
 *   3. Worker の設定 > 変数 に GAS_URL を登録（任意・コード直書きでも可）
 *   4. LINE Developers の Webhook URL に Worker の URL を設定
 */

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbzXBFNNd3xerdN194nRQNPzpV6JwWprEsD6LYcyGFbJAjpsPCaYTQqplgEovD4KddkvrA/exec';

export default {
  async fetch(request, env, ctx) {
    // GET リクエスト（疎通確認用）
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status:  200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST 以外は 405
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status:  405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // リクエストボディと署名を取得（Requestは一度しか読めないため先に取得）
    const body      = await request.text();
    const signature = request.headers.get('X-Line-Signature') || '';

    // GASへの転送を非同期で実行（LINEには即座に200を返す）
    ctx.waitUntil(forwardToGas(body, signature, env));

    return new Response(JSON.stringify({ status: 'ok' }), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

/**
 * GASへPOSTを転送する
 * GASのデプロイURLは302リダイレクトを返すため redirect: 'follow' で自動追従する
 *
 * @param {string} body      LINEから受け取ったリクエストボディ（JSON文字列）
 * @param {string} signature X-Line-Signature ヘッダーの値
 * @param {object} env       Cloudflare Worker の環境変数
 */
async function forwardToGas(body, signature, env) {
  const gasUrl = env.GAS_URL || GAS_URL;

  try {
    const response = await fetch(gasUrl, {
      method:   'POST',
      redirect: 'follow', // GASの302リダイレクトを自動追従
      headers:  {
        'Content-Type':    'application/json',
        'X-Line-Signature': signature,
      },
      body,
    });

    console.log(`GAS転送完了: status=${response.status} url=${response.url}`);
  } catch (err) {
    console.error(`GAS転送エラー: ${err.message}`);
  }
}

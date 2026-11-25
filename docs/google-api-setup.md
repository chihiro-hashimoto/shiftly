# Google API の事前準備

Shiftly 本体（Staff/Admin）は**デフォルトの Cloud プロジェクトのまま**動作します（高度なサービスにより Sheets/Drive API が有効化される想定。【未検証】）。
**Shiftly Setup だけ**が Apps Script API を呼ぶため、次の準備が必要です（無料）。

> 料金: Google Cloud プロジェクトの作成と Apps Script API の有効化に費用はかかりません。課金アカウント（クレジットカード）の登録は不要です。もし画面で課金の設定を求められた場合は**作業を中止し**、無断で課金を有効にしないでください。

## 1. 利用者（管理者）側: Apps Script API をオン（必須・1 回）

1. 管理者の Google アカウントで https://script.google.com/home/usersettings を開く
2. 「Google Apps Script API」をオンにする

これを行わないと Setup は「Apps Script API が無効です」と表示して停止します（自動検出）。

## 2. Setup の Cloud プロジェクト（標準プロジェクト）の準備

Apps Script のデフォルトプロジェクトでは API を手動で有効化できないため、Setup には標準 Cloud プロジェクトを紐づけます。

1. https://console.cloud.google.com/ で新しいプロジェクトを作成（例: `shiftly-setup`）
2. 「API とサービス」→「ライブラリ」で **Google Apps Script API** と **Google Drive API** を有効化
3. 「OAuth 同意画面」を設定
   - ユーザーの種類: 外部（個人の Google アカウントの場合）
   - アプリ名: Shiftly Setup、サポートメール: 管理者（または配布者）のアドレス
   - スコープ: 手動追加は不要（Setup の appsscript.json の oauthScopes が使われます）
   - 公開ステータス: **テスト**の場合は管理者の Google アカウントを「テストユーザー」に追加（テストユーザーは最大 100 人、認可は 7 日で失効しますが Setup は都度承認で問題ありません）
4. プロジェクト番号を控える
5. Setup の Apps Script プロジェクトで「プロジェクトの設定」→「Google Cloud Platform（GCP）プロジェクト」→「プロジェクトを変更」→ プロジェクト番号を入力

## 3. Setup が要求するスコープ（最小限）

| スコープ | 用途 |
|---|---|
| `script.projects` | Shiftly-Staff / Shiftly-Admin の作成・コード配置・バージョン作成 |
| `script.deployments` | Web アプリのデプロイ作成・更新（URL 維持）・ロールバック |
| `script.external_request` | Apps Script API・Core への HTTPS 呼び出し |
| `drive.file` | Setup のレジストリファイル（進捗・リソース ID）の保存（Setup が作成したファイルのみ） |
| `userinfo.email` | 管理者アカウントの確認（取り違え防止） |

## 4. Shiftly 本体のスコープ

| プロジェクト | スコープ | 用途 |
|---|---|---|
| Staff（Core） | `drive.file` | Shiftly フォルダ・DB・明細・出力・バックアップ（Shiftly が作成したもののみ） |
| | `script.external_request` | 保存済みファイル本体の取得（Drive REST） |
| | `script.scriptapp` | 日次トリガーの登録 |
| | `userinfo.email` | 所有者アカウントの記録 |
| Admin | `script.external_request` | Core への署名付きリクエスト |
| | `userinfo.email` | 管理者アカウントの表示 |

フル `drive`、`spreadsheets`、Gmail 等のスコープは要求しません。Google パスワードを Shiftly が受け取ることはありません。

## 5. 再認証

- Google の権限承認画面は、スコープ変更を伴う更新時や承認の失効時に再表示されます。内容を確認して承認してください
- アクセストークンは GAS が実行時に取得するもので、Shiftly は保存しません

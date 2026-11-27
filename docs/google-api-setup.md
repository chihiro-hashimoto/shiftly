# Google API の事前準備

> **2026-11-27（A案。docs/decisions.md D-029）**: 導入は、開発者が公開する**共通の Shiftly Setup**（ホスト型）を標準にした。利用者（店舗の Google 所有者）の準備は「1」だけ。Google Cloud の作業は開発者が「2」で 1 回だけ行う。
> 自分で Setup を配置する方法（自己ホスト型。開発者・検証用）は「4」。

Shiftly 本体（Staff/Admin）は**利用者の既定の Cloud プロジェクトのまま**動作します（高度なサービスにより Sheets/Drive API が有効化される想定。【未検証】）。

> 料金: Google Cloud プロジェクトの作成と Apps Script API の有効化に費用はかかりません。課金アカウント（クレジットカード）の登録は不要です。もし画面で課金の設定を求められた場合は**作業を中止し**、無断で課金を有効にしないでください。

## 1. 利用者（店舗の Google 所有者）: Apps Script API をオン（必須・1 回）

共通 Setup の画面に「Google Apps Script API がオフになっています」と表示された場合だけ行います（Setup が自動で判定します）。

1. Setup の画面の「Google の設定画面を開く」を押す（https://script.google.com/home/usersettings が開く）
2. 「Google Apps Script API」のスイッチをオンにする
3. Setup の画面に戻り「設定が完了したので再確認」を押す（反映まで数分かかることがあります）

これは Google の仕様で、利用者のアカウントで Shiftly のプロジェクトを作るために必要です。Shiftly がこの設定を代わりに変更することはありません。

## 2. 開発者: 共通 Setup の Cloud プロジェクト（標準プロジェクト）の準備（1 回だけ）

Apps Script の既定のプロジェクトでは API を手動で有効化できないため、共通 Setup には開発者の標準 Cloud プロジェクトを紐づけます。利用者はこの作業をしません。

1. 開発者の Google アカウントで https://console.cloud.google.com/ を開き、新しいプロジェクトを作成（例: `shiftly-setup`）
2. 「API とサービス」→「ライブラリ」で **Google Apps Script API** と **Google Drive API** を有効化
3. 「OAuth 同意画面」（表示によっては「Google Auth Platform」）を設定
   - ユーザーの種類: 外部
   - アプリ名: Shiftly Setup、サポートメール・デベロッパーの連絡先: 開発者のアドレス
   - スコープ: 「3」の 5 つ（Setup の appsscript.json の oauthScopes。Cloud Console でセンシティブかどうかの表示を確認し、記録する）
   - **公開ステータス: テスト**（限定公開）。利用者・検証用アカウントを「テストユーザー」に追加（最大 100 人。テストの承認は 7 日で失効し、失効後は Setup を開くと再承認を求められる。作成済みの Staff・Admin は利用者の既定のプロジェクトのため影響しない【要確認 L49】）
   - 一般公開（「本番環境」への切替）は、**OAuth の審査（アプリの確認）を受けて完了した後**に行う（「5」）
4. プロジェクト番号を控える
5. 共通 Setup の Apps Script プロジェクトで「プロジェクトの設定」→「Google Cloud Platform（GCP）プロジェクト」→「プロジェクトを変更」→ プロジェクト番号を入力（配置の手順は docs/deployment-guide.md「6」）

## 3. Setup が要求するスコープ（最小限）

| スコープ | 用途 |
|---|---|
| `script.projects` | Shiftly-Staff / Shiftly-Admin の作成・コード配置・バージョン作成 |
| `script.deployments` | Web アプリのデプロイの作成・照会（初回の構築とテスト用 URL の取得。v1.3 では更新・ロールバックに使わない。D-027） |
| `script.external_request` | Apps Script API・Core への HTTPS 呼び出し |
| `drive.file` | Setup のレジストリファイル（進捗・リソース ID）の保存（Setup が作成したファイルのみ） |
| `userinfo.email` | 利用者のアカウントの確認（取り違え防止） |

## 4. 自己ホスト型（開発者・検証用の別の方法）

利用者が自分の標準 Cloud プロジェクトで「2」を行い、自分のアカウントに Setup を配置する従来の方法です（docs/installer-guide.md「0.5」）。一般の利用者には案内しません。

## 5. OAuth の審査（一般公開の前に必要。開発者）

- 共通 Setup は、開発者の OAuth クライアントで利用者の Google アカウントのデータ（Apps Script のプロジェクト）を操作するため、センシティブなスコープを含むと判断している（`script.projects` 等。分類は Cloud Console の表示で確認する。**要確認**）
- 審査が完了していない間は、利用者に「このアプリは Google で確認されていません」と表示される。限定公開（テストユーザー）の間は、提供者が開発者本人であることを利用者が確認できる場合に限り「詳細」→「移動」を案内する。**警告を無条件に無視させない**
- 一般公開に必要なもの（開発者が準備。Google の現行の要件を Cloud Console で確認する）: アプリのホームページ・プライバシーポリシーの URL（承認済みドメイン）、スコープの利用目的の説明、操作の動画、サポートの連絡先。Google Workspace の同じ組織の内部だけで使う場合（「内部」）は審査の対象外とされている（Shiftly の想定する個人の Google アカウントには当てはまらない）
- 審査の結果・期間は Google の判断による（未確定）

## 6. Shiftly 本体のスコープ

| プロジェクト | スコープ | 用途 |
|---|---|---|
| Staff（Core） | `drive.file` | Shiftly フォルダ・DB・明細・出力・バックアップ（Shiftly が作成したもののみ） |
| | `script.external_request` | 保存済みファイル本体の取得（Drive REST） |
| | `script.scriptapp` | 日次トリガーの登録 |
| | `userinfo.email` | 所有者アカウントの記録 |
| Admin | `script.external_request` | Core への署名付きリクエスト |
| | `userinfo.email` | 管理者アカウントの表示 |

フル `drive`、`spreadsheets`、Gmail 等のスコープは要求しません。Google パスワードを Shiftly が受け取ることはありません。Staff・Admin の承認は、利用者が自分のプロジェクトとして Google の画面で行います（テスト用 URL または スクリプトエディタ）。

## 7. 再認証

- Google の権限承認画面は、スコープ変更を伴う更新時や承認の失効時に再表示されます。内容を確認して承認してください
- 共通 Setup へのアクセスを取り消す場合: https://myaccount.google.com/permissions で「Shiftly Setup」のアクセスを削除（作成済みの Staff・Admin・DB は残る）
- アクセストークンは GAS が実行時に取得するもので、Shiftly は保存しません

## 出典（公式資料）

- Apps Script API の有効化: https://developers.google.com/apps-script/api/how-tos/enable
- Apps Script API で関数を実行（scripts.run の条件: API 実行可能としてのデプロイ・同じ標準 Cloud プロジェクトの共有・トリガーを作れない）: https://developers.google.com/apps-script/api/how-tos/execute
- Web アプリ（実行するユーザー・テスト用デプロイ /dev は編集者だけ）: https://developers.google.com/apps-script/guides/web
- 承認: https://developers.google.com/apps-script/guides/services/authorization
- Cloud プロジェクト: https://developers.google.com/apps-script/guides/cloud-platform-projects
- OAuth クライアントの確認: https://developers.google.com/apps-script/guides/client-verification
- 未確認アプリ・ユーザー数の上限: https://support.google.com/cloud/answer/7454865 ／ 対象ユーザーとテスト: https://support.google.com/cloud/answer/15549945

> 2026-11-27 時点、この作業環境から developers.google.com に接続できなかったため、上記は検索結果の要約での確認にとどまる。開発者は公開の前に原文と Cloud Console の表示を確認すること（**要確認**）。

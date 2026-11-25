# アーキテクチャ

## 1. 全体構成

| 構成要素 | 種類 | 実行/アクセス | 役割 |
|---|---|---|---|
| **Shiftly-Staff**（Core。v1.2 までの名称は Shiftly-Kiosk） | GAS Web アプリ | 実行=デプロイユーザー（Google 所有者）／アクセス=全員（匿名） | 店舗 iPad の画面（スタッフ画面・管理者モード）＋**業務データへの唯一の更新経路**（Core API）。日次トリガー（バックアップ・通知検出） |
| **Shiftly-Admin** | GAS Web アプリ | 実行=Google 所有者／アクセス=自分のみ | Google 所有者の管理画面（PC・スマホ。任意）。業務データに直接触れず、Core へ HMAC 署名付きで転送。構築・更新・復旧・管理者パスワードの設定はこちら |
| **Shiftly Setup** | GAS Web アプリ | 自己ホスト: 実行=管理者・自分のみ／ホスト型: 実行=アクセスしたユーザー | Apps Script API で Staff/Admin を作成・配置・デプロイ・更新・ロールバック |
| 業務 DB | Google スプレッドシート（1ファイル） | Core のみ（drive.file） | `Shiftly/01_Database` |
| ファイル | Google Drive | Core のみ（drive.file） | `Shiftly/00_System〜05_Backup` |

> 指示書の「共通バックエンド用 GAS を追加してよい」に対し、**Core を Staff と同一プロジェクトに置く**判断をした（docs/decisions.md D-003）。打刻（最も遅延に敏感な操作）でサーバー間通信を挟まないこと、権限承認の手動工程を 2 回に抑えることが理由。業務データへの更新経路は Core に一本化されている。

```
店舗 iPad ─ google.script.run(staffApi) ─▶ Core ─ Sheets API v4 / Drive API v3 (高度なサービス, drive.file) ─▶ Shiftly/
                                            ▲ doPost {kind:'owner', envelope(role=admin|setup, HMAC)}
管理者 PC ─ google.script.run(adminApi) ─▶ Admin ─ UrlFetch ─┘
Setup ─ UrlFetch(Apps Script API, 管理者の OAuth トークン) ─▶ Staff/Admin プロジェクト
     └ UrlFetch doPost {kind:'ping'|'pair'|'owner(role=setup)'} ─▶ Core
```

## 2. ソースコード構成

```
src/
  shared/     ドメイン（純粋関数）: time, attendance, labor, wage, payroll, money, leave, period,
              analytics, notifications, permissions, crypto, sha256, csv, xlsx, payslip, types
  backend/    Core API: api.ts（ルーター）, auth.ts, context.ts, store.ts（UnitOfWork/ジャーナル）,
              schema.ts, services.ts, handlers/*, migrations.ts, mock.ts（メモリ環境）
    gas/      GAS 実装: platform.ts（Utilities/Lock/Properties/Cache/Drive）, sheets-adapter.ts
  setup/      apps-script-api.ts（REST クライアント）, installer.ts（状態機械・更新・ロールバック）
  gas/        GAS エントリ: core.ts, admin.ts, setup.ts（ビルド時にトップレベル関数を生成）
  frontend/   React: staff/（店舗 iPad・管理者モード）, admin/（pages/）, setup/, components/, styles/, preview/（モック）, entries/
gas/manifests/  appsscript.json（core / admin / setup 自己ホスト / setup ホスト型）
scripts/        build-frontend.mjs, build-gas.mjs, gen-docs.mjs, serve-preview.mjs
tests/          unit / integration / security / e2e / helpers（harness, gas-emulator）
```

## 3. リクエスト処理（Core）

1. `staffApi(json)`（店舗 iPad。互換名 `kioskApi`）または `doPost` の owner 封筒（管理者・Setup）を受け取る
2. `handleRequest`:
   - 登録済み op のみ（未知の op は拒否。汎用のファイル/シート操作 API はない）
   - 認証: public / device（端末トークン）/ session（端末＋スタッフのセッション。PIN 未設定は本人未確認）/ owner（署名検証済みのみ。`adminAllowed` の操作は管理者モードも可）/ staff_or_owner（管理者・委任スタッフ）/ admin（管理者モードのみ）
   - v1.3 管理者モード: 要求の `adminSession`（管理者トークン）をサーバーで毎回検証し principal=admin とする。重要操作は再認証（5 分）。Google 所有者限定の操作は不可
   - 認可: op ごとの権限（DB から毎回読み込み）、機密操作はステップアップ必須
   - メンテナンス中はスタッフの操作を拒否
   - 更新系は `LockService.getScriptLock()` 内で実行し、開始時に未完了ジャーナルを再適用
   - `requestId` による冪等性（同一 principal・同一 op の再送は保存済み応答を返す）
3. UnitOfWork が読み取りをキャッシュし、書き込みを `flush()` でまとめて Sheets に反映（ジャーナル: started → 書込 → committed）

## 4. データの原本と派生

- 打刻原本（attendance_events）は追記のみ。修正は attendance_corrections に差分として保存し（v1.3: 本人修正・本人確認の有無・管理者の確認状態を含む）、勤務（WorkSession）は毎回「原本＋反映済みの修正＋手動休憩＋休憩申告（予定休憩は取得を確認したもののみ）」から再構築
- v1.3 給与計算に渡す勤務: 店舗設定の時間基準が shift の場合、勤務を「シフト内の実労働＋実労働と確認したシフト外」に変換した派生データ（`applyTimeBasis`）。打刻原本・修正後の勤怠は変更しない（docs/payroll-specification.md §2.5）
- v1.3 申請: 早出・残業申請（overtime_requests ＋履歴 overtime_request_history）、休憩申告（break_declarations）
- 給与は確定時に入力一式と計算根拠をスナップショット保存（payroll_results.snapshot）。以後の設定変更の影響を受けない。訂正は新リビジョン

## 5. フロントエンド

- React + TypeScript + Vite。GAS 用は JS/CSS をインライン化した単一 HTML（HtmlService の iframe で表示）
- 業務データは React の state（メモリ）のみ。localStorage は端末トークン（`shiftly.device.v1`）のみ
- Staff（src/frontend/staff）: 無操作タイムアウト（既定60秒）、タブ非表示・bfcache 復元・pagehide でセッション終了、打刻後自動ログアウト。PIN は氏名選択時に PIN なしでログインを試し、必要な場合のみ入力
- 管理者モード（v1.3）: Staff 画面右上「管理者ページ」→ 管理者パスワード → `AdminApp`（embedded）を表示。管理者トークンはメモリ上のみ。無操作 5 分・タブ非表示・再読み込み・ログアウトで終了し、サーバー側でも失効。URL の履歴を操作しない（戻る操作で管理画面に戻らない）。Google 所有者限定のページ（システム・更新）は表示しない
- Admin のページは店舗 iPad の「管理メニュー」でも、委任された権限の範囲で表示（サーバー側で同じ権限を検証）
- プレビュー: ブラウザ内で Core をメモリ上に起動（`src/frontend/preview`）。Google には接続しない

## 6. 時刻・暦

- 内部は UTC epoch ms、表示・計算は Asia/Tokyo（UTC+9 固定の演算。Intl に依存しない）
- GAS プロジェクト（appsscript.json）・スプレッドシート（作成時に設定）とも Asia/Tokyo。保存値は `+09:00` 付き ISO 文字列で、タイムゾーン設定の不一致の影響を受けない
- 「打刻日時 / 営業日 / 労働日 / 法定休日 / 週 / 給与期間」を区別（docs/payroll-specification.md §2）

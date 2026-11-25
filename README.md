# Shiftly（シフトリー）

店舗勤怠・給与・シフト・人件費管理 Web アプリ。Google Apps Script（GAS）をバックエンド、Google スプレッドシートを DB、Google ドライブをファイル保管に使い、**管理者本人の Google アカウント内で、月額無料**で動作することを目標としています。

> 状態: 開発中（Google 実環境・iPad 実機は未検証）。v1.3（1 台の iPad での管理者モード、PIN 任意化、本人の勤怠修正、予定休憩の取得確認、シフト基準の給与計算、早出・残業申請）を実装済み（モック・エミュレーションで検証）。本番利用・実在スタッフの登録・正式な給与支払いへの利用は、検証と並行運用の後に管理者の判断で行ってください。詳細は `docs/implementation-status.md`。

## 構成

| 構成 | 役割 |
|---|---|
| Shiftly-Staff（Core。v1.2 までの名称は Shiftly-Kiosk） | 店舗 iPad 用画面（スタッフ画面＋右上「管理者ページ」から管理者パスワードで入る管理者モード）＋業務データの唯一の更新経路（GAS Web アプリ、匿名アクセス・Google 所有者として実行） |
| Shiftly-Admin | Google 所有者の管理画面（PC・スマホ。任意。GAS Web アプリ、本人のみ）。構築・更新・復旧・管理者パスワードの設定 |
| Shiftly Setup | 上記 2 つを管理者のアカウントに自動作成・配置・デプロイ・更新するインストーラー |

詳細: `docs/architecture.md`

## はじめに（開発者）

```bash
npm ci
```
```bash
npm run dev
```
→ ブラウザで http://localhost:5173/preview.html（架空のサンプルデータで店舗 iPad（スタッフ・管理者モード）／ Google 所有者の管理画面／セットアップのデモを確認。Google には接続しません。サンプルの PIN・管理者パスワードは画面上部に表示）

## 検証コマンド

| コマンド | 内容 |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 型検査 |
| `npm run test` | 単体テスト（給与ゴールデンテスト含む） |
| `npm run test:integration` | 統合テスト（Core API・Setup・GAS エミュレーション。後者は `build:gas` 後に実行） |
| `npm run test:security` | セキュリティテスト |
| `npm run build` | GAS 用の単一 HTML（dist/gas-html） |
| `npm run build:gas` | GAS 配布物（dist/gas） |
| `npm run build:preview` / `npm run preview` | モックのプレビュー（dist/preview、http://127.0.0.1:4173） |
| `npm run test:e2e` | Playwright E2E（プレビュー対象） |
| `npm run verify` | 上記を順に一括実行 |
| `npm run docs` | DB スキーマ・権限マトリクスの文書をコードから再生成 |

## 文書

| 文書 | 内容 |
|---|---|
| docs/HANDOFF.md | 引き継ぎ（現在の状態・次の作業） |
| docs/requirements.md | 要件の要点 |
| docs/implementation-status.md | 機能 F01〜F41（F38〜F41 は v1.3 で追加）の実装・検証状況 |
| docs/architecture.md / decisions.md | 構成と設計判断 |
| docs/database-schema.md / permission-matrix.md | DB・権限（自動生成） |
| docs/payroll-specification.md | 給与計算仕様 |
| docs/security.md | セキュリティ設計と残存リスク |
| docs/technical-verification.md / research/official-sources.md | 成立性検証と公式資料 |
| docs/google-api-setup.md / installer-guide.md / deployment-guide.md | 準備・導入・デプロイ |
| docs/update-rollback.md / operations-guide.md | 更新・復旧・日常運用 |
| docs/test-plan.md | テスト計画・結果 |

## ライセンス

非公開（UNLICENSED）。依存ライブラリは package.json を参照（qrcode-generator: MIT、React: MIT）。

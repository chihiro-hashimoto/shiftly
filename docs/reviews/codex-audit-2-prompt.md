# Codex 独立監査 2 回目（累計）: プロンプト

> v1.3 実装後の監査。累計 2 回目（上限 5 回）。実行: `codex exec --sandbox read-only`。対象コミットは docs/review-log.md の C-2 に記録する。

```
あなたは独立した監査担当です。リポジトリ（作業ディレクトリ）を読み取り専用で監査してください。ファイルの作成・変更・削除、git の変更操作（commit / push / checkout / reset 等）、外部への送信は行わないでください。読み取り・検索・テストの実行（`npx vitest run ...` 等。ファイルを書き出さないもの）は可です。

## 監査対象
- v1.3 の変更差分: `git diff b093a808f2270a947dfa4f78597fe9a690a7e799..HEAD`（v1.2 の最終コミット b093a80 から v1.3 の HEAD まで）
- 初期開発を含めた最終統合状態: `git diff origin/main...HEAD`（main は初期コミットのまま）と未コミット差分（`git status` / `git diff`）
- 両方を確認し、v1.3 の変更が既存機能を壊していないかも見てください

## 元の指示（Shiftly 追加仕様変更指示 v1.3）の目的・完了条件・変更範囲（引用・要約）
目的:
- 1 台の店舗共用 iPad でスタッフと管理者の操作を完結する
- スタッフの日常的な操作を最小限にする
- シフトを基準とした通常勤務の給与計算を実現する
- 例外的な勤務・休憩・打刻修正のみ、申告・確認によって処理する
- 管理者のスタッフ管理操作を簡潔にする

変更範囲: Staff・管理者の画面導線／管理者パスワード認証／スタッフ PIN 任意化／スタッフ本人の勤怠修正／時給ルールの導線／休憩管理の標準動作／シフト基準の給与計算／早出・残業申請／関連する DB・API・テスト・ドキュメント
変更しない範囲: 完全無料運用、GAS・Sheets・Drive 構成、初回自動インストーラー方式、Google アカウントによる所有者管理、単一 DB 更新経路、既存の給与確定・訂正履歴、税・社会保険料の手動入力、既存の帳票・分析・有給機能、バックアップ・更新・ロールバック、Private 設定

主な要件（引用）:
- 「管理者用パスワードとスタッフ用 PIN は完全に分離する」「共通の初期パスワード、ハードコードされたパスワード、未設定時の認証省略は禁止」「Staff 側の一般セッションから管理者権限を取得できないこと」「管理者画面への遷移可否をフロントエンドだけで判定しないこと」「管理者セッションを利用して任意の Google Drive ファイルを操作できる汎用 API を提供しないこと」「Google 側の本人承認が必要な操作を、管理者パスワードだけで迂回してはならない」「無操作 5 分で管理者セッションを終了」「給与確定、権限変更、バックアップ復元等の重要操作では再認証」
- 「PIN 未設定を許可」「4 桁以上・先頭 0・平文保存禁止」「PIN 未設定と、誤った PIN・空欄入力・認証エラーを混同しない」「PIN 設定済みのスタッフが空欄入力等によって認証を回避できない」「給与・給与明細・個人の機密情報については、氏名選択だけで取得できるようにしない」
- 「元の打刻原本を上書き・削除してはならない」「スタッフは他人の打刻を自己修正機能から変更できない」「給与確定済みの期間については、既存の正式給与記録を直接変更しない」
- 「予定休憩の適用だけを根拠に、実際の取得確認済みとみなさない」「予定休憩と手動打刻を二重控除してはならない」「シフトに休憩設定がない場合、法定休憩時間を根拠なく自動控除してはならない」「休憩不足は警告するが、取得していない休憩を給与計算から差し引いてはならない」
- 「通常勤務の給与計算では、公開済みの登録シフトを基準とする」「打刻原本をシフト時間に書き換えてはならない」「シフト未登録の勤務について、給与対象を自動的に 0 分としてはならない」「申請がないこと、承認されていないことだけを理由に、実際に行った業務を無給扱いしてはならない」「未確認事項を解消せず、機械的にシフト時間だけで正式給与を確定しない」「同一の勤務・時間区間を重複して加算しない」「承認状態と、実労働時間として確認されたかどうかは区別する」
- 例（§9.2）: シフト 18:00〜23:00、打刻 17:55〜23:10、休憩なし → 仮 5:00、実労働なし確認 5:00、早出のみ 5:05、残業のみ 5:10、両方 5:15
- 「共有 iPad 上への給与明細・CSV・Excel 等の機密ファイルの永続保存禁止を維持」

完了条件（抜粋）: 1 台の iPad で完結／管理者ページへパスワード認証で遷移／Staff・管理者の表記へ統一／PIN の未設定と 4 桁以上に対応／本人の打刻修正／原本と全修正履歴を保持／スタッフ・権限画面から時給ルールを設定／通常勤務で休憩ボタン操作不要／休憩の差異を申告可能／シフト基準の給与計算／早出・残業申請と管理者確認／実労働の賃金未払いを発生させない設計／既存機能に重大な回帰がない

## 設計資料
docs/requirements.md（v1.3 の変更）, docs/decisions.md（D-014〜D-020）, docs/security.md, docs/payroll-specification.md（§2.5・§2.6）, docs/permission-matrix.md（自動生成。管理者モード・再認証・PIN なしの列）, docs/database-schema.md, docs/architecture.md, docs/implementation-status.md（F38〜F41）, docs/review-log.md（C-1 の指摘と対応）

## 重点ファイル
- 認証・認可: src/backend/api.ts, src/backend/auth.ts, src/backend/context.ts, src/backend/handlers/admin-auth.ts, src/backend/handlers/system.ts, src/backend/handlers/staff.ts
- 勤怠・申請: src/backend/handlers/requests.ts, src/backend/handlers/attendance.ts, src/shared/attendance.ts, src/shared/worktime.ts, src/backend/services.ts
- 給与: src/shared/payroll.ts, src/backend/handlers/payroll.ts
- 復元・移行: src/backend/handlers/ops.ts（backup.restore）, src/backend/migrations.ts, src/backend/schema.ts
- 画面: src/frontend/staff/StaffApp.tsx, src/frontend/admin/AdminApp.tsx, src/frontend/admin/pages/Requests.tsx, Staff.tsx, PayConditions.tsx, System.tsx, src/frontend/api/transport.ts
- GAS・インストーラー: src/gas/core.ts, scripts/build-gas.mjs, src/setup/installer.ts
- テスト: tests/integration/v13.test.ts, tests/security/v13-security.test.ts, tests/unit/worktime.test.ts, tests/e2e/staff.spec.ts, tests/helpers/harness.ts

## 重点監査の観点
1. Staff からの管理者権限昇格
2. 管理者パスワード・セッションの安全性（ハッシュ・試行制限・失効・トークン・再認証）
3. PIN 任意化によるなりすまし
4. PIN 未設定時の給与・個人情報漏えい
5. 本人以外の勤怠修正
6. 打刻原本と修正履歴の保持
7. 管理者ログアウト後の情報残留（戻る・再読み込み・タブ・bfcache・複数タブ・API 直接呼び出し）
8. 休憩の不正控除
9. シフト外実労働の賃金未払い
10. 早出・残業の重複計上
11. 法定割増計算（深夜・時間外・法定休日・月 60 時間超・日付またぎ）
12. 給与確定後の訂正
13. 旧名称変更（Kiosk→Staff、店長→管理者）による互換性破壊（既存環境・更新・ロールバック・セットアップ再開）
14. 既存機能の回帰（F01〜F37）
15. 自動インストーラー・更新・復旧の回帰
16. Google Drive のアクセス範囲（汎用ファイル操作 API の有無、drive.file）
17. DB の整合性（スキーマ v2 移行、復元時の引き継ぎ、申請・修正・休憩申告の状態遷移）
18. テスト期待値の独立性・妥当性（v1.2 のテストの前提条件の変更が妥当か: tests/helpers/harness.ts の setupStore の timeBasis 既定値など）

## 報告形式
- 重要な指摘だけを、重要度（重大 / 高 / 中）の高い順に最大 20 件
- 各指摘に、根拠（ファイル:行）・再現条件（具体的な入力・手順。給与は入力・期待値・実際の値）・影響範囲・推奨修正を必ず書く
- 推測やコード読解のみの判断は、その旨を明記
- スタイル・好み・軽微な改善は書かない
- 指摘がない観点は最後に「問題なし」として観点番号だけを列挙
- 重要な指摘がまったくない場合は「重要な指摘なし」と簡潔に報告
- これは Codex CLI による独立監査であり、GitHub の自動レビューとは別です
```

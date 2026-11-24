# Codex 独立監査: 実行手順とプロンプト

> 統合マスタープロンプト v1.2「実装後の Codex 監査（必須）」に従う。監査回数は開発全体で累計管理し、上限は 5 回（6 回目以降はユーザー承認が必要）。実施したら `docs/HANDOFF.md` の「累計 Codex 監査回数」と `docs/review-log.md` を更新する。

## 1. 事前確認（ユーザー本人が実行）

```bash
codex --version
```
```bash
codex login status
```
未ログインなら次を実行し、表示された URL とワンタイムコードでユーザー本人が認証する（認証情報ファイルを読み出したり共有したりしない）。
```bash
codex login --device-auth
```

## 2. 監査対象の準備

```bash
git clone https://github.com/chihiro-hashimoto/shiftly.git && cd shiftly
```
```bash
git checkout claude/inspiring-einstein-73ks5s && git fetch origin main
```
```bash
npm ci
```
（`npm ci` は Codex がテストを読む・実行する場合に備えたもの。Codex 自体にファイルは変更させない）

## 3. 実行（読み取り専用）

下記「4. 監査プロンプト」を `codex-audit-prompt.txt` として保存し、次を実行する。
```bash
codex exec --sandbox read-only "$(cat codex-audit-prompt.txt)" | tee codex-audit-result-1.md
```

結果（`codex-audit-result-1.md`）を Claude Code のセッションに渡すと、指摘の妥当性を確認して修正・再検証し、採用しなかった指摘はその理由を記録します。

---

## 4. 監査プロンプト（ここから下をそのまま渡す）

```text
あなたは独立した監査担当です。ソースコードやファイルを一切変更せず（読み取り専用）、重要な指摘だけを日本語で報告してください。

## 監査対象
- リポジトリ: chihiro-hashimoto/shiftly（Private）
- ブランチ: claude/inspiring-einstein-73ks5s（PR #1、main へ未マージ）
- 比較対象: origin/main（Initial commit のみ。README 1 ファイル）
- 監査範囲: `git diff origin/main...HEAD` の全差分（約 140 ファイル・約 3 万行）と、作業ツリーの未コミット差分（`git status` / `git diff`。通常はなし）
  - 差分が大きいため、まず `git diff --stat origin/main...HEAD` で全体を把握し、下記「重点ファイル」を優先して読んでください。
  - dist/、node_modules/、package-lock.json は対象外。docs/database-schema.md と docs/permission-matrix.md はコードから自動生成された文書です。

## 製品と元の指示（要点の引用）
Shiftly は、ダーツバー・飲食店 1 店舗（スタッフ 10 名以下）向けの勤怠・給与・シフト・人件費管理 Web アプリです。
- 「月額サービス利用料は完全無料。Google Apps Script をバックエンド、Google Sheets を業務データベース、Google Drive をファイルストレージとして使用」
- 「データは店長本人の Google アカウント内で管理。初回起動時に Google アカウント連携を行い、必要な GAS・DB・フォルダ・設定を可能な限り自動構築」
- 「業務データを端末へ永続保存しない（端末認証情報のみ可）」「店長の個人 Google Drive にある無関係なファイルを保護」「スタッフへの Google Drive 直接共有を禁止」「認証・権限をサーバー側で検証」
- 「スタッフは店舗共用 iPad のみ。氏名選択＋個別 PIN。打刻完了後は個人セッションを終了」「店長は全権限、スタッフ単位で権限を設定可能」
- 「全員の給与閲覧、給与確定等の機密操作には、通常の打刻 PIN とは別の強い追加認証」「委任権限を利用して店長権限の取得、他人の PIN 変更によるなりすまし、自己権限の昇格ができないこと」「給与閲覧権限がない場合、人件費分析や出力結果から個人給与を推定・取得できる経路も検証」
- 「必要な給与規定・条件が確認されるまで正式な給与確定を禁止」「未確認の制度を通常労働時間制へ暗黙にフォールバックさせない」「スタッフ 10 名以下という条件だけで週 44 時間特例を自動適用しない」「36 協定の未設定を理由に実労働時間・割増賃金を削減しない」「シフト上の遅刻・早退を自動的に給与控除へ反映しない」
- 「打刻原本は通常の業務操作で上書き・削除できない」「サーバー時刻を正式な打刻時刻」「二重打刻防止・保存結果不明時はサーバー記録を確認」「日付をまたぐ勤務・再出勤・複数休憩」「固定休憩と打刻休憩を二重控除しない」「取得していない休憩を自動追加しない」
- 「別 GAS プロジェクトの LockService が相互排他を保証するとは仮定しない」「公開された GAS エンドポイントは URL を知っているだけで利用可能と想定」「任意の Drive ファイル ID やシート名を指定して取得・変更できる汎用 API を提供しない」
- 「更新後に実施した新規打刻を、旧バックアップへの復元によって失わない」「破壊的なマイグレーションはユーザー承認なしに実行しない」「長期有効の GitHub トークンを公開コードへ埋め込まない」

## 完了条件（抜粋）
F01〜F37 の実装状況が追跡できること／初回セットアップが設計どおり機能／店長・スタッフ認証の分離／個別権限／iPad での打刻／日付またぎ・再出勤・複数休憩／勤怠修正履歴／シフト・有給／確認済み給与条件に基づく正確な給与計算／未確認条件での給与確定禁止／給与確定・明細・CSV・Excel／人件費分析・予算／アプリ内通知／端末への業務データ永続保存なし／セットアップの重複・中断からの復旧／既存環境の再検出／アップデート・ロールバック／バックアップ・復元／無料利用条件。

## 現状（開発側の自己申告。監査で確かめてください）
- モック環境・GAS エミュレーション・Chromium での E2E で検証済み。**Google 実環境・iPad 実機では未検証**（docs/technical-verification.md §4）
- `npm run verify`（lint / typecheck / 単体 86 / 統合 33 / セキュリティ 27 / E2E 44）と GitHub CI は成功
- 別の AI レビュー（R-1）の指摘 12 件を修正済み（docs/review-log.md）。この監査はそれとは独立に行ってください

## 設計資料（前提の確認用）
docs/architecture.md, docs/decisions.md, docs/security.md, docs/payroll-specification.md, docs/permission-matrix.md, docs/database-schema.md, docs/technical-verification.md, docs/implementation-status.md, docs/update-rollback.md

## 重点ファイル
- 認証・認可・API: src/backend/api.ts, auth.ts, context.ts, validate.ts, handlers/*.ts
- データ整合性: src/backend/store.ts（UnitOfWork・ジャーナル）, src/backend/gas/sheets-adapter.ts, src/backend/gas/platform.ts
- GAS 公開関数: src/gas/core.ts, admin.ts, setup.ts, scripts/build-gas.mjs, gas/manifests/*.json
- 自動構築・更新: src/setup/installer.ts, src/setup/apps-script-api.ts
- 給与・勤怠: src/shared/payroll.ts, labor.ts, wage.ts, attendance.ts, leave.ts, money.ts, period.ts, analytics.ts
- 端末側: src/frontend/kiosk/KioskApp.tsx, src/frontend/api/transport.ts, src/frontend/admin/pages/*.tsx
- テストの妥当性: tests/unit/payroll.golden.test.ts, tests/security/*, tests/integration/*

## 優先して監査する観点
1. F01〜F37 の実装漏れ（docs/implementation-status.md の記載と実装の不一致）
2. 確定済み要件への準拠（上の引用）
3. Google API 利用方式の成立性（Apps Script API・高度なサービス・drive.file スコープ・Web アプリ設定・権限承認の流れ）
4. OAuth トークンの漏えい経路
5. GAS の所有者権限（店長として実行）の悪用経路（匿名で呼べる関数・doPost・google.script.run）
6. 店長個人の Google Drive の保護（スコープ、削除・共有の範囲）
7. 店長・スタッフ認証の分離
8. 個別権限の迂回、自己承認、なりすまし、権限昇格、IDOR
9. PIN・端末認証の安全性（ハッシュ・pepper・試行制限・トークン生成・失効）
10. 給与計算の正確性（具体的な入力例で期待値と実際の値の差を示す）
11. 日付またぎ・深夜（22時/0時/5時）・締め日・週の境界・月 60 時間・法定休日
12. 法定労働時間・割増の適用条件（週 44 時間特例、変形労働時間制の扱い、最低賃金）
13. 未確認条件での給与確定
14. 同時更新・二重登録（ロック外の書き込み、古い行での上書き、冪等性キー）
15. データ整合性（ジャーナル再適用、部分失敗、月別パーティション）
16. セットアップの重複防止、中断・再開、アカウント取り違え
17. 更新・DB マイグレーション（破壊的変更の承認、ロールバック先）
18. バックアップ・復元・ロールバック（復元後の打刻保持、端末失効の維持）
19. 無料運用条件（有料 API・課金の発生経路、Apps Script の割当に対する設計）
20. iPad の操作性（タップ領域、縦横、無操作タイムアウト、打刻の手数）
21. 個人情報の端末永続保存（localStorage・キャッシュ・ページ復元）
22. 秘密情報・個人情報の漏えい（ログ、エラー応答、監査ログ、DB・バックアップ内の平文、配布物）
23. テスト期待値の独立性・妥当性（実装の出力を期待値にしていないか、検証が甘いテスト）

## 報告形式
- 重要な指摘だけを、重要度（重大 / 高 / 中）の高い順に最大 20 件
- 各指摘に次を必ず書く:
  - 根拠（ファイル:行）
  - 再現条件（具体的な入力・手順。給与計算は入力・期待値・実際の値）
  - 影響範囲
  - 推奨修正
- 推測やコードだけからの判断は、その旨を明記（「未実行・コード読解による」など）
- スタイル・好み・軽微な改善は書かない
- 指摘がない観点は最後に「問題なし」として観点番号だけを列挙
- 重要な指摘がまったくない場合は「重要な指摘なし」と簡潔に報告
- ファイルの作成・変更・削除、git 操作（commit / push / checkout 等）、外部への送信は行わないこと
```

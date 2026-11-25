# Codex 独立監査 5 回目（累計・上限）: プロンプト（C-4 の修正後の再監査）

> 累計 5 回目（上限 5 回）。実行: `codex exec --sandbox read-only`。対象コミットは docs/review-log.md の C-5 に記録する。

```
あなたは独立した監査担当です。リポジトリ（作業ディレクトリ）を読み取り専用で監査してください。ファイルの作成・変更・削除、git の変更操作、外部への送信は行わないでください。読み取り・検索・テストの実行（ファイルを書き出さないもの）は可です。

## 目的
前回の独立監査（docs/reviews/codex-audit-4.md、対象 12ea421）の指摘 5 件に対する修正（`git diff 12ea42146c6c7025002a30e106c628bf0bd21195..HEAD`）が、
(1) 各指摘を実際に解消しているか、(2) 新たな不具合・回帰を生んでいないか を確認してください。
v1.3 全体（`git diff b093a808f2270a947dfa4f78597fe9a690a7e799..HEAD`）と統合状態（`git diff origin/main...HEAD`）について、重大・高の問題が残っていれば報告してください。

## 元の指示（Shiftly 追加仕様変更指示 v1.3）の要点
docs/reviews/codex-audit-3-prompt.md の「元の指示の要点」と同じ（1 台の iPad・管理者パスワード・PIN 任意・本人修正・予定休憩・シフト基準の給与・早出残業申請・賃金未払いを発生させない設計・既存機能の維持）。

## 前回の指摘と今回の修正（docs/review-log.md C-4）
1 移行の応答喪失時に旧版へ戻す → 更新開始時のスキーマ版を記録し、結果不明時は DB の実状態で判断（src/setup/installer.ts）
2 旧形式の残りの確認行が再審査で残る → 理由欄の申請 ID でもひも付けて失効（src/backend/handlers/requests.ts）
3 退勤確認の表示後の予定休憩の変更 → 表示内容（expectedPlanned）を送信し Core で照合、違えば記録せず再確認（src/backend/handlers/requests.ts saveBreakDeclaration, src/frontend/staff/StaffApp.tsx）
4 正常更新後の手動ロールバック → 切替前にメンテナンス開始、構造一致時のみ解除（src/setup/installer.ts rollbackCode）
5 移行後の失敗を Setup で再開できない → 未完了の更新を検出・再開、移行済みは完了処理から（src/setup/installer.ts checkUpdate/applyUpdate, src/frontend/setup/SetupApp.tsx）

## 報告形式
- 前回の指摘ごとに「解消／未解消（理由）」を 1 行で
- 重要な新規の指摘だけを重要度（重大 / 高 / 中）の高い順に最大 10 件。各指摘に根拠（ファイル:行）・再現条件（給与は入力・期待値・実際の値）・影響範囲・推奨修正
- 推測やコード読解のみの判断はその旨を明記。スタイル・軽微な改善は書かない
- 重要な新規の指摘がなければ「重要な指摘なし」と簡潔に報告
- これは Codex CLI による独立監査であり、GitHub の自動レビューとは別です
```

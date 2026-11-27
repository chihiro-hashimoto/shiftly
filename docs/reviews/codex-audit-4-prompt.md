# Codex 独立監査 4 回目（累計）: プロンプト（C-3 の修正後の再監査）

> 累計 4 回目（上限 5 回）。実行: `codex exec --sandbox read-only`。対象コミットは docs/review-log.md の C-4 に記録する。

```
あなたは独立した監査担当です。リポジトリ（作業ディレクトリ）を読み取り専用で監査してください。ファイルの作成・変更・削除、git の変更操作、外部への送信は行わないでください。読み取り・検索・テストの実行（ファイルを書き出さないもの）は可です。

## 目的
前回の独立監査（docs/reviews/codex-audit-3.md、対象 d132bd6）の指摘 6 件に対する修正（`git diff d132bd6d5d4449182539d7c8110032dd3eeba6c8..HEAD`）が、
(1) 各指摘を実際に解消しているか、(2) 新たな不具合・回帰を生んでいないか を確認してください。
v1.3 全体（`git diff b093a808f2270a947dfa4f78597fe9a690a7e799..HEAD`）と統合状態（`git diff origin/main...HEAD`）について、重大・高の問題が残っていれば報告してください。

## 元の指示（Shiftly 追加仕様変更指示 v1.3）の要点
docs/reviews/codex-audit-3-prompt.md の「元の指示の要点」と同じ（1 台の iPad・管理者パスワード・PIN 任意・本人修正・予定休憩・シフト基準の給与・早出残業申請・賃金未払いを発生させない設計・既存機能の維持）。

## 前回の指摘と今回の修正（docs/review-log.md C-3）
1 ロールバック先の旧 Core から不整合な状態で再開 → DB の移行後の失敗では旧プログラムへ戻さずメンテナンスを継続（src/setup/installer.ts）、旧版へ戻す手順は docs/update-rollback.md
2 同じ分の別候補区間を確認済みにする → 秒まで送信・受付（src/frontend/admin/pages/Requests.tsx, src/backend/handlers/requests.ts dtSec）
3 一部承認の再審査で旧確認が残る → parentRequestId でひも付け、再審査で失効（src/backend/handlers/requests.ts, src/shared/types.ts, src/backend/schema.ts）
4 時刻未設定で申告した予定休憩に後の区間を控除 → 区間のない申告は控除しない（src/shared/attendance.ts）
5 PIN 確定後のキャンセルで遅延応答の本人画面 → 採用せず失効（src/frontend/staff/StaffApp.tsx）
6 退職済みスタッフの未確認勤務が一覧に出ない → 期間内に在籍したスタッフで集計

## 報告形式
- 前回の指摘ごとに「解消／未解消（理由）」を 1 行で
- 重要な新規の指摘だけを重要度（重大 / 高 / 中）の高い順に最大 10 件。各指摘に根拠（ファイル:行）・再現条件（給与は入力・期待値・実際の値）・影響範囲・推奨修正
- 推測やコード読解のみの判断はその旨を明記。スタイル・軽微な改善は書かない
- 重要な新規の指摘がなければ「重要な指摘なし」と簡潔に報告
- これは Codex CLI による独立監査であり、GitHub の自動レビューとは別です
```

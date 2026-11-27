# Codex 独立監査 15 回目（累計）: C-14 の対応の確認（対象を限定）

> 2026-11-25 実行。`codex exec --sandbox read-only`、対象 `112259a`（対応差分 `34ee228..112259a`）。プロンプト: docs/reviews/codex-audit-15-prompt.md。マージ可否の判定ではない。以下は Codex の出力（原文のまま）。ファイルへのリンクは監査時の作業ツリーの絶対パス

一部未解消または回帰あり

実際の HEAD は `eff70dd0b69eff876915e8c8ad98da1371a90015` でした。指定の `112259a` との差は監査依頼の Markdown 1 件の追加のみです。ブランチは `claude/friendly-dijkstra-bt20os`、作業ツリーはクリーンで、指定の `34ee228..112259a` を監査しました。 [追加された監査依頼文](/home/user/shiftly/docs/reviews/codex-audit-15-prompt.md)

## A. 14 回目の指摘

- **#1 解消。** 指摘された旧形式の記録では、Admin が開始時の版 `2` のままなので `4／2` を今回の配備済みの組として扱わず、再開時に両方を再配備します。 [判定処理](/home/user/shiftly/src/setup/installer.ts:704) · [テスト](/home/user/shiftly/tests/integration/installer.test.ts:1053)
- **#2 解消。** Admin の切替だけが失敗しても、保存した戻し先を使って再試行できました。途中の更新は拒否され、両方を照合した後に保留記録が消え、メンテナンスが解除されました。 [再試行処理](/home/user/shiftly/src/setup/installer.ts:821) · [テスト](/home/user/shiftly/tests/integration/installer.test.ts:1075)
- **#3 解消。** 旧形式の Registry から更新を始める際に、直前と現在の組を履歴に保存します。更新前バックアップで通信例外が発生した後も、手動で `2／2` から `1／1` に戻せました。 [履歴の保存](/home/user/shiftly/src/setup/installer.ts:544) · [テスト](/home/user/shiftly/tests/integration/installer.test.ts:1095)

## B. 対応差分による回帰

**中｜切替前にロールバックが中止されても、その後の更新が拒否される。**

- **根拠・再現条件**　履歴が `1／1 → 2／2` の状態で手動ロールバックを開始し、メンテナンス開始に一度だけ明示的な失敗応答を返します。両方の配備は `2／2` のままで、メンテナンスも解除中です。障害解消後、修正前は更新が成功して `3／3` になりました。修正後は、メンテナンス開始前に保存した `pendingRollback` が中止時に残るため、更新が拒否されて `2／2` にとどまりました。モックで修正前後を比較しました。 [保留の保存と中止](/home/user/shiftly/src/setup/installer.ts:844) · [更新の拒否](/home/user/shiftly/src/setup/installer.ts:517)
- **影響範囲**　履歴から前の組へ戻そうとして切替前に中止した店舗では、現行版のまま更新へ進む操作が塞がれます。画面の案内に従うと、更新前に旧版への切替が必要になります。
- **推奨修正**　メンテナンス開始の成功を確認してから、最初の配備切替の直前に戻し先を保存してください。再試行時は、すでに保存された戻し先を両方の配備の照合が済むまで保持してください。

差分外で報告対象となる重大事項は確認しませんでした。

## 検証結果

ESLint、`tsc --noEmit`、`git diff --check 34ee228..112259a` は終了コード `0` でした。既存モックと Vitest の `expect` を使い、ファイルを書き出さずに `installer.test.ts` の 56 件を実行し、修正後は全件合格しました。C-14 の追加 3 件は、修正前のインストーラーに差し替えると申告どおりすべて失敗しました。上記の回帰は別のモックケースで確認しました。

ファイル出力を伴う `npm run verify` 全体、`npm run docs`、通常の Vitest スイート、E2E、Google 実環境、iPad 実機での検証は未実行です。

これは Codex CLI による独立確認です。GitHub の自動レビューとは別です。
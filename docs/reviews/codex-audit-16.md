# Codex 独立監査 16 回目（累計）: C-15 の対応の確認（対象を限定）

> 2026-11-26 実行。`codex exec --sandbox read-only`、対象 `696b73f`（対応差分 `112259a..696b73f`）。プロンプト: docs/reviews/codex-audit-16-prompt.md。マージ可否の判定ではない。以下は Codex の出力（原文のまま）。ファイルへのリンクは監査時の作業ツリーの絶対パス

一部未解消または回帰あり

実際の HEAD は `f8c4e01933c3d00c3215b1e8774dbc54882e385f` でした。ブランチ `claude/friendly-dijkstra-bt20os` の作業ツリーはクリーンで、指定の `696b73f` からの差分は監査依頼の Markdown 1 件の追加のみでした。指定の `112259a..696b73f` を監査しました。 [追加された監査依頼文](/home/user/shiftly/docs/reviews/codex-audit-16-prompt.md)

## A. 15 回目の指摘

**解消。** メンテナンス開始が明示的に失敗すると、戻し先を保存せずに中止します。既存のモックで、修正前は戻し先 `1／1` が残り、修正後は配備が `2／2` のまま保留が残らず、後続の更新が成功することを確認しました。 [実装](/home/user/shiftly/src/setup/installer.ts:845) · [追加テスト](/home/user/shiftly/tests/integration/installer.test.ts:1109)

## B. 対応差分による回帰

**高｜戻し先の保存に失敗すると、配備を切り替える前に打刻が停止したままになる。**

- **根拠と再現条件**　メンテナンス解除中で、履歴が `1／1 → 2／2`、保留なしの店舗で手動ロールバックを実行し、戻し先の Registry 保存で例外を発生させます。モックでは、両版とも配備は `2／2` のままですが、修正前はメンテナンス解除中、修正後はメンテナンス中になりました。実装では UserProperties と Drive への保存で発生した例外が Setup API まで伝わり、`SETUP_ERROR` が返ります。 [保存順序](/home/user/shiftly/src/setup/installer.ts:845) · [Registry の保存](/home/user/shiftly/src/gas/setup.ts:80) · [例外処理](/home/user/shiftly/src/gas/setup.ts:128)
- **影響範囲**　前の版の組へ戻そうとした店舗で、復旧操作までスタッフの打刻が止まります。 [メンテナンス中の操作制限](/home/user/shiftly/src/backend/api.ts:109)
- **推奨修正**　切替前の保存例外を処理し、部分保存された保留記録を確認・整理したうえで、この操作が開始したメンテナンスを解除してください。保存状態の確認や解除に失敗した場合は、現在の状態と復旧手順を応答に含めてください。

差分外で報告対象となる重大事項は確認しませんでした。

`npm run lint`、`npm run typecheck`、`git diff --check 112259a..696b73f` は終了コード `0` でした。上記 2 ケースは既存モックと Node.js のアサーションを使い、ファイルを書き出さずに修正前後を比較しました。実環境の例外処理と打刻への影響はコード読解に基づきます。ファイル出力を伴う `npm run verify` と `npm run docs`、通常の Vitest スイート、E2E、Google 実環境、iPad 実機での検証は未実行です。

これは Codex CLI による独立確認です。GitHub の自動レビューとは別です。
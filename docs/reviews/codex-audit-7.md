# Codex 独立監査 7 回目（累計）: マージ可否の判定（C-6 の修正後）

> 2026-11-25 実行。`codex exec --sandbox read-only`、対象 `7937e91`。プロンプト: docs/reviews/codex-audit-7-prompt.md。以下は Codex の出力（原文のまま）。ファイルへのリンクは監査時の作業ツリーの絶対パス

マージ不可

- 判定対象は `7937e914aa55fab1a622dc1c1626f536a95b650e` の統合差分 `origin/main...7937e91` です。開始時の HEAD は指定と一致し、PR #1 の指定コミットと `origin/main` はともに祖先でした。
- 監査中に作業ツリーの HEAD は `ec776b3` に進みました。追加差分は監査依頼文の Markdown 1 件で、実行したテストのコード・設定は対象 SHA と同一です。
- 移行後の再開でデプロイ照会に失敗すると旧版への自動ロールバックに進み得ます。さらに、手順書どおりに旧版へ切り替えて復元すると、確認前に打刻が再開します。
- lint・型検査・読み取り専用の自動テストは合格しました。以下は Codex CLI による独立判定です。PR #2 の GitHub CI は接続制限により確認できませんでした。

### 6 回目の監査指摘

1. **解消** — `system.migrate` の呼び出しが通信例外になった場合、旧版へ戻さずメンテナンスを継続します。直接の回帰テストは合格しました。 [installer.ts](/home/user/shiftly/src/setup/installer.ts:525)
2. **未解消** — v1.3 Core での復元はメンテナンスを引き継ぎます。手順書どおりに v1.2 Core へ戻してから復元する経路にはこの修正が効きません。 [ops.ts](/home/user/shiftly/src/backend/handlers/ops.ts:543) · [update-rollback.md](/home/user/shiftly/docs/update-rollback.md:44)
3. **未解消** — 正常に手動ロールバックした後の再配備テストは合格しました。デプロイ照会の一時障害で移行済みの保護を外す回帰があり、承認待ちの再開では移行前の配備照合も省略されます。 [installer.ts](/home/user/shiftly/src/setup/installer.ts:496)
4. **解消** — 前日 09:00 の退勤漏れがあり、当日 09:00〜17:00 に勤務したケースで、当日の予定休憩 30 分が表示・保存され、勤務 450 分を確認する回帰テストが合格しました。時給 1,200 円なら基本給は手計算で 9,000 円です。 [codex-audit-6.test.ts](/home/user/shiftly/tests/integration/codex-audit-6.test.ts:27)

### マージを止める指摘

1. **高 — 移行後の再開で、一時的なデプロイ照会失敗が旧版への自動ロールバックにつながる。** v1→v2 が完了し、`finish` 前に中断した更新を再開します。Staff または Admin の `getDeployment` が一時的に失敗すると、照会例外は `false` になり、`migrated` も `false` で始まります。その後のアップロードやバージョン作成で例外が起きると、自動ロールバックが v1.2 を配備し得ます。再準備は Core 側の `pendingUpdate` のバックアップ参照も移行後の複製へ更新します。店舗全体の勤怠・給与が旧 Core と v2 DB の不整合にさらされ、復旧時に元のバックアップを取り違えるおそれがあります。移行開始後の保護状態を配備照会から独立して保持し、照会失敗時は再配備やロールバックに進まず再試行できるようにしてください。承認待ちの再開でも移行を呼ぶ前に両配備を照合し、最初のバックアップ参照を保持する回帰テストを追加してください。コード読解による判定です。 [installer.ts](/home/user/shiftly/src/setup/installer.ts:496) · [installer.ts](/home/user/shiftly/src/setup/installer.ts:560) · [installer.ts](/home/user/shiftly/src/setup/installer.ts:582) · [update.ts](/home/user/shiftly/src/backend/handlers/update.ts:24)

2. **高 — 手順書に従う v1.2 への復旧で、確認前に打刻が再開する。** 営業中に取得された v1 の更新前バックアップを使い、v2 への移行後に手順書の順番でコードを v1.2 へ戻してから復元します。期待は Google 所有者の確認までメンテナンス継続です。実際には `b093a80` の旧 Core が復元を実行し、現行のメンテナンス状態を候補へ引き継がずに稼働 DB を切り替えます。更新前バックアップには `off` が残り得るため、店舗全体で確認前に書き込みが再開します。復元候補をメンテナンス状態のまま有効化し、旧版との互換性確認後に明示解除できる復旧手順を実装してください。既存の v1.2 Core を使う通しの回帰テストを追加し、手順書の「復元してもメンテナンスは継続する」と移行失敗時の一律ロールバック記載を実装に合わせてください。旧版と新版のコード読解による判定です。 [旧版の復元処理（b093a80）](https://github.com/chihiro-hashimoto/shiftly/blob/b093a808f2270a947dfa4f78597fe9a690a7e799/src/backend/handlers/ops.ts#L473-L519) · [update-rollback.md](/home/user/shiftly/docs/update-rollback.md:17) · [update-rollback.md](/home/user/shiftly/docs/update-rollback.md:44)

### 検証範囲とリポジトリの衛生

- 実行結果は lint `exit 0`、型検査 `exit 0`、単体 `96 passed / 1 skipped`（`exit 0`）、統合・セキュリティ合計 `164 passed`（`exit 0`）。セキュリティ単独の再実行は `38 passed`（`exit 0`）で、統合は差し引き 126 件です。初回構築・承認後の初期構築再開・正常更新のモックテストは合格しました。現行の v1→v2 移行は追加型のみで、破壊的変更の承認待ちからの更新再開はコード読解です。ファイル出力を伴う XLSX テスト、ビルド、E2E、`npm run verify` 全体は未実行です。
- 既存の給与ゴールデン期待値と、インストーラーの中断再開テストのアサーションに変更はありません。後者は既存の前提どおり両デプロイの版をセットアップしています。ハーネスの `actual` は旧ケースの計算前提を維持し、`shift` は別のテストで明示して検証しています。照合した給与期待値は勤務区間から手計算で一致しました。 [installer.test.ts](/home/user/shiftly/tests/integration/installer.test.ts:450) · [harness.ts](/home/user/shiftly/tests/helpers/harness.ts:44) · [v13.test.ts](/home/user/shiftly/tests/integration/v13.test.ts:45)
- 認証・認可、給与確定と訂正、打刻と修正履歴、ジャーナル・冪等性、共用 iPad の終了処理はコードと該当テストを確認しました。マージを止める根拠は上記の更新・復旧経路です。コミット済みコードと履歴のパターン検索では、秘密鍵・認証トークン・実在スタッフの業務データに該当するものは見つかりませんでした。
- `git diff --check` は統合差分が `exit 2`（末尾空白 1 件、ファイル末尾の余分な空行 2 件）、v1.3 差分が `exit 2`（末尾空白 1 件）、6 回目の監査対象からの差分が `exit 0` でした。空白はマージ判定に含めていません。

### マージ後・本番利用前

- 検証用 Google アカウントで L1〜L17 を実施し、v1.2 からの更新、通信中断、ロールバック、旧版での復元、再更新まで記録する。 [実環境検証](/home/user/shiftly/docs/live-verification.md:27)
- 共用 iPad 実機の Safari／WebKit で、ログアウト、タブ非表示、再読み込み、bfcache 復帰後に個人情報・管理情報が表示されず、機密ファイルが端末に残らないことを確認する。
- 少なくとも 1 給与計算期間は紙のタイムカードと従来の給与計算を並行運用し、全員分を照合する。 [運用ガイド](/home/user/shiftly/docs/operations-guide.md:26)
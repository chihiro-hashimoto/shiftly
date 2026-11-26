# Codex 独立監査 17 回目（累計）: マージ可否の判定（締めくくり）

> 2026-11-26 実行。`codex exec --sandbox read-only`、対象 `848b2c8`（全体の統合状態）。プロンプト: docs/reviews/codex-audit-17-prompt.md。前提: 利用者なし・更新まわりは次の版の前に実環境で検証（D-024）。以下は Codex の出力（原文のまま）。ファイルへのリンクは監査時の作業ツリーの絶対パス

マージ不可

- v1.3 のバックアップ復元後、画面が求める確認をすべて正しく済ませても、古い月給で給与を訂正できました。確定済みの240,000円が200,000円に変わることをメモリ上の統合ハーネスで確認しました。
- 復元によって削除済みのバックアップが利用可能と表示されることも再現しました。初回 Setup には、配備成功後に応答を失うと Web アプリを二重に配備する経路が残っています。
- 指定対象は `848b2c826e5258d4b4fb4c5f8953264c4d24566e` でしたが、ローカルと PR #2 の実際の HEAD は `135925e566419f9670c503a9e01aa6c919baae1c` でした。差は監査プロンプト文書の追加1件で、実装とテストは同一です。作業ツリーはクリーンでした。
- 指摘は v1.3 を初めて導入する店舗にも当てはまります。旧版からの更新や、合意済みのメンテナンス継続は判定理由に含めていません。

## マージ前に修正する指摘

1. **高 — 復元後の給与停止を解除する際に、月給設定を確認しない。** 基本給20万円のバックアップを取り、基本給を24万円に変更して月給を確定します。控除なしで復元すると、訂正は一度 `PAYROLL_BLOCKED` になります。画面が指定する時給ルール・手当・控除はすべて一致しているため、確認を完了すると訂正が通ります。月給条件を照合するまで停止するか、確認済みの24万円を基準に訂正できることが期待値です。実測ではリビジョン2が20万円となり、4万円の過少計算が生じました。9回目以降に追加した解除処理の問題です。解除条件と手順書に月給・固定残業代・所定労働時間などの適用条件を含め、確定時点の条件と照合できるようにしてください。復元した仮計算と一致しない場合に訂正を止める回帰テストも必要です。[解除処理](/home/user/shiftly/src/backend/handlers/payroll.ts:230) · [確認画面](/home/user/shiftly/src/frontend/admin/pages/Payroll.tsx:198) · [月給計算](/home/user/shiftly/src/shared/payroll.ts:448) · [復元手順](/home/user/shiftly/docs/update-rollback.md:37)

2. **中 — 復元がバックアップ履歴の状態を巻き戻す。** 日次バックアップを作成し、その履歴を含む手動バックアップを取ります。その後、世代管理で古い日次バックアップが `pruned` になってから手動バックアップを復元すると、一覧で日次バックアップが `ok` に戻りました。復元候補に同じIDがある場合、現行の履歴で上書きしないためです。管理者は、アプリから復元できない世代を利用可能と判断し得ます。候補に同じIDがあっても現行行を優先し、世代管理で削除された行が `pruned` のまま残ることをテストしてください。[世代管理](/home/user/shiftly/src/backend/handlers/ops.ts:446) · [復元時の履歴引き継ぎ](/home/user/shiftly/src/backend/handlers/ops.ts:562)

3. **中 — 初回 Setup で配備成功直後に中断すると、再開時に別の配備を作る。** コード読解による指摘です。Apps Script 側で Web アプリの作成が成功し、Setup が `deploymentId` を保存する前に応答の喪失や実行中断が起きると、再開時に `createDeployment` を再度呼びます。Staff 側では、Setup の管理対象に入らない匿名アクセス用の配備と URL が残り得ます。配備の意図と対象バージョンを呼び出し前に永続化し、再開時には既存配備を照合してください。一意に特定できない場合は作成を止め、確認手順を案内してください。[初回配備と進捗保存](/home/user/shiftly/src/setup/installer.ts:452) · [実環境の中断試験](/home/user/shiftly/docs/live-verification.md:44)

## 検証結果

- `npm run lint` と `npm run typecheck` は合格。書き出しを伴うテストと既存ビルド依存のテストを除いた Vitest は **18ファイル・293件合格**。別途、既存の `dist` を使った GAS エミュレーションは **4件合格**しました。`dist` と対象コミットの一致は未確認です。`npm run verify` 全体、`npm run docs`、E2E は書き込みを伴うため未実行です。
- `git diff --check` は `origin/main...848b2c8` で終了コード2。`docs/reviews/codex-audit-2.md:69` の行末空白と、`src/backend/handlers/payroll.ts:421`、`src/frontend/admin/pages/Payroll.tsx:1184` の末尾空行を報告しました。`b093a80..848b2c8` は行末空白1件、`84af493..848b2c8` は出力なしでした。
- `payroll.golden.test.ts` に変更はありません。確認した v1.3 のシフト基準テストには、早出5分・残業10分を個別に加算する固定期待値があり、旧ハーネスの `actual` 指定とは別に検証されています。全テストの期待値の作成過程までは確認できません。今回の月給の問題は、復元後の停止と解除を時給制で検証する既存テストでは検出できませんでした。[給与のテストハーネス](/home/user/shiftly/tests/helpers/harness.ts:45) · [シフト基準のテスト](/home/user/shiftly/tests/integration/v13.test.ts:58) · [復元後の停止テスト](/home/user/shiftly/tests/integration/codex-audit-10.test.ts:12)
- 主要な鍵・トークン形式と資格情報ファイル名の検索では、対象ツリーに実認証情報や実店舗の業務データを確認しませんでした。初期コミットの Git 著者情報にはアカウントのメールアドレスが含まれます。Staff の認可、本人未確認セッション、共用端末の終了処理はコードと自動テストの範囲で確認し、追加のマージ阻止事項は特定していません。
- GitHub の PR CI は、指定 SHA の **#103 がキャンセル**、実際の PR #2 HEAD の **#105 が確認時点で実行中**でした。修正後、実際に統合するコミットで CI の合格を確認してください。この報告は Codex CLI による独立監査です。[対象 SHA の CI](https://github.com/chihiro-hashimoto/shiftly/actions/runs/45740007756) · [PR #2 HEAD の CI](https://github.com/chihiro-hashimoto/shiftly/actions/runs/45740078312)

## 次の版の前に対応

- D-024 に沿って、Google 実環境で更新・ロールバックの途中失敗と再開を検証してください。Staff・Admin の版の組と DB 構造を照合できた場合だけメンテナンスを解除することを確認してください。[実環境検証 L11](/home/user/shiftly/docs/live-verification.md:42)

## マージ後、本番利用の前に必要な事項

- Google 実環境で初回 Setup と中断からの再開、打刻、申請、確定・訂正、バックアップと復元を通しで検証する。[実環境検証手順](/home/user/shiftly/docs/live-verification.md)
- iPad 実機の Safari とホーム画面アプリで、ログアウト、バックグラウンド移行、再読み込み、戻る操作の後に個人情報・管理情報が再表示されず、機密ファイルが端末に保存されないことを確認する。[iPad 実機検証](/home/user/shiftly/docs/live-verification.md:45)
- 少なくとも1給与計算期間、紙のタイムカードと従来の給与計算を並行し、全員分を照合する。[運用ガイド](/home/user/shiftly/docs/operations-guide.md:26)
# AGENTS.md — AI エージェント向け作業ルール

- 最初に `docs/HANDOFF.md` → `docs/implementation-status.md` → `docs/decisions.md` を読む
- 言語: ドキュメント・コードコメント・UI 文言は日本語
- 禁止: `dangerouslySetInnerHTML`、業務データの localStorage/sessionStorage/IndexedDB 保存（端末トークン `shiftly.device.v1` のみ可）、汎用のファイルID/シート名指定 API、PIN・トークン・個人情報のログ出力、秘密情報のコミット、破壊的コマンド（`rm -rf`、`git push --force` 等）
- 新しい API 操作は `defineOps` で登録し、`auth`・`perms`・`sensitive`・`mutating` を必ず指定。v1.3: `auth: 'owner'` の操作を店舗 iPad の管理者モード（管理者パスワード）に許可する場合のみ `adminAllowed: true`（既定は Google 所有者のみ）、重要操作は `reauth: true`、PIN 未設定（本人未確認）のスタッフに許可する場合のみ `allowUnverified: true`（応答に機密情報を含めない）。追加後は `npm run docs` で権限マトリクスを再生成
- 業務データの書き込みは Core（`src/backend`）経由のみ。更新系はスクリプトロック内（api.ts が自動で行う）
- 用語: 画面・文書・コードは「Staff」「管理者」（v1.3）。Google 所有者に限定する事項は「Google 所有者」と書く。互換のための旧識別子は docs/decisions.md D-014 に記載したもの以外に増やさない
- 打刻原本（attendance_events）・修正履歴は上書き・削除しない。給与計算の時間区分は docs/payroll-specification.md §2.5（シフト基準）・§2.6（休憩）に従う
- 給与計算を変更したら `docs/payroll-specification.md` を更新し、`tests/unit/payroll.golden.test.ts` の期待値は手計算で追加（実装の出力を期待値にしない。既存の期待値を実装に合わせて変更しない）
- テストが失敗したらコード側を直す。テスト自体の誤りが疑われる場合はユーザーに確認する
- 完了前に `npm run verify`（または該当コマンド）を実行し、実行結果をそのまま報告。未実行のものを実行済みと書かない
- main への直接 push・マージ、本番デプロイ、実データ登録はユーザー承認後

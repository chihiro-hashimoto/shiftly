# HANDOFF（セッション引き継ぎ）

> 新しいセッションは、まずこのファイルを読み、次に `docs/implementation-status.md`・`docs/decisions.md`・`AGENTS.md` を読むこと。
> 元の指示は統合マスタープロンプト v1.2 と追加仕様変更指示 v1.3、リリース範囲適正化指示（B案、2026-11-27、D-027）。要点は `docs/requirements.md` にあり、再入力は不要。

## 現在の工程
- **前提（2026-11-26、ユーザー確認）: まだ公開しておらず、利用している店舗はない**。v1.3 が最初に導入する版。v1.2 で運用中の店舗を前提とした対応は該当なし。更新・ロールバックは次の版の前に Google の実環境で検証する（docs/decisions.md D-024）
- v1.2: 工程 A〜L 完了（F01〜F37 の実装・モック／エミュレーション検証・E2E・独立レビュー R-1・Codex 監査 C-1）
- **v1.3（2026-11-25）**: 実装・テスト・文書更新を完了（F38〜F41 を追加。docs/requirements.md「v1.3 の変更」）。Codex 監査 C-2（累計 2 回目）は docs/review-log.md を参照
- **B案（2026-11-27、D-027）**: v1.3 は「正常時は自動・異常時は手動」。アプリ内の自動復元・稼働中の DB の自動切替・自動更新・更新に伴う DB の自動移行・自動ロールバックを v1.3 から除外（処理を削除、DEFERRED_OPS で全経路を拒否）。データの復元は Google 所有者の保守作業（maintenance.begin / finish）。C-24 の A1・A3・A4 は機能を修正、A2 は仕様変更で実行経路を除外（docs/review-log.md「C-24 の対応」）。41 機能の分類: 初回 37・一部手動 2（F26・F35）・延期 2（F36・F37）
- **D-027 追補（2026-11-27）**: 残存リスクの整理。停止中の給与期間はアプリの外の例外的な手動訂正（運用手順「9.1」）、保守の「開始のやり直し」を廃止（記録を失ったら保守中のまま。紙のタイムカードと開発者への個別の依頼。「9.2」）、終了前に数式のセルを確認。実環境検証に L24〜L26 と初めて GAS を扱う人向けの構築手順（live-verification.md「1.6」）を追加
- **初回リリース（2026-11-27、D-028）**: v1.3 を v1.3.0 として初回リリースする（限定先行運用）。版を 1.3.0 に変更。工程 A（最終確認）・C（導入手順 installer-guide.md「0.5」、手動アップデート update-rollback.md「2」、障害対応 incident-response.md（DB のファイルの消失の個別対応を含む）、リリースノート release-notes-v1.3.0.md）を実施。給与の手計算シナリオ（live-verification.md「2.5」）をモックで確認（tests/integration/release-scenario.test.ts）
- **導入方法の A案（2026-11-27、D-029。ユーザーの正式な承認）**: 開発者が共通ホスト型 Setup を公開し、利用者自身の Google アカウントに自動構築する。保守の B案（D-027）は維持。新しいセッション（ブランチ `claude/determined-ptolemy-xuuec8`。PR #2 のブランチ `beb0c14` を起点に積み重ね）で実装: API の失敗の分類（USER_API_DISABLED 等）と「Google の設定画面を開く」「設定が完了したので再確認」、構築の内容の表示（構築先のアカウント・作成物・保存先・権限・確認事項）、実行中の工程の表示、完了画面の「次に行うこと」、**ブラウザでの権限承認と初期化**（Apps Script API の一覧の HEAD のテスト用 URL /dev を `#shiftly-init=<確認コード>` 付きで開き、Staff は `shiftlyWebInitialize`（操作するアカウント＝実行するアカウント＋確認コードのハッシュ＋未完了のときだけ＋失敗回数の制限）、Admin は `shiftlyAuthorize`。エディタでの実行は代わりの方法として常に表示）、共通 Setup の利用者の分離（Script Properties・Script Cache・Script Lock を使わない。`createGasCrypto`）、配置物 `dist/gas/setup-hosted/`（例外のログなし）。**Google 実環境では未検証**（docs/live-verification.md「0.2」L41〜L49）
- **現在の工程: B（最低限の Google 実環境検証）のユーザーの操作待ち**。A案により、まず開発者（ユーザー）が共通 Setup を限定公開で配置し（docs/deployment-guide.md「6.1」）、L41〜L49 と「0.1」14 項目・L24〜L26 を行う。docs/live-verification.md「0.1 公開前の必須検証」14 項目と L24〜L26。その後 D（ユーザーの最終のマージの承認 → PR #2 を PR #1 のブランチへ → PR #1 を main へ）→ E（ユーザーによる所有権の移譲）→ F（v1.3.0 の GitHub Release）→ G（本番の構築）→ H（限定先行運用）

## リポジトリ / ブランチ / PR / CI
- リポジトリ: https://github.com/chihiro-hashimoto/shiftly（Private）
  - 所有権の移譲先予定: https://github.com/chihirohashimotoac-coder/shiftly（ユーザーが実施。作業セッションでは移譲・コピー・新規作成をしない）
- ブランチ:
  - `claude/inspiring-einstein-73ks5s`: v1.2（PR https://github.com/chihiro-hashimoto/shiftly/pull/1、ドラフト、`b093a80`）
  - `claude/friendly-dijkstra-bt20os`: **v1.3**（`b093a80` から分岐。v1.2 の全コミットを含む）。v1.3 の新規セッションは v1.2 のブランチへ直接 push できない設定のため、別ブランチ・別 PR とした
  - `claude/determined-ptolemy-xuuec8`: **A案（D-029）**（`claude/friendly-dijkstra-bt20os` の `beb0c14` から分岐。PR #2 のブランチを base にした積み重ねの PR。統合の順は この PR → PR #2 → PR #1 → main）
- PR の関係: v1.3 の PR は PR #1 のブランチ（`claude/inspiring-einstein-73ks5s`）を base にした「積み重ね」の PR（差分は v1.3 の変更のみ）。統合方法は次のいずれか（ユーザーの判断）
  1. v1.3 の PR を先に PR #1 のブランチへマージ → PR #1 を main へマージ（v1.2＋v1.3 が main に入る）
  2. PR #1 をマージ後、v1.3 の PR の base を main に変更してマージ
- 最新コミット: `git log -1` で確認
- CI: `.github/workflows/ci.yml`（push・PR で実行）。結果は PR を参照

## 確定済み仕様（主なもの）
- 構成: Shiftly-Staff（= Core。v1.2 までの名称 Shiftly-Kiosk。匿名アクセス・Google 所有者として実行、DB 唯一の更新経路。店舗 iPad の画面と管理者モード）＋ Shiftly-Admin（Google 所有者のみ、HMAC 署名で Core へ転送）＋ Shiftly Setup（Apps Script API で自動構築）。詳細は docs/architecture.md と docs/decisions.md
- 認証（v1.3）: Google 所有者（構築・保守作業（データの復元・更新は手動）・管理者パスワードの設定）／ 管理者モード（店舗 iPad の「管理者ページ」＋管理者パスワード、無操作 5 分、重要操作は再認証）／ スタッフ（氏名＋PIN。PIN は任意。未設定は本人未確認）。docs/security.md
- スコープ: Core は drive.file / script.external_request / script.scriptapp / userinfo.email。Sheets・Drive は高度なサービスで扱う（SpreadsheetApp は使わない）
- 給与: docs/payroll-specification.md（BigInt 有理数、未設定条件があれば確定禁止、法令ルールセットを版管理）。v1.3: シフト基準（§2.5）・予定休憩は取得確認したもののみ控除（§2.6）

## 実装済み機能 ID（モックで検証済み。実環境は未検証）
- F01〜F41 のうち、v1.3 の対象（初回 37・一部手動 2）を実装（F38〜F41 は v1.3）。F36・F37 と、F26 の自動復元・F35 の更新に伴う移行は延期（実装済みとして数えない）。状況は docs/implementation-status.md
- 未実装として明示しているもの: 変形労働時間制等、時間単位年休、標準報酬日額方式、出来高払の割増、日割の規定、環境間のデータ移行の自動化

## 未解決・未確認
1. Google 実環境での検証: ユーザーが検証用アカウントで実施（手順と記録表: docs/live-verification.md。B案で L11・L12・L17 を対象外とし、L18〜L26（構築の完了の条件・失敗時の停止・記録ファイル・バックアップ・保守作業・手動の復元・数式のセル・DB のファイルの消失の個別対応・開始時の記録を読めない場合）を追加。**L24・L25 は本番導入の前に必須**）。結果待ち
6. 本番導入の前に必要なもの: DB のファイルを失った場合の開発者の個別対応の手順書（L25。v1.3 のアプリの機能ではない。未検証の復旧の能力は保証しない）
2. iPad 実機（Safari、ホーム画面）での検証: **ユーザーの実機が必要**（管理者モードの終了動作・PIN 入力・休憩確認ダイアログを含む）
3. （解決）Codex 監査1 #8: v1.3 の休憩仕様で対応（docs/review-log.md、D-017）
4. 未確定の業務条件（docs/requirements.md「未確定事項」）は管理者が設定画面で登録する
5. v1.3 で追加した確認待ちの事項: 管理者パスワードの初期設定（Google 所有者が Shiftly-Admin で設定）、既存店舗の時間基準（既定はシフト基準。実績基準に戻す場合は店舗設定）

## テスト結果（直近の実行）
- `npm ci` → `npm run verify`（2026-11-27、A案（D-029）の実装の後に実行、exit 0）: lint・typecheck・単体 103・統合 466・セキュリティ 58・E2E 108 件すべて合格（計 735。追加: 単体 2（web-init）・統合 26（hosted-setup: API の失敗の分類・テスト用 URL・確認コード・所有者限定の初期化・匿名と別アカウントの拒否・回数の制限・利用者の分離・共通 Setup の配置物）・E2E 16（構築の内容・API 無効の案内と再確認・ブラウザでの承認の案内・完了画面の次に行うこと・初期化と接続の画面。各 4 画面幅）。既存のテストの期待値は変更していない）。`npm run docs` の再生成で差分なし。`git diff --check origin/main` 問題なし。**Google 実環境・iPad 実機・WebKit では未検証**
- `npm ci` → `npm run verify`（2026-11-27、v1.3.0 の版の変更・給与の手計算シナリオの追加の後に実行、exit 0）: lint・typecheck・単体 101・統合 440・セキュリティ 58・E2E 92 件すべて合格（計 691）。`npm run docs` の再生成で差分なし。`git diff --check origin/main` 問題なし。`npm audit --omit=dev` は 0 件（moderate 8 件は開発時だけの依存）
- （以前の記録）`npm ci` → `npm run verify`（2026-11-27、D-027 追補の後に実行、exit 0）: lint・typecheck・単体 101・統合 439・セキュリティ 58・E2E 92 件すべて合格。`npm run docs` の再生成で差分なし。`git diff --check origin/main` 問題なし
- （以前の記録）`npm ci` → `npm run verify`（2026-11-27、B案の実装・独立した点検 2 回の対応の後に実行、exit 0）: lint・typecheck・単体 101・統合 435・セキュリティ 58・E2E 92 件すべて合格。`npm run docs` の再生成で差分なし。`git diff --check origin/main` 問題なし。npm audit の 8 件（moderate）は既存の依存関係のもの（依存関係は変更していない）
- （以前の記録）`npm ci` → `npm run verify`（2026-11-26、C-23 の構造的な対応・独立した点検 2 回の対応の後に実行、exit 0。対象 9429da3 のコード。権限表・DB 定義は再生成して差分なし。`git diff --check origin/main` 問題なし）: lint・typecheck 合格／単体 101・統合 429・セキュリティ 39・E2E 88 件すべて合格。`npm audit` は既存の依存（minimatch）の中程度 8 件（今回は依存を変更していない）
  - 統合に v1.3（v13.test.ts 47 件: §9.2 の期待値を含む）・Codex 監査2〜6 の回帰（codex-audit-2.test.ts・codex-audit-3.test.ts・codex-audit-6.test.ts・codex-audit-8.test.ts・codex-audit-9.test.ts・codex-audit-10.test.ts・codex-audit-17.test.ts・installer.test.ts・restore-policy.test.ts）・GAS エミュレーション（v1.2 の 32 列シートの読み込みと移行を含む）
  - E2E は店舗 iPad（スタッフ・管理者モード・PIN 未設定・休憩確認）・Google 所有者の管理画面の全ページ・Setup（iPad 横・縦／PC 1440／スマホ 390、Chromium）
- GitHub CI: v1.3 の各コミット（`564a04a`・`d132bd6`・`12ea421`）で成功。最新コミットは PR のチェックを参照
- いずれもモック・エミュレーション・Chromium での検証。**Google 実環境・iPad 実機・WebKit では未検証**

## 次に実行する作業
0. A案（D-029）: ユーザーが開発者のアカウントで共通 Setup を限定公開で配置（docs/google-api-setup.md「2」→ docs/deployment-guide.md「6.1」）→ 検証用の利用者アカウント 2 つで L41〜L49。NG（例: HEAD のテスト用 URL が取れない・/dev で初期化が拒否される）は公開を阻害する事項として最小限に修正。代わりの方法（エディタ）は残っているため、構築そのものは止まらない
1. 工程 B: ユーザーが検証用アカウントで docs/live-verification.md「0.1」の 14 項目と L24〜L26 を実施し、結果を共有する（NG があれば、公開前に直すべき問題（D-028）だけを最小限に修正）。Codex の再監査（25 回目）は実施しない（新たな承認が必要）
2. ユーザーから実環境検証の記録（docs/live-verification.md の表。L1〜L10・L13〜L16・L18〜L26）を受け取り、technical-verification.md に反映・NG を修正
3. 工程 D〜F（D-028）: ユーザーの最終のマージの承認 → PR #2 を PR #1 のブランチへマージ → PR #1 を main へマージ → ユーザーが Settings → General → Danger Zone → Transfer ownership で `chihirohashimotoac-coder` へ移譲 → 移譲後の main から v1.3.0 の GitHub Release（配布物 shiftly-gas-bundle.zip・shiftly-preview.zip・SHA-256・リリースノート）
4. 次期以降の候補（約束しない）: アプリ内の復元（稼働中の DB の切替）・Setup による更新・ロールバック・更新に伴う DB の移行（docs/update-rollback.md「2」）

## レビュー
- 独立レビュー R-1（Claude エージェント、Codex ではない）: 指摘 12 件をすべて修正（docs/review-log.md）
- Codex 監査 C-1: 指摘 15 件。14 件修正、#8 は v1.3 で対応（docs/review-log.md、原文 docs/reviews/codex-audit-1.md）
- Codex 監査 C-2（v1.3 実装後）: 指摘 10 件をすべて修正（docs/review-log.md、原文 docs/reviews/codex-audit-2.md）

## D-027 の要点（引き継ぎ）
- v1.3 で提供しない操作は src/backend/api.ts の DEFERRED_OPS（登録すると読み込み時にエラー）。Setup の鍵は読み取りだけ。setupApi の更新・ロールバックは拒否
- 保守作業: src/backend/handlers/maintenance.ts（MAINTENANCE_TABLES で全表の扱いを型で必須）。保守の記録は Script Properties の SHIFTLY_MAINTENANCE（ある間は全員の更新系を停止）。エディタ関数 shiftlyMaintenanceBegin / Finish / Status（開始のやり直しの関数はない。D-027 追補）。終了前に数式のセルを確認（TableAdapter.findFormulas。Sheets では数式と値の読み比べ）
- 画面の世代は乱数で、発行は初めての構築と保守作業の終了だけ（issueEpoch）。既存の環境では自動で作り直さない
- Setup の記録ファイルは保存済み ID で直接照会（src/gas/setup.ts）。Drive の検索は listAllDriveFiles（全ページ）。完了には registryReport と所有者のプロジェクトの確認が必要

## D-026 の要点（引き継ぎ）
- 全 API 操作に分類（kind）を型で必須。画面からの業務更新（edit。45 操作）は共通の入口で復元世代を照合（STALE_VIEW）。照合しない操作は src/backend/epoch-exemptions.ts に理由を登録（テストの固定の一覧と一致が必要）。分類の一覧は docs/permission-matrix.md（自動生成）
- 画面の世代は Script Properties（SHIFTLY_RESTORE_EPOCH。名前は互換のため維持）。画面は最初の世代を固定し、異なる世代で「画面を読み込み直してください」
- 初回の構築の作成物の状態と失敗の扱いは docs/creation-matrix.md。結果不明は確認・関連付けまで作らない。完了前に作成物の整合性を検証（プロジェクトの重複は自動では確かめられないため、所有者の確認を完了の条件にした。D-027）
- 新しい操作を追加するときは kind を決め、edit 以外の更新系なら除外の理由を登録する。新しい外部の作成物を追加するときは creation-matrix の状態管理に従う

## A案の要点（引き継ぎ。D-029）
- 共通 Setup はホスト型（`gas/manifests/setup-hosted.json`: USER_ACCESSING / ANYONE / exceptionLogging NONE）。コードは自己ホスト型と同一（ビルドで `dist/gas/setup-hosted/` にコピー）
- `scripts.run` は使わない（同じ標準 Cloud プロジェクトの共有が必要・トリガーを作れない）。Staff の初期化はテスト用 URL（/dev。編集者だけ）での `shiftlyWebInitialize`。確認コードは Setup の SecretRegistry.initCode（UserProperties）、Core の bootstrap には `initCodeHash` だけ。以前の Setup で始めた構築は Core の配置の前に発行
- 画面の分類コード: StepResult.error.code（SetupErrorCode）。USER_API_DISABLED のときだけ設定画面のボタンを出す
- 重複の確認（D-027 の所有者の確認）は維持。drive.file でプロジェクトを一覧できるかは L43 ④ で確認してから自動化を判断
- OAuth: 一般公開は審査の後。それまで限定公開（テストユーザー最大 100・承認 7 日）。スコープの分類は Cloud Console で要確認
- 公式資料（developers.google.com）は、この作業環境のネットワークの制限で原文を取得できず、検索結果の要約で確認した（docs/google-api-setup.md「出典」）

## 累計 Codex 監査回数
- **累計 24 回**（承認済みの上限 5 回。6〜24 回目はユーザーの指示で実施。20・21 回目は判定なしで中断。25 回目以降は未承認。A案の実装（2026-11-27）の後も実施していない）
  - 1 回目: 2026-11-24、対象 `50156ae`。開発コンテナに Codex CLI 0.167.0 を一時導入し、ユーザー本人がブラウザでデバイス認証。`codex exec --sandbox read-only`
  - 2 回目: 2026-11-25、対象 `564a04a`（v1.3 実装後）。Codex CLI 0.167.1、ユーザー本人のデバイス認証。指摘 10 件をすべて修正（docs/review-log.md C-2）
  - 3 回目: 2026-11-25、対象 `d132bd6`（C-2 の修正後の再監査）。C-2 の 6 件解消・4 件未解消＋新規 2 件 → 6 件をすべて修正（docs/review-log.md C-3）
  - 4 回目: 2026-11-25、対象 `12ea421`（C-3 の修正後の再監査）。C-3 の 4 件解消・2 件未解消＋新規 3 件 → 5 件をすべて修正（docs/review-log.md C-4）
  - 5 回目: 2026-11-25、対象 `d43d321`（C-4 の修正後の再監査）。重大 0 件。C-4 の 3 件解消・2 件未解消＋新規 1 件 → 3 件をすべて修正（docs/review-log.md C-5）
  - 6 回目: 2026-11-25、対象 `df70198`（マージ可否の判定）。**判定はマージ不可**。指摘 4 件（高 3 / 中 1）は、ユーザーの指示によりすべて修正（docs/review-log.md C-6）
  - 7 回目: 2026-11-25、対象 `7937e91`（C-6 の修正後のマージ可否の判定）。**判定はマージ不可**。C-6 の 2 件解消・2 件未解消。指摘 2 件（高 2）は、ユーザーの指示によりすべて修正（docs/review-log.md C-7）
  - 8 回目: 2026-11-25、対象 `56d402d`（C-7 の修正後のマージ可否の判定）。**判定はマージ不可**。C-7 の 2 件は解消。新規の指摘 3 件（高 2 / 中 1）は、ユーザーの指示により対応（#1・#3 はコード、#2 は手順書。docs/review-log.md C-8）
  - 9 回目: 2026-11-25、対象 `84af493`（C-8 の対応後のマージ可否の判定）。**判定はマージ不可**。C-8 の 1 件解消・2 件未解消。指摘 3 件（高 2 / 中 1）は、ユーザーの指示により対応（#1・#3 はコード、#2 は手順書。docs/review-log.md C-9・decisions.md D-022）
  - 10 回目: 2026-11-25、対象 `e616d04`（C-9 の対応の確認。対象を限定。マージ可否の判定ではない）。結果は一部未解消または回帰あり（C-9 の 3 件は一部未解消、回帰 2 件: 高 1 / 中 1）。ユーザーの指示によりすべて対応（docs/review-log.md C-10）
  - 11 回目: 2026-11-25、対象 `ae9a959`（C-10 の対応の確認。対象を限定）。C-10 の 3 件解消・2 件未解消。指摘 2 件（高 1 / 中 1）は、ユーザーの指示により対応（#1 はコード、#2 は手順書。docs/review-log.md C-11）
  - 12 回目: 2026-11-25、対象 `fb5603b`（C-11 の対応の確認。対象を限定）。C-11 の 2 件は解消。対応による回帰 3 件（高 1 / 中 2）は、ユーザーの指示により対応し、状態の組み合わせを網羅するテストを追加（docs/review-log.md C-12）
  - 13 回目: 2026-11-25、対象 `ede9758`（C-12 の対応の確認。対象を限定）。C-12 の 3 件は解消。対応による回帰 2 件（高 2）とテストの不足は、ユーザーの指示により版の組を明示的に記録する方式で対応（docs/review-log.md C-13・decisions.md D-023）
  - 14 回目: 2026-11-25、対象 `34ee228`（C-13 の対応の確認。対象を限定）。C-13 の指摘は解消。版の組の記録方式による回帰 3 件（高 2 / 中 1）は、ユーザーの指示により対応（docs/review-log.md C-14）
  - 15 回目: 2026-11-25、対象 `112259a`（C-14 の対応の確認。対象を限定）。C-14 の 3 件は解消。対応による回帰 1 件（中）は、ユーザーの指示により対応（docs/review-log.md C-15）
  - 16 回目: 2026-11-26、対象 `696b73f`（C-15 の対応の確認。対象を限定）。C-15 の 1 件は解消。対応による回帰 1 件（高）は「迷ったら止める」規則（D-024）で対応（docs/review-log.md C-16）
  - 17 回目: 2026-11-26、対象 `848b2c8`（全体のマージ可否の判定。締めくくり）。**判定はマージ不可**。指摘 3 件（高 1 / 中 2）は、ユーザーの指示により修正（docs/review-log.md C-17）
  - 18 回目: 2026-11-26、対象 `73c8059`（C-17 の修正後の全体のマージ可否）。**判定はマージ不可**。C-17 の 2 件解消・1 件未解消。マージ前 2 件（高 1 / 中 1）・次の版の前 1 件は、ユーザーの指示により修正（復元は Google 所有者に限定。docs/review-log.md C-18）
  - 19 回目: 2026-11-26、対象 `37649e8`（C-18 の修正後の全体のマージ可否）。**判定はマージ不可**。C-18 の 3 件は解消。マージ前 2 件（高 1 / 中 1）・次の版の前 1 件は、ループの分析（D-025）のうえ、不変条件ごとに全体を点検して修正（docs/review-log.md C-19）
  - 20 回目: 2026-11-26、対象 `ab17757`（C-19 の対応・ループの分析・独立した点検の後の全体のマージ可否）。**判定なしで中断**（OpenAI 側の内容の判定で打ち切り。docs/review-log.md C-20）
  - 21 回目: 2026-11-26、対象 `f2a8f59`（20 回目の言い換え版）。**判定なしで中断**（同じ理由。docs/review-log.md C-21）
  - 22 回目: 2026-11-26、対象 `3f8cdc9`（範囲を絞った判定: C-19 の指摘と R1・R2・S1）。**判定はマージ不可**。C-19 の 3 件は解消。マージ前 4 件（高 2 / 中 2）は、ユーザーの指示により仕組みで閉じる形で修正（docs/review-log.md C-22）
  - 23 回目: 2026-11-26、対象 `271ebdf`（C-22 の対応の確認。範囲を絞った判定）。**判定はマージ不可**。C-22 の 3 件解消・1 件未解消、R2 は成り立つ。マージ前 4 件（高 1 / 中 3）は未対応（docs/review-log.md C-23）
  - 24 回目: 2026-11-27、対象 `5d209d7`（C-23 の構造的な対応・D-026 の確認。範囲を絞った判定）。**判定はマージ不可**。C-23 の 4 件は解消、R2 は成り立つ。A 4 件（高 3 / 中 1）は、ユーザーの B案の指示により対応（A1・A3・A4 は機能を修正、A2 は仕様変更で実行経路を除外。Codex による再確認は未実施。docs/review-log.md「C-24 の対応」）

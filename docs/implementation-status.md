# 実装状況（F01〜F41）

> v1.3 のリリース範囲（B案。D-027）: 初回リリース対象 37・一部手動 2（F26・F35）・次期以降に延期 2（F36・F37）。分類の一覧は docs/requirements.md「v1.3 のリリース範囲」。延期した機能は実装済みとして数えない（「実装」欄は —）。

> **v1.3.0 初回リリース（2026-11-27、D-028）**: 版 1.3.0。実環境（Google・iPad 実機）は**未検証**のまま（docs/live-verification.md「0.1」の 14 項目が公開前に必須）。給与の手計算シナリオ（2.5）はモックで一致を確認（tests/integration/release-scenario.test.ts）。下の表の「実環境」列は、検証の結果を受け取るまで「未」

凡例: **実装** = コード実装済み ／ **自動テスト** = モック（メモリ環境）・エミュレーションでの自動テスト済み ／ **画面確認** = プレビュー上で Playwright による操作確認済み ／ **実環境** = Google 実環境・iPad 実機での確認（**現時点ですべて未実施**）

> 「実装完了」「実環境検証完了」「本番運用可能」は別。現時点は **実装（モック検証）段階**で、実環境検証・本番運用可能はいずれも未達。

| ID | 機能 | 主な実装 | 実装 | 自動テスト | 画面確認 | 実環境 |
|---|---|---|---|---|---|---|
| F01 | 初期設定・DB自動生成 | gas/platform.ts provisionStorage, handlers/system.ts initialize, gas/core.ts shiftlyAuthorize | ○ | ○（エミュ） | — | 未 |
| F02 | 店舗端末登録・管理 | auth.ts（登録コード・端末トークン・失効）, Devices.tsx, Staff 登録画面 | ○ | ○ | ○ | 未 |
| F03 | 管理者・スタッフ認証 | Admin 署名, PIN（PBKDF2+pepper）, セッション, ステップアップ。v1.3: PIN 任意（本人未確認セッション）・4〜12桁・段階的ロック延長 | ○ | ○ | ○ | 未 |
| F04 | スタッフ個別権限 | permissions.ts, api.ts 認可, Staff.tsx | ○ | ○ | ○ | 未 |
| F05 | スタッフ・雇用条件 | handlers/staff.ts, Staff.tsx, PayConditions.tsx（v1.3: スタッフ・権限の「時給ルール」「月給設定」から対象スタッフを固定して開く。独立したナビゲーションは廃止） | ○ | ○ | ○ | 未 |
| F06 | 出勤・退勤打刻 | attendance.punch（サーバー時刻・冪等・状態遷移）, Staff | ○ | ○ | ○ | 未 |
| F07 | 休憩管理 | v1.3: 予定休憩方式（標準。休憩ボタン非表示・退勤時に取得確認）／休憩打刻方式。予定休憩は取得を確認したものだけ控除、申告（取得なし・短縮・延長・時間帯違い・追加）、二重控除防止、休憩不足は警告のみ | ○ | ○ | ○ | 未 |
| F08 | 勤務時間・勤怠確認 | sessionsFor, attendance.list/mine, Attendance.tsx | ○ | ○ | ○ | 未 |
| F09 | 勤怠修正・修正履歴 | attendance.correct（原本不変・理由・修正者）, 紙タイムカード登録。v1.3: 確認状態・本人確認の有無の列を追加 | ○ | ○ | ○ | 未 |
| F10 | シフト作成・編集・公開 | handlers/shifts-leave.ts, Shifts.tsx | ○ | ○ | ○ | 未 |
| F11 | 遅刻・早退・欠勤検出 | notifications.ts, attendance.compareShifts（給与へ自動反映しない） | ○ | ○ | ○ | 未 |
| F12 | 個人・曜日・時間帯別時給 | wage.ts（優先度・矛盾検出・営業日基準）, payconf | ○ | ○ | ○ | 未 |
| F13 | 月給制 | payroll.ts（法定内残業・固定残業代・欠勤/遅刻早退控除は承認分のみ） | ○ | ○ | ○ | 未 |
| F14 | 給与計算 | labor.ts / payroll.ts（BigInt 有理数、法令ルールセット版管理）。v1.3: シフト基準の給与対象時間（F41） | ○ | ○（ゴールデン50件＋v1.3 期待値） | ○ | 未 |
| F15 | 交通費 | 未設定/なし/日額/月額/実費、上限 | ○ | ○ | ○ | 未 |
| F16 | 各種手当 | 頻度・期間・割増算定基礎（7種のみ除外可）・最低賃金算入 | ○ | ○ | ○ | 未 |
| F17 | 控除 | 手動入力、未入力と控除なしの区別 | ○ | ○ | ○ | 未 |
| F18 | 給与締め・確定・訂正 | 状態遷移・確定前チェック・スナップショット・訂正リビジョン | ○ | ○ | ○ | 未 |
| F19 | 給与明細PDF・本人閲覧 | payslip.ts, payslips.*（iPad は HTML 表示のみ、PDF は管理者端末） | ○ | ○ | ○（本人閲覧） | 未（PDF 変換未検証） |
| F20 | 有給休暇 | leave.ts（通常/比例付与・FIFO・時効・年5日）, Leave.tsx | ○ | ○ | ○ | 未 |
| F21 | アプリ内通知 | notifications.scan（重複防止・日次）, Notifications.tsx | ○ | ○ | ○ | 未 |
| F22 | 人件費分析 | analytics.ts（日・曜日・時間帯・スタッフ別、配賦、個人給与推定防止） | ○ | ○ | ○ | 未 |
| F23 | 人件費予算・実績・予測 | budgets.*, 着地予測（実績＋公開シフト） | ○ | ○ | ○ | 未 |
| F24 | CSV・Excel出力 | csv.ts / xlsx.ts、勤怠・給与・シフト・賃金台帳 | ○ | ○ | ○ | 未 |
| F25 | 監査ログ | audit()（PII・秘密情報なし）, Audit.tsx | ○ | ○ | ○ | 未 |
| F26 | バックアップ・復元（**一部手動**。D-027） | 日次/月次/手動バックアップ・世代管理・失敗の通知（ops.ts runBackup・scanNotifications）、Backup.tsx（復元のボタンなし・保守作業の案内）。**データの復元は Google 所有者の保守作業**（handlers/maintenance.ts。開始・終了と守る記録の照合）。アプリ内の復元・DB の切替は**延期**（サーバーで拒否） | ○（バックアップ・保守作業） | ○ | ○ | 未 |
| F27 | 店舗設定 | settings.*（給与規定の確認とリセット）, Settings.tsx | ○ | ○ | ○ | 未 |
| F28 | Googleアカウント連携 | Setup のアカウント確認・取り違え防止、Admin の本人認証 | ○ | ○（擬似） | ○（デモ） | 未 |
| F29 | 初期セットアップウィザード | SetupApp.tsx, installer.ts | ○ | ○（擬似） | ○（デモ） | 未 |
| F30 | GASプロジェクト自動生成 | apps-script-api.ts createProject | ○ | ○（擬似） | — | 未 |
| F31 | GASコード自動配置 | updateContent（SHA-256 検証・ブートストラップ生成）。初回の構築の範囲（構築済みの環境への再配置＝更新は F36 として延期） | ○ | ○（擬似） | — | 未 |
| F32 | GAS自動デプロイ | versions.create / deployments.create・update（初回の構築の範囲） | ○ | ○（擬似） | — | 未 |
| F33 | 既存環境の自動検出 | Registry（UserProperties＋Drive の記録ファイル。保存済み ID で直接照会・全ページ検索・環境 ID の照合。D-027）, Core の環境情報ファイル | ○ | ○（擬似・エミュ） | — | 未 |
| F34 | セットアップ中断・再開 | 工程ごとの冪等実行・進捗保存・再実行 | ○ | ○（擬似） | ○（デモ） | 未 |
| F35 | DB構造の自動更新（**一部手動**。更新は延期） | 初回の DB 構造の生成（initialize・シートの自動作成）は対象。**版の更新に伴う DB の自動移行（system.migrate・migrations.ts）は延期**（処理を削除し、サーバーで拒否） | ○（初回の生成） | ○ | — | 未 |
| F36 | アプリアップデート（**延期**） | v1.3 では提供しない（Setup の更新・定期的な自動更新を削除。setupApi・Core の操作は NOT_IN_THIS_RELEASE）。更新は Google 所有者の保守作業（docs/update-rollback.md） | — | ○（拒否のテスト） | ○（ボタンなし） | — |
| F37 | ロールバック・環境復旧（**延期**。復旧は手動） | 自動ロールバック・自動復旧は v1.3 では提供しない（処理を削除し、サーバーで拒否）。環境の復旧は Google 所有者の保守作業（maintenance.begin / finish、shiftlyResetSetupPairing・shiftlyResetAdminPairing） | — | ○（拒否のテスト） | ○（ボタンなし） | — |
| **F38** | 店舗 iPad の管理者モード（v1.3） | adminAuth.*（管理者パスワード・管理者セッション・再認証・変更/再設定）, api.ts（principal=admin・adminAllowed・reauth）, StaffApp（管理者ページ・管理者モード）, System.tsx（Google 所有者の設定画面） | ○ | ○ | ○ | 未 |
| **F39** | スタッフ本人の勤怠修正・休憩の申告（v1.3） | attendance.selfCorrect / myDetails / breaks.declare / attendance.review / reviewList, StaffApp「勤怠確認・修正」, Requests.tsx | ○ | ○ | ○ | 未 |
| **F40** | 早出・残業申請と管理者確認（v1.3） | overtime.request / mine / cancel / resubmit / list / review, overtime_request_history, Requests.tsx, 通知 | ○ | ○ | ○（一部） | 未 |
| **F41** | シフト基準の給与対象時間・シフト外勤務の確認（v1.3） | worktime.ts（A〜G）, services.payableSessionsFor, offshift.list / confirm, 給与の確定前チェック | ○ | ○（§9.2 の期待値） | ○（一部） | 未 |

画面確認: 各ページの実装担当がプレビュー上で主要操作を Playwright で実行（コンソールエラー0、1440px/390px で横スクロールなし）。加えて管理画面全16ページの巡回 E2E（tests/e2e/admin.spec.ts。v1.3 で「給与条件」を「申請・確認」に置き換え）と、店舗 iPad の管理者モード・PIN 未設定・退勤時の休憩確認・本人の勤怠修正の E2E（tests/e2e/staff.spec.ts）。F40/F41 の管理画面（申請の承認・シフト外勤務の一括確認）の操作は E2E 未自動化（API の統合テストで確認）。店舗 iPad の委任メニューでの追加認証を伴う操作は一部未確認。

## 既知の制約・未対応

- 変形労働時間制・フレックス・標準報酬日額方式・出来高払の割増算定・期間途中の日割は未対応（選択・該当時は給与確定を禁止）
- 時間単位年休は未対応（労使協定が必要なため）。半日単位は設定で許可した場合のみ
- 月給制スタッフの時間帯別人件費は配賦しない（日別まで）
- 管理者交代時の環境間データ移行の自動化はなし（手順のみ）
- Google 実環境・iPad 実機・WebKit での検証は未実施（docs/technical-verification.md §4）
- Codex 独立監査: 1 回目を実施（2026-11-24、指摘 15 件。14 件修正、#8 は v1.3 の休憩仕様で対応）。v1.3 実装後の監査は累計 2 回目（docs/review-log.md）
- v1.3: 管理者モードでは「システム・保守」と管理者パスワードの再設定はできない（Google 所有者の Shiftly-Admin で行う）
- v1.3（D-027）: アプリ内のデータの復元・稼働中の DB の切替・自動更新・更新に伴う DB の自動移行・自動ロールバックは提供しない（次期以降の候補）。障害時は Google 所有者の保守作業（docs/operations-guide.md「9」）。DB のファイル自体を失った場合など、保守作業で安全に戻せない障害は未解決として扱う
- v1.3: PIN 未設定のスタッフは、本人確認ができないため給与・明細・勤怠の詳細を店舗 iPad で確認できない（管理者が対面で確認して伝えるか、PIN を設定する）

## 既知の画面側の制約（API 追加で改善可能）
- シフトの週表示は月曜始まり固定（店舗の週の起算曜日はスタッフが参照できない）
- 勤務パターンの削除 API なし
- 半日年休の可否はサーバーのエラーで通知（スタッフ端末から店舗設定を参照できないため）

## テスト結果

（docs/HANDOFF.md に最新の実行結果を記録）

# 実装状況（F01〜F37）

凡例: **実装** = コード実装済み ／ **自動テスト** = モック（メモリ環境）・エミュレーションでの自動テスト済み ／ **画面確認** = プレビュー上で Playwright による操作確認済み ／ **実環境** = Google 実環境・iPad 実機での確認（**現時点ですべて未実施**）

> 「実装完了」「実環境検証完了」「本番運用可能」は別。現時点は **実装（モック検証）段階**で、実環境検証・本番運用可能はいずれも未達。

| ID | 機能 | 主な実装 | 実装 | 自動テスト | 画面確認 | 実環境 |
|---|---|---|---|---|---|---|
| F01 | 初期設定・DB自動生成 | gas/platform.ts provisionStorage, handlers/system.ts initialize, gas/core.ts shiftlyAuthorize | ○ | ○（エミュ） | — | 未 |
| F02 | 店舗端末登録・管理 | auth.ts（登録コード・端末トークン・失効）, Devices.tsx, Kiosk 登録画面 | ○ | ○ | ○ | 未 |
| F03 | 店長・スタッフ認証 | Admin 署名, PIN（PBKDF2+pepper）, セッション, ステップアップ | ○ | ○ | ○ | 未 |
| F04 | スタッフ個別権限 | permissions.ts, api.ts 認可, Staff.tsx | ○ | ○ | ○ | 未 |
| F05 | スタッフ・雇用条件 | handlers/staff.ts, Staff.tsx, PayConditions.tsx | ○ | ○ | ○ | 未 |
| F06 | 出勤・退勤打刻 | attendance.punch（サーバー時刻・冪等・状態遷移）, Kiosk | ○ | ○ | ○ | 未 |
| F07 | 休憩管理 | 打刻休憩・固定休憩（二重控除防止）・手動休憩、休憩不足検出 | ○ | ○ | ○ | 未 |
| F08 | 勤務時間・勤怠確認 | sessionsFor, attendance.list/mine, Attendance.tsx | ○ | ○ | ○ | 未 |
| F09 | 勤怠修正・修正履歴 | attendance.correct（原本不変・理由・修正者）, 紙タイムカード登録 | ○ | ○ | ○ | 未 |
| F10 | シフト作成・編集・公開 | handlers/shifts-leave.ts, Shifts.tsx | ○ | ○ | ○ | 未 |
| F11 | 遅刻・早退・欠勤検出 | notifications.ts, attendance.compareShifts（給与へ自動反映しない） | ○ | ○ | ○ | 未 |
| F12 | 個人・曜日・時間帯別時給 | wage.ts（優先度・矛盾検出・営業日基準）, payconf | ○ | ○ | ○ | 未 |
| F13 | 月給制 | payroll.ts（法定内残業・固定残業代・欠勤/遅刻早退控除は承認分のみ） | ○ | ○ | ○ | 未 |
| F14 | 給与計算 | labor.ts / payroll.ts（BigInt 有理数、法令ルールセット版管理） | ○ | ○（ゴールデン50件） | ○ | 未 |
| F15 | 交通費 | 未設定/なし/日額/月額/実費、上限 | ○ | ○ | ○ | 未 |
| F16 | 各種手当 | 頻度・期間・割増算定基礎（7種のみ除外可）・最低賃金算入 | ○ | ○ | ○ | 未 |
| F17 | 控除 | 手動入力、未入力と控除なしの区別 | ○ | ○ | ○ | 未 |
| F18 | 給与締め・確定・訂正 | 状態遷移・確定前チェック・スナップショット・訂正リビジョン | ○ | ○ | ○ | 未 |
| F19 | 給与明細PDF・本人閲覧 | payslip.ts, payslips.*（iPad は HTML 表示のみ、PDF は店長端末） | ○ | ○ | ○（本人閲覧） | 未（PDF 変換未検証） |
| F20 | 有給休暇 | leave.ts（通常/比例付与・FIFO・時効・年5日）, Leave.tsx | ○ | ○ | ○ | 未 |
| F21 | アプリ内通知 | notifications.scan（重複防止・日次）, Notifications.tsx | ○ | ○ | ○ | 未 |
| F22 | 人件費分析 | analytics.ts（日・曜日・時間帯・スタッフ別、配賦、個人給与推定防止） | ○ | ○ | ○ | 未 |
| F23 | 人件費予算・実績・予測 | budgets.*, 着地予測（実績＋公開シフト） | ○ | ○ | ○ | 未 |
| F24 | CSV・Excel出力 | csv.ts / xlsx.ts、勤怠・給与・シフト・賃金台帳 | ○ | ○ | ○ | 未 |
| F25 | 監査ログ | audit()（PII・秘密情報なし）, Audit.tsx | ○ | ○ | ○ | 未 |
| F26 | バックアップ・復元 | 日次/月次/更新前/手動、世代管理、復元（後続打刻の保持） | ○ | ○ | ○ | 未 |
| F27 | 店舗設定 | settings.*（給与規定の確認とリセット）, Settings.tsx | ○ | ○ | ○ | 未 |
| F28 | Googleアカウント連携 | Setup のアカウント確認・取り違え防止、Admin の本人認証 | ○ | ○（擬似） | ○（デモ） | 未 |
| F29 | 初期セットアップウィザード | SetupApp.tsx, installer.ts | ○ | ○（擬似） | ○（デモ） | 未 |
| F30 | GASプロジェクト自動生成 | apps-script-api.ts createProject | ○ | ○（擬似） | — | 未 |
| F31 | GASコード自動配置 | updateContent（SHA-256 検証・ブートストラップ生成） | ○ | ○（擬似） | — | 未 |
| F32 | GAS自動デプロイ | versions.create / deployments.create・update | ○ | ○（擬似） | — | 未 |
| F33 | 既存環境の自動検出 | Registry（UserProperties＋Drive レジストリ）, Core の環境情報ファイル | ○ | ○（擬似） | — | 未 |
| F34 | セットアップ中断・再開 | 工程ごとの冪等実行・進捗保存・再実行 | ○ | ○（擬似） | ○（デモ） | 未 |
| F35 | DB構造の自動更新 | migrations.ts, system.migrate（破壊的変更は承認制）、ヘッダー追加 | ○（枠組み。現時点で移行定義なし） | ○ | ○ | 未 |
| F36 | アプリアップデート | installer.applyUpdate（更新前バックアップ・URL維持） | ○ | ○（擬似） | ○（デモ） | 未 |
| F37 | ロールバック・環境復旧 | rollbackCode, backup.restore, system.resetSetupPairing | ○ | ○ | ○ | 未 |

画面確認: 各ページの実装担当がプレビュー上で主要操作を Playwright で実行（コンソールエラー0、1440px/390px で横スクロールなし）。加えて管理画面全16ページの巡回 E2E（tests/e2e/admin.spec.ts）。店舗 iPad の委任メニューでの追加認証を伴う操作は一部未確認。

## 既知の制約・未対応

- 変形労働時間制・フレックス・標準報酬日額方式・出来高払の割増算定・期間途中の日割は未対応（選択・該当時は給与確定を禁止）
- 時間単位年休は未対応（労使協定が必要なため）。半日単位は設定で許可した場合のみ
- 月給制スタッフの時間帯別人件費は配賦しない（日別まで）
- 店長交代時の環境間データ移行の自動化はなし（手順のみ）
- Google 実環境・iPad 実機・WebKit での検証は未実施（docs/technical-verification.md §4）
- Codex 独立監査は未実施（Codex CLI が環境にない）

## 既知の画面側の制約（API 追加で改善可能）
- シフトの週表示は月曜始まり固定（店舗の週の起算曜日はスタッフが参照できない）
- 勤務パターンの削除 API なし
- 半日年休の可否はサーバーのエラーで通知（スタッフ端末から店舗設定を参照できないため）

## テスト結果

（docs/HANDOFF.md に最新の実行結果を記録）

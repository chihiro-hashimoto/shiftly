# 技術的成立性の検証

> 区分: **【公式資料】** 公式資料（検索で確認した抜粋。原文の直接取得は不可）で確認した事実 ／ **【実装・自動テスト】** 本リポジトリのコードとテストで確認した事実 ／ **【GASエミュ】** ビルド済み GAS バンドルを模擬環境で実行して確認した事実 ／ **【未検証】** Google 実環境で未確認の事項
>
> 一次情報の出典一覧と信頼度の注意は `docs/research/official-sources.md` を参照。この開発環境のネットワーク許可リストの制約により、developers.google.com 等の**原文を直接取得できていない**（公式ドメインに限定した検索結果の抜粋で確認）。

## 0. 結論（2026-11-24 時点）

| 項目 | 判定 | 根拠・残課題 |
|---|---|---|
| 無料構成（GAS + Sheets + Drive、有料サービスなし） | 成立見込み | 【公式資料】割当（実行6分、UrlFetch 2万/日、トリガー90分/日 等）の範囲内の設計。実測は未実施 |
| Setup から GAS を自動作成・配置・デプロイ | 成立見込み（要実環境検証） | 【公式資料】projects.create → updateContent → versions.create → deployments.create で `entryPoints[].webApp.url` が返る。【実装・自動テスト】擬似 API で状態機械を検証。【未検証】実 API の応答 |
| 生成した GAS の権限承認 | **自動化不可（仕様）** | 管理者本人がスクリプトエディタで `shiftlyAuthorize` を 1 回実行する手動工程として設計（承認の迂回はしない）。Setup が工程を案内し、完了を自動確認 |
| Apps Script API の利用者設定 | **手動（仕様）** | 【公式資料】利用者ごとに Apps Script の設定で API をオンにする必要があり既定はオフ。Setup がエラーを検出して案内 |
| Setup の Cloud プロジェクト | 標準 Cloud プロジェクトが必要 | 【公式資料】デフォルトプロジェクトでは API を手動で有効化できない。Setup（配布者または管理者）が 1 回だけ標準プロジェクトを作成・Apps Script API を有効化（無料） |
| drive.file のみで業務 DB（Sheets）を操作 | 成立見込み（要実環境検証） | 【公式資料】Sheets API のスコープ一覧に drive.file が含まれる。SpreadsheetApp.openById は spreadsheets スコープが必要なため**使わず**、高度なサービス（Sheets API v4 / Drive API v3）で実装。【未検証】高度なサービス経由の実動作 |
| 高度なサービスの API 有効化 | 成立見込み | 【公式資料】デフォルト Cloud プロジェクトでは高度なサービス追加時に対応 API が自動有効化。【未検証】API でマニフェストに記載した場合も同様か |
| スタッフ用 Web アプリ（匿名アクセス・管理者として実行） | 成立見込み | 【公式資料】`ANYONE_ANONYMOUS` + `USER_DEPLOYING`。アクセス者のメールは取得できない前提でアプリ独自認証（端末トークン＋PIN） |
| 管理者用 Web アプリ（自分のみ） | 成立見込み | 【公式資料】`MYSELF`。Google が本人認証 |
| Admin → Core のサーバー間通信 | 成立見込み（要実環境検証） | HMAC-SHA256 署名＋時刻窓＋ノンス。【実装・自動テスト】【GASエミュ】で検証。【未検証】UrlFetch で匿名 Web アプリの doPost を呼んだ際のリダイレクト挙動 |
| 単一の更新経路と排他 | 成立 | 業務 DB への書き込みは Core のみ。`LockService.getScriptLock()`（同一スクリプト内で排他）【公式資料】。別プロジェクト間のロックには依存しない |
| PIN の安全な検証 | 成立 | 【実装・自動テスト】PBKDF2-HMAC-SHA256（RFC 8018、Node 実装・RFC 7914 ベクタと一致）＋ Script Properties の pepper ＋ 試行制限 |
| 乱数（トークン） | 条件付き | 【公式資料】`Utilities.getUuid()` は一意性保証なし・乱数品質の記載なし。複数 UUID を連結し SHA-256 で整形して使用。**暗号学的品質は未確認**（docs/security.md のリスク参照） |
| iPad Safari での端末トークン保持 | **要実機検証** | GAS の HtmlService は iframe（googleusercontent.com）で表示されるため、Safari の ITP（第三者ストレージの分割・期限）により localStorage が消える可能性。消えた場合は再登録で復旧（業務データは失われない） |
| v1.3 店舗 iPad の管理者モード | 成立見込み（要実機検証） | 【実装・自動テスト】管理者パスワード・管理者セッション（サーバー検証・無操作 5 分・再認証）を Core 内で実装。Google の追加の承認は不要（既存の Core の権限内）。【未検証】iPad Safari・ホーム画面アプリでの pagehide/visibilitychange/bfcache の挙動、GAS の iframe 内での入力欄（パスワードの自動入力・保存の提案の有無） |
| v1.3 PIN 任意化・シフト基準・申請 | 成立（ロジック） | 【実装・自動テスト】モックで検証。【未検証】GAS 上の処理時間（申請・確認の一覧は直近 31〜62 日の勤怠を再構築するため、人数・期間による実行時間の実測が必要） |
| 給与明細 PDF 生成 | 要実環境検証 | `Utilities.newBlob(html).getAs('application/pdf')` を使用。日本語フォントの描画品質は未確認。不可の場合も画面表示・印刷で代替可能 |

## 1. 採用アーキテクチャと検証済み/未検証の対応

```
[店舗 iPad] ──google.script.run──> [Shiftly-Staff (Core)] ──Sheets API/Drive API (drive.file)──> [管理者の Drive: Shiftly/]
  端末トークン＋PIN                    匿名アクセス・管理者として実行          唯一の書き込み経路・LockService
                                       ▲ doPost（HMAC 署名: admin / setup 役割）
[管理者の PC/スマホ] ──google.script.run──> [Shiftly-Admin] ─UrlFetch─┘
  Google 本人認証（アクセス=自分のみ）
[Shiftly Setup] ──Apps Script API（管理者の OAuth）──> Staff/Admin の作成・コード配置・デプロイ・更新
```

詳細は `docs/architecture.md`。

## 2. 公式資料で確認した主要事項（抜粋）

| 確認事項 | 内容 | 出典 |
|---|---|---|
| Apps Script API | projects.create / updateContent（全置換）/ versions.create / deployments.create・update。deployment に `entryPoints[].webApp.url` | official-sources.md §1 |
| API の利用者設定 | 既定オフ。利用者が設定でオン | §2 |
| scripts.run | 標準 Cloud プロジェクトの共有・API 実行可能デプロイが必要 → **本設計では使用しない**（Web アプリの doPost を使用） | §2 |
| デフォルト/標準 Cloud プロジェクト | 高度なサービスの API 自動有効化はデフォルトのみ | §3 |
| スコープ | drive.file は非機密・ファイル単位。drive は制限付き。spreadsheets は機密。openById は spreadsheets が必要 | §4 |
| Web アプリ | IFRAME のみ。USER_DEPLOYING ではアクセス者のメール取得不可 | §5 |
| 割当 | 6分/実行、同時30/ユーザー、トリガー90分/日、UrlFetch 2万/日、Properties 9KB/値・500KB、Cache 100KB・最長6時間 | §6 |
| Sheets API の分単位の割当 | **未確認**。Codex 監査1 #15 は「書き込み 1 ユーザー毎分60回」を前提にしたが、公式ページ（developers.google.com/workspace/sheets/api/limits）はこの開発環境から取得できず未確認。書き込み呼び出しは 1 人分（ログイン→打刻→ログアウト）で 15 回 → 9 回以下に削減済み（GAS エミュレーションで計測）。実環境で開店・閉店時の集中を測定する（live-verification.md L8） | — |
| LockService | getScriptLock は実行ユーザーにかかわらず同一スクリプト内で排他 | §7 |
| OAuth 同意 | テスト状態はテストユーザー100人・7日で失効。未検証アプリは新規100人まで。個人用途は検証不要 | §8 |
| Drive 容量 | 15GB を Gmail・フォトと共有 | §10 |
| GitHub Pages | Free の非公開リポジトリでは利用不可。商用 SaaS・機密情報のやり取りには使用不可 → **不採用** | §11 |
| GitHub Actions | Free で約2,000分/月相当（非公開リポジトリ） | §12 |

## 3. 自動テスト・エミュレーションで確認した事項

| 項目 | テスト | 結果 |
|---|---|---|
| Core API 全体（約85操作）の業務フロー | tests/integration/flow.test.ts | 合格 |
| 認証・認可・IDOR・リプレイ・総当たり | tests/security/api-security.test.ts | 合格 |
| Setup 状態機械（重複防止・中断再開・取り違え防止・改ざん検知・完了の条件。更新・ロールバックは v1.3 では提供しない。D-027） | tests/integration/installer.test.ts | 合格 |
| ビルド済み GAS バンドルの動作（Sheets/Drive/Properties/Cache/Lock/Utilities を模擬） | tests/integration/gas-emulation.test.ts | 合格（**模擬環境であり Google 実環境ではない**） |
| 給与計算（手計算の独立期待値） | tests/unit/payroll.golden.test.ts | 合格 |
| Staff/Setup 画面（Chromium、iPad 横縦・PC・スマホ幅） | tests/e2e | 合格（**WebKit・iPad 実機ではない**） |

## 4. 未検証事項（本番前に Google 実環境・実機で確認が必要）

1. Apps Script API の実応答（deployments.create の entryPoints、deployments.update 後に Web アプリ URL が変わらないこと）
2. API で作成したプロジェクトのマニフェスト（高度なサービス・oauthScopes・webapp）の反映と、デフォルト Cloud プロジェクトでの Sheets/Drive API の自動有効化
3. drive.file スコープで、高度なサービス経由の Sheets API 読み書き・Drive ファイル作成/コピー/一覧・About.get（容量取得）が動作すること
4. `shiftlyAuthorize` をエディタで実行した後、匿名 Web アプリ（管理者として実行）が承認済みスコープで動作すること
5. Admin（UrlFetch）→ Core（匿名 Web アプリ doPost）の POST → 302 リダイレクト → 応答取得
6. `Utilities.newBlob(html).getAs('application/pdf')` の日本語描画
7. iPad Safari（ホーム画面追加を含む）での localStorage（端末トークン）の保持期間、bfcache・タブ復帰時の挙動、印刷
8. 性能（打刻 3 秒以内などの目標値）: GAS のコールドスタートと Sheets API 呼び出し回数に依存。未計測
   - 保守作業の開始・終了（D-027）は全表・全月のシートを 1 回の実行で読み、全行のハッシュを計算する。数年分の打刻・監査ログで GAS の実行時間の上限（6 分）に近づかないかは未計測（docs/live-verification.md L22 で時間を記録する）
9. Sheets のセル上限（資料により 1,000万/2,000万セルで食い違い）。設計は 1,000万セル以下を前提（月別パーティションで 1 シートの肥大化を回避）
10. 時間主導トリガー（日次 4 時台）の実行と 90 分/日の上限に対する実行時間
11. Setup をホスト型（実行=アクセスしたユーザー）で運用する場合の OAuth 同意画面（未確認アプリ表示・100人上限）の実際の表示

## 4.5 v1.3.0 初回リリースの時点の状態（2026-11-27）

| 区分 | 状態 |
|---|---|
| 自動テスト（モック・GAS エミュレーション・Chromium の E2E） | 合格（PR #2 の CI。件数は docs/HANDOFF.md「テスト結果」） |
| 給与の手計算シナリオ（live-verification.md「2.5」） | **モックで一致を確認**（tests/integration/release-scenario.test.ts）。実環境は未 |
| Google 実環境（Apps Script・Sheets・Drive・承認） | **未実施**（live-verification.md「0.1」の 14 項目と L24〜L26 が公開前に必須） |
| iPad 実機（Safari・ホーム画面） | **未実施** |
| 依存関係の脆弱性（`npm audit`） | 実行時の依存（react・react-dom・qrcode-generator）は 0 件（`npm audit --omit=dev`）。moderate 8 件は開発時だけの依存（eslint・typescript-eslint が使う minimatch）で、配布物（GAS のバンドル・画面）には含まれない。無関係な依存の一括更新はしない |

## 5. 実環境検証の手順（ユーザー承認後に実施）

本番アカウントと区別した**検証用 Google アカウント**で、`docs/installer-guide.md` の手順に沿って Setup を実行し、上記 1〜11 を確認して本書に「実測結果」を追記する。検証用環境には実在スタッフの情報を登録しないこと。

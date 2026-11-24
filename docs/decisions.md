# 設計判断記録（ADR）

各判断は「背景 → 決定 → 代替案 → 影響」で記録する。ユーザー承認が必要なものは明記。

## D-001 対象リポジトリ
- 背景: 指示書の Repository は `chihirohashimotoac-coder/shiftly`。本セッションで操作権限があるのは `chihiro-hashimoto/shiftly`（Private・push 可）のみ
- 決定: `chihiro-hashimoto/shiftly` で作業。別リポジトリの新規作成・公開設定の変更はしていない
- 影響: **ユーザー確認事項**（同一リポジトリか、移管の必要があるか）

## D-002 セットアップ配信方式: GAS の Setup Web アプリ（GitHub Pages は不採用）
- 背景: GitHub Free の非公開リポジトリでは Pages を使えず、Pages は商用 SaaS・機密情報のやり取りに使用不可（official-sources §11）
- 決定: Setup を GAS Web アプリとして配布。2 方式: (A) 自己ホスト（店長アカウントに Setup を 1 つ置く。clasp またはファイル貼り付け 1 回）、(B) ホスト型（配布者アカウントで「実行=アクセスしたユーザー」）
- 代替案: ローカル起動（Node が必要で店長負担大）、Pages（不可）
- 影響: Apps Script API の呼び出しには Setup に紐づく**標準 Cloud プロジェクト**（無料）での API 有効化が必要（1 回のみ）

## D-003 Core を Shiftly-Kiosk に同居（共通バックエンド用 GAS は分けない）
- 背景: 更新経路の一本化が必須。Admin（アクセス=自分のみ）を Core にすると、匿名の Kiosk からのサーバー間呼び出しに drive スコープ付きトークンが必要になる
- 決定: Core（業務 DB の唯一の更新者）を匿名アクセスの Kiosk プロジェクトに置き、Admin は HMAC 署名で Core に転送
- 代替案: 3 プロジェクト（Core / Admin / Kiosk）→ 打刻ごとに UrlFetch が増え遅延増、承認工程も 3 回
- 影響: 公開エンドポイントは全操作で認証・認可（URL を知っていれば呼べる前提）。セキュリティテストで全 op を検査

## D-004 drive.file スコープ ＋ 高度なサービス（SpreadsheetApp は不使用）
- 背景: SpreadsheetApp.openById は `spreadsheets`（全スプレッドシート）スコープが必要。店長の無関係なファイルの保護が必須
- 決定: Core は drive.file のみ。DB・フォルダは Core 自身が作成し、Sheets API v4 / Drive API v3 の高度なサービスで操作
- 影響: 【未検証】実環境での動作（docs/technical-verification.md §4）

## D-005 Admin・Setup と Core のペアリング
- 決定: Setup が生成したブートストラップ（Core: ペアリングコードの SHA-256 のみ、Admin: 使い捨てコード）で初回に HMAC 鍵を交換し、各プロジェクトの Script/User Properties に保存。Setup 鍵は更新関連の操作のみ許可（最小権限）
- 理由: 長期秘密をソースコードに埋め込まない。API で別プロジェクトの Script Properties は設定できない

## D-006 GAS の権限承認は店長のエディタ実行（shiftlyAuthorize）
- 背景: API でのデプロイ成功と実行権限の承認は別。承認の自動化はできず、すべきでない
- 決定: Setup が該当工程で停止し、エディタを開くボタンと手順を表示。ping で完了を自動確認

## D-007 PIN 保護方式
- 決定: PBKDF2-HMAC-SHA256（反復 1,000、16 バイト salt）に、DB・バックアップと分離した pepper（Script Properties）を HMAC で結合。個人 5 回失敗で 15 分ロック、端末単位で 15 分 20 回の上限
- 理由: 6 桁 PIN はハッシュ単体ではオフライン総当たりに耐えないため、秘密鍵の分離とオンライン試行制限を主防御とする
- 未確認: GAS 上の PBKDF2 実行時間（反復回数は実測後に調整）

## D-008 金額計算は BigInt 有理数、端数処理は項目合計で 1 回
- 理由: 浮動小数点誤差の排除。日々の切捨て禁止（official-sources §16）。30 分単位の丸めは行わない（常に分・秒単位で計算）

## D-009 未対応の制度・未設定条件は確定禁止（フォールバックしない）
- 変形労働時間制等、標準報酬日額方式、出来高払の割増算定、期間途中の日割（規定未確認）は blocking

## D-010 XLSX は自前実装（SheetJS 等を導入しない）
- 理由: GAS・ブラウザ両対応、依存ライブラリのサプライチェーン・ライセンスリスク回避。openpyxl で読めることをテストで確認

## D-011 プレビューはモックデータのブラウザ内実行 ＋ CI Artifacts
- 背景: 非公開リポジトリのため無料・安全な公開ホスティングがない（Pages 不可）
- 決定: `npm run build:preview` の成果物（dist/preview）を GitHub Actions の Artifacts（リポジトリ権限者のみ）として保存。ローカルでは `npm run preview`

## D-012 共用 iPad での給与明細は HTML 表示のみ
- 理由: PDF のダウンロード・ブラウザキャッシュによる残存を避ける。PDF は店長端末（payslips.pdf は店長専用）

## D-013 依存パッケージの版
- 公開後 2 週間以上経過した版に固定（package.json は完全一致指定）。npm の arborist 不具合回避のため `.npmrc` に legacy-peer-deps（ピア依存は手動確認済み）
- TypeScript は typescript-eslint の対応範囲（<6.1）に合わせ 6.0.2

# Shiftly 成立性検証: 公式資料調査メモ

- 調査日: 2026-11-24
- 対象: GAS + Google Sheets + Google Drive の無料構成、GitHub Pages/Actions、日本の労働法・税
- 出典は公式ドメイン（developers.google.com / support.google.com / docs.github.com / mhlw.go.jp 配下 / check-roudou.mhlw.go.jp / nta.go.jp）に限定。

## 0. 調査方法と信頼度の注意（必読）

- **本文の直接取得（WebFetch）はすべて「取得失敗」**。この調査環境のネットワーク許可リストに含まれていないため、以下のホストは名前解決できなかった:
  `developers.google.com` / `support.google.com` / `docs.github.com` / `www.mhlw.go.jp` / `elaws.e-gov.go.jp`。
  （nta.go.jp・check-roudou.mhlw.go.jp も同じ制約下にあると判断し、直接取得は試していない。）
- 代わりに **WebSearch（対象ドメインに限定）を使い、公式ページの検索結果要約と抜粋で事実を確認した**。下の「出典URL」は検索結果に実際に出てきた公式ページの URL で、存在は確認できている。一方、本文は抜粋と要約でしか見ていない。
- そのため、本書の「確認した事実」は **検索結果に出た公式ページ抜粋で裏付けられた事実**を意味する。実装前に、重要な数値（割当、上限、法定日数）は原文で再確認すること（推奨: 調査環境の許可リストに上記ドメインを追加して再取得する）。
- 検索抜粋で裏付けが取れなかったものは「未確認」と明記した。
- e-Gov 法令検索（elaws）の条文原文は取得できなかった。条文の内容は厚生労働省と各労働局の解説ページで確認している。

---

## [Google]

### 1. Apps Script API（projects / versions / deployments）と manifest の webapp 設定

**確認した事実**
- `projects.create`: `POST /v1/projects`。本文は `title`（任意）と `parentId`（任意。Drive ファイルにバインドする場合に指定）。省略するとスタンドアロンスクリプトになる。基本 manifest だけを持つ空のプロジェクトが作られる。
- `projects.updateContent`: `PUT /v1/projects/{scriptId}/content`。本文は `files[]` で、`appsscript`（JSON 型の manifest）を必ず含める。**既存ファイルは全置換される**ため、公式ガイドは「getContent → 編集 → updateContent」の手順を推奨している。
- `projects.versions.create`: `POST /v1/projects/{scriptId}/versions`。現在のコードから不変のバージョンを作る。
- `projects.deployments.create`: `POST /v1/projects/{scriptId}/deployments`。本文は `versionNumber`・`manifestFileName`・`description` のみ。**レスポンスの Deployment に `entryPoints[]` が含まれ、`entryPoints[].webApp.url`（WebAppEntryPoint.url）と `entryPointConfig`（WebAppConfig: access / executeAs）が返る**。必要スコープは `https://www.googleapis.com/auth/script.deployments`。
- `projects.deployments.update`: `PUT .../deployments/{deploymentId}`。本文は `deploymentConfig`（`scriptId`, `versionNumber`, `manifestFileName`, `description`）。
- manifest の `webapp.access` は `MYSELF` / `DOMAIN` / `ANYONE` / `ANYONE_ANONYMOUS` の4値。MYSELF は「デプロイしたユーザーのみ（スクリプトのオーナーとは限らない）」、ANYONE_ANONYMOUS は「ログインしていないユーザーも含めて誰でも」。
- manifest の `webapp.executeAs` は `USER_ACCESSING`（アクセスしたユーザーとして実行）/ `USER_DEPLOYING`（デプロイしたユーザーとして実行。オーナーとは限らない）。

**出典URL**
- https://developers.google.com/apps-script/api/reference/rest
- https://developers.google.com/apps-script/api/reference/rest/v1/projects
- https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent
- https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments
- https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments/create
- https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments/update
- https://developers.google.com/apps-script/api/how-tos/manage-projects
- https://developers.google.com/apps-script/manifest/web-app-api-executable （依頼にあった `/manifest/web-app` は、検索ではこの URL として出てきた）

**未確認/注意**
- `versions.create` のリクエスト本文の項目（description など）は抜粋に出てこなかった。**未確認**。
- `deployments.update` で versionNumber を差し替えても Web アプリ URL が変わらないこと: **未確認**（設計上の前提にするなら原文で確認）。
- `deployments.get` も同じ構造で entryPoints を返すと推定されるが、**未確認**。
- access と executeAs の組み合わせの制約（例: `ANYONE_ANONYMOUS` と `USER_ACCESSING` を併用できるか）は**未確認**。

### 2. Apps Script API を呼ぶための前提条件と scripts.run の制約

**確認した事実**
- 利用者ごとに、Apps Script ダッシュボードの **Settings パネルで「Google Apps Script API」をオンにする**必要がある。**既定はオフ**で、オンにすると、承認したサードパーティアプリがそのユーザーのスクリプトとデプロイを変更できるようになる。
- 呼び出し元の Cloud プロジェクトで Apps Script API を有効化する必要がある（各クイックスタートの手順）。
- **Apps Script API はサービスアカウントに対応していない**（API の Introduction と execute ガイドに警告がある）。
- `scripts.run` の要件:
  - スクリプトが **API 実行可能（API executable）としてデプロイ**されていること。
  - 呼び出し元とスクリプトが**同じ「標準」Cloud プロジェクト**を共有していること（デフォルトプロジェクトでは不可）。違うと 403 PERMISSION_DENIED になる。
  - OAuth トークンが、呼ぶ関数だけでなく**スクリプト全体が使うスコープ**をすべて含むこと。
  - 認可を必要としないスクリプトは実行できない。
  - 受け渡せる値は基本型（文字列、数値、真偽値、配列、オブジェクト）のみ。
  - 最大6分程度かかることを想定する。

**出典URL**
- https://developers.google.com/apps-script/guides/dashboard
- https://developers.google.com/apps-script/api/quickstart/js
- https://developers.google.com/apps-script/api/concepts
- https://developers.google.com/apps-script/api/how-tos/execute
- https://developers.google.com/apps-script/api/reference/rest/v1/scripts/run

**未確認/注意**
- URL `https://script.google.com/home/usersettings` そのものは公式ページの抜粋に出てこなかった。**未確認**（ダッシュボードの Settings パネルであることまでは確認済み）。

### 3. デフォルト Cloud プロジェクトと標準 Cloud プロジェクト

**確認した事実**
- **デフォルトプロジェクト**: Apps Script が自動で作る。高度なサービス（Advanced Services）を追加すると、**対応する API が自動で有効化される**（advanced ガイドの記述は「デフォルトプロジェクトならこの手順は不要」）。ただし、デフォルトプロジェクトでは API を自分で有効化できず、OAuth 同意画面も設定できない。
- **標準プロジェクト**: 高度なサービスを使う場合、対応 API を**手動で有効化**する必要がある。
- デフォルトから標準へは切り替えられるが、**戻せない**。切り替え後は、高度なサービスに対応する API を新しいプロジェクトで改めて有効化する必要がある。
- `scripts.run`、ブランド検証、機密/制限付きスコープの本番検証には**標準プロジェクトが必要**。

**出典URL**
- https://developers.google.com/apps-script/guides/cloud-platform-projects
- https://developers.google.com/apps-script/guides/services/advanced
- https://developers.google.com/apps-script/guides/client-verification

**未確認/注意**
- 特になし（上記は複数の公式ページで一致していた）。

### 4. oauthScopes の明示指定と drive.file

**確認した事実**
- manifest の最上位 `oauthScopes` にスコープを明示指定できる（明示した場合だけ manifest に現れる）。
- `drive.file` は「アプリが作成したファイル、またはユーザーがそのアプリで開いたファイル（Picker で選んだファイルなど）」だけにアクセスできる**ファイル単位のスコープ**。分類は**非機密（non-sensitive）**。
- フル `drive` スコープは**制限付き（restricted）**。この区分の検証にはセキュリティ評価が必要。
- `spreadsheets` スコープは**機密（sensitive）**。
- **`SpreadsheetApp.openById` に必要なスコープは `https://www.googleapis.com/auth/spreadsheets` だけ**と記載されている（`currentonly` などの狭い代替は載っていない）。→ **GAS の SpreadsheetApp では drive.file だけでは openById できない**と読める。
- `spreadsheets.currentonly` が使えるのは Apps Script サービス（バインドされたシートなど）だけで、Advanced Services や REST の直接呼び出しには効かない。
- Sheets API v4（REST）の `spreadsheets.get` などは、受け付けるスコープの一覧に `drive.file` を含む。Sheets の権限は**ファイル（スプレッドシート）単位**で、シート単位には絞れない。

**出典URL**
- https://developers.google.com/workspace/add-ons/concepts/workspace-scopes
- https://developers.google.com/workspace/sheets/api/scopes
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet-app
- https://developers.google.com/apps-script/concepts/scopes
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get

**未確認/注意**
- 「Sheets API v4 を drive.file だけで呼び、自分が作ったスプレッドシートを読み書きできる」ことは、スコープ一覧に drive.file が含まれる点から**ほぼ確実と推定**するが、実際に読み書きできるかは**未確認**（実機での検証を推奨）。
- GAS 内で Advanced Sheets Service（Sheets API）と drive.file を組み合わせて openById の代わりにする構成が通るかは**未確認**。

### 5. Web アプリ（doGet/doPost、HtmlService、google.script.run、getActiveUser）

**確認した事実**
- `doGet(e)` または `doPost(e)` を持ち、HtmlOutput か TextOutput を返すスクリプトは Web アプリとして公開できる。
- HtmlService の **NATIVE と EMULATED は廃止済みで、IFRAME のみ**。`setSandboxMode` を呼んでも効果はない。IFRAME の制約: リンクの target は `_top` か `_blank`、スクリプトや外部 CSS は HTTPS で読み込む、トップレベルナビゲーションは制限される。
- `google.script.run` は**非同期**で、結果は成功ハンドラに渡される。受け渡しできる型はプリミティブと、それで構成されたオブジェクト・配列。**Date・Function・DOM 要素（form 以外）は不可**。form を渡せるのは唯一の引数のときだけ。**名前が `_` で終わるサーバー関数は private** で、クライアントから呼べない。
- `Session.getActiveUser().getEmail()` は、セキュリティポリシーで識別情報へのアクセスが許されないと**空文字**を返す。**「自分として実行（execute as me = USER_DEPLOYING）」の Web アプリでは、アクセスしたユーザーのメールは取得できない**（単純トリガーやカスタム関数でも同様）。この場合 `getEffectiveUser()` はデプロイしたユーザーになる。
- 信頼できない HTML の出力には `appendUntrusted`（コンテキストに応じたエスケープ）が用意されている。

**出典URL**
- https://developers.google.com/apps-script/guides/web
- https://developers.google.com/apps-script/guides/html/restrictions
- https://developers.google.com/apps-script/reference/html/sandbox-mode
- https://developers.google.com/apps-script/guides/html/communication
- https://developers.google.com/apps-script/guides/html/reference/run
- https://developers.google.com/apps-script/reference/base/session
- https://developers.google.com/apps-script/reference/base/user
- https://developers.google.com/apps-script/reference/html/html-output

**未確認/注意**
- consumer（@gmail.com）アカウントが USER_ACCESSING で別ユーザーとして使う場合に `getActiveUser().getEmail()` が取れるかは、抜粋では明示がなく**未確認**（実機での確認が必要）。
- GitHub Pages など外部オリジンから GAS Web アプリへ fetch したときの CORS とリダイレクトの挙動は**未調査/未確認**。

### 6. 割り当て・上限（consumer アカウント）

**確認した事実**（quotas ページ。「予告なく変更されることがある」「ユーザー単位で、最初のリクエストから24時間でリセットされる」と記載）
- スクリプト実行時間: **6分/実行**
- 同時実行数: **30/ユーザー**、**1,000/スクリプト**
- トリガーの合計実行時間: **90分/日（consumer）**、6時間/日（Workspace）
- UrlFetch の呼び出し回数: **20,000回/日（consumer）**
- Properties の値サイズ: **9KB/値**、合計 **500KB/プロパティストア**
- 単純トリガーの実行上限: 30秒
- CacheService: 値は **100KB/キーまで**、有効期限は **1〜21,600秒（6時間）**、既定は600秒。項目数の上限は **1,000**（超えると期限が遠い900件が残る）。有効期限は「目安」で、早く消えることがある（null の処理が必要）。

**出典URL**
- https://developers.google.com/apps-script/guides/services/quotas
- https://developers.google.com/apps-script/reference/cache/cache
- https://developers.google.com/apps-script/reference/cache/cache-service
- https://developers.google.com/apps-script/guides/triggers
- https://support.google.com/drive/answer/37603 （Sheets のセル上限）

**未確認/注意**
- **Sheets のセル上限は資料ごとに食い違っている**。Drive ヘルプ（answer/37603）の抜粋は「**最大 2,000万セルまたは 100MB**」。AppSheet ヘルプやコミュニティでは「1,000万セル」と書かれている。依頼にあった「1000万セル」は公式ページでは裏付けが取れず、**未確認**。設計は**保守的に 1,000万セル以下**を前提にし、原文を再確認すること。
- 検索キャッシュの版によって「トリガー合計実行時間」の行の有無が違った。90分/日は原文で再確認が必要。

### 7. LockService / Utilities

**確認した事実**
- `LockService.getScriptLock()`: **実行ユーザーにかかわらず**、同じスクリプトのコード区間が同時に実行されるのを防ぐ。`getUserLock()` は同じユーザーの同時実行だけを防ぐ。`getDocumentLock()` はドキュメント単位。ロックは `tryLock` / `waitLock` を呼んだ時点で取得される。
- `Utilities.computeHmacSha256Signature(value, key[, charset])`: byte[] を返す。文字列とバイト配列の両方の入力を受け付ける。
- `Utilities.computeDigest(algorithm, value[, charset])`: MD5 / SHA_1 / SHA_256 / SHA_384 / SHA_512。
- `Utilities.getUuid()`: `java.util.UUID.randomUUID()` 相当の文字列を返す。公式に「**時間と空間のすべてにわたって一意であることは保証されない**ので、一意性が保証されなければならない場面では使わないこと」という注意書きがある。
- V8 ランタイムには Crypto モジュールがなく、ハッシュなどには Utilities を使う。

**出典URL**
- https://developers.google.com/apps-script/reference/lock/lock-service
- https://developers.google.com/apps-script/reference/lock/lock
- https://developers.google.com/apps-script/reference/utilities/utilities
- https://developers.google.com/apps-script/guides/v8-runtime

**未確認/注意**
- getScriptLock が「スクリプトプロジェクト単位」であることは「同じスクリプトのコード区間」という記述から推定できるが、「プロジェクト単位」という文言そのものは**未確認**。
- getUuid の乱数品質（暗号論的に安全な乱数か）についての記載は見つからなかった。**未確認**。セッショントークンなど推測されては困る値には、getUuid だけに頼らない設計を推奨。

### 8. OAuth 同意画面・未確認アプリ・検証

**確認した事実**
- 公開ステータスが「**テスト**」の場合、テストユーザーは**最大100人**（追加した時点で枠を消費する）。テストユーザーの認可は**同意から7日で失効**し、refresh token も無効になる。例外は openid / email / profile のみを要求する場合。
- 本番公開しても**未検証のアプリ**は「未確認のアプリ」画面が表示され、**検証が終わるまで新規ユーザーは100人まで**に制限される。
- 「個人用途」（共有しない、または利用者が自分の知っている100人未満）なら検証は不要とされる。ただし100人を超えるには検証が必要。開発・テスト段階でも検証は不要。
- Apps Script: **オーナーと利用者が同じ Workspace ドメインなら検証は不要**。ドメイン外の利用者には未確認アプリ画面が出て、人数にも上限がある。機密/制限付きスコープの検証を申請するには**標準 Cloud プロジェクトへの切り替えが必要**。
- 開発中は「詳細 → {プロジェクト名}（安全ではないページ）に移動」で警告を回避できる。
- 審査期間の目安: 機密スコープは約10営業日、制限付きスコープは約6週間（FAQ）。

**出典URL**
- https://support.google.com/cloud/answer/15549945 （Manage App Audience）
- https://support.google.com/cloud/answer/7454865 （Unverified apps）
- https://support.google.com/cloud/answer/13464323 （When is verification not needed）
- https://support.google.com/cloud/answer/13463817 （FAQ）
- https://developers.google.com/apps-script/guides/client-verification
- https://developers.google.com/identity/protocols/oauth2/policies
- https://developers.google.com/identity/protocols/oauth2/production-readiness/overview

**未確認/注意**
- 依頼にあった https://support.google.com/cloud/answer/10311615 は検索結果に出てこなかった（**取得失敗/未確認**）。同じ内容は answer/15549945 などで確認した。
- consumer アカウントで作った GAS（デフォルトプロジェクト）を、他店の従業員が「USER_ACCESSING」で使うと、各自に未確認アプリ画面と100人上限がかかる。この構成での細かい挙動は**未確認**。

### 9. Google Identity Services（token model）

**確認した事実**
- token model はブラウザ専用のライブラリで、**OAuth 2.0 の implicit grant フローがベース**。`initTokenClient()` に client ID とスコープを渡し、`requestAccessToken()` で同意を求めてアクセストークンを得る。
- トークンは**短命**で、`TokenResponse.expires_in`（秒）で有効期限が示される。**refresh token は発行されず、バックグラウンドでの自動更新もない**。期限が切れたら、ユーザー操作（ボタン押下など）から再度 `requestAccessToken()` を呼ぶ。トークンはブラウザに保存されない。
- 期限切れまたは失効したトークンを使うと API は 401（invalid_token）を返す。
- Google の別のページ（OIDC reference / YouTube ガイド）では、implicit flow（response_type=token）は**推奨されず**、SPA には Authorization Code + PKCE を勧めている。

**出典URL**
- https://developers.google.com/identity/oauth2/web/guides/use-token-model
- https://developers.google.com/identity/oauth2/web/guides/migration-to-gis
- https://developers.google.com/identity/oauth2/web/reference/js-reference
- https://developers.google.com/identity/oauth2/web/guides/how-user-authz-works
- https://developers.google.com/identity/openid-connect/reference

**未確認/注意**
- 「**クライアントシークレットは不要**」と明記した文は見つからなかった（サンプルは client_id だけを使っている）。**未確認（ほぼ確実と推定）**。
- 有効期限が「1時間（3600秒）」であることは、他の Google API ドキュメントの記述から推定できるが、GIS token model についての明記は**未確認**。expires_in の値で判断する実装にすること。

### 10. Google Drive の無料容量

**確認した事実**
- Google アカウントごとに**無料で 15GB**。この容量は **Gmail・Google ドライブ・Google フォトで共有**される。
- 共有フォルダ内のファイルは、**元のオーナーの容量だけ**を消費する。
- 容量を超えると Drive の多くの操作が制限される（ダウンロード・削除・Takeout は可能）。超過が2年以上続くとコンテンツが削除されることがある。

**出典URL**
- https://support.google.com/drive/answer/9312312
- https://support.google.com/drive/answer/6374270
- https://support.google.com/googleone/answer/9312312

**未確認/注意**
- 特になし。

---

## [GitHub]

### 11. GitHub Pages（非公開リポジトリ・利用制限）

**確認した事実**
- Pages は GitHub Free / Free for organizations では**公開リポジトリのみ**。非公開リポジトリでの Pages は Pro / Team / Enterprise Cloud / Enterprise Server が必要。→ **GitHub Free の非公開リポジトリでは Pages は使えない**。
- Pages サイトは、リポジトリが非公開でも**インターネットに公開される**（Enterprise Managed Users を除く）。
- 利用制限: 「**オンラインビジネス、EC サイト、または主に商取引の仲介や商用 SaaS の提供を目的とするサイトを無料で運営するためのホスティングとして使うことは想定されておらず、許可されていない**」。パスワードやクレジットカード番号など**機密性の高いやり取りに使ってはならない**。
- 公開サイトは最大1GB、帯域は月100GB のソフトリミット。

**出典URL**
- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- https://docs.github.com/en/get-started/learning-about-github/faq-about-changes-to-githubs-plans

**未確認/注意**
- 依頼にあった `about-github-pages` は、現在は `what-is-github-pages` として検索に出てきた。
- Shiftly のフロントを Pages に置く場合、「商用 SaaS」に当たるかは利用形態（有償提供の有無）しだいで、法的判断は**未確認**。有償で提供するなら Pages は避けるべきと読める。

### 12. GitHub Actions（Free プランの private リポジトリ）

**確認した事実**
- 現行の docs では、GitHub Free の Actions に含まれる量は**分数ではなく金額（月 $12 相当の計算資源）**で表記されている。標準 Linux 2コアの単価（$0.006/分）で換算すると**約2,000分/月**。旧ドキュメントと FAQ では「2,000分/月」と書かれていた。
- ストレージは **500MB**（GitHub Packages と共有）。
- 実行できる分数はランナーの種類で変わる（例: Linux 1コアは $0.002/分）。

**出典URL**
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://docs.github.com/en/billing/reference/product-usage-included
- https://docs.github.com/en/billing/reference/actions-runner-pricing
- https://docs.github.com/en/get-started/learning-about-github/faq-about-changes-to-githubs-plans

**未確認/注意**
- 公開リポジトリで標準ランナーが無料かどうかは今回は確認していない（**未確認**）。

---

## [日本の労働法・税]

### 13. 法定労働時間（32条）と特例措置対象事業場（40条・則25条の2）

**確認した事実**
- 原則は1日8時間・1週40時間。
- 特例措置: **商業、映画・演劇業（映画製作を除く）、保健衛生業、接客娯楽業**のうち、**常時10人未満**（パートタイマーなども含めて数える）の事業場は、**週44時間**（1日8時間は変わらない）。
- 接客娯楽業には「旅館、料理店、**飲食店**、接客業又は娯楽場の事業」が含まれる。→ **小規模飲食店は特例措置の対象になりうる**。

**出典URL**
- https://www.mhlw.go.jp/file/05-Shingikai-11201000-Roudoukijunkyoku-Soumuka/0000136358.pdf
- https://www.check-roudou.mhlw.go.jp/qa/roudousya/roudoujikan/q4.html
- https://jsite.mhlw.go.jp/shizuoka-roudoukyoku/hourei_seido_tetsuzuki/roudoukijun_keiyaku/hourei_seido/kantoku00/kantoku0005.html
- https://jsite.mhlw.go.jp/osaka-roudoukyoku/hourei_seido_tetsuzuki/roudoukijun_keiyaku/hourei_seido/jikan2/info.html

**未確認/注意**
- e-Gov の条文原文は**取得失敗**。「常時10人未満」の判定方法（企業単位ではなく事業場単位であることなど）の細部は**未確認**。設定で週40/44を切り替えられるようにすべき。

### 14. 休憩（34条）

**確認した事実**
- 6時間超〜8時間以下なら少なくとも45分、8時間超なら少なくとも1時間を、**労働時間の途中に**与える。6時間以下なら義務はない（残業で6時間を超えた時点で義務が生じる）。
- 分割はできるが、極端に短いと休憩と認められない可能性がある。一斉付与が原則（労使協定で除外できる。業種によっては協定も不要）。

**出典URL**
- https://www.mhlw.go.jp/bunya/roudoukijun/faq_kijyunhou_13.html
- https://www.mhlw.go.jp/bunya/roudoukijun/faq_kijyunhou_14.html
- https://jsite.mhlw.go.jp/tochigi-roudoukyoku/hourei_seido_tetsuzuki/roudoukijun_keiyaku/roukijou/roukihou_point/kijunhou_kaisetsu/article34.html

**未確認/注意**
- 一斉付与の適用除外業種に飲食店（接客娯楽業）が含まれるかは、抜粋で明記を確認できず**未確認**。

### 15. 割増賃金（37条）と算定基礎の除外手当（則21条）

**確認した事実**
- 時間外 **25%以上**。**月60時間を超える部分は50%以上**（**中小企業も2023年4月1日から**適用）。法定休日 **35%以上**。深夜（22時〜5時）**25%以上**。
- 重複したときの率: 時間外+深夜 = **50%**、月60時間超+深夜 = **75%**、休日+深夜 = **60%**。法定休日には時間外という概念がないため、**休日に8時間を超えて働いても35%のまま**（時間外の割増は加算しない）。
- 月60時間の算定に**法定休日の労働は含めない**が、法定外休日（例: 土曜）の時間外労働は含める。
- 引上げ分の代わりに代替休暇を与える制度がある（労使協定が必要）。
- 算定基礎から除外できる賃金は**限定列挙の7種類**: 家族手当、通勤手当、別居手当、子女教育手当、住宅手当、臨時に支払われた賃金、1か月を超える期間ごとに支払われる賃金。名称ではなく**実質で判断**する（一律支給の家族手当・通勤手当・住宅手当は除外できない）。

**出典URL**
- https://www.mhlw.go.jp/content/000930914.pdf
- https://www.mhlw.go.jp/content/12600000/001076011.pdf
- https://www.mhlw.go.jp/bunya/roudoukijun/faq_kijyungyosei07.html
- https://www.check-roudou.mhlw.go.jp/study/roudousya_jikangai.html
- https://www.check-roudou.mhlw.go.jp/qa/roudousya/chingin/q3.html
- https://jsite.mhlw.go.jp/osaka-roudoukyoku/hourei_seido_tetsuzuki/roudoukijun_keiyaku/hourei_seido/jikan2/warimasi.html
- https://jsite.mhlw.go.jp/osaka-roudoukyoku/yokuaru_goshitsumon/jigyounushi/jikangai.html
- https://www.mhlw.go.jp/web/t_doc?dataId=00tc8495&dataType=1&pageNo=1 （在宅勤務手当の通達 R6）

**未確認/注意**
- 「中小企業」の判定基準（資本金と労働者数、業種別）の具体的な数値は抜粋になく**未確認**。2023年4月以降は全企業が50%なので、実装上の分岐は不要。

### 16. 端数処理（昭和63年3月14日 基発第150号）

**確認した事実**
- 1か月の時間外・休日・深夜労働それぞれの**合計**に1時間未満の端数があれば、**30分未満を切り捨て、30分以上を1時間に切り上げる**ことが認められている。
- 1時間あたりの賃金額と割増賃金額の**1円未満は、50銭未満を切り捨て、50銭以上を1円に切り上げる**ことが認められている。1か月の割増賃金総額の1円未満も同じ扱い。
- **1日単位ではこの端数処理はできない**。日々の時間外を切り捨てて払わないのは**24条または37条違反**。常に切り捨てる処理も認められない。

**出典URL**
- https://jsite.mhlw.go.jp/aichi-roudoukyoku/var/rev0/0119/6636/hasuutoriatukai.pdf
- https://jsite.mhlw.go.jp/osaka-roudoukyoku/yokuaru_goshitsumon/jigyounushi/jikangai.html
- https://jsite.mhlw.go.jp/shimane-roudoukyoku/content/contents/001308250.pdf

**未確認/注意**
- 1か月の賃金支払額の100円未満・1,000円未満の端数処理（翌月繰越など）は今回の抜粋では確認していない（**未確認**）。

### 17. 年次有給休暇（39条）

**確認した事実**
- 要件: 雇入れから6か月継続勤務し、全労働日の8割以上出勤していること。
- 通常の付与日数（6か月・1年6か月…6年6か月以上）: **10・11・12・14・16・18・20日**。
- 比例付与（週所定労働時間が30時間未満で、かつ週4日以下または年216日以下の人）:
  - 週4日（年169〜216日）: 7・8・9・10・12・13・15
  - 週3日（年121〜168日）: 5・6・6・8・9・10・11
  - 週2日（年73〜120日）: 3・4・4・5・6・6・7
  - 週1日（年48〜72日）: 1・2・2・2・3・3・3
- **時効は2年**（2020年改正後も変わらない。115条）。前年度分だけが繰り越される。就業規則に定めがなければ、繰越分から使ったと推定される。
- **年5日の取得義務**: 法定付与日数が**10日以上**の労働者が対象。基準日から1年以内に5日（2019年4月施行）。
- **時間単位年休**: **労使協定が必要**（届出は不要）で、**年5日以内**。1時間未満の単位（30分など）は不可。1日分の時間数の端数は切り上げる（7.5時間なら8時間）。**時間単位で取った分は年5日の取得義務から差し引けない**。
- **半日単位**: 労使協定は不要で、労働者が希望し使用者が同意すれば可能（就業規則に定める）。

**出典URL**
- https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/faq/kijyunhou_6_00001.html
- https://www.mhlw.go.jp/content/11201250/000487338.pdf
- https://www.mhlw.go.jp/content/000560872.pdf
- https://www.check-roudou.mhlw.go.jp/qa/roudousya/yukyu/q3.html
- https://www.check-roudou.mhlw.go.jp/qa/roudousya/yukyu/q6.html
- https://work-holiday.mhlw.go.jp/holiday/time-unit.html
- https://jsite.mhlw.go.jp/gunma-roudoukyoku/hourei_seido_tetsuzuki/roudoukijun_keiyaku/jyouken03_5.html

**未確認/注意**
- 半日単位で取った分を年5日に充当できるか（0.5日として数える）は、今回の抜粋では明記を確認できず**未確認**（一般にはできるとされているが、原文で確認すること）。
- 比例付与の対象者で付与日数が10日以上になる人（週4日の5年6か月以上など）も年5日義務の対象になる点は、「付与日数10日以上」という条件から導いたもの。

### 18. 記録の保存（109条）と賃金台帳の記載事項（則54条）

**確認した事実**
- 保存期間は **5年**（2020年4月改正）。ただし**経過措置で当分の間は3年**。
- 対象は労働者名簿、賃金台帳、**出勤簿・タイムカードなどの労働時間の記録**を含む。
- 起算日は原則として記録が完結した日。**賃金の支払期日のほうが遅い場合は支払期日**が起算日になる（改正で明確化）。
- 賃金台帳の記載事項（則54条）: 氏名、性別、賃金計算期間、労働日数、労働時間数、**休日労働時間数・時間外労働時間数・深夜労働時間数**、基本給や手当など賃金の種類ごとの額、労使協定による控除額 など。様式は任意で、電子でもよい。虚偽の記載は120条の罰則（30万円以下の罰金）の対象になりうる。
- 賃金請求権の時効も5年（当分の間3年）に延長された。

**出典URL**
- https://www.mhlw.go.jp/content/000617974.pdf
- https://www.mhlw.go.jp/content/11200000/000667098.pdf
- https://www.mhlw.go.jp/web/t_doc?dataId=73023000&dataType=0&pageNo=2 （労働基準法施行規則）
- https://www.mhlw.go.jp/file/05-Shingikai-11201000-Roudoukijunkyoku-Soumuka/8_sankou4.pdf
- https://www.mhlw.go.jp/new-info/kobetu/roudou/gyousei/kantoku/dl/041115-1a_0004.pdf

**未確認/注意**
- 則54条の全号（「性別」以外の細目や、日々雇い入れる者の扱いなど）は原文を取得できておらず、一部**未確認**。

### 19. 給与明細（支払明細書）の電子交付

**確認した事実**
- 支払明細書の交付義務は**所得税法231条1項**。電磁的方法での提供は**同条2項・3項と所令356条**に基づき、**受給者の承諾**が必要。
- 承諾の取り方: **あらかじめ電磁的方法の種類と内容を示し、書面または電磁的方法で承諾を得る**。承諾書の書式は法令で定められていない。
- **令和5年度税制改正**で、給与所得の源泉徴収票と給与等の支払明細書について、「期限までに回答がなければ承諾したものとみなす」と事前に通知しておけば、**みなし承諾**が成立する仕組みが導入された。
- 承諾した後でも、受給者から**書面での交付を請求されたら書面で交付**しなければならない。

**出典URL**
- https://www.nta.go.jp/publication/pamph/hotei/denshikofu-qa/answer.htm
- https://www.nta.go.jp/law/shitsugi/hotei/1/04.htm
- https://www.nta.go.jp/publication/pamph/hotei/tebiki2026/PDF/10.pdf

**未確認/注意**
- みなし承諾の施行日と、通知文に必要な記載事項の詳細は**未確認**（国税庁の最新 Q&A で確認すること）。

### 20. 最低賃金

**確認した事実**
- 地域別最低賃金は**都道府県別**で、**毎年度改定**される。発効日は都道府県ごとに異なる（10月1日が多いが、それ以外の県もある）。公式一覧ページには令和8年度の額と発効日が載っている。

**出典URL**
- https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/minimumichiran/index.html （公式一覧）
- https://saiteichingin.mhlw.go.jp/table/page_list_nationallist.php （厚労省の特設サイト）
- https://www.mhlw.go.jp/stf/newpage_74920.html （令和8年度の目安）

**未確認/注意**
- 具体的な金額は掲載時点によって検索結果が食い違ったため、本書には載せない（**未確認**）。アプリでは都道府県・発効日つきのマスタとして持ち、毎年更新する設計にすること。

---

## 設計に影響する重要事項トップ10

1. **GitHub Free では非公開リポジトリの Pages は使えない。Pages は商用 SaaS や機密性の高いやり取りに使えない**。給与や個人情報を扱う Shiftly の画面を Pages に置くなら、利用形態（無償/有償）とデータの流れを再検討する必要がある。GAS の HtmlService で画面を出す構成のほうが規約上は安全。
2. **SpreadsheetApp.openById に必要なのは `spreadsheets`（機密スコープ）で、drive.file では足りない**。drive.file（非機密）で通すには Sheets API（REST/Advanced Service）を使う必要があるが、その実際の動作は**未確認**で実機検証が必要。
3. **未検証アプリは新規ユーザー100人まで。「テスト」状態ではテストユーザー100人・認可は7日で失効**。店舗ごとに GAS を各オーナーのアカウントにデプロイし、従業員は USER_DEPLOYING で使う（従業員には OAuth 同意を求めない）構成のほうが無料運用に向く。
4. **USER_DEPLOYING の Web アプリでは `Session.getActiveUser().getEmail()` が使えない**。従業員の識別は Google アカウントではなく、アプリ独自の認証（HMAC 署名トークンなど）で設計する必要がある。`getUuid` は一意性が保証されず、乱数品質も**未確認**なので、トークン生成の方式は別途検討すること。
5. **Apps Script API は、利用者ごとのダッシュボード設定（既定はオフ）と Cloud 側での API 有効化が必要で、サービスアカウントは使えない**。`scripts.run` は標準 Cloud プロジェクトと API 実行可能デプロイが必要で、無料のワンクリック配布には向かない。自動デプロイは `projects.create → updateContent → versions.create → deployments.create`（レスポンスの `entryPoints[].webApp.url` で URL を取得）の流れになる。
6. **割当（consumer）: 実行6分/回、トリガー合計90分/日、同時30/ユーザー、UrlFetch 20,000/日、Properties は9KB/値・500KB/ストア、Cache は100KB/キー・最長6時間・1,000件**。月次の給与計算はバッチを分割する必要があり、重い集計をトリガーで回すのは慎重に。設定値は Properties に、大きいデータは Sheets に置く。
7. **書き込みの排他には `LockService.getScriptLock()` を使う**（ユーザーにかかわらず同じスクリプト内で排他）。打刻の二重登録を防ぐのにも使う。
8. **割増率と端数処理のルールを計算エンジンに組み込む**: 時間外25%、月60時間超50%（2023年4月から中小企業も）、休日35%、深夜25%（重複時は50/75/60%）。端数処理は**月の合計で30分単位の四捨五入、円未満は50銭で四捨五入**だけ。**日単位の切捨ては違法**。除外手当は7種類の限定列挙。特例措置（飲食店で10人未満なら週44時間）は設定で切り替えられるようにする。
9. **年休: 通常表と比例付与表、時効2年、付与10日以上なら年5日の取得義務、時間単位は労使協定と年5日以内（年5日義務には充当不可）**。付与・取得・失効を台帳として管理するデータモデルが必要。
10. **記録の保存は5年（当分の間3年。起算日は支払期日が遅ければ支払期日）、賃金台帳には則54条の記載事項が必要、給与明細の電子交付には承諾（みなし承諾の仕組みあり）が必要で、書面を請求されたら書面で交付**。削除しない（論理削除）設計、承諾記録と日時の保存、印刷できる明細が必要。Drive の15GB は Gmail・フォトと共有なので、PDF の大量保存には注意。Sheets のセル上限は資料により1,000万〜2,000万で食い違うため、保守的に見積もる。

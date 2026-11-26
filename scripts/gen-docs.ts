/**
 * コードから文書を生成（記述と実装の食い違いを防ぐ）
 *  - docs/database-schema.md: src/backend/schema.ts
 *  - docs/permission-matrix.md: src/shared/permissions.ts ＋ 登録済み API 操作（auth / perms / sensitive）
 */
import { writeFileSync } from 'node:fs';
import { TABLES, SCHEMA_VERSION } from '../src/backend/schema';
import { listOps } from '../src/backend/index';
import { EPOCH_EXEMPT } from '../src/backend/epoch-exemptions';
import { PERMISSIONS } from '../src/shared/permissions';

const typeJa: Record<string, string> = { string: '文字列（必須）', string_nullable: '文字列（null可）', number: '数値（必須）', number_nullable: '数値（null可）', boolean: '真偽', json: 'JSON' };

let db = `# データベース設計（Google Sheets）\n\n> このファイルは \`npm run docs\`（scripts/gen-docs.ts）で src/backend/schema.ts から自動生成されます。手で編集しないでください。\n\n- スキーマバージョン: **${SCHEMA_VERSION}**\n- 1テーブル = 1シート。1行目はヘッダー、A列 \`id\` が主キー（ランダムID。氏名は主キーにしない）\n- 全テーブル共通列: \`id\`（主キー）/ \`createdAt\` / \`updatedAt\`（ISO 8601 +09:00）/ \`version\`（楽観的排他。更新ごとに+1）\n- 月別パーティション: \`<table>__YYYY_MM\` シート（打刻原本・監査ログ・冪等性キー）。期間取得時は必要な月のシートだけを読む\n- 書き込みは Sheets API の \`valueInputOption=RAW\`（\`=\` で始まる文字列を数式として評価させない）\n- 削除: 業務データは物理削除しない（退職は status=retired、シフトは cancelled、修正は別テーブル、確定給与は superseded）\n- 列の追加は末尾のみ（後方互換）。読み取り時に不足列は既定値で補う\n- アクセス: すべて Core API（サーバー側の認証・認可）経由。シートへの直接アクセス API は提供しない\n\n`;
for (const t of TABLES) {
  db += `## ${t.name}\n\n${t.description}${t.partitionBy ? `（月別パーティション: \`${t.partitionBy}\` の年月）` : ''}\n\n| 列 | 型 |\n|---|---|\n`;
  for (const [c, ty] of t.columns) db += `| \`${c}\` | ${typeJa[ty] ?? ty} |\n`;
  db += '\n';
}
db += `## 業務データ以外の保存場所\n\n| 情報 | 保存場所 | 備考 |\n|---|---|---|\n| PIN・管理者パスワードの pepper、Admin/Setup との HMAC 鍵、DB ファイルID、フォルダID | Core の Script Properties | DB・バックアップに含めない |\n| 端末トークン | iPad の localStorage（平文はここのみ）／ DB には SHA-256 | 端末認証情報のみ永続保存を許可 |\n| スタッフのセッショントークン・管理者セッショントークン | iPad の画面のメモリ上のみ（平文）／ DB には SHA-256 | ブラウザに永続保存しない。再読み込みで破棄 |\n| セッション（スタッフ・管理者）の最終操作時刻・ノンス・試行回数 | Core の CacheService | 消失時は安全側（失効）に倒す |\n| Setup の進捗・リソースID | Setup の UserProperties ＋ 管理者 Drive のレジストリ JSON | ペアリングコード・Setup 鍵は UserProperties のみ |\n| 給与明細 PDF・出力ファイル・バックアップ | 管理者の Drive（Shiftly/02〜05 フォルダ） | drive.file スコープ（Shiftly 作成ファイルのみ） |\n`;
writeFileSync('docs/database-schema.md', db);

const authJa: Record<string, string> = { public: '公開（未認証可）', device: '登録端末', session: 'スタッフ本人（端末＋氏名選択／PIN）', owner: 'Google 所有者', staff_or_owner: '管理者（Google 所有者・管理者モード）／委任スタッフ', admin: '管理者モード（管理者パスワード）のみ' };
let pm = `# 権限マトリクス\n\n> \`npm run docs\` で src/shared/permissions.ts と登録済み API 操作から自動生成。手で編集しないでください。\n\n## スタッフ個別権限\n\n| キー | 名称 | 区分 | 機密（追加認証） | 初期値 |\n|---|---|---|---|---|\n`;
for (const p of PERMISSIONS) pm += `| \`${p.key}\` | ${p.label} | ${p.group} | ${p.sensitive ? '○' : ''} | ${p.defaultForStaff ? '付与' : ''} |\n`;
pm += `\n管理者（Google 所有者、および店舗 iPad で管理者パスワードにより認証した管理者モード）は全権限を固定で保持（削除不可）。**権限管理・PIN/管理用パスコード設定・端末登録・店舗設定は管理者専用**で、スタッフへは付与できません。**システムの構築・更新・移行・メンテナンス切替、バックアップからの復元、管理者パスワードの初期設定・再設定は Google 所有者専用**で、管理者モードからも実行できません。\n\n## 管理者・スタッフの区分（v1.3）\n\n| 区分 | 認証 | できること |\n|---|---|---|\n| Google 所有者 | Google アカウント（Shiftly-Admin・Setup・エディタ） | すべて（構築・更新・復旧＝バックアップからの復元を含む・管理者パスワードの設定/再設定を含む） |\n| 管理者モード | 登録済み端末＋管理者パスワード（無操作5分で終了） | 「管理者モード」列が ○ の操作。「再認証」が ○ の操作は直近5分以内のパスワード再入力が必要 |\n| スタッフ（本人確認済み） | 登録済み端末＋氏名＋PIN | 個別権限の範囲 |\n| スタッフ（本人未確認・PIN 未設定） | 登録済み端末＋氏名 | 「PIN なし」列が ○ の操作のみ（打刻・公開シフト・承認待ちとなる申告） |\n\n## API 操作ごとの認可（サーバー側で毎回検証）\n\n「分類」と「世代の照合」は D-026（復元世代）。分類 \`edit\`（画面上のデータに基づく業務更新）はすべて、API の共通の入口（ロックの内側）で、画面がデータを取得した時点の復元世代を照合し、古い・ない場合は拒否する。照合しない更新系の操作は、理由を src/backend/epoch-exemptions.ts に登録している（下の「世代の照合を適用しない更新系の操作」）。\n\n| 操作 | 分類 | 認証 | 必要な権限（いずれか） | スタッフの追加認証 | 管理者モード | 再認証 | PIN なし | 更新系 | 世代の照合 |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const o of listOps().sort((a, b) => a.name.localeCompare(b.name))) {
  const adminOk = o.auth === 'admin' || o.auth === 'staff_or_owner' || (o.auth === 'owner' && !!o.adminAllowed);
  pm += `| \`${o.name}\`${o.name.startsWith('kiosk.') ? '（互換名: v1.2 までの名称。staff.* と同じ処理）' : ''} | ${o.kind} | ${authJa[o.auth]} | ${(o.perms ?? []).map((x) => `\`${x}\``).join(', ')} | ${o.sensitive ? '必要' : ''} | ${adminOk ? '○' : ''} | ${o.reauth ? '○' : ''} | ${o.allowUnverified ? '○' : ''} | ${o.mutating ? '○' : ''} | ${o.kind === 'edit' ? '○' : o.mutating ? '除外（理由は下表）' : ''} |\n`;
}
pm += `\n### 世代の照合を適用しない更新系の操作（D-026。src/backend/epoch-exemptions.ts）\n\n| 操作 | 分類 | 理由 |\n|---|---|---|\n`;
for (const o of listOps()
  .filter((x) => x.mutating && x.kind !== 'edit')
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)))
  pm += `| \`${o.name}\` | ${o.kind} | ${EPOCH_EXEMPT[o.name] ?? '（未登録）'} |\n`;
pm += `\n### ハンドラ内の追加制約（自己操作・昇格の防止）\n\n- スタッフは自分自身の勤怠修正（管理者向けの修正）・給与条件変更・雇用条件変更・有給付与/取得/調整・給与確定/訂正・退職処理、自分の早出残業申請・本人修正・休憩申告の確認（承認）を行えない
- 本人による勤怠修正・休憩申告・早出残業申請（v1.3）は、本人の勤務からサーバー側で対象を特定する（他人の勤務は指定できない）。本人未確認（PIN 未設定）の申告・確定済み期間の修正は承認待ち（未反映）\n- 他者の給与明細の閲覧は \`payslip_view_others\` ＋追加認証（5分間）が必要。閲覧は監査ログに記録\n- 人件費分析: \`payroll_view_all\` がない場合、スタッフ別内訳・1名のみが勤務した日の金額・時間帯別金額を返さない\n- 出力: 共用 iPad（スタッフ・管理者モード）にはファイル本体を返さず、Google 所有者の Drive に保存のみ\n- 権限変更は既存セッションにも次の操作から反映（毎回 DB から再読込）\n`;
writeFileSync('docs/permission-matrix.md', pm);
console.log('docs generated');

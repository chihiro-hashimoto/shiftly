/**
 * コードから文書を生成（記述と実装の食い違いを防ぐ）
 *  - docs/database-schema.md: src/backend/schema.ts
 *  - docs/permission-matrix.md: src/shared/permissions.ts ＋ 登録済み API 操作（auth / perms / sensitive）
 */
import { writeFileSync } from 'node:fs';
import { TABLES, SCHEMA_VERSION } from '../src/backend/schema';
import { listOps } from '../src/backend/index';
import { PERMISSIONS } from '../src/shared/permissions';

const typeJa: Record<string, string> = { string: '文字列（必須）', string_nullable: '文字列（null可）', number: '数値（必須）', number_nullable: '数値（null可）', boolean: '真偽', json: 'JSON' };

let db = `# データベース設計（Google Sheets）\n\n> このファイルは \`npm run docs\`（scripts/gen-docs.ts）で src/backend/schema.ts から自動生成されます。手で編集しないでください。\n\n- スキーマバージョン: **${SCHEMA_VERSION}**\n- 1テーブル = 1シート。1行目はヘッダー、A列 \`id\` が主キー（ランダムID。氏名は主キーにしない）\n- 全テーブル共通列: \`id\`（主キー）/ \`createdAt\` / \`updatedAt\`（ISO 8601 +09:00）/ \`version\`（楽観的排他。更新ごとに+1）\n- 月別パーティション: \`<table>__YYYY_MM\` シート（打刻原本・監査ログ・冪等性キー）。期間取得時は必要な月のシートだけを読む\n- 書き込みは Sheets API の \`valueInputOption=RAW\`（\`=\` で始まる文字列を数式として評価させない）\n- 削除: 業務データは物理削除しない（退職は status=retired、シフトは cancelled、修正は別テーブル、確定給与は superseded）\n- 列の追加は末尾のみ（後方互換）。読み取り時に不足列は既定値で補う\n- アクセス: すべて Core API（サーバー側の認証・認可）経由。シートへの直接アクセス API は提供しない\n\n`;
for (const t of TABLES) {
  db += `## ${t.name}\n\n${t.description}${t.partitionBy ? `（月別パーティション: \`${t.partitionBy}\` の年月）` : ''}\n\n| 列 | 型 |\n|---|---|\n`;
  for (const [c, ty] of t.columns) db += `| \`${c}\` | ${typeJa[ty] ?? ty} |\n`;
  db += '\n';
}
db += `## 業務データ以外の保存場所\n\n| 情報 | 保存場所 | 備考 |\n|---|---|---|\n| PIN の pepper、Admin/Setup との HMAC 鍵、DB ファイルID、フォルダID | Core の Script Properties | DB・バックアップに含めない |\n| 端末トークン | iPad の localStorage（平文はここのみ）／ DB には SHA-256 | 端末認証情報のみ永続保存を許可 |\n| セッションの最終操作時刻・ノンス・試行回数 | Core の CacheService | 消失時は安全側（失効）に倒す |\n| Setup の進捗・リソースID | Setup の UserProperties ＋ 店長 Drive のレジストリ JSON | ペアリングコード・Setup 鍵は UserProperties のみ |\n| 給与明細 PDF・出力ファイル・バックアップ | 店長の Drive（Shiftly/02〜05 フォルダ） | drive.file スコープ（Shiftly 作成ファイルのみ） |\n`;
writeFileSync('docs/database-schema.md', db);

const authJa: Record<string, string> = { public: '公開（未認証可）', device: '登録端末', session: 'スタッフ本人（端末＋PIN）', owner: '店長専用', staff_or_owner: '店長／委任スタッフ' };
let pm = `# 権限マトリクス\n\n> \`npm run docs\` で src/shared/permissions.ts と登録済み API 操作から自動生成。手で編集しないでください。\n\n## スタッフ個別権限\n\n| キー | 名称 | 区分 | 機密（追加認証） | 初期値 |\n|---|---|---|---|---|\n`;
for (const p of PERMISSIONS) pm += `| \`${p.key}\` | ${p.label} | ${p.group} | ${p.sensitive ? '○' : ''} | ${p.defaultForStaff ? '付与' : ''} |\n`;
pm += `\n店長は全権限を固定で保持（削除不可）。**権限管理・PIN/管理用パスコード設定・端末登録・バックアップ復元・店舗設定・システム更新は店長専用**で、スタッフへは付与できません。\n\n## API 操作ごとの認可（サーバー側で毎回検証）\n\n| 操作 | 認証 | 必要な権限（いずれか） | スタッフの追加認証 | 更新系 |\n|---|---|---|---|---|\n`;
for (const o of listOps().sort((a, b) => a.name.localeCompare(b.name))) pm += `| \`${o.name}\` | ${authJa[o.auth]} | ${(o.perms ?? []).map((x) => `\`${x}\``).join(', ')} | ${o.sensitive ? '必要' : ''} | ${o.mutating ? '○' : ''} |\n`;
pm += `\n### ハンドラ内の追加制約（自己操作・昇格の防止）\n\n- スタッフは自分自身の勤怠修正・給与条件変更・雇用条件変更・有給付与/取得/調整・給与確定/訂正・退職処理を行えない\n- 他者の給与明細の閲覧は \`payslip_view_others\` ＋追加認証（5分間）が必要。閲覧は監査ログに記録\n- 人件費分析: \`payroll_view_all\` がない場合、スタッフ別内訳・1名のみが勤務した日の金額・時間帯別金額を返さない\n- 出力: スタッフ端末（共用 iPad）にはファイル本体を返さず、店長の Drive に保存のみ\n- 権限変更は既存セッションにも次の操作から反映（毎回 DB から再読込）\n`;
writeFileSync('docs/permission-matrix.md', pm);
console.log('docs generated');

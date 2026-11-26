/**
 * 復元世代（D-026）の照合を適用しない更新系の操作と、その理由（明示的な登録）。
 * 更新系（mutating）で分類が 'edit' 以外の操作は、ここに理由を登録しないと読み込み時にエラーになる（api.ts の defineOps）。
 * 'edit'（画面上のデータに基づく業務更新）はすべて、共通の入口で世代を照合する（登録は不要。除外もできない）
 */
export const EPOCH_EXEMPT: Record<string, string> = {
  // punch: サーバー時刻に基づく事実の記録
  'attendance.punch':
    '打刻の時刻はサーバーの時刻で、打刻原本は追記だけ（復元でも再投入される）。ただし、退勤の打刻に休憩の申告（画面で選んだ内容。既存の申告を置き換える）が付いている場合は、世代を照合する（editWhen）。復元でスタッフのセッションは失効し、ログインし直す',
  // auth: 認証・端末・セッション・資格情報
  'auth.login': 'ログイン（セッションの発行）。画面のデータを書き戻さない',
  'auth.logout': 'ログアウト（セッションの失効）',
  'auth.changePin': '本人が新しい PIN を設定する（現在の PIN で確認。画面のデータを書き戻さない）',
  'auth.stepUp': '追加認証（セッションの状態だけを変える）',
  'adminAuth.login': '管理者モードのログイン（セッションの発行）',
  'adminAuth.logout': '管理者モードのログアウト',
  'adminAuth.reauth': '管理者の再認証（セッションの状態だけを変える）',
  'adminAuth.changePassword': '管理者が新しいパスワードを設定する（現在のパスワードで確認）',
  'adminAuth.setPassword': 'Google 所有者が管理者パスワードを新しく設定する（画面のデータを書き戻さない）',
  'adminAuth.unlock': '管理者パスワードのロックの解除',
  'adminAuth.revokeSessions': '管理者セッションの一括失効（安全側の操作）',
  'credentials.setPin': 'スタッフの PIN を新しく設定する（画面のデータを書き戻さない）',
  'credentials.clearPin': 'スタッフの PIN の解除',
  'credentials.unlock': 'PIN のロックの解除',
  'credentials.setStepUp': '追加認証のパスコードを新しく設定する',
  'staff.enroll': '端末の登録（使い捨ての登録コード。復元でも使用済みのコードは巻き戻らない）',
  'devices.createEnrollment': '端末登録コードの発行（新しいコードを作るだけ）',
  'devices.revoke': '端末の失効（安全側の操作。復元でも失効は巻き戻らない）',
  // system: 復元・バックアップ・初期化・更新・メンテナンス
  'backup.restore': '復元そのもの（Google 所有者だけ。確認の入力が必要。実行時に世代を進める）',
  'backup.run': 'バックアップの作成（現在のデータを複製するだけ）',
  'system.initialize': '初期化（冪等。既存のデータは変えない）',
  'system.migrate': 'DB の構造の移行（Setup の更新の工程。画面のデータを使わない）',
  'system.prepareUpdate': '更新の準備（メンテナンスの開始とバックアップ。Setup の工程）',
  'system.finishUpdate': '更新の完了（整合性の確認と版の記録。Setup の工程）',
  'system.setMaintenance': 'メンテナンスの切り替え（Setup の工程）',
  'system.resetSetupPairing': 'Setup との接続のリセット（新しい接続の準備だけ）',
  // output: 出力
  'export.attendance': '出力（現在のデータを読み出してファイルを作る。出力の履歴だけを追記する）',
  'export.payroll': '出力（同上）',
  'export.shifts': '出力（同上）',
  'export.wageLedger': '出力（同上）',
  // internal: 定期実行・内部処理
  'system.dailyJob': '日次の定期実行（現在のデータからバックアップ・通知を作る）',
  'notifications.scan': '通知の検出（現在のデータから通知を作る。画面のデータを使わない）',
};

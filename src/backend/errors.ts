/** API エラー（利用者向けメッセージは日本語。内部情報・個人情報を含めない） */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 423 | 429 | 500 | 503 = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const E = {
  unauthenticated: () => new ApiError('UNAUTHENTICATED', '認証が必要です。もう一度ログインしてください', 401),
  deviceNotRegistered: () => new ApiError('DEVICE_NOT_REGISTERED', 'この端末は登録されていません。管理者に端末登録を依頼してください', 401),
  forbidden: (what = 'この操作') => new ApiError('FORBIDDEN', `${what}を行う権限がありません`, 403),
  reauthRequired: () => new ApiError('REAUTH_REQUIRED', 'この操作の前に、管理者パスワードをもう一度入力してください', 403),
  identityRequired: () => new ApiError('IDENTITY_REQUIRED', 'この情報を表示するには PIN による本人確認が必要です（PIN 未設定の場合は管理者に確認を依頼してください）', 403),
  stepUpRequired: () => new ApiError('STEP_UP_REQUIRED', 'この操作には管理用パスコードによる追加認証が必要です', 403),
  notFound: (what = 'データ') => new ApiError('NOT_FOUND', `${what}が見つかりません`, 404),
  invalid: (msg: string) => new ApiError('INVALID_INPUT', msg, 400),
  conflict: (msg: string) => new ApiError('CONFLICT', msg, 409),
  locked: (msg: string) => new ApiError('LOCKED', msg, 423),
  rateLimited: (msg: string) => new ApiError('RATE_LIMITED', msg, 429),
  maintenance: () => new ApiError('MAINTENANCE', 'システム更新中のため一時的に利用できません。しばらくしてからお試しください', 503),
  maintenanceWork: () => new ApiError('MAINTENANCE', 'Google 所有者による保守作業中のため、データの更新を停止しています。保守作業の終了後にお試しください（打刻は紙のタイムカードに記録してください）', 503),
  notInitialized: () => new ApiError('NOT_INITIALIZED', '初期セットアップが完了していません', 503),
};

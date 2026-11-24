# データベース設計（Google Sheets）

> このファイルは `npm run docs`（scripts/gen-docs.ts）で src/backend/schema.ts から自動生成されます。手で編集しないでください。

- スキーマバージョン: **1**
- 1テーブル = 1シート。1行目はヘッダー、A列 `id` が主キー（ランダムID。氏名は主キーにしない）
- 全テーブル共通列: `id`（主キー）/ `createdAt` / `updatedAt`（ISO 8601 +09:00）/ `version`（楽観的排他。更新ごとに+1）
- 月別パーティション: `<table>__YYYY_MM` シート（打刻原本・監査ログ・冪等性キー）。期間取得時は必要な月のシートだけを読む
- 書き込みは Sheets API の `valueInputOption=RAW`（`=` で始まる文字列を数式として評価させない）
- 削除: 業務データは物理削除しない（退職は status=retired、シフトは cancelled、修正は別テーブル、確定給与は superseded）
- 列の追加は末尾のみ（後方互換）。読み取り時に不足列は既定値で補う
- アクセス: すべて Core API（サーバー側の認証・認可）経由。シートへの直接アクセス API は提供しない

## store_settings

店舗設定（1行）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `storeName` | 文字列（必須） |
| `storeAddress` | 文字列（必須） |
| `timezone` | 文字列（必須） |
| `businessHours` | JSON |
| `businessDayCutoff` | 文字列（必須） |
| `workingTimeSystem` | 文字列（必須） |
| `weekStartDay` | 数値（null可） |
| `statutoryHolidayWeekday` | 数値（null可） |
| `weekly44Confirmed` | 真偽 |
| `agreement36` | 文字列（必須） |
| `overtime60StartDay` | 数値（null可） |
| `payrollClosingDay` | 数値（null可） |
| `payMonthOffset` | 数値（null可） |
| `payDay` | 数値（null可） |
| `yenRounding` | 文字列（必須） |
| `minimumWages` | JSON |
| `employerCostRatePercent` | 数値（null可） |
| `idleTimeoutSec` | 数値（必須） |
| `pinMaxAttempts` | 数値（必須） |
| `pinLockMinutes` | 数値（必須） |
| `publicHolidays` | JSON |
| `paidLeaveWageMethod` | 文字列（必須） |
| `halfDayLeaveAllowed` | 真偽 |
| `payslipDelivery` | 文字列（必須） |
| `retentionYears` | 数値（必須） |
| `dailyBackupGenerations` | 数値（必須） |
| `monthlyBackupGenerations` | 数値（必須） |
| `payrollRulesConfirmedAt` | 文字列（null可） |

## employees

スタッフ（主キーは id。氏名は主キーにしない）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeCode` | 文字列（必須） |
| `displayName` | 文字列（必須） |
| `kana` | 文字列（必須） |
| `status` | 文字列（必須） |
| `hireDate` | 文字列（null可） |
| `retireDate` | 文字列（null可） |
| `payType` | 文字列（必須） |
| `sortOrder` | 数値（必須） |
| `electronicPayslipConsent` | 真偽 |
| `note` | 文字列（必須） |

## employment_history

雇用条件履歴

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `effectiveFrom` | 文字列（必須） |
| `effectiveTo` | 文字列（null可） |
| `payType` | 文字列（必須） |
| `weeklyScheduledDays` | 数値（null可） |
| `weeklyScheduledMinutes` | 数値（null可） |
| `yearlyScheduledDays` | 数値（null可） |
| `dailyScheduledMinutes` | 数値（null可） |
| `monthlyAverageScheduledMinutes` | 数値（null可） |
| `note` | 文字列（必須） |

## credentials

PIN・管理用パスコードのハッシュ（平文なし。pepper は Script Properties）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `kind` | 文字列（必須） |
| `hash` | 文字列（必須） |
| `salt` | 文字列（必須） |
| `iterations` | 数値（必須） |
| `algo` | 文字列（必須） |
| `failedCount` | 数値（必須） |
| `lockedUntil` | 文字列（null可） |
| `mustChange` | 真偽 |

## permissions

スタッフ個別権限

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `permissions` | JSON |

## devices

登録済み店舗端末（トークンはハッシュのみ）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `name` | 文字列（必須） |
| `tokenHash` | 文字列（必須） |
| `status` | 文字列（必須） |
| `registeredAt` | 文字列（必須） |
| `lastUsedAt` | 文字列（null可） |
| `revokedAt` | 文字列（null可） |
| `userAgentHint` | 文字列（必須） |

## device_enrollments

端末登録コード（短時間・使い捨て）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `codeHash` | 文字列（必須） |
| `deviceName` | 文字列（必須） |
| `expiresAt` | 文字列（必須） |
| `usedAt` | 文字列（null可） |

## sessions

スタッフセッション（トークンはハッシュのみ）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `tokenHash` | 文字列（必須） |
| `deviceId` | 文字列（必須） |
| `employeeId` | 文字列（必須） |
| `expiresAt` | 文字列（必須） |
| `lastActivityAt` | 文字列（必須） |
| `stepUpUntil` | 文字列（null可） |
| `revokedAt` | 文字列（null可） |

## wage_rules

時給ルール（個人・曜日・時間帯・祝日・特定日）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `kind` | 文字列（必須） |
| `hourlyRate` | 数値（必須） |
| `effectiveFrom` | 文字列（必須） |
| `effectiveTo` | 文字列（null可） |
| `weekdays` | JSON |
| `timeFrom` | 文字列（null可） |
| `timeTo` | 文字列（null可） |
| `specialDates` | JSON |
| `priority` | 数値（必須） |
| `includesNightPremium` | 真偽 |
| `premiumBaseRate` | 数値（null可） |
| `note` | 文字列（必須） |

## salary_rules

月給制の給与条件

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `effectiveFrom` | 文字列（必須） |
| `effectiveTo` | 文字列（null可） |
| `monthlySalary` | 数値（必須） |
| `monthlyScheduledMinutes` | 数値（null可） |
| `scheduledWeekdays` | JSON |
| `scheduledDailyMinutes` | 数値（null可） |
| `inLegalOvertimeRate` | 数値（null可） |
| `fixedOvertime` | JSON |
| `absenceDeduction` | JSON |
| `lateEarlyDeduction` | JSON |
| `confirmed` | 真偽 |
| `note` | 文字列（必須） |

## attendance_events

打刻原本（追記専用・月別）（月別パーティション: `at` の年月）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `type` | 文字列（必須） |
| `at` | 文字列（必須） |
| `deviceId` | 文字列（null可） |
| `source` | 文字列（必須） |
| `requestId` | 文字列（必須） |
| `actorId` | 文字列（null可） |
| `note` | 文字列（必須） |

## attendance_corrections

勤怠修正（原本は不変。修正前後・理由・修正者）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `action` | 文字列（必須） |
| `targetEventId` | 文字列（null可） |
| `newType` | 文字列（null可） |
| `newAt` | 文字列（null可） |
| `reason` | 文字列（必須） |
| `actorId` | 文字列（必須） |
| `actorKind` | 文字列（必須） |
| `status` | 文字列（必須） |
| `before` | 文字列（必須） |
| `after` | 文字列（必須） |

## manual_breaks

手動登録の休憩

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `start` | 文字列（必須） |
| `end` | 文字列（必須） |
| `reason` | 文字列（必須） |
| `actorId` | 文字列（必須） |

## shifts

シフト

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `date` | 文字列（必須） |
| `start` | 文字列（必須） |
| `end` | 文字列（必須） |
| `breakMinutes` | 数値（必須） |
| `applyFixedBreak` | 真偽 |
| `fixedBreakStart` | 文字列（null可） |
| `status` | 文字列（必須） |
| `publishedAt` | 文字列（null可） |
| `note` | 文字列（必須） |

## shift_patterns

勤務パターン

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `name` | 文字列（必須） |
| `start` | 文字列（必須） |
| `end` | 文字列（必須） |
| `breakMinutes` | 数値（必須） |

## shift_history

シフト変更履歴

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `shiftId` | 文字列（必須） |
| `action` | 文字列（必須） |
| `before` | 文字列（必須） |
| `after` | 文字列（必須） |
| `actorId` | 文字列（必須） |

## leave_grants

有給付与

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `grantDate` | 文字列（必須） |
| `days` | 数値（必須） |
| `expiresOn` | 文字列（必須） |
| `kind` | 文字列（必須） |
| `attendanceRateConfirmed` | 真偽 |
| `note` | 文字列（必須） |

## leave_transactions

有給取得・調整履歴

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `date` | 文字列（必須） |
| `days` | 数値（必須） |
| `kind` | 文字列（必須） |
| `scheduledMinutes` | 数値（null可） |
| `grantId` | 文字列（null可） |
| `reason` | 文字列（必須） |
| `actorId` | 文字列（必須） |

## transport_rules

交通費規定（個人別）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `effectiveFrom` | 文字列（必須） |
| `effectiveTo` | 文字列（null可） |
| `method` | 文字列（必須） |
| `amount` | 数値（必須） |
| `monthlyCap` | 数値（null可） |
| `actualAmounts` | JSON |
| `note` | 文字列（必須） |

## allowances

各種手当

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `name` | 文字列（必須） |
| `kind` | 文字列（必須） |
| `amount` | 数値（必須） |
| `effectiveFrom` | 文字列（必須） |
| `effectiveTo` | 文字列（null可） |
| `premiumBaseCategory` | 文字列（必須） |
| `includeInMinimumWage` | 真偽 |
| `periodAmounts` | JSON |
| `note` | 文字列（必須） |

## deductions

控除（手動入力）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `periodId` | 文字列（必須） |
| `status` | 文字列（必須） |
| `incomeTax` | 数値（必須） |
| `residentTax` | 数値（必須） |
| `healthInsurance` | 数値（必須） |
| `pension` | 数値（必須） |
| `employmentInsurance` | 数値（必須） |
| `nursingInsurance` | 数値（必須） |
| `others` | JSON |
| `note` | 文字列（必須） |

## payroll_adjustments

給与調整（承認済みの欠勤・遅刻早退控除、手動加減算）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `employeeId` | 文字列（必須） |
| `periodId` | 文字列（必須） |
| `kind` | 文字列（必須） |
| `quantity` | 数値（必須） |
| `amount` | 数値（null可） |
| `label` | 文字列（必須） |
| `reason` | 文字列（必須） |
| `approvedBy` | 文字列（必須） |

## payroll_periods

給与計算期間

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `periodKey` | 文字列（必須） |
| `from` | 文字列（必須） |
| `to` | 文字列（必須） |
| `payDate` | 文字列（必須） |
| `status` | 文字列（必須） |

## payroll_results

給与計算結果（確定版は不変。訂正は新リビジョン）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `periodId` | 文字列（必須） |
| `employeeId` | 文字列（必須） |
| `revision` | 数値（必須） |
| `status` | 文字列（必須） |
| `computedAt` | 文字列（必須） |
| `confirmedAt` | 文字列（null可） |
| `confirmedBy` | 文字列（null可） |
| `calcVersion` | 文字列（必須） |
| `totals` | JSON |
| `snapshot` | 文字列（必須） |
| `issues` | 文字列（必須） |
| `correctionReason` | 文字列（必須） |

## pay_slips

給与明細

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `periodId` | 文字列（必須） |
| `employeeId` | 文字列（必須） |
| `payrollResultId` | 文字列（必須） |
| `revision` | 数値（必須） |
| `driveFileId` | 文字列（null可） |
| `issuedAt` | 文字列（必須） |
| `status` | 文字列（必須） |

## budgets

人件費予算

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `month` | 文字列（必須） |
| `monthlyAmount` | 数値（必須） |
| `dailyAmounts` | JSON |
| `laborCostAllocation` | 文字列（必須） |

## notifications

アプリ内通知

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `kind` | 文字列（必須） |
| `dedupeKey` | 文字列（必須） |
| `audience` | 文字列（必須） |
| `employeeId` | 文字列（null可） |
| `title` | 文字列（必須） |
| `body` | 文字列（必須） |
| `severity` | 文字列（必須） |
| `status` | 文字列（必須） |
| `relatedDate` | 文字列（null可） |

## audit_logs

監査ログ（追記専用・月別。PII・秘密情報は記録しない）（月別パーティション: `at` の年月）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `at` | 文字列（必須） |
| `actorKind` | 文字列（必須） |
| `actorId` | 文字列（null可） |
| `action` | 文字列（必須） |
| `targetType` | 文字列（必須） |
| `targetId` | 文字列（null可） |
| `summary` | 文字列（必須） |
| `requestId` | 文字列（null可） |

## backup_history

バックアップ履歴

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `kind` | 文字列（必須） |
| `driveFileId` | 文字列（必須） |
| `schemaVersion` | 数値（必須） |
| `status` | 文字列（必須） |
| `sizeBytes` | 数値（null可） |
| `note` | 文字列（必須） |

## system_metadata

システム情報（環境ID・スキーマ・バージョン等）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `key` | 文字列（必須） |
| `value` | 文字列（必須） |

## request_idempotency

冪等性キー（再送時の重複登録防止）（月別パーティション: `createdAt` の年月）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `requestId` | 文字列（必須） |
| `op` | 文字列（必須） |
| `principalKey` | 文字列（必須） |
| `responseJson` | 文字列（必須） |

## operation_journal

書き込み処理履歴（部分失敗の検出・再実行）

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `op` | 文字列（必須） |
| `state` | 文字列（必須） |
| `detail` | 文字列（必須） |

## migration_history

DB マイグレーション履歴

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `fromVersion` | 数値（必須） |
| `toVersion` | 数値（必須） |
| `status` | 文字列（必須） |
| `note` | 文字列（必須） |

## exports

出力ファイル履歴

| 列 | 型 |
|---|---|
| `id` | 文字列（必須） |
| `createdAt` | 文字列（必須） |
| `updatedAt` | 文字列（必須） |
| `version` | 数値（必須） |
| `kind` | 文字列（必須） |
| `format` | 文字列（必須） |
| `driveFileId` | 文字列（必須） |
| `requestedBy` | 文字列（必須） |
| `note` | 文字列（必須） |

## 業務データ以外の保存場所

| 情報 | 保存場所 | 備考 |
|---|---|---|
| PIN の pepper、Admin/Setup との HMAC 鍵、DB ファイルID、フォルダID | Core の Script Properties | DB・バックアップに含めない |
| 端末トークン | iPad の localStorage（平文はここのみ）／ DB には SHA-256 | 端末認証情報のみ永続保存を許可 |
| セッションの最終操作時刻・ノンス・試行回数 | Core の CacheService | 消失時は安全側（失効）に倒す |
| Setup の進捗・リソースID | Setup の UserProperties ＋ 店長 Drive のレジストリ JSON | ペアリングコード・Setup 鍵は UserProperties のみ |
| 給与明細 PDF・出力ファイル・バックアップ | 店長の Drive（Shiftly/02〜05 フォルダ） | drive.file スコープ（Shiftly 作成ファイルのみ） |

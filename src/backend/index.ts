/**
 * Core バックエンドのエントリ（全ハンドラを登録）
 */
import './handlers/system';
import './handlers/staff';
import './handlers/attendance';
import './handlers/shifts-leave';
import './handlers/payconf';
import './handlers/payroll';
import './handlers/ops';
import './handlers/update';
export { handleRequest, listOps, type ApiRequest, type ApiResponse, type Backend } from './api';
export { verifyOwnerEnvelope, signOwnerEnvelope, SECRET_KEYS, ensureSecrets } from './auth';
export { APP_VERSION } from './version';

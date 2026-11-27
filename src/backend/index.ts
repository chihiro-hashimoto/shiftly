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
import './handlers/maintenance';
import './handlers/admin-auth';
import './handlers/requests';
export { handleRequest, listOps, DEFERRED_OPS, type ApiRequest, type ApiResponse, type Backend } from './api';
export { verifyOwnerEnvelope, verifyEnvelope, signOwnerEnvelope, SECRET_KEYS, SETUP_ALLOWED_OPS, ensureSecrets } from './auth';
export { APP_VERSION } from './version';

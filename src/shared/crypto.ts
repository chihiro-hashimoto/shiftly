/**
 * 暗号ユーティリティ（プラットフォーム非依存部分）
 *
 * 方針:
 * - 独自アルゴリズムは作らない。PBKDF2（RFC 8018）を HMAC-SHA256 上で標準どおり実装する。
 *   HMAC-SHA256 自体はプラットフォーム（GAS: Utilities.computeHmacSha256Signature / Node: crypto / ブラウザ: WebCrypto）提供のものを使う。
 * - 6桁 PIN は鍵空間が小さいため、ハッシュだけでは DB 漏えい時のオフライン総当たりに耐えない。
 *   そこで「サーバー側秘密鍵（pepper: Script Properties に保存し DB・バックアップに含めない）」を PIN と結合し、
 *   さらにオンライン試行回数制限・一時ロックを併用する。
 */

export type Bytes = Uint8Array;
export type HmacSha256 = (key: Bytes, data: Bytes) => Bytes;

/** UTF-8 エンコード（GAS V8 には TextEncoder がないため自前実装） */
export function utf8(s: string): Bytes {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function toHex(b: Bytes): string {
  let s = '';
  for (const x of b) s += (x & 0xff).toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h: string): Bytes {
  if (!/^[0-9a-f]*$/i.test(h) || h.length % 2) throw new Error('不正な16進文字列');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Bytes[]): Bytes {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** PBKDF2-HMAC-SHA256（RFC 8018 §5.2） */
export function pbkdf2Sha256(hmac: HmacSha256, password: Bytes, salt: Bytes, iterations: number, dkLen: number): Bytes {
  if (iterations < 1) throw new Error('iterations must be >= 1');
  const hLen = 32;
  const blocks = Math.ceil(dkLen / hLen);
  const out = new Uint8Array(blocks * hLen);
  for (let i = 1; i <= blocks; i++) {
    const intBlock = new Uint8Array([(i >>> 24) & 0xff, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff]);
    let u = hmac(password, concat(salt, intBlock));
    const t = new Uint8Array(u);
    for (let c = 1; c < iterations; c++) {
      u = hmac(password, u);
      for (let k = 0; k < hLen; k++) t[k] = t[k]! ^ u[k]!;
    }
    out.set(t, (i - 1) * hLen);
  }
  return out.slice(0, dkLen);
}

/** 定数時間比較（長さ不一致は即 false） */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const PIN_ALGO = 'pbkdf2-sha256-peppered-v1' as const;

/**
 * PIN ハッシュ: PBKDF2(password = HMAC(pepper, pin), salt, iterations)
 * pepper を知らない限り、DB の hash/salt からオフライン総当たりはできない。
 */
export function hashSecret(hmac: HmacSha256, pepper: Bytes, secret: string, saltHex: string, iterations: number): string {
  const pw = hmac(pepper, utf8(secret));
  return toHex(pbkdf2Sha256(hmac, pw, fromHex(saltHex), iterations, 32));
}

export function validatePinFormat(pin: unknown, length = 6): string | null {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${length}}$`).test(pin)) return `PINは${length}桁の数字で入力してください`;
  if (/^(\d)\1+$/.test(pin)) return '同じ数字の繰り返しは使用できません';
  const asc = '01234567890';
  const desc = '09876543210';
  if (asc.includes(pin) || desc.includes(pin)) return '連続した数字は使用できません';
  return null;
}

/**
 * v1.3 の PIN 方針: 4〜12 桁の数字（先頭 0 可）。同じ数字の繰り返し・連続した数字は不可。
 * 短い PIN は推測されやすいため、サーバー側で試行回数制限と段階的なロック延長を行う（docs/security.md）
 */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 12;
export function validatePinPolicy(pin: unknown): string | null {
  if (typeof pin !== 'string' || !/^\d+$/.test(pin) || pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH)
    return `PINは${PIN_MIN_LENGTH}〜${PIN_MAX_LENGTH}桁の数字で入力してください`;
  return validatePinFormat(pin, pin.length);
}

/**
 * 管理者パスワードの方針（v1.3）: 12〜128 文字、英大文字・英小文字・数字・記号のうち 3 種類以上、
 * 同じ文字の 4 回以上の連続や、推測しやすい語（password, shiftly, admin 等）を含まない
 */
export const ADMIN_PASSWORD_MIN = 12;
export function validateAdminPassword(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < ADMIN_PASSWORD_MIN || pw.length > 128) return `管理者パスワードは${ADMIN_PASSWORD_MIN}〜128文字で入力してください`;
  if (/\s/.test(pw)) return '管理者パスワードに空白は使用できません';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (kinds < 3) return '英大文字・英小文字・数字・記号のうち3種類以上を含めてください';
  if (/(.)\1{3,}/.test(pw)) return '同じ文字を4回以上続けることはできません';
  const lower = pw.toLowerCase();
  for (const w of ['password', 'passw0rd', 'shiftly', 'admin', 'qwerty', '123456', 'abcdef']) if (lower.includes(w)) return `推測されやすい語（${w}）は使用できません`;
  return null;
}

export function validateStepUpSecret(s: unknown): string | null {
  if (typeof s !== 'string' || s.length < 10 || s.length > 64) return '管理用パスコードは10〜64文字で入力してください';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return '管理用パスコードには英字と数字を含めてください';
  return null;
}

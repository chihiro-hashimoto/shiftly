/**
 * 金額計算（有理数・BigInt）
 *
 * 浮動小数点誤差を避けるため、計算途中は分数（分子/分母 BigInt）で保持し、
 * 端数処理は「項目ごとの月合計」で 1 回だけ行う（昭和63年3月14日基発150号の考え方に沿う）。
 */
import type { RoundingMode } from './types';

export class Frac {
  readonly n: bigint;
  readonly d: bigint;
  private constructor(n: bigint, d: bigint) {
    if (d === 0n) throw new Error('分母が0です');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    this.n = g > 1n ? n / g : n;
    this.d = g > 1n ? d / g : d;
  }
  static of(n: number | bigint, d: number | bigint = 1): Frac {
    return new Frac(toBig(n), toBig(d));
  }
  static readonly ZERO = new Frac(0n, 1n);
  add(o: Frac): Frac {
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Frac): Frac {
    return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Frac | number): Frac {
    const f = typeof o === 'number' ? Frac.of(o) : o;
    return new Frac(this.n * f.n, this.d * f.d);
  }
  div(o: Frac | number): Frac {
    const f = typeof o === 'number' ? Frac.of(o) : o;
    if (f.n === 0n) throw new Error('0で除算');
    return new Frac(this.n * f.d, this.d * f.n);
  }
  cmp(o: Frac): number {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  isZero(): boolean {
    return this.n === 0n;
  }
  /** 円未満の端数処理 */
  round(mode: RoundingMode): number {
    return Number(roundBig(this.n, this.d, mode));
  }
  /** 表示・デバッグ用（概数） */
  toNumber(): number {
    return Number(this.n) / Number(this.d);
  }
  toJSON(): string {
    return `${this.n}/${this.d}`;
  }
}

function toBig(v: number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (!Number.isFinite(v)) throw new Error(`数値が不正です: ${v}`);
  if (Number.isInteger(v)) return BigInt(v);
  // 小数は10進表現から正確に分数化（金額設定に小数は通常使わないが安全側に）
  const s = v.toString();
  if (s.includes('e')) throw new Error(`指数表記の数値は扱えません: ${s}`);
  throw new Error(`整数以外は Frac.of(n, d) で指定してください: ${s}`);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

/** 有理数 n/d を円単位に丸める（half_up: 0.5 以上切上げ、負数は絶対値で処理） */
export function roundBig(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const neg = n < 0n;
  const an = neg ? -n : n;
  const q = an / d;
  const r = an % d;
  let res: bigint;
  if (r === 0n) res = q;
  else if (mode === 'ceil') res = neg ? q : q + 1n;
  else res = r * 2n >= d ? q + 1n : q;
  return neg ? -res : res;
}

export function sumFrac(xs: Frac[]): Frac {
  return xs.reduce((a, b) => a.add(b), Frac.ZERO);
}

/** 整数円の検証 */
export function assertYen(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`${label} は0以上の整数（円）で入力してください`);
  }
  return v;
}

export function formatYen(v: number): string {
  return `¥${v.toLocaleString('ja-JP')}`;
}

/** ブラウザでの初期化の画面の URL のフラグメントの読み取り（A案・D-029） */
import { describe, expect, it } from 'vitest';
import { parseInitHash } from '../../src/frontend/components/webInit';

describe('parseInitHash', () => {
  const code = 'a'.repeat(64);
  it('確認コード（64 桁の 16 進）と admin だけを受け付ける', () => {
    expect(parseInitHash(`shiftly-init=${code}`)).toBe(code);
    expect(parseInitHash(`#shiftly-init=${code}`)).toBe(code);
    expect(parseInitHash('shiftly-init=admin')).toBe('admin');
    expect(parseInitHash(`x=1&shiftly-init=${code}&y=2`)).toBe(code);
  });
  it('形式が合わない場合は null（通常の画面を表示する）', () => {
    for (const h of [undefined, null, '', 'shiftly-init=', 'shiftly-init=ABC', `shiftly-init=${'a'.repeat(63)}`, `shiftly-init=${code}x`, 'shiftly-init=admin2', `xshiftly-init=${code}`]) expect(parseInitHash(h)).toBeNull();
  });
});

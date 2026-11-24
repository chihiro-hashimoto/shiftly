import { describe, expect, it } from 'vitest';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { hashSecret, pbkdf2Sha256, timingSafeEqualHex, toHex, utf8, validatePinFormat, validateStepUpSecret } from '../../src/shared/crypto';
import { csvEscape, toCsv } from '../../src/shared/csv';
import { buildXlsx, crc32, toBase64 } from '../../src/shared/xlsx';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hmac = (k: Uint8Array, d: Uint8Array) => new Uint8Array(createHmac('sha256', k).update(d).digest());

describe('PBKDF2-HMAC-SHA256', () => {
  it('Node の実装と一致（独立参照実装との比較）', () => {
    for (const [pw, salt, it_, len] of [
      ['password', 'salt', 1, 32],
      ['password', 'salt', 2, 32],
      ['password', 'salt', 4096, 32],
      ['passwordPASSWORDpassword', 'saltSALTsaltSALTsaltSALTsaltSALTsalt', 4096, 40],
    ] as const) {
      const ours = toHex(pbkdf2Sha256(hmac, utf8(pw), utf8(salt), it_, len));
      const ref = pbkdf2Sync(pw, salt, it_, len, 'sha256').toString('hex');
      expect(ours).toBe(ref);
    }
  });
  it('RFC 7914 §11 のテストベクタ（P="passwd", S="salt", c=1）', () => {
    const v = toHex(pbkdf2Sha256(hmac, utf8('passwd'), utf8('salt'), 1, 64));
    expect(v).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
  });
  it('pepper が異なれば同じ PIN でもハッシュが異なる', () => {
    const a = hashSecret(hmac, utf8('pepper-A'), '482913', '00112233445566778899aabbccddeeff', 10);
    const b = hashSecret(hmac, utf8('pepper-B'), '482913', '00112233445566778899aabbccddeeff', 10);
    expect(a).not.toBe(b);
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, b)).toBe(false);
  });
  it('UTF-8 エンコード（サロゲートペア含む）', () => {
    expect(Array.from(utf8('あ𠮷'))).toEqual(Array.from(Buffer.from('あ𠮷', 'utf8')));
  });
  it('PIN・パスコードの形式検証', () => {
    expect(validatePinFormat('482913')).toBeNull();
    expect(validatePinFormat('111111')).not.toBeNull();
    expect(validatePinFormat('123456')).not.toBeNull();
    expect(validatePinFormat('12345')).not.toBeNull();
    expect(validateStepUpSecret('abc')).not.toBeNull();
    expect(validateStepUpSecret('Shiftly2026x')).toBeNull();
  });
});

describe('CSV', () => {
  it('数式インジェクションを無害化', () => {
    expect(csvEscape('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvEscape('+1')).toBe("'+1");
    expect(csvEscape('-1')).toBe("'-1");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvEscape(-1)).toBe('-1'); // 数値はそのまま
    expect(csvEscape('a,b')).toBe('"a,b"');
  });
  it('BOM と CRLF', () => {
    const s = toCsv(['氏名', '金額'], [['山田', 1000]]);
    expect(s.startsWith('﻿')).toBe(true);
    expect(s).toContain('\r\n');
  });
});

describe('XLSX', () => {
  it('CRC32 既知値', () => {
    expect(crc32(utf8('123456789')).toString(16)).toBe('cbf43926');
  });
  it('Python zipfile / openpyxl で読める（利用可能な場合）', () => {
    const bytes = buildXlsx([{ name: '勤怠', header: ['氏名', '分', '式'], rows: [['山田 <太郎>', 480, '=1+1'], ['佐藤', 0, null]] }]);
    const dir = mkdtempSync(join(tmpdir(), 'shiftly-xlsx-'));
    const f = join(dir, 'a.xlsx');
    writeFileSync(f, bytes);
    const py = `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
names=z.namelist(); assert 'xl/worksheets/sheet1.xml' in names
try:
  import openpyxl
  wb=openpyxl.load_workbook(sys.argv[1]); ws=wb.active
  print(ws.title, ws['A2'].value, ws['B2'].value, ws['C2'].value, ws['C2'].data_type)
except ImportError:
  print('NO_OPENPYXL')
`;
    const out = execFileSync('python3', ['-I', '-c', py, f]).toString().trim();
    if (out !== 'NO_OPENPYXL') expect(out).toBe('勤怠 山田 <太郎> 480 =1+1 s');
    expect(toBase64(new Uint8Array([1, 2, 3, 4]))).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });
});

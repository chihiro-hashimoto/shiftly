/**
 * 最小構成の XLSX（Office Open XML SpreadsheetML）書き出し
 * - 外部ライブラリに依存せず、GAS / ブラウザ / Node の全環境で動作させるため自前実装
 * - ZIP は無圧縮（STORE）。CRC-32 は標準多項式（0xEDB88320）
 * - 文字列は inlineStr として格納するため、数式として評価されない
 */
import { utf8 } from './crypto';

export type XCell = string | number | boolean | null | undefined;
export interface XSheet {
  name: string;
  header: string[];
  rows: XCell[][];
  /** 列幅（文字数）。省略時は自動 */
  widths?: number[];
}

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** 無圧縮 ZIP を生成 */
export function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  // DOS 日時（固定: 2020-01-01 00:00）— 再現性のため
  const dosTime = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = utf8(f.name);
    const crc = crc32(f.data);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0),
      ...name,
    ];
    chunks.push(local, Array.from(f.data));
    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    ]);
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)];
  const total = offset + cdSize + end.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function xmlEscape(s: string): string {
  // XML 1.0 で不正な制御文字を除去
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  return cleaned.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sanitizeSheetName(n: string, used: Set<string>): string {
  let s = n.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
  let i = 2;
  const base = s;
  while (used.has(s)) s = `${base.slice(0, 28)}_${i++}`;
  used.add(s);
  return s;
}

function cellXml(ref: string, v: XCell, style: number): string {
  if (v === null || v === undefined || v === '') return '';
  const s = style ? ` s="${style}"` : '';
  if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : '';
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
}

function sheetXml(sh: XSheet): string {
  const rows: string[] = [];
  const all: XCell[][] = [sh.header, ...sh.rows];
  all.forEach((r, ri) => {
    const cells = r.map((v, ci) => cellXml(`${colName(ci)}${ri + 1}`, v, ri === 0 ? 1 : 0)).join('');
    rows.push(`<row r="${ri + 1}">${cells}</row>`);
  });
  const widths = sh.widths ?? sh.header.map((h, i) => Math.min(40, Math.max(8, h.length * 2, ...sh.rows.slice(0, 200).map((r) => String(r[i] ?? '').length + 2))));
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

export function buildXlsx(sheets: XSheet[]): Uint8Array {
  const used = new Set<string>();
  const names = sheets.map((s) => sanitizeSheetName(s.name, used));
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const add = (name: string, xml: string) => files.push({ name, data: utf8(xml) });
  add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>',
  );
  add(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  add(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
  );
  add(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  add(
    'xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  );
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zipStore(files);
}

export function toBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += chars[(n >> 18) & 63]! + chars[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? chars[n & 63]! : '=';
  }
  return out;
}

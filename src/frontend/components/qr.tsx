/** QR コード（qrcode-generator で行列を作り、SVG 要素として描画。HTML 文字列は挿入しない） */
import qrcode from 'qrcode-generator';

export function QrCode({ text, size = 180, label }: { text: string; size?: number; label: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push([r, c]);
  const q = 4;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n + q * 2} ${n + q * 2}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n + q * 2} height={n + q * 2} fill="#fff" />
      {cells.map(([r, c]) => (
        <rect key={`${r}-${c}`} x={c + q} y={r + q} width={1} height={1} fill="#1b2430" />
      ))}
    </svg>
  );
}

/** Shiftly ブランド（オリジナルのロゴ: 盤面グリーンの文字盤と、中心のブラス色の点＝ダーツの的心） */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Shiftly">
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#1F6F5C" />
      <circle cx="32" cy="32" r="19" fill="none" stroke="#FFFFFF" strokeWidth="5" strokeDasharray="88 32" strokeLinecap="round" transform="rotate(-120 32 32)" />
      <path d="M32 32 L32 18" stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round" />
      <path d="M32 32 L42 38" stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round" />
      <circle cx="32" cy="32" r="4.5" fill="#B88A2E" />
    </svg>
  );
}

export function Wordmark({ size = 28, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <span className="row" style={{ gap: 10 }}>
      <LogoMark size={size} />
      <span style={{ fontFamily: 'var(--font-num)', fontWeight: 700, fontSize: size * 0.82, letterSpacing: '0.02em', color }}>Shiftly</span>
    </span>
  );
}

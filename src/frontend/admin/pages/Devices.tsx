/** 店舗端末（登録コード発行・名称変更・失効） F02 */
import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Empty, ErrorBox, Field, Loading, Modal, Panel, useAction, useClient, useLoad } from '../../components/ui';
import type { Device } from '../../../shared/types';

/** 管理画面のグリッド内で横幅を超えないようにする（表は .table-wrap 内でスクロール） */
const PAGE_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

type DeviceView = Omit<Device, 'tokenHash'>;

const ENROLL_MINUTES = 15;

function fmtDateTime(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

/** プレビューでは店舗 iPad 画面の URL を初期値にする（本番の管理画面 URL はスタッフ用 URL と異なるため空欄） */
function defaultStaffUrl(): string {
  try {
    const u = new URL(location.href);
    if (!u.pathname.endsWith('preview.html')) return '';
    u.searchParams.set('view', 'kiosk');
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

export function DevicesPage() {
  const client = useClient();
  const list = useLoad(() => client.call<DeviceView[]>('devices.list'), []);
  const [rename, setRename] = useState<DeviceView | null>(null);
  const [revoke, setRevoke] = useState<DeviceView | null>(null);
  const [showRevoked, setShowRevoked] = useState(true);

  const rows = [...(list.data ?? [])].sort((a, b) => (a.status === b.status ? (a.registeredAt < b.registeredAt ? 1 : -1) : a.status === 'active' ? -1 : 1));
  const shown = rows.filter((d) => showRevoked || d.status === 'active');
  const activeCount = rows.filter((d) => d.status === 'active').length;

  return (
    <div style={PAGE_STYLE}>
      <EnrollPanel onIssued={list.reload} />

      <Panel
        title={
          <h2>
            登録済みの端末 <span className="small muted" style={{ fontWeight: 400 }}>{list.data ? `利用中 ${activeCount} 台 / 全 ${rows.length} 台` : ''}</span>
          </h2>
        }
        actions={
          <>
            <label className="check small">
              <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
              失効済みも表示
            </label>
            <button className="btn btn-sm btn-ghost" onClick={list.reload} disabled={list.loading}>
              再読み込み
            </button>
          </>
        }
        pad={false}
      >
        {list.loading && <Loading />}
        {list.error && <div className="panel-body"><ErrorBox message={list.error} onRetry={list.reload} /></div>}
        {list.data && !list.loading && shown.length === 0 && <Empty>{rows.length === 0 ? '登録済みの端末はありません。上の「登録コードを発行」から店舗 iPad を登録してください' : '利用中の端末はありません'}</Empty>}
        {list.data && !list.loading && shown.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>端末名</th>
                  <th>状態</th>
                  <th>登録日時</th>
                  <th>最終利用</th>
                  <th>失効日時</th>
                  <th>ブラウザ情報</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.id} style={d.status === 'revoked' ? { color: 'var(--ink-3)' } : undefined}>
                    <td style={{ fontWeight: 600, minWidth: 120 }}>{d.name}</td>
                    <td>{d.status === 'active' ? <span className="badge badge-board">利用中</span> : <span className="badge badge-bull">失効</span>}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(d.registeredAt)}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(d.lastUsedAt)}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(d.revokedAt)}</td>
                    <td className="small muted" title={d.userAgentHint} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.userAgentHint || '—'}
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {d.status === 'active' && (
                        <>
                          <button className="btn btn-sm" onClick={() => setRename(d)}>
                            名称変更
                          </button>{' '}
                          <button className="btn btn-sm" style={{ color: 'var(--bull)' }} onClick={() => setRevoke(d)}>
                            失効
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="two-col">
        <Panel title="端末を交換する・トークンが漏えいした場合">
          <ol className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li>一覧から対象の端末を<strong>失効</strong>します。失効した端末からは、その時点でログイン中のスタッフも含め打刻・閲覧ができなくなります。</li>
            <li>新しい（または同じ）iPad で、スタッフ用 URL を開きます。</li>
            <li>この画面で<strong>登録コードを発行</strong>し、iPad の画面に入力して再登録します。</li>
          </ol>
          <p className="small muted" style={{ marginTop: 8 }}>失効した端末は元に戻せません。必要な場合は再登録してください（失効の記録は監査ログに残ります）。</p>
        </Panel>
        <Panel title="ご注意">
          <ul className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li>iPad のブラウザ（Safari）で<strong>履歴・Webサイトデータを消去すると、端末の登録が消えるため再登録が必要</strong>です。プライベートブラウズでは登録を保持できません。</li>
            <li>端末の登録はブラウザに保存した端末トークンで判定しています。<strong>物理的な iPad の完全な識別は保証できません</strong>。</li>
            <li>使わなくなった端末は必ず失効してください。</li>
          </ul>
        </Panel>
      </div>

      {rename && <RenameModal d={rename} onClose={() => setRename(null)} onDone={() => { setRename(null); list.reload(); }} />}
      {revoke && <RevokeModal d={revoke} onClose={() => setRevoke(null)} onDone={() => { setRevoke(null); list.reload(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ 登録コード発行
function EnrollPanel({ onIssued }: { onIssued: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [name, setName] = useState('店舗iPad');
  const [issued, setIssued] = useState<{ code: string; expiresAt: string; deviceName: string } | null>(null);
  const [url, setUrl] = useState(defaultStaffUrl);
  const now = useNow(issued !== null);

  const issue = async () => {
    const deviceName = name.trim();
    const r = await run(() => client.call<{ code: string; expiresAt: string }>('devices.createEnrollment', { deviceName }), '登録コードを発行しました');
    if (r) {
      setIssued({ ...r, deviceName });
      onIssued();
    }
  };
  const remainSec = issued ? Math.max(0, Math.floor((Date.parse(issued.expiresAt) - now) / 1000)) : 0;
  const expired = issued !== null && remainSec <= 0;

  return (
    <Panel title="店舗 iPad を登録する">
      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}>
        <div className="stack" style={{ alignContent: 'start' }}>
          <ol className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 2 }}>
            <li>登録する iPad でスタッフ用 URL を開きます（右の QR コードを読み取ると簡単です）。</li>
            <li>端末名を入力して「登録コードを発行」を押します。</li>
            <li>iPad の画面に表示された入力欄に、登録コードを入力します。</li>
          </ol>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 200px' }}>
              <Field label="端末名" hint="例: レジ横iPad（40文字まで）">
                <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
            <button className="btn btn-primary" onClick={issue} disabled={busy || !name.trim()}>
              登録コードを発行
            </button>
          </div>
          {issued && (
            <div
              style={{
                border: `2px solid ${expired ? 'var(--line)' : 'var(--board)'}`,
                borderRadius: 'var(--radius-m)',
                padding: '14px 16px',
                background: expired ? '#fafbfa' : 'var(--board-soft)',
                textAlign: 'center',
              }}
              aria-live="polite"
            >
              <div className="small muted">「{issued.deviceName}」の登録コード</div>
              <div
                className="num"
                data-testid="enroll-code"
                style={{
                  fontSize: 'clamp(2rem, 8vw, 3rem)',
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  lineHeight: 1.2,
                  color: expired ? 'var(--ink-3)' : 'var(--board-deep)',
                  textDecoration: expired ? 'line-through' : undefined,
                  userSelect: 'all',
                  overflowWrap: 'anywhere',
                }}
              >
                {issued.code.slice(0, 5)} {issued.code.slice(5)}
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                {expired ? (
                  <span style={{ color: 'var(--bull)', fontWeight: 600 }}>有効期限が切れました。もう一度発行してください</span>
                ) : (
                  <>
                    有効期限 {fmtDateTime(issued.expiresAt).slice(11)}（あと <span className="num">{Math.floor(remainSec / 60)}:{String(remainSec % 60).padStart(2, '0')}</span>）・1回限り有効
                  </>
                )}
              </div>
            </div>
          )}
          <p className="small muted">登録コードは発行から{ENROLL_MINUTES}分間・1回だけ使えます。コードは画面にのみ表示され、保存されません。入力時は大文字・小文字やスペースを区別しません。</p>
        </div>
        <div className="stack" style={{ alignContent: 'start' }}>
          <Field label="スタッフ用URL" hint="Shiftly Setup に表示されたスタッフ用（店舗 iPad 用）の URL を貼り付けてください">
            <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://script.google.com/macros/s/…/exec" inputMode="url" />
          </Field>
          <QrView text={url.trim()} />
        </div>
      </div>
    </Panel>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// ------------------------------------------------------------------ QR コード（SVG を React 要素として描画）
function QrView({ text }: { text: string }) {
  const qr = useMemo(() => {
    if (!text) return null;
    if (!/^https?:\/\//i.test(text)) return { error: 'http:// または https:// から始まる URL を入力してください' } as const;
    try {
      const q = qrcode(0, 'M');
      q.addData(text, 'Byte');
      q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { n, d } as const;
    } catch {
      return { error: 'URL が長すぎるため QR コードを作成できません' } as const;
    }
  }, [text]);
  if (!qr) return <div className="empty small" style={{ border: '1px dashed var(--line)', borderRadius: 'var(--radius-m)' }}>URL を入力すると QR コードを表示します</div>;
  if ('error' in qr) return <ErrorBox message={qr.error ?? ''} />;
  const m = 4; // quiet zone
  const size = qr.n + m * 2;
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 6 }}>
      <svg
        role="img"
        aria-label="スタッフ用URLの QR コード"
        viewBox={`${-m} ${-m} ${size} ${size}`}
        width={220}
        height={220}
        shapeRendering="crispEdges"
        style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 'var(--radius-s)', maxWidth: '100%', height: 'auto' }}
      >
        <rect x={-m} y={-m} width={size} height={size} fill="#fff" />
        <path d={qr.d} fill="#000" />
      </svg>
      <div className="small muted" style={{ overflowWrap: 'anywhere', textAlign: 'center', maxWidth: 360 }}>{text}</div>
      <p className="small muted">iPad のカメラで読み取り、Safari で開いてください。QR コードには登録コードは含まれません。</p>
    </div>
  );
}

// ------------------------------------------------------------------ モーダル
function RenameModal({ d, onClose, onDone }: { d: DeviceView; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [name, setName] = useState(d.name);
  const save = async () => {
    const r = await run(() => client.call('devices.rename', { deviceId: d.id, name: name.trim() }), '端末名を変更しました');
    if (r) onDone();
  };
  return (
    <Modal
      title="端末名の変更"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim() || name.trim() === d.name}>
            保存
          </button>
        </>
      }
    >
      <Field label="端末名" hint="40文字まで">
        <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function RevokeModal({ d, onClose, onDone }: { d: DeviceView; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const submit = async () => {
    const r = await run(() => client.call('devices.revoke', { deviceId: d.id }), `「${d.name}」を失効しました`);
    if (r) onDone();
  };
  return (
    <Modal
      title="端末を失効しますか？"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-danger" onClick={submit} disabled={busy}>
            失効する
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <p>
          <strong>{d.name}</strong>（登録 {fmtDateTime(d.registeredAt)}）を失効します。
        </p>
        <ul className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          <li>この端末からは打刻・ログインができなくなり、ログイン中のスタッフのセッションも失効します。</li>
          <li>失効は取り消せません。引き続き使う場合は、新しい登録コードを発行して再登録してください。</li>
          <li>端末トークンが漏えいした疑いがある場合や、iPad を交換・処分する場合に失効してください。</li>
        </ul>
      </div>
    </Modal>
  );
}

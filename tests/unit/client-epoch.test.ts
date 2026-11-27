/**
 * 画面側のクライアントの復元世代（D-026）
 * - 最初に受け取った世代を固定し、以後のすべての要求に付ける（途中で置き換えない）
 * - 異なる世代の応答・STALE_VIEW を受け取ったら古い画面として通知する
 * - 再ログイン（セッションの付け替え）では固定した世代は変わらない
 */
import { describe, expect, it } from 'vitest';
import { Client, onStaleView, type ApiResult, type Transport } from '../../src/frontend/api/transport';

function fakeTransport(responses: Array<Partial<ApiResult> & { ok: boolean }>) {
  const sent: Array<Record<string, unknown>> = [];
  const t: Transport = {
    mode: 'admin',
    call: async (req) => {
      sent.push(req as Record<string, unknown>);
      const r = responses.shift() ?? { ok: true, data: null };
      return (r.ok ? { ok: true, data: (r as { data?: unknown }).data ?? null, ...('epoch' in r ? { epoch: r.epoch } : {}) } : { ok: false, error: (r as { error: { code: string; message: string } }).error, ...('epoch' in r ? { epoch: r.epoch } : {}) }) as ApiResult;
    },
  };
  return { t, sent };
}

describe('Client の復元世代', () => {
  it('最初の応答の世代を固定し、以後の要求に付ける。異なる世代を受け取っても固定した世代は置き換えない', async () => {
    const { t, sent } = fakeTransport([{ ok: true, epoch: 100 }, { ok: true, epoch: 100 }, { ok: true, epoch: 200 }, { ok: true, epoch: 200 }]);
    const c = new Client(t);
    let notified = 0;
    const off = onStaleView(() => notified++);
    await c.raw('settings.get');
    expect(sent[0]!.epoch).toBeUndefined(); // まだ受け取っていない
    await c.raw('settings.update', { a: 1 });
    expect(sent[1]!.epoch).toBe(100);
    await c.raw('employees.list'); // 復元の後の応答（世代 200）
    expect(c.stale).toBe(true);
    expect(notified).toBe(1);
    await c.raw('settings.update', { a: 2 }); // 古い画面からの保存: 固定した世代（100）のまま送る（新しい世代を付け直さない）
    expect(sent[3]!.epoch).toBe(100);
    expect(c.epoch).toBe(100);
    off();
  });

  it('STALE_VIEW の応答で古い画面として通知する', async () => {
    const { t } = fakeTransport([{ ok: true, epoch: 5 }, { ok: false, error: { code: 'STALE_VIEW', message: '' }, epoch: 5 }]);
    const c = new Client(t);
    let notified = 0;
    const off = onStaleView(() => notified++);
    await c.raw('settings.get');
    await c.raw('settings.update');
    expect(c.stale).toBe(true);
    expect(notified).toBe(1);
    off();
  });

  it('再ログイン（セッションの付け替え）では固定した世代は変わらない', async () => {
    const { t, sent } = fakeTransport([{ ok: true, epoch: 7 }, { ok: true, epoch: 7 }]);
    const c = new Client(t);
    await c.raw('settings.get');
    c.adminSession = 'new-session';
    c.session = 'new-staff-session';
    await c.raw('permissions.set');
    expect(sent[1]!.epoch).toBe(7);
    expect(sent[1]!.adminSession).toBe('new-session');
  });

  it('新しいクライアント（画面の作り直し）は、最新の世代を固定する', async () => {
    const { t, sent } = fakeTransport([{ ok: true, epoch: 9 }, { ok: true, epoch: 9 }]);
    const c = new Client(t);
    await c.raw('settings.get');
    await c.raw('settings.update');
    expect(sent[1]!.epoch).toBe(9);
    expect(c.stale).toBe(false);
  });
});

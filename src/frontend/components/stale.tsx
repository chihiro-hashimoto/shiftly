/**
 * 復元より前に読み込んだ画面の案内（D-026）
 * サーバーが復元世代の不一致（STALE_VIEW）を返した、または異なる世代の応答を受け取ったときに表示する。
 * 「読み込み直す」で画面全体（入力中の内容・クライアントの状態を含む）を作り直す。古い入力内容は自動では送り直さない
 */
import { useEffect, useState } from 'react';
import { onStaleView } from '../api/transport';

export function StaleViewGuard({ onReset }: { onReset: () => void }) {
  const [stale, setStale] = useState(false);
  useEffect(() => onStaleView(() => setStale(true)), []);
  if (!stale) return null;
  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="stale-title" style={{ zIndex: 1000 }}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <h2 id="stale-title" style={{ marginTop: 0 }}>画面を読み込み直してください</h2>
        <p>この画面を開いた後に、Google 所有者の保守作業（データの復元など）が行われました。表示中の内容は保守作業の前のものです。</p>
        <p>入力中の内容は保存されていません。読み込み直した後に最新の内容を確認し、必要な入力をやり直してください。</p>
        <button
          className="btn btn-primary btn-lg"
          onClick={() => {
            setStale(false);
            onReset();
          }}
        >
          読み込み直す
        </button>
      </div>
    </div>
  );
}

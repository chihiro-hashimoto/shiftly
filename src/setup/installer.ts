/**
 * Shiftly Setup のインストーラー（状態機械）
 *
 * - 各工程は冪等。進捗・リソースID は Registry（サーバー側: UserProperties ＋ Drive のレジストリファイル）に保存し、
 *   端末のキャッシュでは初回判定しない。
 * - プロジェクト作成直後に ID を保存（重複生成防止）。保存前に通信が切れた場合は、
 *   タイトルに環境IDを含めて手動で識別・削除できるようにする（Apps Script API に一覧取得はない）。
 * - Google の権限承認は利用者本人が行う工程として止める（自動で迂回しない）。
 * - アカウント取り違え防止: 既存レジストリの所有者メールと現在のアカウントが異なれば停止。
 */
import { AppsScriptApi, AppsScriptApiError, webAppUrl, type Deployment, type ScriptFile } from './apps-script-api';

export type StepId =
  | 'account'
  | 'api'
  | 'store'
  | 'core.create'
  | 'core.upload'
  | 'core.deploy'
  | 'core.authorize'
  | 'admin.create'
  | 'admin.upload'
  | 'admin.deploy'
  | 'admin.authorize'
  | 'setup.pair'
  | 'verify';

export const STEPS: Array<{ id: StepId; label: string; manual?: boolean }> = [
  { id: 'account', label: 'Google アカウントの確認' },
  { id: 'api', label: 'Apps Script API の利用確認' },
  { id: 'store', label: '店舗情報の入力' },
  { id: 'core.create', label: 'Shiftly-Staff（本体）の作成' },
  { id: 'core.upload', label: 'Shiftly-Staff のコード配置' },
  { id: 'core.deploy', label: 'Shiftly-Staff のデプロイ' },
  { id: 'core.authorize', label: 'Shiftly-Staff の権限承認と初期化（フォルダ・DB 作成）', manual: true },
  { id: 'admin.create', label: 'Shiftly-Admin（管理者用）の作成' },
  { id: 'admin.upload', label: 'Shiftly-Admin のコード配置' },
  { id: 'admin.deploy', label: 'Shiftly-Admin のデプロイ' },
  { id: 'admin.authorize', label: 'Shiftly-Admin の権限承認と接続', manual: true },
  { id: 'setup.pair', label: '更新用の接続設定' },
  { id: 'verify', label: '接続・DB 整合性の確認' },
];

export interface ProjectRef {
  scriptId?: string;
  deploymentId?: string;
  url?: string;
  versionNumber?: number;
  title?: string;
  /** 作成 API の呼び出し開始時刻（応答を受け取る前に保存。応答喪失時に重複作成しないための目印） */
  creatingAt?: string;
  /** 作成の結果が分からないことと、一覧での確認を案内済みか（案内の後の「再実行」でだけ目印を外す。Codex 監査19 #2） */
  creatingPrompted?: boolean;
  /** Web アプリのデプロイの作成の目印（呼び出しの前に保存。応答喪失・中断の後の再開で、既存のデプロイを照合する。Codex 監査17 #3） */
  deployingAt?: string;
  /** 作成を要求したデプロイの説明（照合に使う） */
  deployingDescription?: string;
  /** デプロイの作成の結果が分からないことと、「デプロイを管理」での確認を案内済みか（独立した点検 S1-1） */
  deployingPrompted?: boolean;
  /** 案内の後、管理者がデプロイがないことを確認したと明示したか（一覧で見つからない場合に、同じ説明で作成してよい） */
  deployingConfirmed?: boolean;
  /** 記録しているデプロイが照会で見つからないことを案内済みか／ないことの確認を明示したか（Codex 監査22 #4） */
  deploymentMissingPrompted?: boolean;
  deploymentMissingConfirmed?: boolean;
  /** 記録しているプロジェクトが照会で見つからないことを案内済みか／ないことの確認を明示したか（Codex 監査23 #4） */
  projectMissingPrompted?: boolean;
  projectMissingConfirmed?: boolean;
}

export interface Registry {
  schema: 1;
  envId: string;
  ownerEmail: string;
  storeName: string;
  appVersion: string | null;
  createdAt: string;
  updatedAt: string;
  steps: Partial<Record<StepId, { status: 'done' | 'error'; at: string; message?: string }>>;
  core: ProjectRef;
  admin: ProjectRef;
  /**
   * 構築の完了前の検証の記録（D-026 S1）。checked: 自動で確かめた項目／unverified: 自動では確かめられない項目
   * （Apps Script のプロジェクトの重複。Setup の権限 drive.file では一覧できないため、検証済みとして扱わず、完了画面で確認を案内する）
   */
  verification?: Verification;
  /**
   * 自動では確かめられない項目（Apps Script のプロジェクトの重複）を、所有者が確認したことの記録（D-027。Codex 監査24 A4）。
   * 確認したときの Staff・Admin のプロジェクトの ID と結び付ける（プロジェクトを作り直す・関連付け直した場合は確認し直す）。
   * 確認がない間は構築を完了しない
   */
  projectsConfirmed?: { core: string; admin: string; at: string } | null;
  /** 所有者の確認を案内済みか（案内の後の「再実行」の確認の明示でだけ記録する） */
  projectsConfirmPrompted?: boolean;
  /** ペアリングコードのハッシュ（非秘密）。平文コードは SecretRegistry に保持 */
  adminPairingHash: string;
  setupPairingHash: string;
}

/** 秘密情報（UserProperties のみ。Drive のレジストリファイルには書かない） */
export interface SecretRegistry {
  adminPairingCode: string;
  setupPairingCode: string;
  setupKey: string | null;
  /** ペアリング送信前に保存する鍵（応答喪失時の再開用。成功後に削除） */
  pendingSetupKey?: string;
}

/**
 * 構築の完了前の検証の記録（D-026 S1・D-027）。checked: 自動で確かめた項目／unverified: 自動では確かめられない項目／
 * ownerConfirmed: 自動では確かめられない項目のうち、所有者が確認したと明示したもの（完了の条件）
 */
export interface Verification {
  at: string;
  checked: string[];
  unverified: string[];
  ownerConfirmed?: string[];
}

export interface ReleaseBundle {
  version: string;
  core: ScriptFile[];
  admin: ScriptFile[];
  /** ファイル名 → SHA-256（ビルド時に生成。配置前に再計算して改ざん・破損を検知） */
  hashes: Record<string, string>;
}

export interface CorePing {
  app: string;
  version: string;
  schemaVersion: number;
  initialized: boolean;
  envId: string;
  adminPaired: boolean;
  setupPaired: boolean;
}

export interface InstallerDeps {
  api: AppsScriptApi;
  release: ReleaseBundle;
  load(): { reg: Registry | null; secrets: SecretRegistry | null };
  save(reg: Registry, secrets: SecretRegistry): void;
  userEmail(): string | null;
  randomHex(bytes: number): string;
  sha256Hex(s: string): string;
  now(): string;
  /** Core へ POST（ping / pair） */
  postCore(url: string, body: unknown): { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  /**
   * Google ドライブの Setup の記録ファイルの点検（D-027。Codex 監査24 A4）。全ページを一覧し、この環境の記録ファイルが 1 つだけで、
   * 保存している ID と一致することを確かめる。一覧の途中で失敗した場合は例外（点検できない）。点検できない環境では undefined
   */
  registryReport?(envId: string): { ok: boolean; issues: string[] };
  /** Core へ Setup 役割の署名付きリクエスト */
  callCoreAsSetup(url: string, keyHex: string, req: { op: string; args?: unknown }): { ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

export interface StepResult {
  state: PublicState;
  /** 利用者の操作待ち（権限承認など） */
  waitingFor: null | { step: StepId; instructions: string[]; openUrl?: string };
  error: null | { step: StepId; message: string; fix: string; confirm?: string };
}

export interface PublicState {
  envId: string | null;
  ownerEmail: string | null;
  storeName: string | null;
  steps: Array<{ id: StepId; label: string; status: 'done' | 'error' | 'pending'; message?: string; manual?: boolean }>;
  /** 構築の完了前の検証の記録（自動で確かめた項目／自動では確かめられない項目／所有者が確認した項目。D-026 S1・D-027） */
  verification: Verification | null;
  complete: boolean;
  /** 店舗 iPad（Shiftly-Staff）の URL */
  staffUrl: string | null;
  adminUrl: string | null;
  coreEditorUrl: string | null;
  adminEditorUrl: string | null;
  installedVersion: string | null;
  releaseVersion: string;
}

export class InstallerError extends Error {
  constructor(
    readonly step: StepId,
    message: string,
    readonly fix: string,
    /** 再実行の前に利用者が確認すべきこと（画面は確認のチェックがあるまで「再実行」を押せない） */
    readonly confirm?: string,
  ) {
    super(message);
  }
}

/**
 * 「作成されていない」と判断してよい応答（D-026 S1。許可リスト）。要求の内容・認証・権限・利用上限の段階で Google が拒否した
 * （作成の処理に進んでいない）ことが分かるものだけ。400: 要求の形式が不正／401: 認証されていない／403: 権限がない・API が無効／
 * 429: 利用上限。404・409・410・412・499（取消）などは、作成済みかどうかを応答から判断できないため含めない
 */
export const DEFINITELY_NOT_CREATED = new Set([400, 401, 403, 429]);

/**
 * 外部の作成の要求が失敗したとき、作成されたかどうかが分からないか（Codex 監査19 #2・独立した点検 D-026）。
 * 許可リスト（DEFINITELY_NOT_CREATED）の応答だけを「作成されていない」とし、それ以外（通信の例外・タイムアウト・5xx・
 * その他の 4xx・ID のない成功応答）はすべて、作成されたかどうか分からないとして扱う
 */
export function createOutcomeUnknown(e: unknown): boolean {
  if (!(e instanceof AppsScriptApiError)) return true;
  return !DEFINITELY_NOT_CREATED.has(e.status);
}

const editorUrl = (id?: string) => (id ? `https://script.google.com/home/projects/${encodeURIComponent(id)}/edit` : null);

export class Installer {
  private reg: Registry | null;
  private sec: SecretRegistry | null;
  constructor(private readonly d: InstallerDeps) {
    const l = d.load();
    this.reg = l.reg;
    this.sec = l.secrets;
    if (this.reg && !this.sec) this.recoverSecrets();
  }

  /**
   * レジストリ（非秘密）のみ復元でき、秘密情報（ペアリングコード・Setup 鍵）を失った場合の復旧。
   * 新しい Setup 用ペアリングコードを発行し、Core のコード再配置・再デプロイ・再ペアリングが必要な状態に戻す。
   * 事前に Shiftly-Staff のエディタで shiftlyResetSetupPairing（Setup との接続のリセット）の実行が必要。
   */
  private recoverSecrets() {
    const code = this.d.randomHex(32);
    this.sec = { adminPairingCode: '', setupPairingCode: code, setupKey: null };
    this.reg!.setupPairingHash = this.d.sha256Hex(code);
    for (const s of ['core.upload', 'core.deploy', 'setup.pair', 'verify'] as StepId[]) delete this.reg!.steps[s];
    this.persist();
  }

  /** Setup の記録（レジストリ）を読み込めたか（ない場合は新しい環境の構築になる） */
  hasRegistry(): boolean {
    return !!this.reg;
  }

  state(): PublicState {
    const r = this.reg;
    return {
      envId: r?.envId ?? null,
      ownerEmail: r?.ownerEmail ?? null,
      storeName: r?.storeName || null,
      steps: STEPS.map((s) => ({ id: s.id, label: s.label, manual: s.manual, status: r?.steps[s.id]?.status ?? 'pending', message: r?.steps[s.id]?.message })),
      complete: !!r && STEPS.every((s) => r.steps[s.id]?.status === 'done'),
      verification: r?.verification ?? null,
      staffUrl: r?.core.url ?? null,
      adminUrl: r?.admin.url ?? null,
      coreEditorUrl: editorUrl(r?.core.scriptId),
      adminEditorUrl: editorUrl(r?.admin.scriptId),
      installedVersion: r?.appVersion ?? null,
      releaseVersion: this.d.release.version,
    };
  }

  private persist() {
    if (!this.reg || !this.sec) return;
    this.reg.updatedAt = this.d.now();
    this.d.save(this.reg, this.sec);
  }

  private mark(step: StepId, status: 'done' | 'error', message?: string) {
    if (!this.reg) return;
    this.reg.steps[step] = { status, at: this.d.now(), ...(message ? { message } : {}) };
    this.persist();
  }

  /** 既存環境の所有者と現在のアカウントの照合（すべての操作の前に実行） */
  private guardAccount(): StepResult['error'] {
    if (!this.reg) return null;
    const email = this.d.userEmail();
    if (!email || email.toLowerCase() !== this.reg.ownerEmail.toLowerCase())
      return { step: 'account', message: `この環境は別の Google アカウント（${maskEmail(this.reg.ownerEmail)}）で作成されています`, fix: '管理者の Google アカウントでログインし直してください（アカウントの取り違え防止）' };
    return null;
  }

  /** 次の未完了工程を 1 つ実行 */
  runNext(input: { storeName?: string } = {}): StepResult {
    const guard = this.guardAccount();
    if (guard) return { state: this.state(), waitingFor: null, error: guard };
    const next = STEPS.find((s) => this.reg?.steps[s.id]?.status !== 'done');
    if (!next) return { state: this.state(), waitingFor: null, error: null };
    // 構築を完了した環境（版を記録済み）を、別の版の Setup で作り直さない（v1.3 では Setup による既存環境の更新を提供しない。D-027）
    if (this.reg?.appVersion && this.reg.appVersion !== this.d.release.version)
      return {
        state: this.state(),
        waitingFor: null,
        error: {
          step: next.id,
          message: `この環境は Shiftly ${this.reg.appVersion} で構築されています。この Setup（${this.d.release.version}）では変更しません`,
          fix: 'v1.3 では、構築済みの環境のアプリの更新を Setup から行いません（更新は Google 所有者の保守作業として行います。docs/update-rollback.md）。構築に使った版の Setup を使ってください',
        },
      };
    try {
      const waiting = this.run(next.id, input);
      if (!waiting) this.mark(next.id, 'done');
      return { state: this.state(), waitingFor: waiting, error: null };
    } catch (e) {
      const err = e instanceof InstallerError ? e : toInstallerError(next.id, e);
      // 確認を求めない別の理由の失敗では、その工程の「案内済み」「確認済み」を外す（関連付け・確認の明示は、直近の失敗が
      // 確認を求めた場合だけ有効にする。D-026 の再点検 #3）
      if (this.reg && !err.confirm) {
        const which = next.id.startsWith('core.') ? 'core' : next.id.startsWith('admin.') ? 'admin' : null;
        if (which && (next.id.endsWith('.create') || next.id.endsWith('.deploy'))) {
          const flags = next.id.endsWith('.create')
            ? { creatingPrompted: undefined, projectMissingPrompted: undefined, projectMissingConfirmed: undefined }
            : { deployingPrompted: undefined, deployingConfirmed: undefined, deploymentMissingPrompted: undefined, deploymentMissingConfirmed: undefined };
          this.reg[which] = { ...this.reg[which], ...flags };
        }
      }
      if (this.reg) this.mark(next.id, 'error', err.message);
      return { state: this.state(), waitingFor: null, error: { step: err.step, message: err.message, fix: err.fix, ...(err.confirm ? { confirm: err.confirm } : {}) } };
    }
  }

  /** 完了するか利用者操作が必要になるまで連続実行（GAS の実行時間上限に配慮し上限回数あり） */
  runUntilBlocked(input: { storeName?: string } = {}, maxSteps = 6): StepResult {
    let r = this.runNext(input);
    for (let i = 1; i < maxSteps && !r.error && !r.waitingFor && !r.state.complete; i++) r = this.runNext(input);
    return r;
  }

  private run(step: StepId, input: { storeName?: string }): StepResult['waitingFor'] {
    const d = this.d;
    switch (step) {
      case 'account': {
        const email = d.userEmail();
        if (!email) throw new InstallerError(step, 'Google アカウントを確認できません', 'Google にログインし、Shiftly Setup の権限を承認してから再度開いてください');
        if (this.reg && this.reg.ownerEmail && this.reg.ownerEmail.toLowerCase() !== email.toLowerCase())
          throw new InstallerError(step, `この環境は別の Google アカウント（${maskEmail(this.reg.ownerEmail)}）で作成されています`, '管理者の Google アカウントでログインし直してください（アカウントの取り違え防止）');
        if (!this.reg) {
          const now = d.now();
          const adminCode = d.randomHex(32);
          const setupCode = d.randomHex(32);
          this.reg = {
            schema: 1,
            envId: `env_${d.randomHex(10)}`,
            ownerEmail: email,
            storeName: '',
            appVersion: null,
            createdAt: now,
            updatedAt: now,
            steps: {},
            core: {},
            admin: {},
            adminPairingHash: d.sha256Hex(adminCode),
            setupPairingHash: d.sha256Hex(setupCode),
          };
          this.sec = { adminPairingCode: adminCode, setupPairingCode: setupCode, setupKey: null };
          this.persist();
        }
        return null;
      }
      case 'api': {
        const p = d.api.probe();
        if (!p.ok) {
          if (p.reason === 'API_DISABLED')
            throw new InstallerError(step, 'Apps Script API が無効です', 'https://script.google.com/home/usersettings を開き「Google Apps Script API」をオンにしてから再実行してください（Shiftly Setup を提供する Cloud プロジェクト側で API が無効な場合は導入手順書の事前準備を確認）');
          throw new InstallerError(step, `Apps Script API を利用できません（${p.message}）`, 'Shiftly Setup の権限（スクリプトの作成・デプロイ）を承認したか確認してください');
        }
        return null;
      }
      case 'store': {
        const name = (input.storeName ?? this.reg!.storeName).trim();
        if (!name || name.length > 60) throw new InstallerError(step, '店舗名を入力してください（60文字以内）', '店舗名を入力して「次へ」を押してください');
        this.reg!.storeName = name;
        this.persist();
        return null;
      }
      case 'core.create':
        // v1.3 で名称を Shiftly-Kiosk から Shiftly-Staff に変更。既存の環境は保存済みの scriptId で識別するため、旧名称のプロジェクトもそのまま使う
        return this.createProject('core', `Shiftly-Staff (${this.reg!.envId})`);
      case 'admin.create':
        return this.createProject('admin', `Shiftly-Admin (${this.reg!.envId})`);
      case 'core.upload':
        this.upload('core');
        return null;
      case 'admin.upload':
        this.upload('admin');
        return null;
      case 'core.deploy':
        this.deploy('core');
        return null;
      case 'admin.deploy':
        this.deploy('admin');
        return null;
      case 'core.authorize': {
        const ping = this.ping();
        if (ping && ping.initialized && ping.envId === this.reg!.envId) return null;
        if (ping && ping.envId !== this.reg!.envId) throw new InstallerError(step, '接続先の環境IDが一致しません', 'Shiftly Setup のサポート情報を確認してください');
        return {
          step,
          openUrl: editorUrl(this.reg!.core.scriptId) ?? undefined,
          instructions: [
            '下のボタンで Shiftly-Staff のスクリプトエディタを開きます（管理者の Google アカウント）。',
            '関数の選択欄で「shiftlyAuthorize」を選び「実行」を押します。',
            'Google の確認画面で権限を確認し「許可」を押します（Shiftly が作成したファイルのみ操作する権限です）。',
            '実行ログに完了が表示されたら、この画面に戻って「確認して続行」を押してください。',
          ],
        };
      }
      case 'admin.authorize': {
        const ping = this.ping();
        if (ping?.adminPaired) return null;
        return {
          step,
          openUrl: editorUrl(this.reg!.admin.scriptId) ?? undefined,
          instructions: [
            '下のボタンで Shiftly-Admin のスクリプトエディタを開きます。',
            '「shiftlyAuthorize」を選び「実行」→ 権限を確認して「許可」を押します。',
            '完了したら、この画面に戻って「確認して続行」を押してください。',
          ],
        };
      }
      case 'setup.pair': {
        if (this.sec!.setupKey) return null;
        // 鍵は Setup 側で生成して送信前に保存する（応答が失われても、保存済みの鍵で登録済みかを確かめて再開できる）
        if (!this.sec!.pendingSetupKey) {
          this.sec!.pendingSetupKey = d.randomHex(32);
          this.persist();
        }
        const pending = this.sec!.pendingSetupKey;
        const r = d.postCore(this.reg!.core.url!, { kind: 'pair', role: 'setup', pairingCode: this.sec!.setupPairingCode, clientKey: pending });
        let key: string | null = r.ok ? (r.data as { key: string }).key : null;
        // 登録済み（CONFLICT）: 前回の応答が失われた可能性。保存済みの鍵で署名した呼び出しが通れば、その鍵が登録されている。
        // 鍵が拒否された（UNAUTHENTICATED）場合だけ「別の鍵で登録済み」としてリセットを案内し、一時的な失敗では再実行を案内する（独立した点検 補足3）
        let checkCode: string | null = null;
        if (!r.ok && r.error?.code === 'CONFLICT') {
          const info = d.callCoreAsSetup(this.reg!.core.url!, pending, { op: 'system.info' });
          if (info.ok) key = pending;
          else checkCode = info.error?.code ?? 'unknown';
        }
        if (!key)
          throw new InstallerError(
            step,
            `更新用の接続設定に失敗しました（${r.error?.code ?? 'unknown'}${checkCode ? ` / 確認: ${checkCode}` : ''}）`,
            r.error?.code !== 'CONFLICT'
              ? 'Shiftly-Staff の初期化が完了しているか確認し、再実行してください'
              : checkCode === 'UNAUTHENTICATED'
                ? 'Shiftly-Staff のスクリプトエディタで shiftlyResetSetupPairing（更新用接続のリセット。Setup との接続のリセット）を実行してから再実行してください'
                : '登録済みの接続を確認できませんでした。時間をおいて「再実行」を押してください',
          );
        this.sec!.setupKey = key;
        delete this.sec!.pendingSetupKey;
        this.persist();
        return null;
      }
      case 'verify': {
        // 所有者の確認の案内は、直近の失敗が確認を求めた場合だけ有効にする（別の理由の失敗では外す。D-026 の再点検 #3 と同じ方針）
        this.reg!.projectsConfirmPrompted = undefined;
        const ping = this.ping();
        if (!ping) throw new InstallerError(step, 'Shiftly-Staff に接続できません', 'デプロイと権限承認が完了しているか確認してください');
        const chk = this.callCore('system.integrityCheck');
        const res = chk.data as { ok: boolean; issues: string[] } | undefined;
        if (!chk.ok || !res) throw new InstallerError(step, `確認に失敗しました（${chk.error?.message ?? ''}）`, '時間をおいて再実行してください');
        if (!res.ok) throw new InstallerError(step, `DB の整合性に問題があります: ${res.issues.join(' / ')}`, '管理画面「システム・保守」の整合性チェックで内容を確認してください');
        const v = this.verifyCreations(ping);
        if (v.issues.length)
          throw new InstallerError(
            step,
            `作成物の確認で問題が見つかりました: ${v.issues.join(' / ')}`,
            '案内の内容を Apps Script の画面・Google ドライブで確認し、重複がある場合は使わないほうを整理（アーカイブ・ゴミ箱に移動）してから「再実行」を押してください（自動では削除しません）',
          );
        // 自動では確かめられない項目（プロジェクトの重複）は、所有者の確認を完了の条件にする（D-027。Codex 監査24 A4）。
        // 確認は、案内の後の「再実行」で確認を明示した場合だけ記録し、確認したときのプロジェクトの ID と結び付ける
        const r = this.reg!;
        const confirmed = r.projectsConfirmed && r.projectsConfirmed.core === r.core.scriptId && r.projectsConfirmed.admin === r.admin.scriptId;
        r.verification = { at: this.d.now(), checked: v.checked, unverified: v.unverified, ...(confirmed ? { ownerConfirmed: v.unverified } : {}) };
        if (!confirmed) {
          r.projectsConfirmPrompted = true;
          this.persist();
          throw new InstallerError(
            step,
            '自動では確かめられない項目があります。所有者の確認が終わるまで、構築を完了しません',
            `https://script.google.com/home を開き、「${r.core.title ?? 'Shiftly-Staff'}」「${r.admin.title ?? 'Shiftly-Admin'}」がそれぞれ 1 つずつであることを確認してください（同じ名前のプロジェクトが複数ある場合は、記録と異なるほうを使わないでください。自動では削除しません）。確認できたら、確認のチェックを付けて「再実行」を押してください`,
            `Apps Script のプロジェクト一覧で「${r.core.title ?? 'Shiftly-Staff'}」「${r.admin.title ?? 'Shiftly-Admin'}」が 1 つずつであることを確認しました`,
          );
        }
        r.projectsConfirmPrompted = undefined;
        r.appVersion = ping.version;
        this.persist();
        return null;
      }
    }
  }

  /**
   * 構築の完了前の作成物の検証（D-026 S1）。予防（作成の前の目印・確認）を補う事後の確認で、二重作成の防止の代わりではない。
   * 自動で確かめられる項目だけを checked に入れ、確かめられない項目は unverified に入れる（検証済みとして扱わない）
   */
  private verifyCreations(ping: CorePing): { issues: string[]; checked: string[]; unverified: string[] } {
    const r = this.reg!;
    const issues: string[] = [];
    const checked: string[] = [];
    for (const which of ['core', 'admin'] as const) {
      const ref = r[which];
      const name = which === 'core' ? 'Shiftly-Staff' : 'Shiftly-Admin';
      const title = ref.title ?? `${name} (${r.envId})`;
      // 1) 未解決の作成中・要確認の状態がない
      if (ref.creatingAt || ref.creatingPrompted || ref.deployingAt || ref.deployingPrompted || ref.deploymentMissingPrompted || ref.projectMissingPrompted)
        issues.push(`${name}: 作成の結果が確認されていない状態が残っています`);
      // 2) 記録しているプロジェクトが存在し、この環境の名前である
      const p = ref.scriptId ? this.d.api.getProject(ref.scriptId) : null;
      if (!p) issues.push(`${name}: 記録しているプロジェクトを確認できません`);
      else if (p.title !== title) issues.push(`${name}: プロジェクトの名前が一致しません（${p.title}）`);
      // 3) Shiftly のセットアップが作ったデプロイが 1 つだけで、記録している ID と一致する（Web アプリの URL も一致）
      if (ref.scriptId) {
        const deps = this.d.api.listDeployments(ref.scriptId).filter((d) => (d.deploymentConfig?.description ?? '').startsWith('Shiftly '));
        if (deps.length !== 1) issues.push(`${name}: Shiftly のデプロイが ${deps.length} つあります（1 つのはず。「デプロイを管理」で確認）`);
        else if (deps[0]!.deploymentId !== ref.deploymentId) issues.push(`${name}: デプロイが記録と一致しません`);
        else {
          const got = this.d.api.getDeployment(ref.scriptId, ref.deploymentId!);
          if (!got || webAppUrl(got) !== ref.url) issues.push(`${name}: Web アプリの URL が記録と一致しません`);
        }
      }
    }
    if (!issues.length) checked.push('Staff・Admin のプロジェクトの存在と名前', 'Staff・Admin の Web アプリのデプロイが 1 つずつで記録と一致');
    // 4) Staff と Admin の関連付け: Admin に配置したコードの接続先が Staff の URL で、Core で Admin・Setup との接続が完了している
    const adminFiles = r.admin.scriptId ? this.d.api.getContent(r.admin.scriptId).files : [];
    const bs = adminFiles.find((f) => f.name === 'bootstrap')?.source ?? '';
    const m = /SHIFTLY_ADMIN_BOOTSTRAP = (\{.*\});/.exec(bs);
    let coreUrl: unknown;
    try {
      coreUrl = m ? (JSON.parse(m[1]!) as { coreUrl?: unknown }).coreUrl : null;
    } catch {
      coreUrl = null;
    }
    if (coreUrl !== r.core.url) issues.push('Shiftly-Admin の接続先が Shiftly-Staff の URL と一致しません');
    else if (!ping.adminPaired || !ping.setupPaired) issues.push('Shiftly-Staff で Admin・Setup との接続が完了していません');
    else checked.push('Admin の接続先と Staff・Admin・Setup の接続');
    // 5) Core の Google ドライブの構成物（フォルダ・DB・環境情報ファイル）が 1 つずつで、保存済みの ID と一致し、作成中の目印がない
    const sc = this.callCore('system.storageCheck');
    const sr = sc.data as { ok: boolean; issues: string[]; unavailable?: boolean } | undefined;
    if (!sc.ok || !sr) issues.push(`Google ドライブの構成物を点検できませんでした（${sc.error?.message ?? ''}）`);
    else if (sr.unavailable) issues.push('Google ドライブの構成物を点検できない環境です');
    else if (!sr.ok) issues.push(...sr.issues);
    else checked.push('Google ドライブのフォルダ・DB・環境情報ファイルが 1 つずつで記録と一致');
    checked.push('DB の構造（整合性の確認）');
    // 6) Google ドライブの Setup の記録ファイルが、この環境について 1 つだけで、保存している ID と一致する（全ページを一覧。D-027・Codex 監査24 A4）
    if (!this.d.registryReport) issues.push('Setup の記録ファイルを点検できない環境です');
    else {
      let rr: { ok: boolean; issues: string[] };
      try {
        rr = this.d.registryReport(r.envId);
      } catch (e) {
        rr = { ok: false, issues: [`Setup の記録ファイルを点検できませんでした（${e instanceof Error ? e.message.slice(0, 120) : '不明'}）`] };
      }
      if (!rr.ok) issues.push(...rr.issues);
      else checked.push('Google ドライブの Setup の記録ファイルが 1 つで記録と一致');
    }
    // 自動では確かめられない: Setup の権限（drive.file）ではプロジェクトの一覧を取得できない
    const unverified = [`Apps Script のプロジェクト一覧で「${r.core.title ?? 'Shiftly-Staff'}」「${r.admin.title ?? 'Shiftly-Admin'}」が 1 つずつであること（Setup の権限では一覧できないため、自動では確認していません）`];
    return { issues, checked, unverified };
  }

  private createProject(which: 'core' | 'admin', title: string): null {
    const ref = this.reg![which];
    const step: StepId = which === 'core' ? 'core.create' : 'admin.create';
    if (ref.scriptId) {
      // 記録しているプロジェクトがあるか照会する。照会で見つからない（一時的な 404 を含む）ことだけを、作り直してよい根拠にしない
      // （Codex 監査23 #4、D-026 S1）。所有者が一覧で確認して、ないことを明示した場合（または別の ID を関連付けた場合）だけ進む
      if (this.d.api.getProject(ref.scriptId)) {
        if (ref.projectMissingPrompted) {
          this.reg![which] = { ...ref, projectMissingPrompted: undefined, projectMissingConfirmed: undefined };
          this.persist();
        }
        return null;
      }
      const t = ref.title ?? title;
      if (!ref.projectMissingConfirmed) {
        this.reg![which] = { ...ref, projectMissingPrompted: true };
        this.persist();
        throw new InstallerError(
          step,
          `記録している「${t}」（ID: ${ref.scriptId}）を確認できませんでした`,
          `Apps Script のプロジェクト一覧（https://script.google.com/home）で「${t}」を確認してください。ある場合は、チェックを付けずに数分おいてから「再実行」を押すか、そのプロジェクトの ID を「既存の ID を関連付ける」に入力してください。ない（削除した）ことを確認した場合は、確認のチェックを付けて「再実行」を押すと、新しく作ります`,
          `プロジェクト一覧で「${t}」（ID: ${ref.scriptId}）がないことを確認しました`,
        );
      }
      // 所有者が、ないことを確認した: 記録を外して作成の手順へ進む（作成の前に目印を保存する。完了前の検証で重複も確かめる）。
      // 新しいプロジェクトには、コードの配置・デプロイ・権限承認からやり直す。Staff を作り直す場合は、接続先が変わるため
      // Admin の配置・デプロイ・接続と Setup の接続もやり直す
      this.reg![which] = { title: t };
      const redo: StepId[] =
        which === 'core'
          ? ['core.upload', 'core.deploy', 'core.authorize', 'admin.upload', 'admin.deploy', 'admin.authorize', 'setup.pair', 'verify']
          : ['admin.upload', 'admin.deploy', 'admin.authorize', 'verify'];
      for (const s of redo) delete this.reg!.steps[s];
      this.persist();
    }
    const unknownResult = (t: string) => {
      // 作成されたかどうか分からない。自動では作り直さず、一覧での確認を案内する（案内したことを記録し、その後の「再実行」でだけ目印を外す）
      this.reg![which] = { ...this.reg![which], creatingPrompted: true };
      this.persist();
      return new InstallerError(
        step,
        `「${t}」の作成結果を確認できませんでした（作成されたかどうか分かりません）`,
        `Apps Script のプロジェクト一覧（https://script.google.com/home）に「${t}」があるか確認してください。ある場合はゴミ箱に移動してから「再実行」を押してください（同じプロジェクトが二重に作られるのを防ぐため、自動では作り直しません）`,
        `プロジェクト一覧で「${t}」がないこと（またはゴミ箱に移動したこと）を確認しました`,
      );
    };
    if (this.reg![which].creatingAt) {
      // 前回の作成要求の結果が不明（作成済みで応答だけ失われた可能性）。自動では作り直さない
      // 前回の要求時の名称で案内する（v1.2 で開始したセットアップの再開では旧名称の Shiftly-Staff）
      throw unknownResult(this.reg![which].title ?? title);
    }
    this.reg![which] = { title, creatingAt: this.d.now() };
    this.persist();
    let p: { scriptId: string };
    try {
      p = this.d.api.createProject(title);
    } catch (e) {
      // Google が要求を拒否した（作成されていない）ことが分かる場合は、目印を外して通常の失敗として扱う（再実行で作成できる）
      if (!createOutcomeUnknown(e)) {
        this.reg![which] = { title };
        this.persist();
        throw e;
      }
      // 作成されたかどうか分からない場合は、最初の失敗から確認を案内する（Codex 監査19 #2）
      throw unknownResult(title);
    }
    // 作成直後に保存（以後の再実行は既存 ID を使う）
    this.reg![which] = { scriptId: p.scriptId, title };
    this.persist();
    return null;
  }

  /** 配布物の完全性確認とブートストラップ（環境固有の設定）付きのファイル一式 */
  private filesFor(which: 'core' | 'admin'): ScriptFile[] {
    const rel = this.d.release;
    const files = which === 'core' ? rel.core : rel.admin;
    for (const f of files) {
      const expect = rel.hashes[`${which}/${f.name}`];
      if (!expect || this.d.sha256Hex(f.source) !== expect)
        throw new InstallerError(which === 'core' ? 'core.upload' : 'admin.upload', `配布ファイル ${f.name} の検証に失敗しました（破損または改ざんの可能性）`, 'Shiftly Setup を正規の配布物で更新してから再実行してください');
    }
    const r = this.reg!;
    const bootstrap: ScriptFile =
      which === 'core'
        ? { name: 'bootstrap', type: 'SERVER_JS', source: `var SHIFTLY_BOOTSTRAP = ${JSON.stringify({ envId: r.envId, storeName: r.storeName, adminPairingHash: r.adminPairingHash, setupPairingHash: r.setupPairingHash })};\n` }
        : { name: 'bootstrap', type: 'SERVER_JS', source: `var SHIFTLY_ADMIN_BOOTSTRAP = ${JSON.stringify({ envId: r.envId, coreUrl: r.core.url, pairingCode: this.sec!.adminPairingCode })};\n` };
    return [bootstrap, ...files];
  }

  private upload(which: 'core' | 'admin') {
    const ref = this.reg![which];
    if (!ref.scriptId) throw new InstallerError(`${which}.upload` as StepId, 'プロジェクトが作成されていません', '再実行してください');
    if (which === 'admin' && !this.reg!.core.url) throw new InstallerError('admin.upload', 'Shiftly-Staff の URL が未確定です', 'Shiftly-Staff のデプロイを先に完了してください');
    this.d.api.updateContent(ref.scriptId, this.filesFor(which));
  }

  private deploy(which: 'core' | 'admin') {
    const ref = this.reg![which];
    const v = this.d.api.createVersion(ref.scriptId!, `Shiftly ${this.d.release.version}`);
    let existing = ref.deploymentId ? this.d.api.getDeployment(ref.scriptId!, ref.deploymentId) : null;
    if (existing && (ref.deploymentMissingPrompted || ref.deploymentMissingConfirmed)) {
      // 照会で見つかった: 「見つからない」の案内は解消した（ほかの理由の失敗で、関連付けを受け付ける状態を残さない。再点検 #3）
      this.reg![which] = { ...ref, deploymentMissingPrompted: undefined, deploymentMissingConfirmed: undefined };
      this.persist();
    }
    if (ref.deploymentId && !existing) {
      // 記録しているデプロイが照会で見つからない（一時的な照会の失敗の可能性がある）。確認の明示があるまで新しく作らない（Codex 監査22 #4、D-025 S1）
      const name = which === 'core' ? 'Shiftly-Staff' : 'Shiftly-Admin';
      if (!ref.deploymentMissingConfirmed) {
        this.reg![which] = { ...ref, deploymentMissingPrompted: true };
        this.persist();
        throw new InstallerError(
          `${which}.deploy` as StepId,
          `記録している「${name}」の Web アプリのデプロイ（${ref.deploymentId}）を確認できませんでした`,
          `Apps Script のエディタで「${name}」を開き、「デプロイ」→「デプロイを管理」で、このデプロイがあるか確認してください。ある場合は、チェックを付けずに数分おいてから「再実行」を押してください。ない場合（削除・アーカイブした場合）は、確認のチェックを付けて「再実行」を押すと、新しいデプロイを作ります`,
          `「デプロイを管理」で、デプロイ（${ref.deploymentId}）がないことを確認しました`,
        );
      }
      this.reg![which] = { ...ref, deploymentId: undefined, deploymentMissingPrompted: undefined, deploymentMissingConfirmed: undefined };
      this.persist();
      existing = null;
    }
    const dep: Deployment = existing
      ? this.d.api.updateDeployment(ref.scriptId!, ref.deploymentId!, v.versionNumber, `Shiftly ${this.d.release.version}`)
      : this.createDeploymentOnce(which, v.versionNumber);
    // 実際のデプロイの版が、今回作成した版と一致することを確認する（記録と実際の版をずらさない。Codex 監査18）。
    // 応答に版の番号がない場合は個別に取得して確かめ、確かめられなければ記録せずに止める（Codex 監査19 次の版の前）
    let actual = dep.deploymentConfig?.versionNumber;
    if (actual === undefined) actual = this.d.api.getDeployment(ref.scriptId!, dep.deploymentId)?.deploymentConfig?.versionNumber;
    if (actual === undefined)
      throw new InstallerError(
        `${which}.deploy` as StepId,
        'デプロイの版を確認できませんでした',
        '時間をおいて「再実行」を押してください。解消しない場合は、Apps Script の「デプロイを管理」で状態を確認してください',
      );
    if (actual !== v.versionNumber)
      throw new InstallerError(
        `${which}.deploy` as StepId,
        `デプロイの版（v${actual}）が、今回作成した版（v${v.versionNumber}）と一致しません`,
        '時間をおいて「再実行」を押してください。解消しない場合は、Apps Script の「デプロイを管理」で状態を確認してください',
      );
    const url = webAppUrl(dep) ?? webAppUrl(this.d.api.getDeployment(ref.scriptId!, dep.deploymentId) ?? dep);
    if (!url) throw new InstallerError(`${which}.deploy` as StepId, 'Web アプリの URL を取得できませんでした', 'マニフェストの webapp 設定を確認してください（導入手順書）');
    this.reg![which] = {
      ...this.reg![which],
      deploymentId: dep.deploymentId,
      url,
      versionNumber: v.versionNumber,
      deployingAt: undefined,
      deployingDescription: undefined,
      deployingPrompted: undefined,
      deployingConfirmed: undefined,
      deploymentMissingPrompted: undefined,
      deploymentMissingConfirmed: undefined,
    };
    this.persist();
  }

  /**
   * Web アプリのデプロイを 1 つだけ作る（Codex 監査17 #3、D-025 S1）。
   * 作成の要求の前に目印（日時と説明）を保存する。前回の作成の結果が不明（目印が残っている）なら、デプロイの一覧で説明を照合する:
   * 1 つならそれを使い、2 つ以上なら作成を止めて確認を案内する。0 なら（一覧への反映の遅れで見えていない可能性があるため）
   * 「デプロイを管理」での確認を案内し、管理者が確認を明示した場合（retry の confirmedNoDuplicate）だけ、同じ説明で作成する（独立した点検 S1-1）。
   * 作成の失敗は、Google の拒否（4xx）が分かる場合だけ「作成されていない」として目印を外し、それ以外は結果が分からないとして確認を案内する
   */
  private createDeploymentOnce(which: 'core' | 'admin', versionNumber: number): Deployment {
    const ref = this.reg![which];
    const step: StepId = which === 'core' ? 'core.deploy' : 'admin.deploy';
    const name = which === 'core' ? 'Shiftly-Staff' : 'Shiftly-Admin';
    const unknownResult = (desc: string) => {
      this.reg![which] = { ...this.reg![which], deployingPrompted: true, deployingConfirmed: undefined };
      this.persist();
      return new InstallerError(
        step,
        `「${name}」の Web アプリのデプロイの作成結果を確認できませんでした（作成されたかどうか分かりません）`,
        `Apps Script のエディタで「${name}」を開き、「デプロイ」→「デプロイを管理」で、説明が「${desc}」のデプロイがあるか確認してください。ない場合は、確認のチェックを付けて「再実行」を押してください。ある場合は、チェックを付けずに数分おいてから画面を再読み込みし、続きを実行してください（一覧に反映されると、そのデプロイを使います。同じデプロイが二重に作られるのを防ぐため、自動では作り直しません）`,
        `「デプロイを管理」で、説明が「${desc}」のデプロイがないことを確認しました`,
      );
    };
    let description: string;
    if (ref.deployingAt && !ref.deployingDescription) {
      // 目印だけで説明の記録がない（照合できない）: 確認の明示があるまで作らない
      if (!ref.deployingConfirmed) throw unknownResult(`Shiftly ${this.d.release.version} (${this.reg!.envId} ${which}`);
      description = `Shiftly ${this.d.release.version} (${this.reg!.envId} ${which} ${this.d.now()})`;
      this.reg![which] = { ...ref, deployingDescription: description };
      this.persist();
    } else if (ref.deployingAt && ref.deployingDescription) {
      const desc = ref.deployingDescription;
      // 説明で照合する（一覧の応答に Web アプリの URL が含まれない場合に備え、使うデプロイは個別に取得し直す。実環境での一覧の応答の内容は未検証）
      const found = this.d.api.listDeployments(ref.scriptId!).filter((d) => d.deploymentConfig?.description === desc);
      if (found.length === 1) {
        // 見つかったデプロイを使う。今回作成した版へ切り替え、実際の版と記録をそろえる（Codex 監査18: 再利用した配備の版と記録のずれ）
        const id = found[0]!.deploymentId;
        this.reg![which] = { ...ref, deploymentId: id, deployingAt: undefined, deployingDescription: undefined, deployingPrompted: undefined, deployingConfirmed: undefined };
        this.persist();
        return this.d.api.updateDeployment(ref.scriptId!, id, versionNumber, desc);
      }
      if (found.length > 1)
        throw new InstallerError(
          step,
          `「${name}」の Web アプリのデプロイが複数見つかりました（前回の作成の結果を確認できなかったため）`,
          `Apps Script のエディタで「${name}」を開き、「デプロイ」→「デプロイを管理」で、説明が「${desc}」のデプロイを 1 つだけ残して、ほかをアーカイブしてから「再実行」を押してください（管理されていない URL が残るのを防ぐため、自動では選びません）`,
        );
      // 一覧で見つからない: 確認の明示があるまで作らない（同じ説明を使い続け、遅れて一覧に現れたデプロイとも照合できるようにする）
      if (!ref.deployingConfirmed) throw unknownResult(desc);
      description = desc;
    } else {
      description = `Shiftly ${this.d.release.version} (${this.reg!.envId} ${which} ${this.d.now()})`;
      this.reg![which] = { ...ref, deployingAt: this.d.now(), deployingDescription: description, deployingPrompted: undefined, deployingConfirmed: undefined };
      this.persist();
    }
    let dep: Deployment;
    try {
      dep = this.d.api.createDeployment(ref.scriptId!, versionNumber, description);
    } catch (e) {
      // Google が要求を拒否した（作成されていない）ことが分かる場合は、目印を外して通常の失敗として扱う（再実行で作成できる）
      if (!createOutcomeUnknown(e)) {
        this.reg![which] = { ...this.reg![which], deployingAt: undefined, deployingDescription: undefined, deployingPrompted: undefined, deployingConfirmed: undefined };
        this.persist();
        throw e;
      }
      throw unknownResult(description);
    }
    this.reg![which] = { ...this.reg![which], deploymentId: dep.deploymentId, deployingAt: undefined, deployingDescription: undefined, deployingPrompted: undefined, deployingConfirmed: undefined };
    this.persist();
    return dep;
  }

  private ping(): CorePing | null {
    if (!this.reg?.core.url) return null;
    const r = this.d.postCore(this.reg.core.url, { kind: 'ping' });
    return r.ok ? (r.data as CorePing) : null;
  }

  private callCore(op: string, args?: unknown) {
    if (!this.sec?.setupKey || !this.reg?.core.url) return { ok: false, error: { code: 'NOT_PAIRED', message: '更新用の接続設定が完了していません' } };
    return this.d.callCoreAsSetup(this.reg.core.url, this.sec.setupKey, { op, args });
  }

  /** 失敗した工程の状態を解除して再実行可能にする */
  retry(step: StepId, confirmedNoDuplicate = false) {
    if (this.reg?.steps[step]?.status === 'error') {
      delete this.reg.steps[step];
      // 作成工程の再実行は、確認を案内した後（creatingPrompted）で、管理者が重複がないことを確認したと明示した場合
      // （confirmedNoDuplicate。画面の確認のチェック）に限り、作成中の目印を解除する。それ以外の再実行では目印を残し、
      // 次の実行で確認を案内する（サーバー側で確認の明示を検証する。Codex 監査19 #2）
      for (const [s, which] of [['core.create', 'core'], ['admin.create', 'admin']] as const) {
        const ref = this.reg[which];
        if (step === s && !ref.scriptId && ref.creatingAt && ref.creatingPrompted && confirmedNoDuplicate) {
          delete ref.creatingAt;
          delete ref.creatingPrompted;
        }
        if (step === s && ref.scriptId && ref.projectMissingPrompted && confirmedNoDuplicate) ref.projectMissingConfirmed = true;
      }
      // 構築の完了前の所有者の確認（D-027）: 案内の後の確認の明示だけを記録する（その時点のプロジェクトの ID と結び付ける）
      if (step === 'verify' && this.reg.projectsConfirmPrompted && confirmedNoDuplicate && this.reg.core.scriptId && this.reg.admin.scriptId)
        this.reg.projectsConfirmed = { core: this.reg.core.scriptId, admin: this.reg.admin.scriptId, at: this.d.now() };
      // デプロイの作成も同じ（独立した点検 S1-1）。目印と説明は残し、一覧で見つからない場合に同じ説明で作成してよいことだけを記録する
      for (const [s, which] of [['core.deploy', 'core'], ['admin.deploy', 'admin']] as const) {
        const ref = this.reg[which];
        if (step === s && ref.deployingAt && ref.deployingPrompted && confirmedNoDuplicate) ref.deployingConfirmed = true;
        if (step === s && ref.deploymentId && ref.deploymentMissingPrompted && confirmedNoDuplicate) ref.deploymentMissingConfirmed = true;
      }
      this.persist();
    }
  }

  /**
   * 既存のプロジェクト・デプロイを関連付ける（D-026 S1）。作成の結果が分からない・記録したものが見つからない場合に、所有者が
   * Apps Script の画面で見つけた ID を入力する。照会で存在し、この環境のもの（名前・説明）であることを確かめてから記録する
   */
  attach(step: StepId, id: string): { ok: boolean; message: string } {
    if (!this.reg) return { ok: false, message: 'セットアップが開始されていません' };
    if (!/^[A-Za-z0-9_-]{3,200}$/.test(id)) return { ok: false, message: 'ID の形式が正しくありません' };
    const which = step.startsWith('core.') ? 'core' : step.startsWith('admin.') ? 'admin' : null;
    if (!which) return { ok: false, message: 'この工程では関連付けできません' };
    const ref = this.reg[which];
    const expectedTitle = ref.title ?? `${which === 'core' ? 'Shiftly-Staff' : 'Shiftly-Admin'} (${this.reg.envId})`;
    // 関連付けは、その工程が失敗していて、作成の結果を確認できないことを案内した場合だけ受け付ける（独立した点検 #6）
    const prompted =
      step === 'core.create' || step === 'admin.create' ? !!(ref.creatingPrompted || ref.projectMissingPrompted) : step === 'core.deploy' || step === 'admin.deploy' ? !!(ref.deployingPrompted || ref.deploymentMissingPrompted) : false;
    if (this.reg.steps[step]?.status !== 'error' || !prompted) return { ok: false, message: '関連付けは、作成の結果を確認できないと案内された工程でだけ行えます' };
    // 関連付けの後にやり直す工程（後続の工程と最後の確認）。Staff の URL が変わり得るため、Staff の場合は Admin の配置以降もやり直す
    const redo: Record<string, StepId[]> = {
      'core.create': ['core.create', 'core.upload', 'core.deploy', 'core.authorize', 'admin.upload', 'admin.deploy', 'admin.authorize', 'setup.pair', 'verify'],
      'admin.create': ['admin.create', 'admin.upload', 'admin.deploy', 'admin.authorize', 'verify'],
      'core.deploy': ['core.deploy', 'admin.upload', 'admin.deploy', 'verify'],
      'admin.deploy': ['admin.deploy', 'verify'],
    };
    const resetSteps = (sameAsRecorded = false) => {
      // 記録と同じものを関連付けた場合は、その工程と最後の確認だけをやり直す（接続・承認はそのまま有効）
      for (const s of sameAsRecorded ? [step, 'verify' as StepId] : (redo[step] ?? [step, 'verify'])) delete this.reg!.steps[s];
    };
    if (step === 'core.create' || step === 'admin.create') {
      const p = this.d.api.getProject(id);
      if (!p) return { ok: false, message: 'その ID のプロジェクトを確認できませんでした' };
      if (p.title !== expectedTitle) return { ok: false, message: `プロジェクトの名前が「${expectedTitle}」と一致しません（${p.title}）` };
      const same = ref.scriptId === id;
      // 記録と同じプロジェクトならデプロイ等の記録を残す（消すと新しいデプロイを作ってしまう）。別のプロジェクトなら記録を作り直す
      this.reg[which] = same ? { ...ref, title: expectedTitle, scriptId: id, creatingAt: undefined, creatingPrompted: undefined, projectMissingPrompted: undefined, projectMissingConfirmed: undefined } : { title: expectedTitle, scriptId: id };
      resetSteps(same);
      this.persist();
      return { ok: true, message: `「${expectedTitle}」を関連付けました` };
    }
    if (step === 'core.deploy' || step === 'admin.deploy') {
      if (!ref.scriptId) return { ok: false, message: 'プロジェクトが記録されていません' };
      const dep = this.d.api.getDeployment(ref.scriptId, id);
      if (!dep) return { ok: false, message: 'その ID のデプロイを確認できませんでした' };
      const desc = dep.deploymentConfig?.description ?? '';
      if (!desc.startsWith(`Shiftly `) || !desc.includes(`${this.reg.envId} ${which}`)) return { ok: false, message: 'Shiftly のセットアップで作成したデプロイではありません（説明が一致しません）' };
      const same = ref.deploymentId === id;
      this.reg[which] = { ...ref, deploymentId: id, deployingAt: undefined, deployingDescription: undefined, deployingPrompted: undefined, deployingConfirmed: undefined, deploymentMissingPrompted: undefined, deploymentMissingConfirmed: undefined };
      resetSteps(same);
      this.persist();
      return { ok: true, message: 'デプロイを関連付けました' };
    }
    return { ok: false, message: 'この工程では関連付けできません' };
  }
}

export function maskEmail(e: string): string {
  const [u, dmn] = e.split('@');
  if (!u || !dmn) return '***';
  return `${u.slice(0, 2)}***@${dmn}`;
}

function toInstallerError(step: StepId, e: unknown): InstallerError {
  if (e instanceof AppsScriptApiError) {
    if (e.reason === 'API_DISABLED') return new InstallerError(step, 'Apps Script API が無効です', 'https://script.google.com/home/usersettings で Google Apps Script API をオンにしてください');
    if (e.reason === 'PERMISSION') return new InstallerError(step, `権限がありません（${e.message}）`, 'Shiftly Setup の権限を承認し直してください（再認証）');
    if (e.reason === 'QUOTA') return new InstallerError(step, 'Google の利用上限に達しました', '時間をおいて再実行してください');
    return new InstallerError(step, `Google API エラー（${e.message}）`, '時間をおいて再実行してください。解決しない場合は導入手順書のトラブルシューティングを参照');
  }
  return new InstallerError(step, e instanceof Error ? e.message : '不明なエラー', '再実行してください');
}

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
import { AppsScriptApi, AppsScriptApiError, webAppUrl, type ScriptFile } from './apps-script-api';

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
  previousVersionNumber?: number;
  title?: string;
  /** 作成 API の呼び出し開始時刻（応答を受け取る前に保存。応答喪失時に重複作成しないための目印） */
  creatingAt?: string;
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
  /** ペアリングコードのハッシュ（非秘密）。平文コードは SecretRegistry に保持 */
  adminPairingHash: string;
  setupPairingHash: string;
  update: null | {
    target: string;
    stage: string;
    backupId?: string;
    startedAt: string;
    message?: string;
    prevCore?: number;
    prevAdmin?: number;
    /** 更新開始時の DB のスキーマ版（記録のみ。移行の結果が不明な場合は移行済みとして扱い、この値では判断しない） */
    startSchema?: number;
    /** DB の移行が完了しているか（移行後の失敗は旧版へ戻さず、再開時は完了処理から行う） */
    migrated?: boolean;
  };
}

/** 秘密情報（UserProperties のみ。Drive のレジストリファイルには書かない） */
export interface SecretRegistry {
  adminPairingCode: string;
  setupPairingCode: string;
  setupKey: string | null;
  /** ペアリング送信前に保存する鍵（応答喪失時の再開用。成功後に削除） */
  pendingSetupKey?: string;
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
  /** Core へ Setup 役割の署名付きリクエスト */
  callCoreAsSetup(url: string, keyHex: string, req: { op: string; args?: unknown }): { ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

export interface StepResult {
  state: PublicState;
  /** 利用者の操作待ち（権限承認など） */
  waitingFor: null | { step: StepId; instructions: string[]; openUrl?: string };
  error: null | { step: StepId; message: string; fix: string };
}

export interface PublicState {
  envId: string | null;
  ownerEmail: string | null;
  storeName: string | null;
  steps: Array<{ id: StepId; label: string; status: 'done' | 'error' | 'pending'; message?: string; manual?: boolean }>;
  complete: boolean;
  /** 店舗 iPad（Shiftly-Staff）の URL */
  staffUrl: string | null;
  adminUrl: string | null;
  coreEditorUrl: string | null;
  adminEditorUrl: string | null;
  installedVersion: string | null;
  releaseVersion: string;
  update: Registry['update'];
}

export class InstallerError extends Error {
  constructor(
    readonly step: StepId,
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
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
   * 事前に管理者の管理画面「システム・更新」で更新用接続のリセット（system.resetSetupPairing）が必要。
   */
  private recoverSecrets() {
    const code = this.d.randomHex(32);
    this.sec = { adminPairingCode: '', setupPairingCode: code, setupKey: null };
    this.reg!.setupPairingHash = this.d.sha256Hex(code);
    for (const s of ['core.upload', 'core.deploy', 'setup.pair', 'verify'] as StepId[]) delete this.reg!.steps[s];
    this.persist();
  }

  state(): PublicState {
    const r = this.reg;
    return {
      envId: r?.envId ?? null,
      ownerEmail: r?.ownerEmail ?? null,
      storeName: r?.storeName || null,
      steps: STEPS.map((s) => ({ id: s.id, label: s.label, manual: s.manual, status: r?.steps[s.id]?.status ?? 'pending', message: r?.steps[s.id]?.message })),
      complete: !!r && STEPS.every((s) => r.steps[s.id]?.status === 'done'),
      staffUrl: r?.core.url ?? null,
      adminUrl: r?.admin.url ?? null,
      coreEditorUrl: editorUrl(r?.core.scriptId),
      adminEditorUrl: editorUrl(r?.admin.scriptId),
      installedVersion: r?.appVersion ?? null,
      releaseVersion: this.d.release.version,
      update: r?.update ?? null,
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
    try {
      const waiting = this.run(next.id, input);
      if (!waiting) this.mark(next.id, 'done');
      return { state: this.state(), waitingFor: waiting, error: null };
    } catch (e) {
      const err = e instanceof InstallerError ? e : toInstallerError(next.id, e);
      if (this.reg) this.mark(next.id, 'error', err.message);
      return { state: this.state(), waitingFor: null, error: { step: err.step, message: err.message, fix: err.fix } };
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
            update: null,
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
        if (!r.ok && r.error?.code === 'CONFLICT' && d.callCoreAsSetup(this.reg!.core.url!, pending, { op: 'system.info' }).ok) key = pending;
        if (!key)
          throw new InstallerError(
            step,
            `更新用の接続設定に失敗しました（${r.error?.code ?? 'unknown'}）`,
            r.error?.code === 'CONFLICT' ? '管理画面「システム・更新」で「更新用接続のリセット」を実行してから再実行してください' : 'Shiftly-Staff の初期化が完了しているか確認し、再実行してください',
          );
        this.sec!.setupKey = key;
        delete this.sec!.pendingSetupKey;
        this.persist();
        return null;
      }
      case 'verify': {
        const ping = this.ping();
        if (!ping) throw new InstallerError(step, 'Shiftly-Staff に接続できません', 'デプロイと権限承認が完了しているか確認してください');
        const chk = this.callCore('system.integrityCheck');
        const res = chk.data as { ok: boolean; issues: string[] } | undefined;
        if (!chk.ok || !res) throw new InstallerError(step, `確認に失敗しました（${chk.error?.message ?? ''}）`, '時間をおいて再実行してください');
        if (!res.ok) throw new InstallerError(step, `DB の整合性に問題があります: ${res.issues.join(' / ')}`, '管理画面「システム・更新」で内容を確認してください');
        this.reg!.appVersion = ping.version;
        this.persist();
        return null;
      }
    }
  }

  private createProject(which: 'core' | 'admin', title: string): null {
    const ref = this.reg![which];
    if (ref.scriptId) {
      // 既存 ID がまだ存在するか確認（削除済みなら作り直す）
      if (this.d.api.getProject(ref.scriptId)) return null;
      this.reg![which] = {};
    }
    const step: StepId = which === 'core' ? 'core.create' : 'admin.create';
    if (this.reg![which].creatingAt) {
      // 前回の作成要求の結果が不明（作成済みで応答だけ失われた可能性）。自動では作り直さない
      // 前回の要求時の名称で案内する（v1.2 で開始したセットアップの再開では旧名称の Shiftly-Staff）
      title = this.reg![which].title ?? title;
      throw new InstallerError(
        step,
        `前回の「${title}」の作成結果を確認できませんでした`,
        `Apps Script のプロジェクト一覧（https://script.google.com/home）に「${title}」があるか確認してください。ある場合はゴミ箱に移動してから「再実行」を押してください（同じプロジェクトが二重に作られるのを防ぐため、自動では作り直しません）`,
      );
    }
    this.reg![which] = { title, creatingAt: this.d.now() };
    this.persist();
    const p = this.d.api.createProject(title);
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
    let dep = ref.deploymentId ? this.d.api.getDeployment(ref.scriptId!, ref.deploymentId) : null;
    if (dep) dep = this.d.api.updateDeployment(ref.scriptId!, ref.deploymentId!, v.versionNumber, `Shiftly ${this.d.release.version}`);
    else dep = this.d.api.createDeployment(ref.scriptId!, v.versionNumber, `Shiftly ${this.d.release.version}`);
    const url = webAppUrl(dep);
    if (!url) throw new InstallerError(`${which}.deploy` as StepId, 'Web アプリの URL を取得できませんでした', 'マニフェストの webapp 設定を確認してください（導入手順書）');
    // 更新中の再配備（中断からの再開）では、ロールバック先を更新開始前の版のまま保持する（Codex 監査5）
    const upd = this.reg!.update;
    const before = upd ? (which === 'core' ? upd.prevCore : upd.prevAdmin) : undefined;
    this.reg![which] = { ...ref, deploymentId: dep.deploymentId, url, previousVersionNumber: before ?? ref.versionNumber, versionNumber: v.versionNumber };
    this.persist();
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
  retry(step: StepId) {
    if (this.reg?.steps[step]?.status === 'error') {
      delete this.reg.steps[step];
      // 作成工程の再実行は、管理者が重複がないことを確認した上での明示的な操作として、作成中の目印を解除する
      if (step === 'core.create' && !this.reg.core.scriptId) delete this.reg.core.creatingAt;
      if (step === 'admin.create' && !this.reg.admin.scriptId) delete this.reg.admin.creatingAt;
      this.persist();
    }
  }

  // ------------------------------------------------------------------ アップデート（F36）
  checkUpdate(): { installed: string | null; available: string; needsUpdate: boolean; core: CorePing | null; pending?: string | null } {
    const ping = this.ping();
    const installed = ping?.version ?? this.reg?.appVersion ?? null;
    // 未完了の更新（移行後の失敗など）が残っている場合は、配備済みの版が同じでも再開を表示する（Codex 監査4）
    const u = this.reg?.update;
    const pending = u && u.target === this.d.release.version ? (u.message ?? `更新が完了していません（段階: ${u.stage}）`) : null;
    return { installed, available: this.d.release.version, needsUpdate: (!!installed && compareVersion(this.d.release.version, installed) > 0) || !!pending, core: ping, pending };
  }

  /** Core の system.info（DB のスキーマ版・プログラムの期待するスキーマ版・メンテナンス） */
  private coreInfo(): { schemaVersion: number; expectedSchemaVersion: number; maintenance: boolean } | null {
    const r = this.callCore('system.info');
    const d = r.ok ? (r.data as { schemaVersion?: number; expectedSchemaVersion?: number; maintenance?: boolean }) : null;
    return d && typeof d.schemaVersion === 'number' && typeof d.expectedSchemaVersion === 'number' ? { schemaVersion: d.schemaVersion, expectedSchemaVersion: d.expectedSchemaVersion, maintenance: !!d.maintenance } : null;
  }

  /**
   * 更新の実行（管理者の承認後に呼ぶ）
   * 1) メンテナンス＋更新前バックアップ 2) 配布物の検証・コード更新 3) バージョン作成・既存デプロイ更新（URL 維持）
   * 4) DB マイグレーション（破壊的変更は承認がなければ停止）5) 完了・整合性確認。失敗時はロールバック。
   */
  applyUpdate(opts: { approveDestructive: boolean }): { ok: boolean; message: string; requiresApproval?: string[] } {
    const guard = this.guardAccount();
    if (guard) return { ok: false, message: guard.message };
    if (!this.state().complete) return { ok: false, message: '初期セットアップが完了していません' };
    const target = this.d.release.version;
    const reg = this.reg!;
    // 更新開始前のバージョン番号を保持（承認待ちから再開した場合も、更新前の版へ戻せるように）
    // 移行後に失敗した更新の再開（コードは新しい版のまま。バックアップの再取得・再配備をせず完了処理から行う）
    // 移行の段階（migrate / finish）で中断した更新も、移行済みの可能性があるため同様に扱う（Codex 監査5）
    // ただし、配備されているコードがこの更新で配備した版である場合に限る（手動ロールバック等で旧版に戻っていれば、配備からやり直す。Codex 監査6 #3）
    const afterMigration = !!(reg.update && reg.update.target === target && (reg.update.migrated || ['migrate', 'finish'].includes(reg.update.stage))) && this.deployedByThisUpdate();
    const resuming = afterMigration || (reg.update && reg.update.target === target && reg.update.prevCore !== undefined && reg.update.stage !== 'failed');
    const prevCore = resuming ? reg.update!.prevCore : reg.core.versionNumber;
    const prevAdmin = resuming ? reg.update!.prevAdmin : reg.admin.versionNumber;
    if (!resuming) {
      reg.update = { target, stage: 'start', startedAt: this.d.now(), prevCore, prevAdmin, startSchema: this.coreInfo()?.schemaVersion };
      this.persist();
    }
    const step = (stage: string) => {
      reg.update = { ...(reg.update ?? { target, startedAt: this.d.now() }), target, stage };
      this.persist();
    };
    // DB の移行が完了したか（移行後の失敗では、旧プログラムへ戻さない。Codex 監査3 #1）
    let migrated = afterMigration;
    try {
      // 承認待ち・移行後の失敗からの再開では、バックアップ・コード更新・デプロイは完了済み（DB 更新から再開）
      if (!(resuming && (reg.update!.stage === 'awaiting_approval' || afterMigration))) {
        step('prepare');
        const prep = this.callCore('system.prepareUpdate', { targetVersion: target });
        if (!prep.ok) return this.failUpdate(`更新前バックアップに失敗しました（${prep.error?.message ?? ''}）。更新は行っていません`);
        // 中断からの再開でも、最初の更新前バックアップの参照を保持する
        reg.update!.backupId = reg.update!.backupId ?? (prep.data as { backupId: string }).backupId;
        step('code');
        this.upload('core');
        this.upload('admin');
        step('deploy');
        this.deploy('core');
        this.deploy('admin');
      }
      step('migrate');
      let mig: ReturnType<Installer['callCore']>;
      try {
        mig = this.callCore('system.migrate', { approveDestructive: opts.approveDestructive });
      } catch (e) {
        // 通信が例外になった場合も結果は不明（Core で移行が進んでいる可能性）。移行済みとして扱い、旧版へ戻さない（Codex 監査6 #1）
        migrated = true;
        throw e;
      }
      if (!mig.ok) {
        // 応答がない・内部エラー等で結果が不明な場合は、Core で移行が進んでいる可能性があるため移行済みとして扱い、旧版へ戻さない
        // （ロック外の読み取りで移行前と判断しない。再開時は Core のロック内で移行をやり直す＝冪等。Codex 監査5）
        const definitive = ['CONFLICT', 'INVALID_INPUT', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_PAIRED', 'NOT_INITIALIZED'];
        if (!definitive.includes(mig.error?.code ?? '')) migrated = true;
        throw new Error(`DB 更新に失敗しました（${mig.error?.message ?? ''}）`);
      }
      const need = (mig.data as { requiresApproval: string[] }).requiresApproval;
      if (need.length === 0) {
        migrated = true;
        reg.update = { ...reg.update!, migrated: true };
        this.persist();
      }
      if (need.length) {
        step('awaiting_approval');
        return { ok: false, message: '破壊的な DB 変更が含まれるため、内容を確認して承認してください（コードは更新済み・メンテナンス中）', requiresApproval: need };
      }
      step('finish');
      // 完了処理の前に、配備されているコードがこの更新の版であることを確認する（旧版の Core で完了させない。Codex 監査6 #3）
      if (!this.deployedByThisUpdate()) throw new Error('配備されているプログラムが更新先の版ではありません（ロールバック等で切り替わった可能性）');
      const fin = this.callCore('system.finishUpdate');
      if (!fin.ok) throw new Error(`更新の完了処理に失敗しました（${fin.error?.message ?? ''}）`);
      reg.appVersion = target;
      reg.update = null;
      this.persist();
      return { ok: true, message: `バージョン ${target} に更新しました` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // finish の段階の失敗は移行の後（移行済み）
      if (!migrated && reg.update && reg.update.stage === 'finish') migrated = true;
      if (migrated) {
        reg.update = { ...reg.update!, migrated: true };
        // DB は新しい構造に移行済み。旧プログラムは新しい構造の DB を正しく扱えず、メンテナンス解除の検査も持たないため、
        // プログラムは新しい版のまま、メンテナンスを継続する（新しい版の Core は構造の一致を検査できる）
        return this.failUpdate(
          `更新に失敗しました: ${msg}。DB の更新後に失敗したため、プログラムは新しい版（${target}）のまま、メンテナンスを継続しています（スタッフの打刻は停止中）。` +
            '原因（整合性の確認結果など）を管理画面「システム・更新」で確認し、解消してから更新を再実行してください。旧版に戻す必要がある場合は docs/update-rollback.md の手順（更新前バックアップの復元と旧版への切替）に従ってください',
        );
      }
      const rb = this.rollbackCode(prevCore, prevAdmin);
      return this.failUpdate(`更新に失敗しました: ${msg}。${rb}`);
    }
  }

  /**
   * Staff・Admin の既存デプロイが、この更新で配備した版（更新開始前の版ではない）を指しているか。
   * Apps Script API で実際のデプロイの版を確認する
   */
  private deployedByThisUpdate(): boolean {
    const reg = this.reg;
    const u = reg?.update;
    if (!reg || !u) return false;
    for (const [which, prev] of [['core', u.prevCore], ['admin', u.prevAdmin]] as const) {
      const ref = reg[which];
      if (!ref.scriptId || !ref.deploymentId || !ref.versionNumber || ref.versionNumber === prev) return false;
      try {
        const dep = this.d.api.getDeployment(ref.scriptId, ref.deploymentId);
        if (dep?.deploymentConfig?.versionNumber !== ref.versionNumber) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private failUpdate(message: string) {
    if (this.reg) {
      this.reg.update = this.reg.update ? { ...this.reg.update, stage: 'failed', message } : null;
      this.persist();
    }
    return { ok: false, message };
  }

  /** GAS コードのロールバック（デプロイを以前のバージョン番号へ戻す。URL は変わらない） */
  rollbackCode(prevCore?: number, prevAdmin?: number): string {
    const reg = this.reg!;
    const out: string[] = [];
    // 配備を切り替える前に、現在の Core で書き込みを止める（旧版と DB の組み合わせを確認するまで営業を再開しない。Codex 監査4）
    const on = this.callCore('system.setMaintenance', { on: true });
    if (!on.ok) return `メンテナンスを開始できなかったため、ロールバックを中止しました（${on.error?.message ?? ''}）。現在のバージョンのまま稼働しています`;
    out.push('メンテナンスを開始しました');
    for (const [which, prev] of [['core', prevCore ?? reg.core.previousVersionNumber], ['admin', prevAdmin ?? reg.admin.previousVersionNumber]] as const) {
      const ref = reg[which];
      if (!prev || !ref.scriptId || !ref.deploymentId) continue;
      try {
        this.d.api.updateDeployment(ref.scriptId, ref.deploymentId, prev, `Shiftly rollback to v${prev}`);
        reg[which] = { ...ref, versionNumber: prev };
        out.push(`${which === 'core' ? 'Staff' : 'Admin'} をバージョン ${prev} に戻しました`);
      } catch (e) {
        out.push(`${which} のロールバックに失敗（${e instanceof Error ? e.message : ''}）`);
      }
    }
    // 戻したプログラムと DB の構造が一致するか確認してからメンテナンスを解除する（Codex 監査2 #3）。
    // DB の移行後に失敗した場合、旧プログラムと新しい構造の DB の組み合わせで営業を再開しない
    const d = this.coreInfo();
    if (!d) {
      out.push('戻したプログラムと DB の組み合わせを確認できないため、メンテナンスを継続しています（スタッフの打刻は停止中）。管理画面「システム・更新」で状態を確認してください');
    } else if (d.schemaVersion !== d.expectedSchemaVersion) {
      out.push(
        `DB の構造（v${d.schemaVersion}）が戻したプログラム（v${d.expectedSchemaVersion}）と一致しないため、メンテナンスを継続しています（スタッフの打刻は停止中）。` +
          `管理画面「バックアップ」で更新前バックアップ${this.reg?.update?.backupId ? `（${this.reg.update.backupId}）` : ''}を復元してからメンテナンスを解除するか、原因を解消して更新を再実行してください`,
      );
    } else {
      const off = this.callCore('system.setMaintenance', { on: false });
      out.push(off.ok ? 'メンテナンスを解除しました' : 'メンテナンス解除に失敗しました（管理画面「システム・更新」から解除してください）');
      out.push('DB は自動では戻していません。必要に応じて更新前バックアップから復元してください');
    }
    // コードを戻した後は、進行中の更新を「失敗」として終了する（再開で配備を省略しない。次回の更新は最初から行う。Codex 監査6 #3）
    if (reg.update) reg.update = { ...reg.update, stage: 'failed', message: `ロールバックしました: ${out.join('。')}` };
    this.persist();
    return out.join('。');
  }
}

export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
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

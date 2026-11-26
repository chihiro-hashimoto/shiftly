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
  previousVersionNumber?: number;
  title?: string;
  /** 作成 API の呼び出し開始時刻（応答を受け取る前に保存。応答喪失時に重複作成しないための目印） */
  creatingAt?: string;
  /** Web アプリのデプロイの作成の目印（呼び出しの前に保存。応答喪失・中断の後の再開で、既存のデプロイを照合する。Codex 監査17 #3） */
  deployingAt?: string;
  /** 作成を要求したデプロイの説明（照合に使う） */
  deployingDescription?: string;
}

/** Staff・Admin の版の組 */
export interface VersionPair {
  core: number;
  admin: number;
  appVersion?: string | null;
  at?: string;
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
   * 正常に稼働した Staff・Admin の版の組の履歴（古い順。最後が現在の正常な組）。更新の成功時に追加し、
   * 手動ロールバックで前の組へ戻したときはその組まで切り詰める。戻し先はこの履歴から選ぶ（Codex 監査13）。
   * 旧形式の登録（この項目がない）では、確定できる組だけを使う（knownPairs）
   */
  pairs?: VersionPair[];
  /** 履歴の前の組へ戻す手動ロールバックの戻し先（切替の前に保存し、両方の切替と照合を終えたら消す。再試行はこの組へ戻す。Codex 監査14 #2） */
  pendingRollback?: { core: number; admin: number } | null;
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
    /** 更新の開始前からメンテナンス中だったか（不明なら undefined）。失敗時に解除してよいのは、今回開始したメンテナンスだけ（Codex 監査9 #3） */
    maintenanceBefore?: boolean;
    /** この更新でコードの更新・配備に着手したか（再開後も引き継ぐ。準備の段階の失敗でも、着手済みならロールバックする。Codex 監査10） */
    codeTouched?: boolean;
    /** この更新で配備した版（配備のたびに記録。再開で配備を省略・完了してよいのは、実際の配備がこの組と一致する場合だけ。Codex 監査13） */
    deployed?: { core?: number; admin?: number };
    /**
     * DB の移行が行われた可能性があるか（移行の要求を送る前に true として保存し、明確に拒否された場合だけ戻す）。
     * true の更新は、以後この更新の中で旧版へ自動で戻さない（配備の照会の結果に左右されない。Codex 監査7 #1）
     */
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
    const existing = ref.deploymentId ? this.d.api.getDeployment(ref.scriptId!, ref.deploymentId) : null;
    const dep: Deployment = existing
      ? this.d.api.updateDeployment(ref.scriptId!, ref.deploymentId!, v.versionNumber, `Shiftly ${this.d.release.version}`)
      : this.createDeploymentOnce(which, v.versionNumber);
    // 実際のデプロイの版が、今回作成した版と一致することを確認する（記録と実際の版をずらさない。Codex 監査18）
    const actual = dep.deploymentConfig?.versionNumber;
    if (actual !== undefined && actual !== v.versionNumber)
      throw new InstallerError(
        `${which}.deploy` as StepId,
        `デプロイの版（v${actual}）が、今回作成した版（v${v.versionNumber}）と一致しません`,
        '時間をおいて「再実行」を押してください。解消しない場合は、Apps Script の「デプロイを管理」で状態を確認してください',
      );
    const url = webAppUrl(dep) ?? webAppUrl(this.d.api.getDeployment(ref.scriptId!, dep.deploymentId) ?? dep);
    if (!url) throw new InstallerError(`${which}.deploy` as StepId, 'Web アプリの URL を取得できませんでした', 'マニフェストの webapp 設定を確認してください（導入手順書）');
    // 更新中の再配備（中断からの再開）では、ロールバック先を更新開始前の版のまま保持する（Codex 監査5）
    const upd = this.reg!.update;
    const before = upd ? (which === 'core' ? upd.prevCore : upd.prevAdmin) : undefined;
    this.reg![which] = {
      ...this.reg![which],
      deploymentId: dep.deploymentId,
      url,
      previousVersionNumber: before ?? ref.versionNumber,
      versionNumber: v.versionNumber,
      deployingAt: undefined,
      deployingDescription: undefined,
    };
    // 更新中は、今回配備した版を記録する（再開・完了の判定、ロールバックの判定に使う。Codex 監査13）
    if (upd) this.reg!.update = { ...upd, deployed: { ...(upd.deployed ?? {}), [which]: v.versionNumber } };
    this.persist();
  }

  /**
   * Web アプリのデプロイを 1 つだけ作る（Codex 監査17 #3）。
   * 作成の要求の前に目印を保存し、前回の作成の結果が不明（目印が残っている）なら、デプロイの一覧で照合する:
   * 作成を要求した説明の Web アプリのデプロイが 1 つならそれを使い、0 なら作成し、2 つ以上なら作成を止めて確認を案内する
   */
  private createDeploymentOnce(which: 'core' | 'admin', versionNumber: number): Deployment {
    const ref = this.reg![which];
    const step: StepId = which === 'core' ? 'core.deploy' : 'admin.deploy';
    const name = which === 'core' ? 'Shiftly-Staff' : 'Shiftly-Admin';
    if (ref.deployingAt) {
      const desc = ref.deployingDescription;
      // 説明で照合する（一覧の応答に Web アプリの URL が含まれない場合に備え、使うデプロイは個別に取得し直す。実環境での一覧の応答の内容は未検証）
      const found = this.d.api.listDeployments(ref.scriptId!).filter((d) => !!desc && d.deploymentConfig?.description === desc);
      if (found.length === 1) {
        // 見つかったデプロイを使う。今回作成した版へ切り替え、実際の版と記録をそろえる（Codex 監査18: 再利用した配備の版と記録のずれ）
        const id = found[0]!.deploymentId;
        this.reg![which] = { ...ref, deploymentId: id, deployingAt: undefined, deployingDescription: undefined };
        this.persist();
        return this.d.api.updateDeployment(ref.scriptId!, id, versionNumber, desc!);
      }
      if (found.length > 1)
        throw new InstallerError(
          step,
          `「${name}」の Web アプリのデプロイが複数見つかりました（前回の作成の結果を確認できなかったため）`,
          `Apps Script のエディタで「${name}」を開き、「デプロイ」→「デプロイを管理」で、説明が「${desc}」のデプロイを 1 つだけ残して、ほかをアーカイブしてから「再実行」を押してください（管理されていない URL が残るのを防ぐため、自動では選びません）`,
        );
    }
    const description = `Shiftly ${this.d.release.version} (${this.reg!.envId} ${which} ${this.d.now()})`;
    this.reg![which] = { ...ref, deployingAt: this.d.now(), deployingDescription: description };
    this.persist();
    const dep = this.d.api.createDeployment(ref.scriptId!, versionNumber, description);
    this.reg![which] = { ...this.reg![which], deploymentId: dep.deploymentId, deployingAt: undefined, deployingDescription: undefined };
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
    // 想定外の失敗（処理しきれない例外）は、安全側に止める（D-024）
    try {
      return this.applyUpdateInner(opts);
    } catch (e) {
      return { ok: false, message: this.failSafe('更新', e) };
    }
  }

  private applyUpdateInner(opts: { approveDestructive: boolean }): { ok: boolean; message: string; requiresApproval?: string[] } {
    const guard = this.guardAccount();
    if (guard) return { ok: false, message: guard.message };
    if (!this.state().complete) return { ok: false, message: '初期セットアップが完了していません' };
    if (this.reg?.pendingRollback)
      return { ok: false, message: '前回の「直前のバージョンに戻す」が完了していません（Staff・Admin の版が一致していない可能性があります）。先に「直前のバージョンに戻す」を再実行してください' };
    const target = this.d.release.version;
    const reg = this.reg!;
    // 同じ版への更新の続き（承認待ち・中断・失敗からの再実行）
    const u0 = reg.update && reg.update.target === target ? reg.update : null;
    // DB の移行が行われた可能性がある更新（移行の要求を送った後。Codex 監査3 #1・監査5・監査6 #1）。
    // この保護は保存した状態だけで決め、配備の照会の結果では外さない（照会の一時的な失敗で旧版へ戻さない。Codex 監査7 #1）
    const protect = !!(u0 && (u0.migrated || ['migrate', 'finish'].includes(u0.stage)));
    const awaiting = !!(u0 && u0.stage === 'awaiting_approval');
    // 配備を省略して DB 更新から再開できるのは、実際のデプロイがこの更新で配備した版を指す場合だけ（Codex 監査6 #3・監査7 #1）。
    // 照会できない場合は何も変更せずに中断する（メンテナンスは継続。再実行で続きから行う）
    let skipDeploy = false;
    if (protect || awaiting) {
      const st = this.deploymentState();
      if (st === 'unknown') {
        return {
          ok: false,
          message: 'Staff・Admin の配備の状態を確認できなかったため、更新を中断しました（何も変更していません。メンテナンスは継続中）。時間をおいて「更新を再開」を押してください',
        };
      }
      skipDeploy = st === 'new';
    }
    // 更新開始前の版・最初の更新前バックアップは、同じ更新の続きでは引き継ぐ
    const continuing = !!(u0 && u0.prevCore !== undefined && (protect || u0.stage !== 'failed'));
    const prevCore = continuing ? u0!.prevCore : reg.core.versionNumber;
    const prevAdmin = continuing ? u0!.prevAdmin : reg.admin.versionNumber;
    if (!continuing) {
      // 旧形式の登録（履歴がない）では、更新の記録を作る前に、確定できる版の組（直前の組・現在の組）を履歴に保存する
      // （更新の記録を作ると、旧形式で確定できる組が開始時の組だけになるため。Codex 監査14 #3）
      if (!reg.pairs || !reg.pairs.length) reg.pairs = this.knownPairs();
      let info: ReturnType<Installer['coreInfo']>;
      try {
        info = this.coreInfo();
      } catch {
        info = null;
      }
      reg.update = {
        target,
        stage: 'start',
        startedAt: this.d.now(),
        prevCore,
        prevAdmin,
        startSchema: info?.schemaVersion,
        maintenanceBefore: info ? info.maintenance : undefined,
        deployed: {},
      };
      this.persist();
    }
    const step = (stage: string) => {
      reg.update = { ...(reg.update ?? { target, startedAt: this.d.now() }), target, stage };
      this.persist();
    };
    // この実行で失敗したときに旧版へ戻さないか
    let migrated = protect;
    // この実行でコードの更新に着手したか（準備の段階の失敗は、コードを変更していないためロールバックしない。Codex 監査9 #3）
    // 前回の実行で着手済み（中断から再開）の場合も含む（Codex 監査10 回帰 1）
    let codeTouched = skipDeploy || !!(continuing && u0 && (u0.codeTouched || ['code', 'deploy'].includes(u0.stage)));
    try {
      if (!skipDeploy) {
        step('prepare');
        // 準備の前に、メンテナンスの開始を独立した要求として確定する。更新前バックアップ（準備の中で DB を複製）に
        // 「メンテナンス中」を含めるため。旧版（v1.2）の Core は準備の中の変更を複製の前に確定しないため、Setup 側で行う
        // （旧版へ戻してからそのバックアップを旧版の Core で復元しても、確認前に打刻が再開しない。Codex 監査7 #2）
        const on = this.callCore('system.setMaintenance', { on: true });
        if (!on.ok) return this.failUpdate(`メンテナンスを開始できませんでした（${on.error?.message ?? ''}）。更新は行っていません`);
        if (protect) {
          // DB は移行済みの可能性があるため、更新前バックアップを取り直さない（最初の更新前バックアップの参照を Core・Setup とも保持する）
        } else {
          const prep = this.callCore('system.prepareUpdate', { targetVersion: target });
          if (!prep.ok) return this.failUpdate(`更新前バックアップに失敗しました（${prep.error?.message ?? ''}）。更新は行っていません。${this.releaseStartedMaintenance()}`);
          // 中断からの再開でも、最初の更新前バックアップの参照を保持する
          reg.update!.backupId = reg.update!.backupId ?? (prep.data as { backupId: string }).backupId;
        }
        codeTouched = true;
        reg.update = { ...reg.update!, codeTouched: true };
        step('code');
        this.upload('core');
        this.upload('admin');
        step('deploy');
        this.deploy('core');
        this.deploy('admin');
      }
      // 移行の要求を送る前に「移行の可能性あり」を保存する（応答が失われる・通信の例外・Setup の中断に備える）
      migrated = true;
      reg.update = { ...reg.update!, migrated: true };
      step('migrate');
      const mig = this.callCore('system.migrate', { approveDestructive: opts.approveDestructive });
      if (!mig.ok) {
        // 明確に拒否された場合（Core は移行を行っていない）だけ、この実行での移行の可能性を取り消す。
        // 応答がない・内部エラー等で結果が不明な場合は移行済みとして扱う（ロック外の読み取りで移行前と判断しない。Codex 監査5）
        const definitive = ['CONFLICT', 'INVALID_INPUT', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_PAIRED', 'NOT_INITIALIZED'];
        if (definitive.includes(mig.error?.code ?? '')) {
          migrated = protect;
          reg.update = { ...reg.update!, migrated: protect };
          this.persist();
        }
        throw new Error(`DB 更新に失敗しました（${mig.error?.message ?? ''}）`);
      }
      const need = (mig.data as { requiresApproval: string[] }).requiresApproval;
      if (need.length) {
        // 承認待ち: 今回の要求では何も移行していない
        migrated = protect;
        reg.update = { ...reg.update!, migrated: protect };
        step('awaiting_approval');
        return { ok: false, message: '破壊的な DB 変更が含まれるため、内容を確認して承認してください（コードは更新済み・メンテナンス中）', requiresApproval: need };
      }
      step('finish');
      // 完了処理の前に、配備されているコードがこの更新の版であることを確認する（旧版の Core で完了させない。Codex 監査6 #3）
      if (this.deploymentState() !== 'new') throw new Error('配備されているプログラムが更新先の版ではありません（ロールバック等で切り替わった可能性）');
      const fin = this.callCore('system.finishUpdate');
      if (!fin.ok) throw new Error(`更新の完了処理に失敗しました（${fin.error?.message ?? ''}）`);
      reg.appVersion = target;
      // 正常に稼働する組として履歴に追加する（更新の記録を消す前に、開始時の組を含む履歴を確定する）
      const dp = this.updatePairs().deployed!; // 直前の deploymentState() === 'new' で組がそろっていることを確認済み
      reg.pairs = this.withPair(this.knownPairs(), { core: dp.core, admin: dp.admin, appVersion: target, at: this.d.now() });
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
          `更新に失敗しました: ${msg}。DB の更新が行われた可能性がある段階で失敗したため、旧版へ自動では戻さず、メンテナンスを継続しています（スタッフの打刻は停止中）。` +
            '原因（整合性の確認結果など）を管理画面「システム・更新」で確認し、解消してから更新を再実行してください。旧版に戻す必要がある場合は docs/update-rollback.md の手順（更新前バックアップの復元と旧版への切替）に従ってください',
        );
      }
      if (!codeTouched) {
        // 準備の段階（メンテナンスの開始・更新前バックアップ）の失敗・通信の例外。コードは変更していないため配備を操作せず、
        // 今回開始したメンテナンスだけを、現在の状態を確認できた場合に解除する（Codex 監査9 #3）
        return this.failUpdate(`更新に失敗しました: ${msg}。更新は行っていません。${this.releaseStartedMaintenance()}`);
      }
      // 更新の開始前からメンテナンス中だった（または不明な）場合は、ロールバック後もメンテナンスを継続する
      const rb = this.rollbackCode(prevCore, prevAdmin, { keepMaintenance: reg.update?.maintenanceBefore !== false });
      return this.failUpdate(`更新に失敗しました: ${msg}。${rb}`);
    }
  }

  /**
   * Staff・Admin の既存デプロイの状態（Apps Script API で実際のデプロイの版を照会する）
   * - new: 両方とも、この更新で配備した版（更新開始前と異なる版）を指す
   * - old: 照会できたが、少なくとも一方がこの更新の版を指していない（未配備・手動ロールバック等）
   * - unknown: 照会できなかった（一時的な障害等）。呼び出し側は何も変更せずに中断する
   */
  /** Staff・Admin の実際のデプロイが、指定した版の組を指しているか（照会できない・版が未指定なら null） */
  private deployedVersionsAre(core?: number, admin?: number): boolean | null {
    const reg = this.reg;
    if (!reg || core === undefined || admin === undefined) return null;
    for (const [which, want] of [['core', core], ['admin', admin]] as const) {
      const ref = reg[which];
      if (!ref.scriptId || !ref.deploymentId) return null;
      try {
        const v = this.d.api.getDeployment(ref.scriptId, ref.deploymentId)?.deploymentConfig?.versionNumber;
        if (v === undefined) return null;
        if (v !== want) return false;
      } catch {
        return null;
      }
    }
    return true;
  }

  /** Staff・Admin の実際のデプロイの版の組（照会できなければ null） */
  private actualPair(): { core: number; admin: number } | null {
    const reg = this.reg;
    if (!reg) return null;
    const v: Partial<Record<'core' | 'admin', number>> = {};
    for (const which of ['core', 'admin'] as const) {
      const ref = reg[which];
      if (!ref.scriptId || !ref.deploymentId) return null;
      try {
        const n = this.d.api.getDeployment(ref.scriptId, ref.deploymentId)?.deploymentConfig?.versionNumber;
        if (n === undefined) return null;
        v[which] = n;
      } catch {
        return null;
      }
    }
    return { core: v.core!, admin: v.admin! };
  }

  /** 進行中の更新の開始時の組・今回配備した組（両方の版がそろう場合だけ） */
  private updatePairs(): { start: { core: number; admin: number } | null; deployed: { core: number; admin: number } | null } {
    const u = this.reg?.update;
    const start = u && u.prevCore !== undefined && u.prevAdmin !== undefined ? { core: u.prevCore, admin: u.prevAdmin } : null;
    let deployed: { core: number; admin: number } | null = null;
    if (u?.deployed) {
      // 一部だけ記録されている（片方の配備の途中で中断）場合は、組として扱わない（再開では配備し直す）
      if (u.deployed.core !== undefined && u.deployed.admin !== undefined) deployed = { core: u.deployed.core, admin: u.deployed.admin };
    } else if (u && (u.migrated || ['migrate', 'finish', 'awaiting_approval'].includes(u.stage)) && this.reg!.core.versionNumber !== undefined && this.reg!.admin.versionNumber !== undefined) {
      // 旧形式の記録（deployed がない）で、両方の配備を終えた後の段階（移行・完了・承認待ち）の場合だけ、
      // Setup が最後に配備・切替した版の組で代用する（ロールバックでも更新される）。配備の途中かもしれない段階では代用しない。
      // さらに、Staff・Admin の両方が開始時の版と異なる場合だけ代用する（片方でも開始時の版なら、両方を配備し直す。Codex 監査14 #1）
      const c = this.reg!.core.versionNumber;
      const a = this.reg!.admin.versionNumber;
      if (!start || (c !== start.core && a !== start.admin)) deployed = { core: c, admin: a };
    }
    return { start, deployed };
  }

  /** Staff・Admin の実際の配備の組（両方とも更新の開始時の組 / 両方とも今回配備した組 / 混在 / 照会できない）。版の組の完全一致で判定する */
  private deploymentPair(): 'old' | 'new' | 'mixed' | 'unknown' {
    const actual = this.actualPair();
    if (!actual) return 'unknown';
    const { start, deployed } = this.updatePairs();
    if (deployed && samePair(actual, deployed) && !(start && samePair(deployed, start))) return 'new';
    if (start && samePair(actual, start)) return 'old';
    return 'mixed';
  }

  /** 再開・完了の判定: 実際の配備が今回配備した組と完全に一致するか（Codex 監査6 #3・監査13 #1） */
  private deploymentState(): 'new' | 'old' | 'unknown' {
    const st = this.deploymentPair();
    return st === 'unknown' ? 'unknown' : st === 'new' ? 'new' : 'old';
  }

  /**
   * 正常に稼働した版の組の履歴。旧形式の登録（pairs がない）では、確定できる組だけを返す:
   * 進行中・失敗の更新の記録があればその開始時の組だけ（各プロジェクトの「直前の版」は配備で上書きされ得るため使わない）、
   * なければ両方の「直前の版」の組（あれば）と現在の組（Codex 監査13 #2）
   */
  private knownPairs(): VersionPair[] {
    const reg = this.reg!;
    if (reg.pairs && reg.pairs.length) return reg.pairs;
    const { start } = this.updatePairs();
    if (reg.update) return start ? [start] : [];
    const out: VersionPair[] = [];
    const c = reg.core;
    const a = reg.admin;
    if (c.previousVersionNumber !== undefined && a.previousVersionNumber !== undefined && !(c.previousVersionNumber === c.versionNumber && a.previousVersionNumber === a.versionNumber))
      out.push({ core: c.previousVersionNumber, admin: a.previousVersionNumber });
    if (c.versionNumber !== undefined && a.versionNumber !== undefined) out.push({ core: c.versionNumber, admin: a.versionNumber, appVersion: reg.appVersion });
    return out;
  }

  private withPair(hist: VersionPair[], p: VersionPair): VersionPair[] {
    const last = hist[hist.length - 1];
    const next = last && samePair(last, p) ? [...hist.slice(0, -1), { ...last, ...p }] : [...hist, p];
    return next.slice(-10);
  }

  /**
   * 更新の準備の段階で失敗したときのメンテナンスの扱い（Codex 監査8 #3・監査9 #3）
   * 解除するのは、①この更新で開始したメンテナンス（開始前は解除中と記録済み）で、②現在のプログラムと DB の構造の一致を
   * 確認できた場合だけ。それ以外は継続し、その旨と復旧の操作を返す
   */
  private releaseStartedMaintenance(): string {
    const before = this.reg?.update?.maintenanceBefore;
    if (before === true) return '更新の開始前からメンテナンス中だったため、メンテナンスを継続しています';
    const keep = 'メンテナンスを継続しています（スタッフの打刻は停止中）。管理画面「システム・更新」で状態（DB の構造とプログラムの一致）を確認してから解除してください';
    if (before !== false) return `更新の開始前の状態を確認できなかったため、${keep}`;
    let now: ReturnType<Installer['coreInfo']>;
    try {
      now = this.coreInfo();
    } catch {
      now = null;
    }
    if (!now) return `現在の状態を確認できなかったため、${keep}`;
    if (now.schemaVersion !== now.expectedSchemaVersion) return `DB の構造がプログラムと一致しないため、${keep}`;
    // Staff・Admin の実際の配備が、両方とも更新前の版か、両方ともこの更新の版である場合だけ解除する（版の混在で営業を再開しない。Codex 監査10 回帰 1）
    const pair = this.deploymentPair();
    if (pair === 'mixed') return `Staff・Admin の配備の版が一致しないため、${keep}。Setup の「直前のバージョンに戻す」または更新の再実行で版をそろえてください`;
    if (pair === 'unknown') return `Staff・Admin の配備の状態を確認できなかったため、${keep}`;
    try {
      const off = this.callCore('system.setMaintenance', { on: false });
      return off.ok ? 'メンテナンスを解除しました' : `メンテナンスの解除に失敗したため、${keep}`;
    } catch {
      return `メンテナンスの解除に失敗したため、${keep}`;
    }
  }

  private failUpdate(message: string) {
    if (this.reg) {
      this.reg.update = this.reg.update ? { ...this.reg.update, stage: 'failed', message } : null;
      this.persist();
    }
    return { ok: false, message };
  }

  /** GAS コードのロールバック（デプロイを以前のバージョン番号へ戻す。URL は変わらない） */
  rollbackCode(prevCore?: number, prevAdmin?: number, opts: { keepMaintenance?: boolean } = {}): string {
    // 想定外の失敗（記録の保存の失敗など、処理しきれない例外）は、安全側に止める（D-024。Codex 監査16）
    try {
      return this.rollbackCodeInner(prevCore, prevAdmin, opts);
    } catch (e) {
      return this.failSafe('ロールバック', e);
    }
  }

  /**
   * 「迷ったら止める」（D-024）: 更新・ロールバックの途中で想定外の失敗が起きた場合は、それ以上の切替・解除をせずに中止する。
   * メンテナンスを開始していた場合は解除しない（スタッフの打刻は止まったまま。紙のタイムカードで記録する）。
   * 現在の配備の組とメンテナンスの状態を、確認できる範囲で返す（確認・記録の失敗はさらに例外にしない）
   */
  private failSafe(op: string, e: unknown): string {
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    let deployed = '現在の配備: 確認できませんでした';
    try {
      const p = this.actualPair();
      if (p) deployed = `現在の配備: Staff v${p.core}／Admin v${p.admin}`;
    } catch {
      /* 確認できない */
    }
    let maint = 'メンテナンス: 確認できませんでした';
    try {
      const i = this.coreInfo();
      if (i) maint = i.maintenance ? 'メンテナンス: 継続中（スタッフの打刻は停止中）' : 'メンテナンス: 解除中';
    } catch {
      /* 確認できない */
    }
    const text =
      `${op}の途中で想定外のエラーが発生したため、安全のため処理を中止しました（${msg}）。メンテナンスを開始していた場合は、解除せずに継続しています。${deployed}。${maint}。` +
      '打刻は紙のタイムカードで記録し、docs/update-rollback.md「想定外の失敗」の手順で状態を確認してから、「直前のバージョンに戻す」または更新の再実行を行ってください';
    try {
      if (this.reg?.update) {
        this.reg.update = { ...this.reg.update, stage: 'failed', message: text };
        this.persist();
      }
    } catch {
      /* 記録の保存にも失敗した場合は、応答だけを返す */
    }
    return text;
  }

  private rollbackCodeInner(prevCore?: number, prevAdmin?: number, opts: { keepMaintenance?: boolean } = {}): string {
    const reg = this.reg!;
    const out: string[] = [];
    let rbFailed = false;
    const u = reg.update;
    // 戻し先の版の組（Codex 監査11 #1・監査12・監査13）。版の組は履歴（pairs）と更新の記録から選び、各プロジェクトの「直前の版」からは推測しない
    // - undo: 更新を取り消す（更新の開始時の組へ）。自動ロールバック（呼び出し側の指定）と、手動で、配備に着手した更新が
    //         取り消し終わっていない（codeTouched）か、実際の配備が開始時の組と異なる場合
    // - older: 正常に稼働した組の履歴で、現在の組の一つ前の組へ
    let target: { core: number; admin: number };
    let kind: 'undo' | 'older';
    if (prevCore !== undefined && prevAdmin !== undefined) {
      target = { core: prevCore, admin: prevAdmin };
      kind = 'undo';
    } else {
      const actual = this.actualPair();
      if (!actual || !reg.core.scriptId || !reg.core.deploymentId || !reg.admin.scriptId || !reg.admin.deploymentId)
        return 'Staff・Admin の配備の状態を確認できないため、ロールバックを行いませんでした（メンテナンスの状態は変更していません）。時間をおいて再実行してください';
      const { start } = this.updatePairs();
      if (reg.pendingRollback) {
        // 前回の「前の組へ戻す」が途中で止まっている（片方だけ切り替わった等）: 保存した戻し先の組への切替と照合をやり直す（Codex 監査14 #2）
        target = { ...reg.pendingRollback };
        kind = 'older';
      } else if (start && (u?.codeTouched || !samePair(actual, start))) {
        target = start;
        kind = 'undo';
      } else {
        const hist = this.knownPairs();
        let idx = -1;
        for (let i = hist.length - 1; i >= 0; i--) if (samePair(hist[i]!, actual)) {
          idx = i;
          break;
        }
        if (idx <= 0)
          return (
            '戻せる版の組（Staff・Admin の両方の、以前に正常に稼働した版）がないため、ロールバックを行いませんでした（メンテナンスの状態は変更していません）。' +
            '初回の構築の直後や、以前の Setup で記録した更新の途中など、さらに前の版の組を確定できない場合は戻せません'
          );
        target = { core: hist[idx - 1]!.core, admin: hist[idx - 1]!.admin };
        kind = 'older';
      }
    }
    // 配備を切り替える前に、現在の Core で書き込みを止める（旧版と DB の組み合わせを確認するまで営業を再開しない。Codex 監査4）
    const on = this.callCore('system.setMaintenance', { on: true });
    if (!on.ok) return `メンテナンスを開始できなかったため、ロールバックを中止しました（${on.error?.message ?? ''}）。現在のバージョンのまま稼働しています`;
    out.push('メンテナンスを開始しました');
    if (kind === 'older' && !reg.pendingRollback) {
      // メンテナンスの開始を確認した後、最初の切替の直前に戻し先の組を保存する（片方だけ切り替わった後の再試行で、同じ組へ戻すため）。
      // 切替の前に中止した場合は保存しない（何も変わっていないのに更新を止めない。Codex 監査15）。再試行中は保存済みの組を保持する
      reg.pendingRollback = { ...target };
      this.persist();
    }
    for (const [which, prev] of [['core', target.core], ['admin', target.admin]] as const) {
      const ref = reg[which];
      try {
        this.d.api.updateDeployment(ref.scriptId!, ref.deploymentId!, prev, `Shiftly rollback to v${prev}`);
        reg[which] = { ...ref, versionNumber: prev };
        out.push(`${which === 'core' ? 'Staff' : 'Admin'} をバージョン ${prev} に戻しました`);
      } catch (e) {
        rbFailed = true;
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
    }
    const verified = !rbFailed && this.deployedVersionsAre(target.core, target.admin) === true;
    if (verified) {
      if (kind === 'older') {
        // 履歴を戻し先の組まで切り詰める（次の手動ロールバックはさらに前の組へ）。進行中の更新の記録は、この組を開始時の組として引き継ぐ
        const hist = this.knownPairs();
        let i = hist.length - 1;
        while (i >= 0 && !samePair(hist[i]!, target)) i--;
        reg.pairs = hist.slice(0, i + 1);
        const back = reg.pairs[reg.pairs.length - 1];
        if (back?.appVersion) reg.appVersion = back.appVersion;
        if (u) reg.update = { ...u, prevCore: target.core, prevAdmin: target.admin, deployed: {}, codeTouched: false };
        reg.pendingRollback = null;
      } else if (reg.update) {
        // 更新を取り消し終えた（実際の配備が開始時の組にそろった）。今回配備した組の記録は空にする（旧形式の代用を使わない）
        reg.update = { ...reg.update, deployed: {}, codeTouched: false };
      }
    }
    if (!d || d.schemaVersion !== d.expectedSchemaVersion) {
      // 上で継続の理由を記録済み
    } else if (!verified) {
      // Staff・Admin の版が混在している可能性があるため、営業を再開しない（Codex 監査10 回帰 1）
      out.push(
        `一部のロールバックに失敗した、または Staff・Admin の実際の配備が戻し先の版の組（Staff v${target.core ?? '?'}／Admin v${target.admin ?? '?'}）と一致することを確認できなかったため、メンテナンスを継続しています（スタッフの打刻は停止中）。` +
          'Setup の「直前のバージョンに戻す」を再実行してください（更新の記録がある間は、更新の開始時の版の組へ戻します）',
      );
    } else if (opts.keepMaintenance ?? (u ? u.maintenanceBefore !== false : false)) {
      // 自動ロールバックは呼び出し側の指定、手動は更新の記録の「開始前からメンテナンス中か」に従う（不明なら継続。Codex 監査12）
      out.push('更新の開始前からメンテナンス中だった（または開始前の状態を確認できない）ため、メンテナンスを継続しています。管理画面「システム・更新」で状態を確認してから解除してください');
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

function samePair(x: { core: number; admin: number }, y: { core: number; admin: number }): boolean {
  return x.core === y.core && x.admin === y.admin;
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

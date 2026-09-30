import { createInitialState } from './data';
import { dedupeOps, reduceOps, sortOps } from './merge';
import type {
  ComponentExample,
  ComponentSpec,
  MergeConflict,
  OperationEnvelope,
  PropertySpec,
  SpecOp,
  ValidationIssue,
  WorkspaceState
} from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1028-workspace-v1';
const VIEW_STORAGE_KEY = 'sologsb-1028-view-v2';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

type UndoEntry = { label: string; inverses: SpecOp[]; forwards: SpecOp[] };

interface IngestResult {
  merged: boolean;
  conflictsChanged: boolean;
}

export class SpecStore extends EventTarget {
  /** 本标签页身份，冲突选择时展示来源。 */
  readonly tabId = uid('tab');
  /** 合并后的内容：目录、检查、版本与本地保存都从这里读取。 */
  state: WorkspaceState;
  conflicts: MergeConflict[] = [];

  private baseline: WorkspaceState;
  private ops: SpecOp[] = [];
  private seq = 0;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private lastAction = '';
  /** 上一次发出 change 事件时的冲突指纹，用于提示新冲突。 */
  private conflictFingerprint = '';

  constructor(host: Window = window) {
    super();
    const envelope = this.loadEnvelope();
    this.baseline = envelope.baseline;
    this.ops = envelope.ops;
    const reduced = reduceOps(this.baseline, this.ops);
    const savedSelection = this.loadSelection();
    this.state = savedSelection && reduced.state.components.some((item) => item.id === savedSelection)
      ? { ...reduced.state, selectedId: savedSelection }
      : reduced.state;
    this.conflicts = reduced.conflicts;
    this.conflictFingerprint = this.fingerprint();
    host.addEventListener('storage', this.onStorage);
    host.addEventListener('focus', this.catchUp);
  }

  get selected(): ComponentSpec | undefined {
    return this.state.components.find((item) => item.id === this.state.selectedId);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get lastUndoLabel() { return this.lastAction; }

  conflictsFor(componentId: string): MergeConflict[] {
    return this.conflicts.filter((conflict) => conflict.componentId === componentId);
  }

  select(id: string) {
    if (!this.state.components.some((item) => item.id === id)) return;
    this.state = { ...this.state, selectedId: id };
    // 选中的组件只是本标签页的视图状态，单独保存，不写入共享操作日志。
    try { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ selectedId: id })); } catch { /* 视图状态可丢失 */ }
    this.emit();
  }

  private loadSelection(): string | undefined {
    try {
      const raw = localStorage.getItem(VIEW_STORAGE_KEY);
      if (raw) return (JSON.parse(raw) as { selectedId?: string }).selectedId;
    } catch {
      // 损坏的视图状态回落到默认选中项。
    }
    return undefined;
  }

  addComponent() {
    const id = uid('component');
    const component: ComponentSpec = {
      id,
      name: 'Untitled component',
      category: 'Uncategorised',
      status: 'draft',
      purpose: '说明该组件解决的用户问题。',
      usage: '说明何时使用、何时不要使用。',
      properties: [],
      states: 'default、hover、focus-visible、disabled。',
      keyboardBehavior: '记录 Tab、Enter、Space、方向键和 Esc 等行为。',
      screenReader: '记录角色、名称、状态和动态播报。',
      disabledScenarios: '记录不应使用该组件的场景。',
      interactionSignature: '',
      examples: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
      snapshots: []
    };
    const op = this.makeOp('component.add', { component });
    const inverse = this.makeOp('component.remove', { componentId: id });
    this.dispatch([op], '新建组件', [inverse]);
  }

  updateComponent(patch: Partial<ComponentSpec>) {
    const selected = this.selected;
    if (!selected) return;
    // 契约字段（交互签名、键盘行为）变化后，依赖示例立即失效由重放器统一完成。
    const base = this.baseForPatch(selected, patch);
    const op = this.makeOp('component.update', { componentId: selected.id, patch: clone(patch) }, base);
    // 逆操作基于刚写入的新值，重放时才不会被误判成分叉冲突。
    const inverse = this.makeOp('component.update', { componentId: selected.id, patch: base }, clone(patch));
    this.dispatch([op], '编辑组件', [inverse]);
  }

  addProperty() {
    const selected = this.selected;
    if (!selected) return;
    const property: PropertySpec = {
      id: uid('property'),
      name: 'newProperty',
      type: 'string',
      required: false,
      defaultValue: '',
      description: '描述该属性对开发者和用户的影响。'
    };
    const op = this.makeOp('property.add', { componentId: selected.id, property });
    const inverse = this.makeOp('property.remove', { componentId: selected.id, propertyId: property.id });
    this.dispatch([op], '新增属性', [inverse]);
  }

  updateProperty(propertyId: string, patch: Partial<PropertySpec>) {
    const component = this.selected;
    const property = component?.properties.find((item) => item.id === propertyId);
    if (!component || !property) return;
    const base = this.baseForPatch(property, patch);
    const op = this.makeOp('property.update', { componentId: component.id, propertyId, patch: clone(patch) }, base);
    const inverse = this.makeOp('property.update', { componentId: component.id, propertyId, patch: base }, clone(patch));
    this.dispatch([op], '编辑属性', [inverse]);
  }

  removeProperty(propertyId: string) {
    const component = this.selected;
    const property = component?.properties.find((item) => item.id === propertyId);
    if (!component || !property) return;
    const op = this.makeOp('property.remove', { componentId: component.id, propertyId });
    const inverse = this.makeOp('property.add', { componentId: component.id, property: clone(property) });
    this.dispatch([op], '删除属性', [inverse]);
  }

  addExample() {
    const selected = this.selected;
    if (!selected) return;
    const exampleId = uid('example');
    const tag = selected.name.toLowerCase().replaceAll(' ', '-');
    const example: ComponentExample = {
      id: exampleId,
      title: '新示例',
      code: `<${tag}>示例</${tag}>`,
      propertyIds: [],
      stale: false,
      staleReason: '',
      createdFromRevision: selected.revision
    };
    const op = this.makeOp('example.add', { componentId: selected.id, example });
    const inverse = this.makeOp('example.remove', { componentId: selected.id, exampleId });
    this.dispatch([op], '新增示例', [inverse]);
  }

  updateExample(exampleId: string, patch: Partial<ComponentExample>) {
    const component = this.selected;
    const example = component?.examples.find((item) => item.id === exampleId);
    if (!component || !example) return;
    const base = this.baseForPatch(example, patch);
    const op = this.makeOp('example.update', { componentId: component.id, exampleId, patch: clone(patch) }, base);
    const inverse = this.makeOp('example.update', { componentId: component.id, exampleId, patch: base }, clone(patch));
    this.dispatch([op], '编辑示例', [inverse]);
  }

  removeExample(exampleId: string) {
    const component = this.selected;
    const example = component?.examples.find((item) => item.id === exampleId);
    if (!component || !example) return;
    const op = this.makeOp('example.remove', { componentId: component.id, exampleId });
    const inverse = this.makeOp('example.add', { componentId: component.id, example: clone(example) });
    this.dispatch([op], '删除示例', [inverse]);
  }

  /** 在冲突面板中选择某个新值；以解决操作重放，所有人都会关闭同一条冲突。 */
  resolveConflict(conflict: MergeConflict, value: unknown) {
    const op = this.makeOp('conflict.resolve', { key: conflict.key, value });
    this.dispatch([op], '解决冲突');
  }

  createSnapshot(reason = '手动版本') {
    const selected = this.selected;
    if (!selected) return;
    const { snapshots: _ignored, ...component } = clone(selected);
    const op = this.makeOp('snapshot.create', { componentId: selected.id, reason, component });
    // 版本号推进是全局事实，不进入撤销栈。
    this.dispatch([op], '创建版本快照');
  }

  migrateExamples() {
    const selected = this.selected;
    if (!selected) return;
    const op = this.makeOp('examples.migrate', { componentId: selected.id });
    this.dispatch([op], '迁移示例到当前版本');
  }

  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const component of this.state.components) {
      const names = new Map<string, number>();
      component.properties.forEach((property) => names.set(property.name.trim(), (names.get(property.name.trim()) ?? 0) + 1));
      for (const [name, count] of names) {
        if (name && count > 1) {
          issues.push({ id: `${component.id}-duplicate-${name}`, level: 'error', componentId: component.id, target: component.name, message: `属性名称 ${name} 重复。`, field: 'properties' });
        }
      }
      const contractChanged = component.examples.some((example) => example.createdFromRevision < component.revision);
      component.examples.forEach((example) => {
        const missingReferences = example.propertyIds.filter((id) => !component.properties.some((property) => property.id === id));
        if (example.stale || missingReferences.length) {
          issues.push({ id: `${component.id}-${example.id}-stale`, level: 'warning', componentId: component.id, target: example.title, message: example.staleReason || '示例引用了已删除属性。', field: 'examples' });
        }
        if (!example.code.trim()) {
          issues.push({ id: `${component.id}-${example.id}-empty`, level: 'error', componentId: component.id, target: example.title, message: '示例代码不能为空。', field: 'examples' });
        }
      });
      if (!component.keyboardBehavior.trim()) {
        issues.push({ id: `${component.id}-keyboard`, level: 'error', componentId: component.id, target: component.name, message: '缺少键盘行为说明。', field: 'keyboard' });
      }
      if (!component.screenReader.trim()) {
        issues.push({ id: `${component.id}-screenreader`, level: 'error', componentId: component.id, target: component.name, message: '缺少读屏说明。', field: 'screenReader' });
      }
      if (contractChanged && component.examples.length) {
        issues.push({ id: `${component.id}-contract`, level: 'info', componentId: component.id, target: component.name, message: '属性契约或交互签名发生变化，建议创建快照并迁移示例。', field: 'properties' });
      }
    }
    return issues;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push(entry);
    // 逆操作作为新操作追加进日志：其他标签页重放后得到相同结果。
    // 逆操作的 base 取自被撤销操作写入的新值，重放时才不会被误判成过期分叉。
    const inverses = entry.inverses.map((op) => this.withInverseBase(entry.forwards, this.restamp(op)));
    this.dispatch(inverses, `撤销：${entry.label}`, undefined, { recordHistory: false });
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push(entry);
    // 重做必须换新 id，否则会被“同一操作只处理一遍”的去重逻辑跳过。
    const forwards = entry.forwards.map((op) => this.restamp(op));
    this.dispatch(forwards, `重做：${entry.label}`, undefined, { recordHistory: false });
  }

  /** 让逆操作“基于被撤销的新值”，恢复到旧值时属于对最新值的正常编辑。 */
  private withInverseBase(forwardOps: SpecOp[], inverse: SpecOp): SpecOp {
    const forward = forwardOps.find((op) => op.type === inverse.type && op.payload?.componentId === inverse.payload?.componentId
      && op.payload?.propertyId === inverse.payload?.propertyId
      && op.payload?.exampleId === inverse.payload?.exampleId);
    if (!forward?.payload?.patch || !inverse.payload?.patch) return inverse;
    // base 以撤销发生时合并状态里的当前值为准（可能已被其他标签页接力改过），
    // 这样逆操作是“基于最新值改回旧值”，不会被误判成过期分叉。
    const current = this.currentPatchBase(inverse.payload);
    const fallback = clone(forward.payload.patch as Record<string, unknown>);
    return { ...inverse, base: current ?? fallback };
  }

  /** 按逆操作的定位信息，读出合并状态中对应字段的当前值。 */
  private currentPatchBase(payload: Record<string, unknown>): Record<string, unknown> | undefined {
    const component = this.state.components.find((item) => item.id === payload.componentId);
    if (!component) return undefined;
    let target: object | undefined = component;
    if ('propertyId' in payload) target = component.properties.find((item) => item.id === payload.propertyId);
    else if ('exampleId' in payload) target = component.examples.find((item) => item.id === payload.exampleId);
    if (!target) return undefined;
    const fields = Object.keys(payload.patch as Record<string, unknown>);
    const current: Record<string, unknown> = {};
    for (const field of fields) current[field] = (target as Record<string, unknown>)[field];
    return current;
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.baseline = createInitialState();
    this.ops = [];
    this.seq = 0;
    this.persist();
    this.rebuild('已恢复为内置示例数据');
  }

  // ── 跨标签页合并 ─────────────────────────────────────────────

  private onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    const result = this.ingest(event.newValue);
    if (result.merged) {
      this.rebuild(result.conflictsChanged ? '检测到其他标签页的改动，存在需要选择的冲突' : '已合并其他标签页的改动');
    }
  };

  /** 切回本标签页时主动追一次日志，避免 storage 事件遗漏。 */
  private catchUp = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const result = this.ingest(raw);
      if (result.merged) {
        this.rebuild(result.conflictsChanged ? '已合并其他标签页的改动，存在需要选择的冲突' : '已合并其他标签页的改动');
      }
    } catch {
      // 存储暂时不可读时保留当前合并视图。
    }
  };

  private ingest(raw: string): IngestResult {
    const envelope = JSON.parse(raw) as OperationEnvelope;
    if (envelope.version !== 2 || !Array.isArray(envelope.ops)) return { merged: false, conflictsChanged: false };
    const known = new Set(this.ops.map((op) => op.id));
    const incoming = envelope.ops.filter((op) => !known.has(op.id));
    if (!incoming.length) return { merged: false, conflictsChanged: false };
    this.ops = sortOps(dedupeOps([...this.ops, ...incoming]));
    const beforeFingerprint = this.conflictFingerprint;
    this.rebuildState();
    return { merged: true, conflictsChanged: this.fingerprint() !== beforeFingerprint };
  }

  private dispatch(
    ops: SpecOp[],
    label: string,
    inverses?: SpecOp[],
    options: { recordHistory?: boolean } = {}
  ) {
    this.ops = sortOps(dedupeOps([...this.ops, ...ops]));
    this.persist();
    this.rebuildState();
    this.lastAction = label;
    const isHistoryNavigation = label.startsWith('撤销：') || label.startsWith('重做：');
    if (!isHistoryNavigation && options.recordHistory !== false) {
      this.redoStack = [];
      if (inverses?.length) {
        this.undoStack.push({
          label,
          inverses: [...inverses].reverse().map((op) => this.restamp(op)),
          forwards: ops.map((op) => this.restamp(op))
        });
        this.undoStack = this.undoStack.slice(-40);
      }
    }
    this.emit();
  }

  /** 给历史操作换发新身份与新时间戳，供撤销/重做追加为可重放操作。 */
  private restamp(op: SpecOp): SpecOp {
    return { ...op, id: uid('op'), ts: Date.now(), seq: this.nextSeq(), tabId: this.tabId };
  }

  private makeOp(type: SpecOp['type'], payload?: Record<string, unknown>, base?: unknown): SpecOp {
    const op: SpecOp = { id: uid('op'), type, tabId: this.tabId, ts: Date.now(), seq: this.nextSeq() };
    if (payload) op.payload = payload;
    if (base !== undefined) op.base = base;
    return op;
  }

  private nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  private baseForPatch<T extends object>(target: T, patch: Partial<T>): Partial<T> {
    const base = {} as Partial<T>;
    for (const field of Object.keys(patch) as (keyof T)[]) {
      base[field] = target[field];
    }
    return base;
  }

  private rebuildState() {
    const reduced = reduceOps(this.baseline, this.ops);
    const selectedExists = reduced.state.components.some((item) => item.id === this.state?.selectedId);
    this.state = selectedExists ? { ...reduced.state, selectedId: this.state.selectedId } : reduced.state;
    this.conflicts = reduced.conflicts;
  }

  private rebuild(toast?: string) {
    this.rebuildState();
    this.emit(toast);
  }

  private fingerprint(): string {
    return JSON.stringify(this.conflicts.map((conflict) => `${conflict.key}:${conflict.options.map((option) => option.opId).join(',')}`));
  }

  private loadEnvelope(): OperationEnvelope {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const envelope = JSON.parse(saved) as OperationEnvelope;
        if (envelope.version === 2 && envelope.baseline && Array.isArray(envelope.ops)) return envelope;
      }
      // 首次升级：旧版整份状态成为操作重放的基线，历史内容不丢失。
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const legacyState = JSON.parse(legacy) as WorkspaceState;
        const migrated: OperationEnvelope = { version: 2, baseline: legacyState, ops: [] };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        // 移走旧键，避免下次启动重复迁移。
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        return migrated;
      }
    } catch {
      // 损坏的本地草稿回落到内置示例数据。
    }
    return { version: 2, baseline: createInitialState(), ops: [] };
  }

  private persist() {
    const envelope: OperationEnvelope = { version: 2, baseline: this.baseline, ops: this.ops };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  }

  private emit(toast?: string) {
    const previous = this.conflictFingerprint;
    this.conflictFingerprint = this.fingerprint();
    this.dispatchEvent(new CustomEvent('merge', { detail: { toast, newConflicts: this.conflictFingerprint !== previous } }));
    this.dispatchEvent(new CustomEvent('change'));
  }
}

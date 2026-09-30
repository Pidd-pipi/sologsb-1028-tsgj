import { createInitialState } from './data';
import type {
  ComponentExample,
  ComponentSnapshot,
  ComponentSpec,
  PropertySpec,
  ValidationIssue,
  WorkspaceState
} from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v1';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 一次编辑即一条可重放的顺序操作。操作只追加、不修改，跨标签页同步后
 * 按因果顺序重放得到合并状态。
 */
type OpType =
  | 'component:add'
  | 'component:remove'
  | 'component:update'
  | 'property:add'
  | 'property:update'
  | 'property:remove'
  | 'example:add'
  | 'example:update'
  | 'example:remove'
  | 'snapshot:create'
  | 'snapshot:remove'
  | 'examples:migrate'
  | 'conflict:resolve';

interface Op {
  id: string;
  tabId: string;
  seq: number;
  ts: number;
  componentId: string;
  type: OpType;
  payload: Record<string, any>;
  /** 产生该操作时本标签页已观察到的全部操作 id（因果前沿）。 */
  seen: string[];
}

interface ConflictOption {
  opId: string;
  tabId: string;
  value: string;
}

/**
 * 同一属性名 / 同一条示例代码出现两个新值时的冲突。其他字段直接合并，
 * 只有冲突字段在用户选择前保持挂起。
 */
export interface Conflict {
  key: string;
  componentId: string;
  kind: 'property-name' | 'example-code';
  targetId: string;
  field: 'name' | 'code';
  options: ConflictOption[];
  winnerOpId?: string;
}

const CONTRACT_FIELDS: Array<keyof PropertySpec> = ['name', 'type', 'required', 'defaultValue'];

const pick = <T extends object>(value: T, keys: readonly (keyof T)[]): Record<string, unknown> => {
  const source = value as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of keys) if (key in value) result[key as string] = source[key as string];
  return result;
};

/** 拓扑排序：seen 中的操作先于本操作，同级按 (时间, id) 确定次序。 */
function topoSort(ops: Op[]): Op[] {
  const byId = new Map(ops.map((op) => [op.id, op]));
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const op of ops) {
    const deps = op.seen.filter((id) => byId.has(id));
    indeg.set(op.id, deps.length);
    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(op.id);
    }
  }
  const ready = ops
    .filter((op) => (indeg.get(op.id) ?? 0) === 0)
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const result: Op[] = [];
  const emitted = new Set<string>();
  while (ready.length) {
    const op = ready.shift()!;
    result.push(op);
    emitted.add(op.id);
    for (const dep of dependents.get(op.id) ?? []) {
      indeg.set(dep, (indeg.get(dep) ?? 0) - 1);
      if ((indeg.get(dep) ?? 0) === 0) {
        const next = byId.get(dep)!;
        const idx = ready.findIndex((item) => item.ts > next.ts || (item.ts === next.ts && item.id > next.id));
        if (idx === -1) ready.push(next);
        else ready.splice(idx, 0, next);
      }
    }
  }
  if (result.length < ops.length) {
    // 出现环（理论上不应发生）时兜底追加，保证不丢操作。
    for (const op of ops) if (!emitted.has(op.id)) result.push(op);
  }
  return result;
}

export class SpecStore extends EventTarget {
  private ops: Op[] = [];
  private opIds = new Set<string>();
  private conflicts: Conflict[] = [];
  private merged: ComponentSpec[] = [];
  private baseComponents: ComponentSpec[] = createInitialState().components;
  private selectedId: string;
  private readonly tabId = uid('tab');
  private seq = 0;
  private undoStack: Array<{ label: string; reverse: Op }> = [];
  private redoStack: Array<{ label: string; forward: Op }> = [];
  private lastAction = '';

  constructor() {
    super();
    const { ops, baseState } = this.load();
    if (baseState) {
      this.baseComponents = clone(baseState.components);
      this.selectedId = baseState.selectedId;
    } else {
      this.selectedId = createInitialState().selectedId;
    }
    this.ops = ops;
    this.opIds = new Set(ops.map((op) => op.id));
    this.detectConflicts();
    this.replay();
    window.addEventListener('storage', this.onStorage);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get state(): WorkspaceState {
    return { components: this.merged, selectedId: this.selectedId };
  }

  get selected(): ComponentSpec | undefined {
    return this.merged.find((item) => item.id === this.selectedId);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get lastUndoLabel() { return this.lastAction; }
  get activeConflicts(): Conflict[] { return this.conflicts.filter((item) => !item.winnerOpId); }

  conflictsFor(componentId: string): Conflict[] {
    return this.conflicts.filter((item) => item.componentId === componentId && !item.winnerOpId);
  }

  select(id: string) {
    if (!this.merged.some((item) => item.id === id)) return;
    this.selectedId = id;
    this.emit();
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
    const forward = this.makeOp('component:add', id, { component });
    const reverse = this.makeOp('component:remove', id, { componentId: id });
    this.commit('新建组件', forward, reverse);
    this.selectedId = id;
    this.emit();
  }

  updateComponent(patch: Partial<ComponentSpec>, markExamplesStale = false) {
    const selected = this.selected;
    if (!selected) return;
    const before = pick(selected, Object.keys(patch) as (keyof ComponentSpec)[]);
    const forward = this.makeOp('component:update', selected.id, { patch, before, markExamplesStale });
    const reverse = this.makeOp('component:update', selected.id, { patch: before, before: patch, markExamplesStale: false });
    this.commit('编辑组件', forward, reverse);
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
    const forward = this.makeOp('property:add', selected.id, { property });
    const reverse = this.makeOp('property:remove', selected.id, { propertyId: property.id, silent: true });
    this.commit('新增属性', forward, reverse);
  }

  updateProperty(propertyId: string, patch: Partial<PropertySpec>) {
    const selected = this.selected;
    if (!selected) return;
    const property = selected.properties.find((item) => item.id === propertyId);
    if (!property) return;
    const before = pick(property, Object.keys(patch) as (keyof PropertySpec)[]);
    const patchRecord = patch as unknown as Record<string, unknown>;
    const contractChanged = CONTRACT_FIELDS.some((field) => field in patch && patchRecord[field] !== before[field as string]);
    const forward = this.makeOp('property:update', selected.id, { propertyId, patch, before, contractChanged });
    const reverse = this.makeOp('property:update', selected.id, { propertyId, patch: before, before: patch, contractChanged });
    this.commit('编辑属性', forward, reverse);
  }

  removeProperty(propertyId: string) {
    const selected = this.selected;
    if (!selected) return;
    const property = selected.properties.find((item) => item.id === propertyId);
    if (!property) return;
    const forward = this.makeOp('property:remove', selected.id, { propertyId, property });
    const reverse = this.makeOp('property:add', selected.id, { property });
    this.commit('删除属性', forward, reverse);
  }

  addExample() {
    const selected = this.selected;
    if (!selected) return;
    const example: ComponentExample = {
      id: uid('example'),
      title: '新示例',
      code: `<${selected.name.toLowerCase().replaceAll(' ', '-')}>示例</${selected.name.toLowerCase().replaceAll(' ', '-')}>`,
      propertyIds: [],
      stale: false,
      staleReason: '',
      createdFromRevision: selected.revision
    };
    const forward = this.makeOp('example:add', selected.id, { example });
    const reverse = this.makeOp('example:remove', selected.id, { exampleId: example.id, silent: true });
    this.commit('新增示例', forward, reverse);
  }

  updateExample(exampleId: string, patch: Partial<ComponentExample>) {
    const selected = this.selected;
    if (!selected) return;
    const example = selected.examples.find((item) => item.id === exampleId);
    if (!example) return;
    const before = pick(example, Object.keys(patch) as (keyof ComponentExample)[]);
    const forward = this.makeOp('example:update', selected.id, { exampleId, patch, before });
    const reverse = this.makeOp('example:update', selected.id, { exampleId, patch: before, before: patch });
    this.commit('编辑示例', forward, reverse);
  }

  removeExample(exampleId: string) {
    const selected = this.selected;
    if (!selected) return;
    const example = selected.examples.find((item) => item.id === exampleId);
    if (!example) return;
    const forward = this.makeOp('example:remove', selected.id, { exampleId, example });
    const reverse = this.makeOp('example:add', selected.id, { example });
    this.commit('删除示例', forward, reverse);
  }

  createSnapshot(reason = '手动版本') {
    const selected = this.selected;
    if (!selected) return;
    const { snapshots: _ignored, ...component } = clone(selected);
    void _ignored;
    const snapshot: ComponentSnapshot = {
      revision: selected.revision,
      savedAt: new Date().toISOString(),
      reason,
      component: { ...component, revision: selected.revision }
    };
    const forward = this.makeOp('snapshot:create', selected.id, { snapshot });
    const reverse = this.makeOp('snapshot:remove', selected.id, { revision: snapshot.revision });
    this.commit('创建版本快照', forward, reverse);
  }

  migrateExamples() {
    const selected = this.selected;
    if (!selected) return;
    const activePropertyIds = new Set(selected.properties.map((item) => item.id));
    const nextRevision = selected.revision + 1;
    const changes = selected.examples.map((example) => ({
      exampleId: example.id,
      propertyIds: example.propertyIds.filter((id) => activePropertyIds.has(id)),
      createdFromRevision: nextRevision
    }));
    const before = selected.examples.map((example) => ({
      exampleId: example.id,
      propertyIds: example.propertyIds,
      createdFromRevision: example.createdFromRevision
    }));
    const forward = this.makeOp('examples:migrate', selected.id, { changes, before, revisionDelta: 1 });
    const reverse = this.makeOp('examples:migrate', selected.id, { changes: before, before: changes, revisionDelta: -1 });
    this.commit('迁移示例到当前版本', forward, reverse);
  }

  resolveConflict(key: string, winnerOpId: string) {
    const conflict = this.conflicts.find((item) => item.key === key);
    if (!conflict || !conflict.options.some((item) => item.opId === winnerOpId)) return;
    const op = this.makeOp('conflict:resolve', conflict.componentId, { key, winnerOpId });
    this.appendOps([op]);
    this.detectConflicts();
    this.replay();
    this.persist();
    this.emit();
  }

  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const component of this.merged) {
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
    this.redoStack.push({ label: entry.label, forward: this.instantiate(entry.reverse) });
    this.applyLocal(entry.reverse, entry.label);
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ label: entry.label, reverse: this.instantiate(entry.forward) });
    this.applyLocal(entry.forward, entry.label);
  }

  reset() {
    this.baseComponents = createInitialState().components;
    this.ops = [];
    this.opIds = new Set();
    this.conflicts = [];
    this.undoStack = [];
    this.redoStack = [];
    this.selectedId = createInitialState().selectedId;
    this.replay();
    this.persist();
    this.emit();
  }

  private commit(label: string, forward: Op, reverse: Op) {
    this.undoStack.push({ label, reverse });
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
    this.lastAction = label;
    this.applyLocal(forward, label);
  }

  private applyLocal(op: Op, label: string) {
    this.appendOps([op]);
    this.lastAction = label;
    this.detectConflicts();
    this.replay();
    this.persist();
    this.emit();
  }

  private makeOp(type: OpType, componentId: string, payload: Record<string, any>): Op {
    return {
      id: uid('op'),
      tabId: this.tabId,
      seq: ++this.seq,
      ts: Date.now(),
      componentId,
      type,
      payload,
      seen: [...this.opIds]
    };
  }

  private instantiate(template: Op): Op {
    return { ...template, id: uid('op'), seq: ++this.seq, ts: Date.now(), seen: [...this.opIds] };
  }

  private appendOps(incoming: Op[]) {
    for (const op of incoming) {
      if (this.opIds.has(op.id)) continue; // 同一操作重复到达只处理一遍
      this.opIds.add(op.id);
      this.ops.push(op);
    }
    this.ops.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }

  private onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    this.syncFromStorage();
  };

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.syncFromStorage();
  };

  private syncFromStorage() {
    let raw: string | null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let stored: Op[];
    try {
      const parsed = JSON.parse(raw) as { ops?: Op[] } | WorkspaceState;
      stored = Array.isArray((parsed as { ops?: Op[] }).ops) ? (parsed as { ops: Op[] }).ops : [];
    } catch {
      return;
    }
    const fresh = stored.filter((op) => !this.opIds.has(op.id));
    if (!fresh.length) return;
    this.appendOps(fresh);
    this.detectConflicts();
    this.replay();
    this.emit();
  }

  private replay() {
    const base = clone(this.baseComponents);
    const byId = new Map(base.map((component) => [component.id, component]));
    for (const op of topoSort(this.ops)) {
      this.applyOp(byId, op);
    }
    this.merged = [...byId.values()];
  }

  private applyOp(byId: Map<string, ComponentSpec>, op: Op) {
    const target = byId.get(op.componentId);
    switch (op.type) {
      case 'component:add': {
        if (!byId.has(op.payload.component.id)) byId.set(op.payload.component.id, clone(op.payload.component));
        break;
      }
      case 'component:remove': {
        byId.delete(op.payload.componentId);
        break;
      }
      case 'component:update': {
        if (!target) break;
        this.applyPatch(target, op.payload.patch as Record<string, unknown>, op, target.id, []);
        target.updatedAt = new Date(op.ts).toISOString();
        if (op.payload.markExamplesStale) {
          target.examples.forEach((example) => {
            example.stale = true;
            example.staleReason = '组件交互或属性契约已修改，示例需要重新验证。';
          });
        }
        break;
      }
      case 'property:add': {
        if (!target) break;
        if (!target.properties.some((item) => item.id === op.payload.property.id)) {
          target.properties.push(clone(op.payload.property));
          target.updatedAt = new Date(op.ts).toISOString();
        }
        break;
      }
      case 'property:update': {
        if (!target) break;
        const property = target.properties.find((item) => item.id === op.payload.propertyId);
        if (!property) break;
        this.applyPatch(property, op.payload.patch as Record<string, unknown>, op, property.id, ['name']);
        target.updatedAt = new Date(op.ts).toISOString();
        if (op.payload.contractChanged) {
          target.examples.forEach((example) => {
            if (example.propertyIds.includes(property.id)) {
              example.stale = true;
              example.staleReason = `属性 ${property.name} 契约已变更，示例需要重新验证。`;
            }
          });
        }
        break;
      }
      case 'property:remove': {
        if (!target) break;
        const removed = target.properties.find((item) => item.id === op.payload.propertyId);
        target.properties = target.properties.filter((item) => item.id !== op.payload.propertyId);
        target.updatedAt = new Date(op.ts).toISOString();
        if (!op.payload.silent && removed) {
          target.examples.forEach((example) => {
            if (example.propertyIds.includes(removed.id) || example.code.includes(removed.name)) {
              example.stale = true;
              example.staleReason = `属性 ${removed.name} 已删除，示例代码或说明仍可能引用它。`;
            }
          });
        }
        break;
      }
      case 'example:add': {
        if (!target) break;
        if (!target.examples.some((item) => item.id === op.payload.example.id)) {
          target.examples.push(clone(op.payload.example));
          target.updatedAt = new Date(op.ts).toISOString();
        }
        break;
      }
      case 'example:update': {
        if (!target) break;
        const example = target.examples.find((item) => item.id === op.payload.exampleId);
        if (!example) break;
        this.applyPatch(example, op.payload.patch as Record<string, unknown>, op, example.id, ['code']);
        target.updatedAt = new Date(op.ts).toISOString();
        break;
      }
      case 'example:remove': {
        if (!target) break;
        target.examples = target.examples.filter((item) => item.id !== op.payload.exampleId);
        target.updatedAt = new Date(op.ts).toISOString();
        break;
      }
      case 'snapshot:create': {
        if (!target) break;
        if (!target.snapshots.some((item) => item.revision === op.payload.snapshot.revision)) {
          target.snapshots.unshift(clone(op.payload.snapshot));
          target.snapshots = target.snapshots.slice(0, 12);
        }
        target.revision += 1;
        target.updatedAt = new Date(op.ts).toISOString();
        break;
      }
      case 'snapshot:remove': {
        if (!target) break;
        target.snapshots = target.snapshots.filter((item) => item.revision !== op.payload.revision);
        target.revision = Math.max(1, target.revision - 1);
        target.updatedAt = new Date(op.ts).toISOString();
        break;
      }
      case 'examples:migrate': {
        if (!target) break;
        for (const change of op.payload.changes as Array<{ exampleId: string; propertyIds: string[]; createdFromRevision: number }>) {
          const example = target.examples.find((item) => item.id === change.exampleId);
          if (!example) continue;
          example.propertyIds = change.propertyIds;
          example.createdFromRevision = change.createdFromRevision;
          example.stale = false;
          example.staleReason = '';
        }
        target.revision = Math.max(1, target.revision + (op.payload.revisionDelta ?? 1));
        target.updatedAt = new Date(op.ts).toISOString();
        break;
      }
      default:
        break;
    }
  }

  private applyPatch<T extends object>(target: T, patch: Record<string, unknown>, op: Op, targetId: string, conflictFields: string[]) {
    const record = target as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (conflictFields.includes(key) && this.isFieldBlocked(op, targetId, key)) continue;
      record[key] = value;
    }
  }

  private isFieldBlocked(op: Op, targetId: string, field: string): boolean {
    const conflict = this.conflicts.find((item) => item.targetId === targetId && item.field === field && item.options.some((option) => option.opId === op.id));
    if (!conflict) return false;
    if (conflict.winnerOpId) return conflict.winnerOpId !== op.id;
    return true;
  }

  private detectConflicts() {
    const byKey = new Map<string, Conflict>();
    for (const existing of this.conflicts) byKey.set(existing.key, existing);

    for (const op of this.ops) {
      for (const field of this.conflictFieldsOf(op)) {
        const key = `${op.componentId}:${field.targetId}:${field.field}`;
        let conflict = byKey.get(key);
        if (!conflict) {
          conflict = {
            key,
            componentId: op.componentId,
            kind: field.field === 'name' ? 'property-name' : 'example-code',
            targetId: field.targetId,
            field: field.field as 'name' | 'code',
            options: []
          };
          byKey.set(key, conflict);
        }
        if (!conflict.options.some((option) => option.opId === op.id)) {
          conflict.options.push({ opId: op.id, tabId: op.tabId, value: field.value });
        }
      }
    }

    const result: Conflict[] = [];
    for (const conflict of byKey.values()) {
      // 按值去重，每个新值保留产生它的最新操作。
      const distinct = new Map<string, ConflictOption>();
      for (const option of conflict.options) {
        const prev = distinct.get(option.value);
        if (!prev || this.opTimestamp(option.opId) > this.opTimestamp(prev.opId)) distinct.set(option.value, option);
      }
      const options = [...distinct.values()];
      if (options.length < 2) continue;
      const hasConcurrentPair = options.some((a, i) => options.some((b, j) => i < j && this.areConcurrent(a.opId, b.opId)));
      if (!hasConcurrentPair) continue;
      conflict.options = options;
      result.push(conflict);
    }
    // 冲突解决以操作形式同步：任一标签页选择后，所有标签页都采用该结果。
    for (const op of this.ops) {
      if (op.type !== 'conflict:resolve') continue;
      const conflict = result.find((item) => item.key === op.payload.key);
      if (conflict && conflict.options.some((option) => option.opId === op.payload.winnerOpId)) {
        conflict.winnerOpId = op.payload.winnerOpId;
      }
    }
    this.conflicts = result;
  }

  private conflictFieldsOf(op: Op): Array<{ targetId: string; field: 'name' | 'code'; value: string }> {
    if (op.type === 'property:update' && typeof op.payload.patch?.name === 'string') {
      return [{ targetId: op.payload.propertyId, field: 'name', value: op.payload.patch.name }];
    }
    if (op.type === 'example:update' && typeof op.payload.patch?.code === 'string') {
      return [{ targetId: op.payload.exampleId, field: 'code', value: op.payload.patch.code }];
    }
    return [];
  }

  opTimestamp(opId: string): number {
    return this.ops.find((op) => op.id === opId)?.ts ?? 0;
  }

  private areConcurrent(aId: string, bId: string): boolean {
    if (aId === bId) return false;
    const a = this.ops.find((op) => op.id === aId);
    const b = this.ops.find((op) => op.id === bId);
    if (!a || !b) return false;
    return !a.seen.includes(bId) && !b.seen.includes(aId);
  }

  private load(): { ops: Op[]; baseState?: WorkspaceState } {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { ops?: Op[]; baseState?: WorkspaceState } | WorkspaceState;
        if (Array.isArray((parsed as { ops?: Op[] }).ops)) {
          const newFormat = parsed as { ops: Op[]; baseState?: WorkspaceState };
          if (newFormat.baseState && Array.isArray(newFormat.baseState.components)) {
            return { ops: newFormat.ops, baseState: newFormat.baseState };
          }
          return { ops: newFormat.ops };
        }
        // 兼容旧版整体状态格式：作为基线载入，后续编辑以操作日志追加。
        if (Array.isArray((parsed as WorkspaceState).components)) return { ops: [], baseState: parsed as WorkspaceState };
      }
    } catch {
      // 本地数据损坏时回退到内置示例。
    }
    return { ops: [] };
  }

  private persist() {
    try {
      // 写入前合并本地存储中其他标签页已保存的操作，避免后保存的页面覆盖先保存的内容。
      let stored: Op[] = [];
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { ops?: Op[] };
          if (Array.isArray(parsed.ops)) stored = parsed.ops;
        }
      } catch {
        // 读取失败时仅写入本标签页的操作。
      }
      const merged = new Map<string, Op>();
      for (const op of stored) merged.set(op.id, op);
      for (const op of this.ops) merged.set(op.id, op);
      const ops = [...merged.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        ops,
        baseState: { components: this.baseComponents, selectedId: this.selectedId }
      }));
    } catch {
      // 存储不可用时仅保留内存中的合并结果。
    }
  }

  private emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}

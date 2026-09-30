import type {
  ComponentExample,
  ComponentSnapshot,
  ComponentSpec,
  ConflictOption,
  ConflictTargetKind,
  MergeConflict,
  PropertySpec,
  SpecOp,
  WorkspaceState
} from './types';

// ── 操作排序 ───────────────────────────────────────────────────
// 时间戳为全局基准，同标签页的 seq 保证快速连排不乱序，
// 最后以操作 id 兜底，保证任意标签页重放顺序完全一致。
export const compareOps = (a: SpecOp, b: SpecOp): number =>
  a.ts - b.ts || a.seq - b.seq || (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const sortOps = (ops: SpecOp[]): SpecOp[] => [...ops].sort(compareOps);

/** 相同 id 的操作无论从哪个标签页到达多少次，只处理一遍。 */
export const dedupeOps = (ops: SpecOp[]): SpecOp[] => {
  const seen = new Set<string>();
  return ops.filter((op) => {
    if (seen.has(op.id)) return false;
    seen.add(op.id);
    return true;
  });
};

// ── 冲突推导的内部记录 ─────────────────────────────────────────
interface FieldWrite {
  kind: 'update' | 'resolve';
  value: unknown;
  tabId: string;
  ts: number;
  seq: number;
  opId: string;
  base: unknown;
}

interface FieldTrace {
  kind: ConflictTargetKind;
  componentId: string;
  targetId: string;
  field: string;
  /** 该字段按全局顺序发生过的全部写入（编辑与冲突解决）。 */
  writes: FieldWrite[];
}

const CONTRACT_STALE_REASON = '组件交互或属性契约已修改，示例需要重新验证。';
const deletedPropertyReason = (name: string) => `属性 ${name} 已删除，示例代码或说明仍可能引用它。`;

const isContractPatch = (patch: Record<string, unknown>): boolean =>
  'interactionSignature' in patch || 'keyboardBehavior' in patch;

const markExamplesStale = (component: ComponentSpec, reason: string, filter?: (example: ComponentExample) => boolean) => {
  component.examples.forEach((example) => {
    if (filter && !filter(example)) return;
    example.stale = true;
    example.staleReason = reason;
  });
};

const traceKey = (kind: ConflictTargetKind, componentId: string, targetId: string, field: string) =>
  `${kind}:${componentId}:${targetId}:${field}`;

const conflictKey = (componentId: string, targetId: string, field: string) => `${componentId}:${targetId}:${field}`;

const FIELD_LABELS: Record<string, string> = {
  // 组件
  name: '组件名称', category: '分类', status: '状态', purpose: '用途', usage: '使用规则',
  states: '状态说明', keyboardBehavior: '键盘行为', screenReader: '读屏说明',
  disabledScenarios: '禁用场景', interactionSignature: '交互签名',
  // 属性
  type: '属性类型', required: '是否必填', defaultValue: '默认值', description: '属性说明',
  // 示例
  title: '示例标题', code: '示例代码', propertyIds: '依赖属性'
};

interface ReduceContext {
  traces: Map<string, FieldTrace>;
}

const recordWrite = (
  ctx: ReduceContext,
  kind: ConflictTargetKind,
  componentId: string,
  targetId: string,
  field: string,
  op: SpecOp,
  value: unknown,
  base: unknown
) => {
  const key = traceKey(kind, componentId, targetId, field);
  let trace = ctx.traces.get(key);
  if (!trace) {
    trace = { kind, componentId, targetId, field, writes: [] };
    ctx.traces.set(key, trace);
  }
  trace.writes.push({
    kind: op.type === 'conflict.resolve' ? 'resolve' : 'update',
    value,
    tabId: op.tabId,
    ts: op.ts,
    seq: op.seq,
    opId: op.id,
    base
  });
};

/** 编辑操作的 base 既可能是整份 patch（{ 字段: 旧值 }），也可能直接是该字段的旧值。 */
const fieldBase = (op: SpecOp, field: string): unknown => {
  if (op.base && typeof op.base === 'object' && field in (op.base as Record<string, unknown>)) {
    return (op.base as Record<string, unknown>)[field];
  }
  return op.base;
};

const stamp = (component: ComponentSpec, op: SpecOp) => {
  component.updatedAt = new Date(op.ts).toISOString();
};

const applyOp = (state: WorkspaceState, op: SpecOp, ctx: ReduceContext): void => {
  const payload = (op.payload ?? {}) as Record<string, unknown>;
  const componentId = String(payload.componentId ?? '');
  const component = state.components.find((item) => item.id === componentId);

  switch (op.type) {
    case 'component.add': {
      const fresh = payload.component as ComponentSpec;
      fresh.updatedAt = new Date(op.ts).toISOString();
      const index = state.components.findIndex((item) => item.id === fresh.id);
      if (index >= 0) state.components[index] = fresh;
      else state.components.push(fresh);
      return;
    }
    case 'component.remove': {
      state.components = state.components.filter((item) => item.id !== componentId);
      if (state.selectedId === componentId) state.selectedId = state.components[0]?.id ?? '';
      return;
    }
    case 'component.update': {
      if (!component) return;
      const patch = payload.patch as Partial<ComponentSpec>;
      for (const [field, value] of Object.entries(patch)) {
        // snapshots 等数组字段不参与逐字段冲突检测。
        if (field === 'properties' || field === 'examples' || field === 'snapshots' || field === 'revision') continue;
        (component as unknown as Record<string, unknown>)[field] = value;
        recordWrite(ctx, 'component', component.id, component.id, field, op, value, fieldBase(op, field));
      }
      stamp(component, op);
      if (isContractPatch(patch)) markExamplesStale(component, CONTRACT_STALE_REASON);
      return;
    }
    case 'property.add': {
      if (!component) return;
      const property = payload.property as PropertySpec;
      if (!component.properties.some((item) => item.id === property.id)) component.properties.push(property);
      stamp(component, op);
      return;
    }
    case 'property.remove': {
      if (!component) return;
      const propertyId = String(payload.propertyId ?? '');
      const property = component.properties.find((item) => item.id === propertyId);
      if (!property) return;
      component.properties = component.properties.filter((item) => item.id !== propertyId);
      markExamplesStale(component, deletedPropertyReason(property.name), (example) =>
        example.propertyIds.includes(propertyId) || example.code.includes(property.name));
      stamp(component, op);
      return;
    }
    case 'property.update': {
      if (!component) return;
      const propertyId = String(payload.propertyId ?? '');
      const property = component.properties.find((item) => item.id === propertyId);
      if (!property) return;
      const patch = payload.patch as Partial<PropertySpec>;
      for (const [field, value] of Object.entries(patch)) {
        (property as unknown as Record<string, unknown>)[field] = value;
        recordWrite(ctx, 'property', component.id, property.id, field, op, value, fieldBase(op, field));
      }
      stamp(component, op);
      // 属性契约更新后，依赖它的示例立即失效。
      if ('name' in patch || 'required' in patch || 'type' in patch) {
        markExamplesStale(component, CONTRACT_STALE_REASON, (example) => example.propertyIds.includes(propertyId));
      }
      return;
    }
    case 'example.add': {
      if (!component) return;
      const example = payload.example as ComponentExample;
      if (!component.examples.some((item) => item.id === example.id)) component.examples.push(example);
      stamp(component, op);
      return;
    }
    case 'example.remove': {
      if (!component) return;
      const exampleId = String(payload.exampleId ?? '');
      if (!component.examples.some((item) => item.id === exampleId)) return;
      component.examples = component.examples.filter((item) => item.id !== exampleId);
      stamp(component, op);
      return;
    }
    case 'example.update': {
      if (!component) return;
      const exampleId = String(payload.exampleId ?? '');
      const example = component.examples.find((item) => item.id === exampleId);
      if (!example) return;
      const patch = payload.patch as Partial<ComponentExample>;
      for (const [field, value] of Object.entries(patch)) {
        if (field === 'stale' || field === 'staleReason' || field === 'createdFromRevision') continue;
        (example as unknown as Record<string, unknown>)[field] = value;
        recordWrite(ctx, 'example', component.id, example.id, field, op, value, fieldBase(op, field));
      }
      stamp(component, op);
      return;
    }
    case 'conflict.resolve': {
      const key = String(payload.key ?? '');
      const trace = [...ctx.traces.values()].find((item) => conflictKey(item.componentId, item.targetId, item.field) === key);
      if (!trace) return;
      recordWrite(ctx, trace.kind, trace.componentId, trace.targetId, trace.field, op, payload.value, undefined);
      const target =
        trace.kind === 'component'
          ? state.components.find((item) => item.id === trace.componentId)
          : trace.kind === 'property'
            ? state.components.find((item) => item.id === trace.componentId)?.properties.find((item) => item.id === trace.targetId)
            : state.components.find((item) => item.id === trace.componentId)?.examples.find((item) => item.id === trace.targetId);
      if (target) (target as unknown as Record<string, unknown>)[trace.field] = payload.value;
      const resolvedComponent = state.components.find((item) => item.id === trace.componentId);
      if (resolvedComponent) stamp(resolvedComponent, op);
      return;
    }
    case 'snapshot.create': {
      if (!component) return;
      const reason = String(payload.reason ?? '手动版本');
      const snapComponent = payload.component as Omit<ComponentSpec, 'snapshots'>;
      const snapshot: ComponentSnapshot = {
        revision: snapComponent.revision,
        savedAt: new Date(op.ts).toISOString(),
        reason,
        component: snapComponent
      };
      component.snapshots.unshift(snapshot);
      component.snapshots = component.snapshots.slice(0, 12);
      component.revision = snapComponent.revision + 1;
      stamp(component, op);
      return;
    }
    case 'examples.migrate': {
      if (!component) return;
      const activePropertyIds = new Set(component.properties.map((item) => item.id));
      component.examples.forEach((example) => {
        example.propertyIds = example.propertyIds.filter((id) => activePropertyIds.has(id));
        example.stale = false;
        example.staleReason = '';
        example.createdFromRevision = component.revision;
      });
      component.revision += 1;
      stamp(component, op);
      return;
    }
  }
};

export interface ReducedState {
  state: WorkspaceState;
  conflicts: MergeConflict[];
}

/**
 * 从基线出发，按全局顺序重放去重后的操作日志。
 * 任何标签页调用都会得到相同的合并结果；冲突在重放时顺带推导。
 */
export function reduceOps(baseline: WorkspaceState, rawOps: SpecOp[]): ReducedState {
  const state: WorkspaceState = structuredClone(baseline);
  const ctx: ReduceContext = { traces: new Map() };
  const ops = sortOps(dedupeOps(rawOps));
  for (const op of ops) applyOp(state, op, ctx);
  if (!state.components.some((item) => item.id === state.selectedId)) {
    state.selectedId = state.components[0]?.id ?? '';
  }
  return { state, conflicts: deriveConflicts(state, baseline, ctx) };
}

const readBaselineField = (
  baseline: WorkspaceState,
  kind: ConflictTargetKind,
  componentId: string,
  targetId: string,
  field: string
): unknown => {
  const component = baseline.components.find((item) => item.id === componentId);
  if (!component) return undefined;
  if (kind === 'component') return (component as unknown as Record<string, unknown>)[field];
  if (kind === 'property') return component.properties.find((item) => item.id === targetId)?.[field as keyof PropertySpec];
  return component.examples.find((item) => item.id === targetId)?.[field as keyof ComponentExample];
};

/**
 * 冲突判定（每个被编辑的字段独立推导）：
 * 沿全局写入顺序扫描，维护字段“当前权威值”。
 * - 编辑基于的旧值等于当前权威值：正常的最新写入获胜，不打扰维护者。
 * - 旧值不等于当前权威值（说明另一个标签页已经改成新值）：
 *   · 新值与权威值相同 → 双方一致，自动合并；
 *   · 新值与权威值不同 → 同一属性/同一条示例出现了两个新值，登记冲突让人选择。
 * - 人工解决后以所选值作为新的权威值，冲突关闭；之后再出现分叉会重新登记。
 * 其他字段（不同属性名、不同示例、概述/分类等）互不阻塞，直接合并。
 */
function deriveConflicts(finalState: WorkspaceState, baseline: WorkspaceState, ctx: ReduceContext): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  // 只有“同一属性的字段”与“同一条示例的代码”分叉才需要人工选择；
  // 组件概述、示例标题等其他改动按全局顺序直接合并。
  const isConflictedField = (trace: FieldTrace): boolean =>
    trace.kind === 'property' || (trace.kind === 'example' && trace.field === 'code');
  const targetExists = (trace: FieldTrace): boolean => {
    const component = finalState.components.find((item) => item.id === trace.componentId);
    if (!component) return false;
    if (trace.kind === 'component') return true;
    if (trace.kind === 'property') return component.properties.some((item) => item.id === trace.targetId);
    return component.examples.some((item) => item.id === trace.targetId);
  };
  for (const trace of ctx.traces.values()) {
    if (!isConflictedField(trace) || !targetExists(trace)) continue;
    // 每个标签页“以为”的当前值；分叉冲突 = 写入 base 与全局权威不一致，
    // 且新值也不同于权威。resolve 会把所有标签页的认知统一到所选值。
    let current = readBaselineField(baseline, trace.kind, trace.componentId, trace.targetId, trace.field);
    let authorityOwner: FieldWrite | null = null;
    let pendingOwner: FieldWrite | null = null;
    let pendingParticipants = new Map<string, FieldWrite>();

    for (const write of trace.writes) {
      if (write.kind === 'resolve') {
        current = write.value;
        authorityOwner = write;
        pendingOwner = null;
        pendingParticipants = new Map();
        continue;
      }
      const baseMatches = JSON.stringify(write.base) === JSON.stringify(current);
      if (baseMatches) {
        // 基于权威值的写入直接成为新权威；同标签页的连续编辑刷新其候选，
        // 其他标签页已登记的分叉仍然挂起。
        current = write.value;
        authorityOwner = write;
        if (pendingOwner) {
          if (write.tabId === pendingOwner.tabId) {
            pendingOwner = write;
            pendingParticipants.set(write.tabId, write);
          } else if (write.tabId !== pendingOwner.tabId && pendingParticipants.has(write.tabId)) {
            // 分叉标签页基于最新权威继续编辑，代表它已经看到并接受了新值：取消它的分叉。
            pendingParticipants.delete(write.tabId);
            if (pendingParticipants.size <= 1) {
              pendingOwner = null;
              pendingParticipants = new Map();
            }
          }
        }
        continue;
      }
      // 基于过期值的写入（另一个标签页已经先改过）。
      if (JSON.stringify(write.value) === JSON.stringify(current)) {
        // 改成了同一个值，自动合并；若该标签页是分叉方，分叉消失。
        if (pendingParticipants.has(write.tabId)) {
          pendingParticipants.delete(write.tabId);
          if (pendingParticipants.size <= 1) {
            pendingOwner = null;
            pendingParticipants = new Map();
          }
        }
        continue;
      }
      // 与权威值分叉：权威归属为一方，当前写入为另一方。
      if (!authorityOwner) continue; // 过期写入前必有一次权威写入。
      if (!pendingOwner) {
        const participants = new Map<string, FieldWrite>();
        participants.set(authorityOwner.tabId, authorityOwner);
        participants.set(write.tabId, write);
        pendingOwner = authorityOwner;
        pendingParticipants = participants;
      } else if (write.tabId !== pendingOwner.tabId) {
        pendingParticipants.set(write.tabId, write);
      }
    }

    if (!pendingOwner) continue;
    const candidates = [pendingOwner, ...pendingParticipants.values()].filter(
      (write, index, all) => index === all.findIndex((item) => item.tabId === write.tabId)
    );
    const distinct = new Set(candidates.map((write) => JSON.stringify(write.value)));
    if (candidates.length < 2 || distinct.size < 2) continue;
    const options: ConflictOption[] = candidates
      .sort((a, b) => a.ts - b.ts || a.seq - b.seq || (a.opId < b.opId ? -1 : 1))
      .map((write) => ({ value: write.value, tabId: write.tabId, ts: write.ts, opId: write.opId }));
    conflicts.push({
      key: conflictKey(trace.componentId, trace.targetId, trace.field),
      kind: trace.kind,
      componentId: trace.componentId,
      targetId: trace.targetId,
      field: trace.field,
      label: FIELD_LABELS[trace.field] ?? trace.field,
      options
    });
  }
  return conflicts;
}

export type ComponentStatus = 'draft' | 'review' | 'published';
export type PreviewTheme = 'light' | 'dark';
export type PreviewDensity = 'compact' | 'regular' | 'spacious';

export interface PropertySpec {
  id: string;
  name: string;
  type: string;
  required: boolean;
  defaultValue: string;
  description: string;
}

export interface ComponentExample {
  id: string;
  title: string;
  code: string;
  propertyIds: string[];
  stale: boolean;
  staleReason: string;
  createdFromRevision: number;
}

export interface ComponentSpec {
  id: string;
  name: string;
  category: string;
  status: ComponentStatus;
  purpose: string;
  usage: string;
  properties: PropertySpec[];
  states: string;
  keyboardBehavior: string;
  screenReader: string;
  disabledScenarios: string;
  interactionSignature: string;
  examples: ComponentExample[];
  revision: number;
  updatedAt: string;
  snapshots: ComponentSnapshot[];
}

export interface ComponentSnapshot {
  revision: number;
  savedAt: string;
  reason: string;
  component: Omit<ComponentSpec, 'snapshots'>;
}

export interface WorkspaceState {
  components: ComponentSpec[];
  selectedId: string;
}

export interface ValidationIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  componentId: string;
  target: string;
  message: string;
  field: 'properties' | 'examples' | 'keyboard' | 'screenReader';
}

export interface DiffRow {
  field: string;
  before: string;
  after: string;
}

// ── 跨标签页协作：可重放的顺序操作 ──────────────────────────────

export type OpType =
  | 'component.add'
  | 'component.remove'
  | 'component.update'
  | 'property.add'
  | 'property.remove'
  | 'property.update'
  | 'example.add'
  | 'example.remove'
  | 'example.update'
  | 'conflict.resolve'
  | 'snapshot.create'
  | 'examples.migrate';

/** 同一条属性（字段）或同一条示例代码（字段）的归属。 */
export type ConflictTargetKind = 'component' | 'property' | 'example';

export interface SpecOp {
  /** 全局唯一；相同 id 的操作无论到达多少次只处理一遍。 */
  id: string;
  type: OpType;
  /** 发起操作的标签页，冲突选择时展示来源。 */
  tabId: string;
  /** 毫秒时间戳，操作的全局排序基准。 */
  ts: number;
  /** 同一标签页内严格递增，保证快速连续编辑的顺序确定。 */
  seq: number;
  /** 编辑前该字段的值，用于识别“同一属性/示例出现两个新值”的分叉。 */
  base?: unknown;
  /** 冲突解决的目标键，解决前的所有分叉按此键归并关闭。 */
  resolveKey?: string;
  payload?: Record<string, unknown>;
}

export interface ConflictOption {
  value: unknown;
  tabId: string;
  ts: number;
  opId: string;
}

export interface MergeConflict {
  /** target 字段标识，如 componentId:propertyId:field。 */
  key: string;
  kind: ConflictTargetKind;
  componentId: string;
  targetId: string;
  field: string;
  label: string;
  options: ConflictOption[];
}

/** 本地持久化的不是某个标签页的状态快照，而是操作日志与重放基线。 */
export interface OperationEnvelope {
  version: 2;
  baseline: WorkspaceState;
  ops: SpecOp[];
}

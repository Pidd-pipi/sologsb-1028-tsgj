// 冒烟测试：验证多标签页合并、冲突检测、幂等与失效传播。
// 运行：npx tsx test/merge.test.ts
import { SpecStore } from '../src/store';

// ---- 浏览器环境垫片 ----
const memory = new Map<string, string>();
const listeners = new Map<string, Set<(event: any) => void>>();

const localStorageShim = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); }
};

const windowShim = {
  addEventListener: (type: string, handler: (event: any) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(handler);
  },
  removeEventListener: (type: string, handler: (event: any) => void) => {
    listeners.get(type)?.delete(handler);
  }
};

const documentShim = {
  visibilityState: 'visible',
  addEventListener: (type: string, handler: (event: any) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(handler);
  },
  removeEventListener: (type: string, handler: (event: any) => void) => {
    listeners.get(type)?.delete(handler);
  }
};

(globalThis as any).localStorage = localStorageShim;
(globalThis as any).window = windowShim;
(globalThis as any).document = documentShim;

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

function flushStorageEvent(key: string) {
  const handlers = listeners.get('storage');
  if (!handlers) return;
  for (const handler of [...handlers]) handler({ key });
}

// ---- 场景 1：两个标签页并发编辑同一属性名 → 冲突 ----
console.log('\n场景 1：并发编辑同一属性名产生冲突');
memory.clear();
const tabA = new SpecStore();
const tabB = new SpecStore();
tabA.select('button-spec');
tabB.select('button-spec');

const propId = tabA.selected!.properties[0].id;
tabA.updateProperty(propId, { name: 'buttonLabel' });
tabB.updateProperty(propId, { name: 'labelText' });

// B 的操作写入 localStorage，A 通过 storage 事件合并
flushStorageEvent('sologsb-1028-workspace-v1');

const conflictsA = tabA.conflictsFor('button-spec');
assert(conflictsA.length === 1, 'A 检测到 1 个属性名冲突');
assert(conflictsA[0]?.kind === 'property-name', '冲突类型为 property-name');
assert(conflictsA[0]?.options.length === 2, '冲突包含 2 个候选值');
assert(conflictsA[0]?.options.some((o) => o.value === 'buttonLabel'), '候选包含 buttonLabel');
assert(conflictsA[0]?.options.some((o) => o.value === 'labelText'), '候选包含 labelText');
// 冲突字段在选择前不应被任意一方覆盖
const nameBeforeResolve = tabA.selected!.properties.find((p) => p.id === propId)?.name;
assert(nameBeforeResolve !== 'buttonLabel' && nameBeforeResolve !== 'labelText', '冲突字段在解决前保持挂起');

// A 选择保留 B 的值
const winner = conflictsA[0]!.options.find((o) => o.value === 'labelText')!;
tabA.resolveConflict(conflictsA[0]!.key, winner.opId);
const nameAfterResolve = tabA.selected!.properties.find((p) => p.id === propId)?.name;
assert(nameAfterResolve === 'labelText', '解决后属性名为所选值 labelText');

// ---- 场景 2：非冲突改动直接合并 ----
console.log('\n场景 2：非冲突改动直接合并');
memory.clear();
const storeA = new SpecStore();
const storeB = new SpecStore();
storeA.select('button-spec');
storeB.select('button-spec');

const prop2 = storeA.selected!.properties[0].id;
storeA.updateProperty(prop2, { name: 'mergedName' });
storeB.updateProperty(prop2, { description: 'B 补充的描述' });
flushStorageEvent('sologsb-1028-workspace-v1');

const mergedProp = storeA.selected!.properties.find((p) => p.id === prop2);
assert(mergedProp?.name === 'mergedName', 'A 的属性名改动已合并');
assert(mergedProp?.description === 'B 补充的描述', 'B 的描述改动已合并');

// ---- 场景 3：同一操作重复到达只处理一遍 ----
console.log('\n场景 3：幂等去重');
memory.clear();
const s1 = new SpecStore();
s1.select('button-spec');
const beforeCount = s1.selected!.properties.length;
s1.addProperty();
const afterFirst = s1.selected!.properties.length;
assert(afterFirst === beforeCount + 1, '新增属性后数量 +1');
// 手动把同一份 ops 再写回 localStorage 并触发多次同步
const raw = memory.get('sologsb-1028-workspace-v1')!;
for (let i = 0; i < 3; i++) {
  memory.set('sologsb-1028-workspace-v1', raw);
  flushStorageEvent('sologsb-1028-workspace-v1');
}
const afterReplay = s1.selected!.properties.length;
assert(afterReplay === afterFirst, '重复同步同一操作不会重复新增属性');

// ---- 场景 4：属性契约变更使依赖示例立即失效 ----
console.log('\n场景 4：契约变更使依赖示例失效');
memory.clear();
const t1 = new SpecStore();
t1.select('button-spec');
const example = t1.selected!.examples[0];
assert(example.stale === false, '示例初始未失效');
const labelProp = t1.selected!.properties.find((p) => p.name === 'label')!;
t1.updateProperty(labelProp.id, { required: false });
const exampleAfter = t1.selected!.examples.find((e) => e.id === example.id);
assert(exampleAfter?.stale === true, '依赖示例在属性契约变更后立即失效');
assert(!!exampleAfter?.staleReason, '失效原因已记录');

// ---- 场景 5：示例代码冲突 ----
console.log('\n场景 5：同一条示例代码冲突');
memory.clear();
const c1 = new SpecStore();
const c2 = new SpecStore();
c1.select('button-spec');
c2.select('button-spec');
const exId = c1.selected!.examples[0].id;
c1.updateExample(exId, { code: '<sp-button>保存</sp-button>' });
c2.updateExample(exId, { code: '<sp-button>取消</sp-button>' });
flushStorageEvent('sologsb-1028-workspace-v1');
const codeConflicts = c1.conflictsFor('button-spec');
assert(codeConflicts.length === 1 && codeConflicts[0]?.kind === 'example-code', '检测到 1 个示例代码冲突');
assert(codeConflicts[0]?.options.length === 2, '代码冲突包含 2 个候选');

// ---- 场景 6：本地保存读取合并后内容 ----
console.log('\n场景 6：目录、检查、版本读取合并后内容');
memory.clear();
const w1 = new SpecStore();
w1.select('button-spec');
w1.updateComponent({ purpose: '合并后的用途说明' });
flushStorageEvent('sologsb-1028-workspace-v1');
const issues = w1.validate();
assert(Array.isArray(issues), '检查基于合并后内容运行');
const persisted = JSON.parse(memory.get('sologsb-1028-workspace-v1')!);
assert(Array.isArray(persisted.ops) && persisted.ops.length > 0, '本地保存写入操作日志');
const reloaded = new SpecStore();
const reloadedPurpose = reloaded.selected?.purpose;
assert(reloadedPurpose === '合并后的用途说明', '刷新后从日志重放得到合并内容');

// ---- 场景 7：冲突解决跨标签页同步 ----
console.log('\n场景 7：冲突解决跨标签页同步');
memory.clear();
const r1 = new SpecStore();
const r2 = new SpecStore();
r1.select('button-spec');
r2.select('button-spec');
const rp = r1.selected!.properties[0].id;
r1.updateProperty(rp, { name: 'resolveA' });
r2.updateProperty(rp, { name: 'resolveB' });
flushStorageEvent('sologsb-1028-workspace-v1');
const r1Conflicts = r1.conflictsFor('button-spec');
assert(r1Conflicts.length === 1, 'A 检测到冲突');
const r2ConflictsBefore = r2.conflictsFor('button-spec');
assert(r2ConflictsBefore.length === 1, 'B 也检测到冲突');
// A 选择 resolveB
const r1Winner = r1Conflicts[0]!.options.find((o) => o.value === 'resolveB')!;
r1.resolveConflict(r1Conflicts[0]!.key, r1Winner.opId);
// B 同步 A 的解决操作
flushStorageEvent('sologsb-1028-workspace-v1');
const r2ConflictsAfter = r2.conflictsFor('button-spec');
assert(r2ConflictsAfter.length === 0, 'B 同步后冲突已解决');
const r2Name = r2.selected!.properties.find((p) => p.id === rp)?.name;
assert(r2Name === 'resolveB', 'B 采用了 A 的选择');

// ---- 场景 8：旧版整体状态格式迁移 ----
console.log('\n场景 8：旧版本地数据迁移');
memory.clear();
const legacyState = {
  components: [
    {
      id: 'legacy-comp',
      name: '旧版组件',
      category: 'Legacy',
      status: 'draft',
      purpose: '旧版用途',
      usage: '',
      properties: [],
      states: '',
      keyboardBehavior: '',
      screenReader: '',
      disabledScenarios: '',
      interactionSignature: '',
      examples: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
      snapshots: []
    }
  ],
  selectedId: 'legacy-comp'
};
memory.set('sologsb-1028-workspace-v1', JSON.stringify(legacyState));
const migrated = new SpecStore();
assert(migrated.state.components.length === 1, '旧版数据作为基线载入');
assert(migrated.state.components[0]?.name === '旧版组件', '旧版组件名称保留');
assert(migrated.state.selectedId === 'legacy-comp', '旧版选中项保留');
// 迁移后的编辑以操作日志追加
migrated.updateComponent({ purpose: '新用途' });
const reloadedLegacy = new SpecStore();
assert(reloadedLegacy.state.components[0]?.purpose === '新用途', '迁移后编辑以操作日志重放');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);

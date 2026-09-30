// 双标签页 SpecStore 集成验证：共享 localStorage 垫片 + storage 事件异步转发（与浏览器一致）。
import { SpecStore } from '../src/store.ts';

const assert = (cond, message) => {
  if (!cond) { console.error('FAIL:', message); process.exitCode = 1; }
  else console.log('PASS:', message);
};

// ── 浏览器环境垫片 ─────────────────────────────────────────────
class FakeWindow {
  listeners = new Map();
  addEventListener(type, fn) {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, event) { this.listeners.get(type)?.forEach((fn) => fn(event)); }
}
class FakeStorage {
  map = new Map();
  windows = [];
  register(w) { this.windows.push(w); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    const old = this.map.get(key) ?? null;
    this.map.set(key, value);
    const writer = currentWriter;
    // storage 事件异步投递给其他标签页，模拟真实浏览器时序。
    for (const w of this.windows) {
      if (w !== writer) setTimeout(() => w.dispatch('storage', { key, oldValue: old, newValue: value }), 0);
    }
  }
}
let currentWriter = null;
const storage = new FakeStorage();
const windows = [new FakeWindow(), new FakeWindow()];
windows.forEach((w) => storage.register(w));
const stores = [];
for (const w of windows) {
  globalThis.window = w;
  globalThis.localStorage = storage;
  stores.push(new SpecStore(w));
}
globalThis.window = windows[0];
const [storeA, storeB] = stores;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const inTab = async (w, fn) => { currentWriter = w; fn(); currentWriter = null; await tick(); await tick(); };

const buttonId = 'button-spec';
const labelProp = 'p-label';
const getProp = (store, id = labelProp) =>
  store.state.components.find((c) => c.id === buttonId).properties.find((p) => p.id === id);

// 初始：两页都读到内置数据。
assert(storeA.state.components.length === 3 && storeB.state.components.length === 3, '两标签页初始内容一致');
assert(storeA.conflicts.length === 0 && storeB.conflicts.length === 0, '初始无冲突');

// A 改属性说明 → B 通过 storage 事件自动合并。
await inTab(windows[0], () => {
  storeA.select(buttonId);
  storeA.updateProperty(labelProp, { description: 'A 标签页修改的说明' });
});
assert(getProp(storeB).description === 'A 标签页修改的说明', 'A 页编辑通过操作日志自动合并到 B 页（目录读取合并内容）');

// B 基于合并后的值接力修改 → 线性历史，无冲突。
await inTab(windows[1], () => {
  storeB.select(buttonId);
  storeB.updateProperty(labelProp, { description: 'B 页接力修改' });
});
assert(storeA.conflicts.length === 0 && storeB.conflicts.length === 0, '基于最新值的接力编辑不产生冲突');
assert(getProp(storeA).description === 'B 页接力修改', 'B 页接力修改同步回 A 页');

// 模拟“离线分叉”：两页在 storage 事件到达前，都基于旧值“保存”改成不同新值。
// 先让双方回到同一已知基线。
await inTab(windows[0], () => storeA.updateProperty(labelProp, { defaultValue: '保存-基线' }));
assert(getProp(storeA).defaultValue === '保存-基线' && getProp(storeB).defaultValue === '保存-基线', '分叉前两页基线一致');

// 同步发起两次编辑（不 await），storage 事件尚未投递，双方 base 都是“保存-基线”。
currentWriter = windows[0];
storeA.updateProperty(labelProp, { defaultValue: '提交' });
currentWriter = windows[1];
storeB.updateProperty(labelProp, { defaultValue: '确认' });
currentWriter = null;
await tick(); await tick();
assert(storeB.conflicts.length === 1, '同属性默认值两个新值 → B 页出现冲突');
assert(storeA.conflicts.length === 1, '冲突通过日志同步，A 页也出现同一冲突');
const conflict = storeA.conflicts[0];
assert(conflict.options.map((o) => o.value).sort().join('/') === '提交/确认', '冲突包含双方的新值');

// B 选择“确认” → 解决操作同步，A/B 都关闭冲突。
await inTab(windows[1], () => storeB.resolveConflict(storeB.conflicts[0], '确认'));
assert(storeA.conflicts.length === 0 && storeB.conflicts.length === 0, '选择后两页冲突同时关闭');
assert(getProp(storeA).defaultValue === '确认' && getProp(storeB).defaultValue === '确认', '所选值成为两页一致的合并内容');

// 同一操作重复投递只处理一遍（通过 storage 再次收到同样的日志）。
const beforeCount = JSON.parse(storage.getItem('sologsb-1028-workspace-v2')).ops.length;
windows[1].dispatch('storage', { key: 'sologsb-1028-workspace-v2', newValue: storage.getItem('sologsb-1028-workspace-v2') });
await tick();
assert(storeB.conflicts.length === 0, '重放整份日志不产生新冲突');
const afterCount = JSON.parse(storage.getItem('sologsb-1028-workspace-v2')).ops.length;
assert(beforeCount === afterCount, '重复到达的同一操作只处理一遍');

// 撤销：A 做一次新编辑再撤销，逆操作通过日志同步给 B，两页一致且无伪冲突。
const descAtUndoStart = getProp(storeA).description;
await inTab(windows[0], () => storeA.updateProperty(labelProp, { description: 'A 撤销前临时说明' }));
assert(getProp(storeB).description === 'A 撤销前临时说明', '撤销前两页同步到临时说明');
await inTab(windows[0], () => storeA.undo());
assert(getProp(storeA).description === descAtUndoStart, 'A 页撤销生效：回退到撤销前的合并值');
assert(getProp(storeA).description === getProp(storeB).description, '撤销的逆操作同步后两页结果一致');
assert(storeA.conflicts.length === 0 && storeB.conflicts.length === 0, '撤销不产生伪冲突');

// 契约更新立即失效依赖示例，检查面板读取合并状态。
await inTab(windows[0], () => storeA.updateProperty(labelProp, { required: true }));
const staleIssue = storeB.validate().some((i) => i.componentId === buttonId && i.field === 'examples');
assert(staleIssue, '属性契约更新后依赖示例失效，规范检查读取合并内容');

// 版本保存在合并内容上，两页版本号一致。
const revBefore = storeB.state.components.find((c) => c.id === buttonId).revision;
await inTab(windows[0], () => storeA.createSnapshot('集成测试保存'));
const revA = storeA.state.components.find((c) => c.id === buttonId).revision;
const revB = storeB.state.components.find((c) => c.id === buttonId).revision;
assert(revA === revBefore + 1 && revB === revA, '版本保存基于合并内容并同步两页');
assert(storeB.state.components.find((c) => c.id === buttonId).snapshots[0]?.reason === '集成测试保存', '快照内容来自合并状态');

console.log(process.exitCode ? '有失败用例' : '全部用例通过');

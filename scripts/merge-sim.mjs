// 多标签页合并场景验证：用 esbuild 把 TS 编译为 ESM 后在 Node 中重放。
import { createInitialState } from '../src/data.ts';
import { reduceOps } from '../src/merge.ts';

const assert = (cond, message) => {
  if (!cond) { console.error('FAIL:', message); process.exitCode = 1; }
  else console.log('PASS:', message);
};

const baseline = createInitialState();
const buttonId = 'button-spec';
const propId = 'p-label';
const exampleId = 'example-button-primary';

let ts = 1_000_000;
const op = (tabId, seq, type, payload, base) => ({ id: `op-${tabId}-${seq}`, type, tabId: `tab-${tabId}`, ts: ts++, seq, payload, ...(base === undefined ? {} : { base }) });

// 场景 1：两页改同一属性的不同字段 → 直接合并，无冲突。
{
  const ops = [
    op('A', 1, 'property.update', { componentId: buttonId, propertyId: propId, patch: { type: 'string | slot' } }, 'string'),
    op('B', 2, 'property.update', { componentId: buttonId, propertyId: propId, patch: { description: 'B 改的说明' } }, '按钮可见文字，同时作为无障碍名称。')
  ];
  const { state, conflicts } = reduceOps(baseline, ops);
  const prop = state.components.find((c) => c.id === buttonId).properties.find((p) => p.id === propId);
  assert(prop.type === 'string | slot', '不同字段合并：type 生效');
  assert(prop.description === 'B 改的说明', '不同字段合并：description 生效');
  assert(conflicts.length === 0, '不同字段不产生冲突');
}

// 场景 2：同一属性同一字段两个新值 → 冲突；选择后关闭。
{
  const ops = [
    op('A', 1, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: '提交' } }, '保存'),
    op('B', 2, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: '确认' } }, '保存')
  ];
  const r1 = reduceOps(baseline, ops);
  assert(r1.conflicts.length === 1, '同一属性同字段两个新值 → 1 个冲突');
  assert(r1.conflicts[0].options.length === 2, '冲突包含两个候选值');
  assert(r1.conflicts[0].options.map((o) => o.value).join('/') === '提交/确认', '候选值内容与顺序正确（按时间）');
  // 未解决时合并状态暂以后到值为准，同时冲突保持可见，等人选择。
  const prop = r1.state.components.find((c) => c.id === buttonId).properties.find((p) => p.id === propId);
  assert(prop.defaultValue === '确认', '未解决时合并状态暂取最新写入，冲突仍可见');

  // A 标签页选择“确认”（后到值）。
  const resolve = { id: 'op-resolve-1', type: 'conflict.resolve', tabId: 'tab-A', ts: ts++, seq: 9, payload: { key: r1.conflicts[0].key, value: '确认' } };
  const r2 = reduceOps(baseline, [...ops, resolve]);
  assert(r2.conflicts.length === 0, '选择后冲突关闭');
  const prop2 = r2.state.components.find((c) => c.id === buttonId).properties.find((p) => p.id === propId);
  assert(prop2.defaultValue === '确认', '所选值生效');
}

// 场景 3：同一条示例代码两个新值 → 冲突；改成相同值 → 自动合并。
{
  const diverging = [
    op('A', 1, 'example.update', { componentId: buttonId, exampleId, patch: { code: '<sp-button>AAA</sp-button>' } }, '<sp-button variant="accent">保存</sp-button>'),
    op('B', 2, 'example.update', { componentId: buttonId, exampleId, patch: { code: '<sp-button>BBB</sp-button>' } }, '<sp-button variant="accent">保存</sp-button>')
  ];
  const r1 = reduceOps(baseline, diverging);
  assert(r1.conflicts.some((c) => c.kind === 'example' && c.field === 'code'), '同一条示例代码两个新值 → 冲突');

  const converging = [
    op('A', 1, 'example.update', { componentId: buttonId, exampleId, patch: { code: 'SAME' } }, '<sp-button variant="accent">保存</sp-button>'),
    op('B', 2, 'example.update', { componentId: buttonId, exampleId, patch: { code: 'SAME' } }, '<sp-button variant="accent">保存</sp-button>')
  ];
  const r2 = reduceOps(baseline, converging);
  assert(r2.conflicts.length === 0, '两个新值相同 → 自动合并无冲突');
}

// 场景 4：示例标题等其他字段分叉不冲突，按顺序合并。
{
  const ops = [
    op('A', 1, 'example.update', { componentId: buttonId, exampleId, patch: { title: 'A 的标题' } }, '保存表单'),
    op('B', 2, 'example.update', { componentId: buttonId, exampleId, patch: { title: 'B 的标题' } }, '保存表单')
  ];
  const { state, conflicts } = reduceOps(baseline, ops);
  assert(conflicts.length === 0, '示例标题分叉不打断维护者');
  const ex = state.components.find((c) => c.id === buttonId).examples.find((e) => e.id === exampleId);
  assert(ex.title === 'B 的标题', '示例标题以后到写入为准');
}

// 场景 5：同一操作重复到达只处理一遍（去重）。
{
  const single = op('A', 1, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'X' } }, '保存');
  const { state, conflicts } = reduceOps(baseline, [single, { ...single }, { ...single }]);
  assert(conflicts.length === 0, '重复操作不产生冲突');
  assert(state.components.find((c) => c.id === buttonId).properties.find((p) => p.id === propId).defaultValue === 'X', '重复操作只生效一次');
}

// 场景 6：属性契约更新后，依赖它的示例立即失效。
{
  const variantProp = 'p-variant'; // 仅主示例依赖，禁用示例不依赖
  const ops = [
    op('A', 1, 'property.update', { componentId: buttonId, propertyId: variantProp, patch: { required: true } }, false)
  ];
  const { state } = reduceOps(baseline, ops);
  const comp = state.components.find((c) => c.id === buttonId);
  const dependent = comp.examples.find((e) => e.id === exampleId);
  const independent = comp.examples.find((e) => e.id === 'example-button-disabled');
  assert(dependent.stale === true && dependent.staleReason.length > 0, '依赖被改属性的示例立即失效');
  assert(independent.stale === false, '不依赖该属性的示例不受影响');
}

// 场景 7：删除属性后依赖示例失效；新增属性/示例与删除互不阻塞。
{
  const ops = [
    op('A', 1, 'property.add', { componentId: buttonId, property: { id: 'p-new', name: 'loading', type: 'boolean', required: false, defaultValue: 'false', description: 'x' } }),
    op('B', 2, 'property.remove', { componentId: buttonId, propertyId: 'p-disabled' })
  ];
  const { state } = reduceOps(baseline, ops);
  const comp = state.components.find((c) => c.id === buttonId);
  assert(comp.properties.some((p) => p.id === 'p-new'), '另一页新增的属性保留');
  assert(!comp.properties.some((p) => p.id === 'p-disabled'), '删除的属性消失');
  assert(comp.examples.find((e) => e.id === 'example-button-disabled').stale === true, '删除属性使依赖示例失效');
}

// 场景 8：解决冲突后再分叉 → 重新登记冲突。
{
  const ops = [
    op('A', 1, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'A1' } }, '保存'),
    op('B', 2, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'B1' } }, '保存'),
    { id: 'op-res', type: 'conflict.resolve', tabId: 'tab-A', ts: ts++, seq: 5, payload: { key: `${buttonId}:${propId}:defaultValue`, value: 'A1' } },
    op('A', 6, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'A2' } }, 'A1'),
    op('B', 7, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'B2' } }, 'A1')
  ];
  const { conflicts } = reduceOps(baseline, ops);
  assert(conflicts.length === 1, '解决后再次分叉会重新出现冲突');
  assert(conflicts[0]?.options.map((o) => o.value).join('/') === 'A2/B2', '新冲突只包含新分叉的值');
}

// 场景 8b：人工解决冲突后，同一标签页撤销自己解决前的写入 → 属于该页自己的新编辑，
// 不重新制造跨标签页冲突；但撤销值会安静生效（同页用户对自己历史的操作）。
{
  const ops = [
    op('A', 1, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'A1' } }, '保存'),
    op('B', 2, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'B1' } }, '保存'),
    { id: 'op-res', type: 'conflict.resolve', tabId: 'tab-A', ts: ts++, seq: 5, payload: { key: `${buttonId}:${propId}:defaultValue`, value: 'B1' } },
    // A 在本页撤销自己的 A1：基于 A1 改回“保存”。
    { id: 'op-undo-a', type: 'property.update', tabId: 'tab-A', ts: ts++, seq: 6, base: 'A1', payload: { componentId: buttonId, propertyId: propId, patch: { defaultValue: '保存' } } }
  ];
  const { state, conflicts } = reduceOps(baseline, ops);
  assert(conflicts.length === 0, '同页撤销不复活跨标签页冲突');
  const prop = state.components.find((c) => c.id === buttonId).properties.find((p) => p.id === propId);
  assert(prop.defaultValue === '保存', '撤销值安静生效为该页最新决定');
}

// 场景 8c：解决冲突后，第三个标签页仍拿着旧权威值分叉编辑 → 重新登记冲突，保护人工选择。
{
  const ops = [
    op('A', 1, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'A1' } }, '保存'),
    op('B', 2, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'B1' } }, '保存'),
    { id: 'op-res', type: 'conflict.resolve', tabId: 'tab-A', ts: ts++, seq: 5, payload: { key: `${buttonId}:${propId}:defaultValue`, value: 'B1' } },
    { id: 'op-c-late', type: 'property.update', tabId: 'tab-C', ts: ts++, seq: 7, base: '保存', payload: { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'C1' } } }
  ];
  const { conflicts } = reduceOps(baseline, ops);
  assert(conflicts.length === 1, '离线标签页带着旧值的迟到编辑会重新产生冲突，不覆盖人工选择');
  assert(conflicts[0]?.options.map((o) => o.value).sort().join('/') === 'B1/C1', '新冲突的候选为所选值与迟到值');
}

// 场景 8d：三页并存 A/B 分叉后，权威页 A 基于最新值继续编辑，冲突仍在且候选刷新为 A 新值/B。
{
  const ops = [
    op('A', 1, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'A1' } }, '保存'),
    op('B', 2, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'B1' } }, '保存'),
    op('A', 3, 'property.update', { componentId: buttonId, propertyId: propId, patch: { defaultValue: 'A2' } }, 'A1')
  ];
  const { conflicts } = reduceOps(baseline, ops);
  assert(conflicts.length === 1, '权威页继续编辑不消除与离线页的分叉');
  assert(conflicts[0]?.options.map((o) => o.value).sort().join('/') === 'A2/B1', '候选值刷新为权威页最新值');
}

// 场景 9：目录/检查读取的是合并后内容（快照与迁移都在合并状态上执行）。
{
  const ops = [
    op('A', 1, 'snapshot.create', {
      componentId: buttonId,
      reason: '合并后保存',
      component: (() => { const c = structuredClone(baseline.components.find((x) => x.id === buttonId)); delete c.snapshots; return c; })()
    })
  ];
  const { state } = reduceOps(baseline, ops);
  const comp = state.components.find((c) => c.id === buttonId);
  assert(comp.snapshots.length === 1 && comp.revision === 4, '版本快照基于合并内容创建');
}

console.log(process.exitCode ? '有失败用例' : '全部用例通过');

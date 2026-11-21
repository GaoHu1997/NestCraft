import test from "node:test";
import assert from "node:assert/strict";
import { createEngine, formatNumber, reduce, initialState, actionForKey, MAX_HISTORY } from "../src/calculator.js";

const digit = value => ({ type: "digit", value: String(value) });
const op = value => ({ type: "op", value });
const run = (engine, actions) => actions.forEach(action => engine.press(action));

test("AC-STORY-001-01 四则运算：1 + 2 = 3", () => {
  const engine = createEngine();
  run(engine, [digit(1), op("+"), digit(2), { type: "equals" }]);
  assert.equal(engine.snapshot().state.display, "3");
});

test("AC-STORY-001-02 连续运算复用上一次结果", () => {
  const engine = createEngine();
  run(engine, [digit(1), op("+"), digit(2), { type: "equals" }, op("×"), digit(4), { type: "equals" }]);
  assert.equal(engine.snapshot().state.display, "12");
});

test("AC-STORY-001-03 只允许一个小数点", () => {
  let state = initialState();
  state = reduce(state, digit("0"));
  state = reduce(state, { type: "dot" });
  state = reduce(state, digit("1"));
  state = reduce(state, { type: "dot" });
  assert.equal(state.entry, "0.1");
});

test("AC-STORY-001-04 正负号可来回切换", () => {
  let state = reduce(initialState(), digit(5));
  state = reduce(state, { type: "negate" });
  assert.equal(state.display, "-5");
  state = reduce(state, { type: "negate" });
  assert.equal(state.display, "5");
});

test("AC-STORY-001-05 百分比把当前输入除以 100", () => {
  let state = reduce(initialState(), digit(5));
  state = reduce(state, digit(0));
  state = reduce(state, { type: "percent" });
  assert.equal(state.display, "0.5");
});

test("AC-STORY-001-06 退格逐位删除，最少到 0", () => {
  let state = initialState();
  for (const d of ["1", "2", "3"]) state = reduce(state, digit(d));
  state = reduce(state, { type: "back" });
  assert.equal(state.display, "12");
  state = reduce(state, { type: "back" });
  state = reduce(state, { type: "back" });
  assert.equal(state.display, "0");
});

test("AC-STORY-001-07 除以 0 给出中文错误提示且不产生 Infinity", () => {
  const engine = createEngine();
  run(engine, [digit(8), op("÷"), digit(0), { type: "equals" }]);
  const { state, history } = engine.snapshot();
  assert.equal(state.display, "不能除以 0");
  assert.equal(state.error, "不能除以 0");
  assert.equal(history.length, 0);
});

test("AC-STORY-001-08 错误后输入数字恢复可用", () => {
  const engine = createEngine();
  run(engine, [digit(8), op("÷"), digit(0), { type: "equals" }, digit(7)]);
  const { state } = engine.snapshot();
  assert.equal(state.error, null);
  assert.equal(state.display, "7");
});

test("AC-STORY-001-09 AC 清空全部状态", () => {
  const engine = createEngine();
  run(engine, [digit(9), op("+"), digit(1), { type: "allClear" }]);
  const { state } = engine.snapshot();
  assert.equal(state.display, "0");
  assert.equal(state.op, null);
  assert.equal(state.expression, "");
});

test("AC-STORY-001-10 结果最多保留 10 位小数并去掉末尾 0", () => {
  assert.equal(formatNumber(1 / 3), "0.3333333333");
  assert.equal(formatNumber(2.5), "2.5");
  assert.equal(formatNumber(4), "4");
});

test("AC-STORY-001 补充：重复等号重复上一次运算", () => {
  const engine = createEngine();
  run(engine, [digit(3), op("+"), digit(2), { type: "equals" }, { type: "equals" }]);
  assert.equal(engine.snapshot().state.display, "7");
});

test("AC-STORY-002-01 键盘与点击走同一状态机", () => {
  const clicked = createEngine();
  run(clicked, [digit(1), op("+"), digit(2), { type: "equals" }]);
  const typed = createEngine();
  const events = ["1", "+", "2", "Enter"].map(key => actionForKey({ key }));
  events.forEach(action => typed.press(action));
  assert.equal(typed.snapshot().state.display, clicked.snapshot().state.display);
});

test("AC-STORY-002-02 Backspace 触发退格", () => {
  assert.deepEqual(actionForKey({ key: "Backspace" }), { type: "back" });
});

test("AC-STORY-002-03 Escape 等同 AC", () => {
  assert.deepEqual(actionForKey({ key: "Escape" }), { type: "allClear" });
});

test("AC-STORY-002-04 * 与 / 映射为 × 与 ÷", () => {
  assert.deepEqual(actionForKey({ key: "*" }), { type: "op", value: "×" });
  assert.deepEqual(actionForKey({ key: "/" }), { type: "op", value: "÷" });
  const engine = createEngine();
  run(engine, [digit(6), actionForKey({ key: "*" }), digit(7), { type: "equals" }]);
  assert.equal(engine.snapshot().state.display, "42");
});

test("AC-STORY-002-05 成功计算写入历史且新的在最前", () => {
  const engine = createEngine();
  run(engine, [digit(1), op("+"), digit(2), { type: "equals" }]);
  run(engine, [digit(4), op("+"), digit(5), { type: "equals" }]);
  const { history } = engine.snapshot();
  assert.equal(history.length, 2);
  assert.equal(history[0].expression, "4 + 5 = 9");
});

test("AC-STORY-002-06 历史上限为 20 条", () => {
  const engine = createEngine();
  for (let i = 0; i < MAX_HISTORY + 3; i += 1) {
    run(engine, [digit(1), op("+"), digit(1), { type: "equals" }]);
  }
  assert.equal(engine.snapshot().history.length, MAX_HISTORY);
});

test("AC-STORY-002-07 点击历史回填不新增历史", () => {
  const engine = createEngine();
  run(engine, [digit(2), op("+"), digit(3), { type: "equals" }]);
  const before = engine.snapshot().history.length;
  engine.press({ type: "recall", value: 5 });
  assert.equal(engine.snapshot().state.display, "5");
  assert.equal(engine.snapshot().history.length, before);
});

test("AC-STORY-002-08 清空历史立即生效", () => {
  const engine = createEngine();
  run(engine, [digit(2), op("×"), digit(3), { type: "equals" }]);
  engine.clearHistory();
  assert.equal(engine.snapshot().history.length, 0);
});

test("AC-STORY-002-09 除零计算不写入历史", () => {
  const engine = createEngine();
  run(engine, [digit(1), op("÷"), digit(0), { type: "equals" }]);
  assert.equal(engine.snapshot().history.length, 0);
});

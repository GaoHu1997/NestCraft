/**
 * 计算器内核：显式状态机，不依赖 eval。
 *
 * 约定：
 * - 顺序计算，不做运算符优先级（见 docs/LLD/ADR-001-计算引擎选型.md）。
 * - 数字输入始终是「显示用字符串」，参与计算时才转为数值。
 * - 所有对外动作收敛到 press()，鼠标与键盘走同一条路径（AC-STORY-002-01）。
 */

export const MAX_HISTORY = 20;
export const DIVIDE_BY_ZERO = "不能除以 0";

const OPS = new Set(["+", "-", "×", "÷"]);
const MAX_DECIMALS = 10;

/** 把数值格式化为显示字符串：最多 10 位小数、去掉末尾多余的 0，过大值用指数。 */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return DIVIDE_BY_ZERO;
  if (value === 0) return "0";
  const rounded = Number(value.toFixed(MAX_DECIMALS));
  if (Math.abs(rounded) >= 1e15) return rounded.toExponential(6).replace(/\.?0+e/, "e");
  return String(rounded);
}

function digitCount(text) {
  return text.replace(/[-.]/g, "").length;
}

/** 初始状态。 */
export function initialState() {
  return {
    entry: "0", // 当前输入
    display: "0", // 显示区主行
    left: null, // 已累积的左操作数
    op: null, // 待执行运算符
    waiting: false, // 刚按完运算符，等待新的数字
    error: null, // 错误提示
    expression: "", // 表达式行
    lastOp: null, // 重复等号用
    lastOperand: null,
  };
}

function withDisplay(state) {
  return { ...state, display: state.error ? state.error : state.entry };
}

function apply(state, left, op, right) {
  switch (op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "×":
      return left * right;
    case "÷":
      return right === 0 ? null : left / right;
    default:
      return right;
  }
}

function compute(state, right) {
  const result = apply(state, state.left ?? 0, state.op, right);
  if (result === null) {
    return { ...initialState(), error: DIVIDE_BY_ZERO, display: DIVIDE_BY_ZERO };
  }
  if (!Number.isFinite(result)) {
    return { ...initialState(), error: "结果超出范围", display: "结果超出范围" };
  }
  return result;
}

/**
 * 处理一次动作，返回新状态。
 * action: { type: "digit"|"dot"|"op"|"equals"|"clear"|"allClear"|"back"|"negate"|"percent"|"recall", value? }
 */
export function reduce(state, action) {
  switch (action.type) {
    case "digit": {
      const value = String(action.value);
      if (!/^[0-9]$/.test(value)) return state;
      if (state.error || state.waiting) {
        return withDisplay({ ...state, entry: value, waiting: false, error: null });
      }
      if (digitCount(state.entry) >= 15) return state;
      const entry = state.entry === "0" ? value : `${state.entry}${value}`;
      return withDisplay({ ...state, entry });
    }

    case "dot": {
      if (state.error || state.waiting) return withDisplay({ ...state, entry: "0.", waiting: false, error: null });
      if (state.entry.includes(".")) return state; // AC-STORY-001-03
      return withDisplay({ ...state, entry: `${state.entry}.` });
    }

    case "op": {
      const op = action.value;
      if (!OPS.has(op)) return state;
      if (state.error) return withDisplay({ ...state, error: null, entry: "0", left: null, op, waiting: true });
      const current = Number(state.entry);
      if (state.op !== null && state.waiting) {
        // 连续点运算符：只替换运算符，不重复计算。
        return withDisplay({ ...state, op, expression: `${formatNumber(state.left ?? 0)} ${op}` });
      }
      if (state.op !== null) {
        const result = compute(state, current);
        if (typeof result !== "number") return result;
        const text = formatNumber(result);
        return withDisplay({
          ...state,
          left: result,
          entry: text,
          display: text,
          op,
          waiting: true,
          expression: `${text} ${op}`,
        });
      }
      return withDisplay({
        ...state,
        left: current,
        op,
        waiting: true,
        expression: `${formatNumber(current)} ${op}`,
      });
    }

    case "equals": {
      if (state.error) return state;
      if (state.op === null) {
        // 没有待执行运算符：把当前输入固定为结果，不写历史（AC-STORY-002-09 语义延伸）。
        return withDisplay({ ...state, waiting: true, lastOp: state.lastOp, lastOperand: state.lastOperand });
      }
      const result = compute(state, Number(state.entry));
      if (typeof result !== "number") return result;
      const text = formatNumber(result);
      const expression = `${formatNumber(state.left ?? 0)} ${state.op} ${formatNumber(Number(state.entry))} = ${text}`;
      return withDisplay({
        ...state,
        left: result,
        entry: text,
        display: text,
        op: null,
        waiting: true,
        expression,
        lastOp: state.op,
        lastOperand: Number(state.entry),
        committed: expression,
      });
    }

    case "repeatEquals": {
      if (state.error || state.lastOp === null || state.lastOperand === null) return state;
      const left = Number(state.entry);
      const result = apply(state, left, state.lastOp, state.lastOperand);
      if (result === null) return { ...initialState(), error: DIVIDE_BY_ZERO, display: DIVIDE_BY_ZERO };
      if (!Number.isFinite(result)) return { ...initialState(), error: "结果超出范围", display: "结果超出范围" };
      const text = formatNumber(result);
      const expression = `${formatNumber(left)} ${state.lastOp} ${formatNumber(state.lastOperand)} = ${text}`;
      return withDisplay({ ...state, entry: text, display: text, waiting: true, expression, committed: expression });
    }

    case "clear": {
      // C：只清当前输入；待执行运算符保留。
      if (state.error) return initialState();
      return withDisplay({ ...state, entry: "0", error: null });
    }

    case "allClear":
      return initialState();

    case "back": {
      if (state.error) return initialState();
      if (state.waiting) return withDisplay({ ...state, entry: "0", waiting: false, expression: "" });
      const next = state.entry.length <= 1 ? "0" : state.entry.slice(0, -1);
      const entry = next === "-" ? "0" : next; // AC-STORY-001-06
      return withDisplay({ ...state, entry });
    }

    case "negate": {
      if (state.error) return initialState();
      if (state.entry === "0") return state;
      const entry = state.entry.startsWith("-") ? state.entry.slice(1) : `-${state.entry}`;
      return withDisplay({ ...state, entry }); // AC-STORY-001-04
    }

    case "percent": {
      if (state.error) return initialState();
      const value = Number(state.entry) / 100;
      return withDisplay({ ...state, entry: formatNumber(value), waiting: false }); // AC-STORY-001-05
    }

    case "recall": {
      const value = Number(action.value);
      if (!Number.isFinite(value)) return state;
      return withDisplay({ ...state, entry: formatNumber(value), waiting: false, error: null, expression: "" });
    }

    default:
      return state;
  }
}

/** 键盘事件 → 动作。返回 null 表示该按键不处理。 */
export function actionForKey(event) {
  const { key } = event;
  if (/^[0-9]$/.test(key)) return { type: "digit", value: key };
  switch (key) {
    case ".":
      return { type: "dot" };
    case "+":
      return { type: "op", value: "+" };
    case "-":
      return { type: "op", value: "-" };
    case "*":
    case "x":
    case "X":
      return { type: "op", value: "×" };
    case "/":
      return { type: "op", value: "÷" };
    case "Enter":
    case "=":
      return { type: "equals" };
    case "Backspace":
      return { type: "back" };
    case "Escape":
    case "c":
    case "C":
      return { type: "allClear" };
    case "%":
      return { type: "percent" };
    default:
      return null;
  }
}

/**
 * 可观察引擎：包装 reduce + 历史记录，供界面订阅。
 * 历史只在成功按下等号时写入，最多 MAX_HISTORY 条。
 */
export function createEngine() {
  let state = initialState();
  let history = [];
  const listeners = new Set();
  const notify = () => listeners.forEach(listener => listener({ state, history }));

  const commit = next => {
    state = next;
    if (state.committed) {
      history = [{ expression: state.committed, result: Number(state.entry) }, ...history].slice(0, MAX_HISTORY);
      state = { ...state, committed: undefined };
    }
    notify();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener({ state, history });
      return () => listeners.delete(listener);
    },
    press(action) {
      if (action && action.type === "equals" && state.op === null && state.lastOp !== null && state.waiting) {
        commit(reduce(state, { type: "repeatEquals" }));
        return;
      }
      commit(reduce(state, action));
    },
    /** 供测试与调试读取当前快照。 */
    snapshot() {
      return { state, history };
    },
    clearHistory() {
      history = [];
      notify();
    },
  };
}

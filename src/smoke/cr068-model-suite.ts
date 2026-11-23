/** CR-068 FEAT-014 针对性单测：容量解析、档位映射编译、CLI 协议过滤。
 *  纯函数断言，不访问供应商、模型、SSH 或私人库。
 *  运行：node --experimental-strip-types -e "import('./src/smoke/cr068-model-suite.ts').then(m=>{...})" */
import {
  EFFORT_ORDER,
  capacityError,
  capacityLabel,
  compileEffortMap,
  formatCapacity,
  parseCapacity,
  protocolAllowed,
  protocolsForCli,
} from "../modules/settings/modelCapacity.ts";

export interface Cr068ModelCase {
  name: string;
  ok: boolean;
  detail: string;
}

const expectEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
};

const expectThrows = (fn: () => unknown, label: string): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${label}：期望抛出错误但成功返回`);
};

export function runCr068ModelSuite(): Cr068ModelCase[] {
  const cases: Cr068ModelCase[] = [];
  const check = (name: string, fn: () => string): void => {
    try {
      cases.push({ name, ok: true, detail: fn() });
    } catch (e) {
      cases.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };

  check("容量：K/M 大小写、空格与小数", () => {
    expectEqual(parseCapacity("128K"), 128000, "128K");
    expectEqual(parseCapacity(" 2 k "), 2000, "2 k");
    expectEqual(parseCapacity("1m"), 1000000, "1m");
    expectEqual(parseCapacity("0.1M"), 100000, "0.1M");
    expectEqual(parseCapacity("131072"), 131072, "131072");
    return "128K/2 k/1m/0.1M/131072 均解析为安全正整数";
  });

  check("容量：留空为未知", () => {
    expectEqual(parseCapacity(""), null, "空串");
    expectEqual(parseCapacity("   "), null, "空白");
    expectEqual(parseCapacity(null), null, "null");
    expectEqual(capacityError(""), null, "空串无错误");
    return "空文本/null 返回 null，不当作 0";
  });

  check("容量：0/负/非法/越界均拒绝并给出错误", () => {
    for (const text of ["0", "-1", "1.5", "1e3", "abc", "128KB", "9007199254740992"]) {
      expectThrows(() => parseCapacity(text), text);
      if (!capacityError(text)) throw new Error(`${text} 应有错误文案`);
    }
    return "0、-1、1.5、1e3、abc、128KB、2^53 均拒绝";
  });

  check("容量：列表展示保留非法输入", () => {
    expectEqual(capacityLabel("128000"), "128K", "128000");
    expectEqual(capacityLabel("1000000"), "1M", "1000000");
    expectEqual(capacityLabel("oops"), "oops", "非法文本原样");
    expectEqual(capacityLabel(""), "—", "未知");
    expectEqual(formatCapacity(1500), "1.5K", "1500");
    return "合法值紧凑展示，非法输入不丢失";
  });

  check("映射：同名预填且只编译已启用档位", () => {
    const efforts = compileEffortMap(["low", "high"], { low: "fast", high: undefined, max: "ignored" });
    expectEqual(Object.keys(efforts), ["low", "high"], "仅启用档位");
    expectEqual(efforts.low, "fast", "自定义映射保留");
    expectEqual(efforts.high, "high", "同名预填");
    if ("max" in efforts) throw new Error("未启用档位不应下发");
    return "low=fast，high=high，未启用 max 被忽略";
  });

  check("映射：显式清空为不下发，顺序与七档一致", () => {
    const efforts = compileEffortMap(["off", "max"], { off: "", max: "  " });
    expectEqual(efforts.off, null, "off 清空");
    expectEqual(efforts.max, null, "max 空白");
    expectEqual(Object.keys(efforts), ["off", "max"], "按七档顺序");
    expectEqual(EFFORT_ORDER.length, 7, "七档");
    return "清空映射保留 null；输出顺序跟随 off..max";
  });

  check("映射：未选档位编辑不改变已启用集合", () => {
    const before = compileEffortMap(["medium"], { medium: "med", xhigh: "custom" });
    expectEqual(Object.keys(before), ["medium"], "只保留 medium");
    expectEqual(before.medium, "med", "medium 自定义");
    return "xhigh 的草稿不进入下发集合";
  });

  check("CLI 协议：Claude→Anthropic，Codex/Grok→OpenAI，未知不缩小", () => {
    expectEqual(protocolsForCli("claude"), ["anthropic"], "claude");
    expectEqual(protocolsForCli("codex"), ["openai"], "codex");
    expectEqual(protocolsForCli("grok"), ["openai"], "grok");
    expectEqual(protocolsForCli(null).length, 2, "未知 CLI");
    if (!protocolAllowed("anthropic", "claude")) throw new Error("Claude 应接受 Anthropic");
    if (protocolAllowed("openai", "claude")) throw new Error("Claude 不应接受 OpenAI");
    if (!protocolAllowed("openai", "codex")) throw new Error("Codex 应接受 OpenAI");
    if (protocolAllowed("anthropic", "grok")) throw new Error("Grok 不应接受 Anthropic");
    return "候选过滤与 CLI 可执行协议一致";
  });

  return cases;
}

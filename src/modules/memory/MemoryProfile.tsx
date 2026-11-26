import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { memoryGetProfile } from "@/api/memory";
import type { MemoryProfile as MemoryProfileData } from "@/api/memory";

const FIELD_LABELS: Record<string, string> = {
  identity: "身份",
  name: "身份",
  role: "身份",
  occupation: "身份",
  techstack: "常用技术栈",
  stack: "常用技术栈",
  technologies: "常用技术栈",
  languages: "常用技术栈",
  tools: "常用技术栈",
  communication: "沟通偏好",
  communicationstyle: "沟通偏好",
  chatstyle: "沟通偏好",
  tone: "沟通偏好",
  goal: "当前目标",
  goals: "当前目标",
  currentgoal: "当前目标",
  objectives: "当前目标",
  environment: "工作环境",
  workenvironment: "工作环境",
  workspace: "工作环境",
  os: "工作环境",
  platform: "工作环境",
  preference: "偏好",
  preferences: "偏好",
  habits: "偏好",
  style: "偏好",
};

const FIELD_ORDER = ["identity", "techstack", "communication", "goal", "environment", "preference"];

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeKey(key: string): string {
  return key.replace(/[\s_-]/g, "").toLowerCase();
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(" · ");
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}：${scalarText(item)}`)
      .filter(item => !item.endsWith("："))
      .join("；");
  }
  return "";
}

function parseFields(raw: string): Array<{ key: string; label: string; value: string }> {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ key: "raw", label: "原始画像", value: text }];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const value = scalarText(parsed);
    return value ? [{ key: "raw", label: "原始画像", value }] : [];
  }
  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => {
      const normalized = normalizeKey(key);
      return {
        key,
        label: FIELD_LABELS[normalized] ?? key,
        value: scalarText(value),
        rank: FIELD_ORDER.includes(normalized) ? FIELD_ORDER.indexOf(normalized) : FIELD_ORDER.length,
      };
    })
    .filter(field => field.value.length > 0)
    .sort((left, right) => left.rank - right.rank)
    .map(({ key, label, value }) => ({ key, label, value }));
}

function ProfileLoading() {
  return (
    <div className="memory-loading" aria-busy="true" aria-label="画像加载中">
      <div className="memory-card memory-skeleton-card">
        <div className="memory-skeleton memory-skeleton-body" />
        <div className="memory-skeleton memory-skeleton-meta" />
      </div>
      <div className="memory-card memory-skeleton-card">
        <div className="memory-skeleton memory-skeleton-head" />
        <div className="memory-skeleton memory-skeleton-body" />
        <div className="memory-skeleton memory-skeleton-meta" />
      </div>
    </div>
  );
}

export function MemoryProfile({ scope, refreshToken }: { scope:string; refreshToken: number }) {
  const [profile, setProfile] = useState<MemoryProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setError(null);
    try {
      const next = await memoryGetProfile(scope);
      if (seq !== loadSeq.current) return;
      setProfile(next);
    } catch (loadError) {
      if (seq !== loadSeq.current) return;
      setError(errText(loadError));
    }
  }, [scope]);

  useEffect(() => {
    setProfile(null);
    void load();
  }, [load, refreshToken]);

  useEffect(() => () => { loadSeq.current += 1; }, []);

  if (error) {
    return (
      <div className="memory-error" role="alert">
        <b>画像加载失败</b>
        <p>{error}</p>
        <button className="memory-btn" onClick={() => { setProfile(null); void load(); }}>重试</button>
      </div>
    );
  }

  if (profile === null) return <ProfileLoading />;

  const fields = parseFields(profile.fieldsJson);
  return (
    <div className="memory-scroll">
      <div className="memory-profile-summary">
        {profile.summary.trim() || <span className="memory-muted">还没有画像摘要。AI 会在积累记忆后自动归纳。</span>}
      </div>
      {fields.length > 0 ? (
        <div className="memory-profile-grid">
          {fields.map(field => (
            <Fragment key={field.key}>
              <div className="memory-profile-key">{field.label}</div>
              <div className="memory-profile-value">{field.value}</div>
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="memory-profile-empty">还没有结构化画像字段。</div>
      )}
      <p className="memory-hint">画像由记忆自动归纳，也可手动编辑「摘要」。数据仅保存在本地。</p>
    </div>
  );
}

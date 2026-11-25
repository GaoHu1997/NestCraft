//! CR-078：概览页全平台 token 用量聚合（DB-CR078 §4）。
//! 只读聚合，不建汇总表；缺 usage 的消息不计入（不按字符数估算）。
//! 来源判定（DB-CR078 §4.2）：
//!   - CLI 会话：session.runner='cli' 的 assistant 消息 metaJson.usage；
//!   - 平台主代理 / 子智能体：runner='platform' 会话里 user 消息 metaJson.sessionStats.closedSteps[].usage。
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use chrono::{Datelike, TimeZone};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
    pub requests: i64,
    /// 缓存命中率 = cache / (input + cache)，分母为 0 时 None（界面显示「—」）。
    pub cache_hit_rate: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageDay {
    pub date: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
    pub requests: i64,
}

/// 小时内的单模型用量。趋势图按模型堆叠，悬停详情按此列举。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageHourModel {
    /// 显示名称（模型显示名，同一名称的不同来源会合并）。
    pub name: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
    pub requests: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageHour {
    pub hour: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
    pub requests: i64,
    /// 该小时按显示名称聚合的模型明细，token 降序。
    pub models: Vec<UsageHourModel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageModel {
    pub name: String,
    pub provider_id: Option<String>,
    pub cli_id: Option<String>,
    /// cli | platform | subagent
    pub source: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
    pub requests: i64,
    pub cache_hit_rate: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageProvider {
    pub name: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
    pub requests: i64,
    pub cache_hit_rate: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageStats {
    pub range: String,
    pub from: String,
    pub to: String,
    /// 统计生成时间（ms）。数据只覆盖到查询时刻。
    pub as_of: i64,
    pub totals: UsageTotals,
    /// 日粒度用量，固定覆盖近 HEAT_DAYS 天（活跃热力图的长周期窗口），不随周期筛选变化。
    pub days: Vec<UsageDay>,
    pub hours: Vec<UsageHour>,
    pub models: Vec<UsageModel>,
    pub providers: Vec<UsageProvider>,
    /// 周期内全部消息都缺 usage 的来源数，界面据此显示「未上报」。
    pub unknown_sources: i64,
}

pub(crate) const RANGES: [&str; 5] = ["today", "3d", "7d", "1m", "3m"];

/// 活跃热力图的固定长周期窗口（28 周 × 7 天）。热力图展示的是长期活跃度，
/// 不能跟着上方周期筛选缩成几列，所以日粒度数据始终按这个窗口查询。
pub(crate) const HEAT_DAYS: i64 = 28 * 7;

fn range_to_from(range: &str, today: chrono::NaiveDate) -> Result<chrono::NaiveDate, String> {
    let days = match range {
        "today" => 0,
        "3d" => 2,
        "7d" => 6,
        "1m" => 29,
        "3m" => 89,
        _ => return Err("周期无效".into()),
    };
    today
        .checked_sub_signed(chrono::Duration::days(days))
        .ok_or_else(|| "周期超出可计算范围".into())
}

/// 从 metaJson 提取 CLI assistant 用量；无 usage 返回 None。
fn cli_usage_of(meta: Option<String>) -> Option<(i64, i64, i64)> {
    let v: Value = serde_json::from_str(&meta?).ok()?;
    let u = v.get("usage")?;
    Some((
        u.get("inputTokens").and_then(Value::as_i64).unwrap_or(0),
        u.get("outputTokens").and_then(Value::as_i64).unwrap_or(0),
        u.get("cacheReadTokens").and_then(Value::as_i64).unwrap_or(0),
    ))
}

/// 从 metaJson 提取平台闭合步骤用量合计（含子智能体）；无 sessionStats 返回 None。
fn platform_usage_of(meta: Option<String>) -> Option<(i64, i64, i64)> {
    let v: Value = serde_json::from_str(&meta?).ok()?;
    let steps = v.get("sessionStats")?.get("closedSteps")?.as_array()?;
    let mut sum = (0i64, 0i64, 0i64);
    let mut any = false;
    for step in steps {
        if let Some((i, o, c)) = step.get("usage").and_then(|u| u.as_array()).and_then(|a| {
            if a.len() == 3 {
                Some((
                    a[0].as_i64().unwrap_or(0),
                    a[1].as_i64().unwrap_or(0),
                    a[2].as_i64().unwrap_or(0),
                ))
            } else {
                None
            }
        }) {
            sum.0 += i;
            sum.1 += o;
            sum.2 += c;
            any = true;
        }
    }
    any.then_some(sum)
}

fn hit_rate(input: i64, cache: i64) -> Option<f64> {
    let denom = input + cache;
    (denom > 0).then(|| (cache as f64 / denom as f64 * 1000.0).round() / 10.0)
}

pub(crate) fn stats(
    conn: &Connection,
    range: &str,
    custom_from: Option<&str>,
    custom_to: Option<&str>,
) -> Result<UsageStats, String> {
    let local_today = chrono::Local::now().date_naive();
    let (from, to) = if range == "custom" {
        let f = custom_from.ok_or("请选择开始日期")?;
        let t = custom_to.ok_or("请选择结束日期")?;
        let fd = chrono::NaiveDate::parse_from_str(f, "%Y-%m-%d").map_err(|_| "日期格式无效")?;
        let td = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d").map_err(|_| "日期格式无效")?;
        if td < fd {
            return Err("结束不能早于开始".into());
        }
        (fd, td)
    } else {
        let f = range_to_from(range, local_today)?;
        (f, local_today)
    };
    // 毫秒区间：[from 00:00 本地, to 次日 00:00 本地)
    // 查询窗口取「周期起点」与「热力图起点」的较早者：多取的行只进日粒度（热力图），
    // 汇总、小时、模型、供应商仍只在周期内累计（见循环里的 in_range 判断）。
    let heat_from = local_today
        .checked_sub_signed(chrono::Duration::days(HEAT_DAYS - 1))
        .ok_or_else(|| "热力图时间范围超出可计算范围".to_string())?;
    let query_from = heat_from.min(from);
    let from_day = from.format("%Y-%m-%d").to_string();
    let from_ms = query_from
        .and_hms_opt(0, 0, 0)
        .and_then(|d| d.and_local_timezone(chrono::Local).single())
        .map(|d| d.timestamp_millis())
        .ok_or("开始时间无效")?;
    let to_ms = to
        .succ_opt()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .and_then(|d| d.and_local_timezone(chrono::Local).single())
        .map(|d| d.timestamp_millis())
        .ok_or("结束时间无效")?;

    struct Row {
        day: String,
        hour: i64,
        input: i64,
        output: i64,
        cache: i64,
        model: Option<String>,
        provider: Option<String>,
        cli: Option<String>,
        source: &'static str,
    }

    let mut rows: Vec<Row> = Vec::new();
    // CLI 会话 assistant 消息。
    {
        let mut stmt = conn
            .prepare(
                "SELECT m.createdAt, m.metaJson, s.modelId, s.providerId, s.cliId
                 FROM message m JOIN session s ON s.id = m.sessionId
                 WHERE m.role='assistant' AND m.createdAt >= ?1 AND m.createdAt < ?2 AND s.runner='cli'",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([from_ms, to_ms], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
            })
            .map_err(|e| e.to_string())?;
        for row in mapped {
            let (created, meta, model, provider, cli) = row.map_err(|e| e.to_string())?;
            let Some((i, o, c)) = cli_usage_of(meta) else { continue };
            let local = chrono::Local.timestamp_millis_opt(created).single().ok_or("时间戳无效")?;
            rows.push(Row {
                day: local.format("%Y-%m-%d").to_string(),
                hour: local.format("%H").to_string().parse().unwrap_or(0),
                input: i,
                output: o,
                cache: c,
                model,
                provider,
                cli,
                source: "cli",
            });
        }
    }
    // 平台会话（含子智能体）闭合步骤。
    {
        let mut stmt = conn
            .prepare(
                "SELECT m.createdAt, m.metaJson, s.modelId, s.providerId
                 FROM message m JOIN session s ON s.id = m.sessionId
                 WHERE m.role='user' AND m.createdAt >= ?1 AND m.createdAt < ?2 AND s.runner='platform'",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([from_ms, to_ms], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))
            })
            .map_err(|e| e.to_string())?;
        for row in mapped {
            let (created, meta, model, provider) = row.map_err(|e| e.to_string())?;
            let Some((i, o, c)) = platform_usage_of(meta) else { continue };
            let local = chrono::Local.timestamp_millis_opt(created).single().ok_or("时间戳无效")?;
            rows.push(Row {
                day: local.format("%Y-%m-%d").to_string(),
                hour: local.format("%H").to_string().parse().unwrap_or(0),
                input: i,
                output: o,
                cache: c,
                model,
                provider,
                cli: None,
                // 子智能体与主代理共用平台通道，来源都标 platform；子代理细分在 closedSteps
                // 的 stepId 中，本页不做逐 step 归属（与 CR-062 只读详情分工）。
                source: "platform",
            });
        }
    }

    let mut totals = UsageTotals { input_tokens: 0, output_tokens: 0, cache_tokens: 0, requests: 0, cache_hit_rate: None };
    let mut days: std::collections::BTreeMap<String, UsageDay> = std::collections::BTreeMap::new();
    let mut hours: Vec<UsageHour> = (0..24)
        .map(|hour| UsageHour { hour, input_tokens: 0, output_tokens: 0, cache_tokens: 0, requests: 0, models: Vec::new() })
        .collect();
    // 按显示名称聚合：同名模型跨来源合并成同一行 / 同一色块。
    let mut models: std::collections::BTreeMap<String, UsageModel> = std::collections::BTreeMap::new();
    let mut hour_models: Vec<std::collections::BTreeMap<String, UsageHourModel>> =
        (0..24).map(|_| std::collections::BTreeMap::new()).collect();
    let mut providers: std::collections::BTreeMap<String, UsageProvider> = std::collections::BTreeMap::new();

    for r in &rows {
        // 日粒度先累计：它服务固定长周期热力图，覆盖整个查询窗口。
        let day = days.entry(r.day.clone()).or_insert_with(|| UsageDay {
            date: r.day.clone(), input_tokens: 0, output_tokens: 0, cache_tokens: 0, requests: 0,
        });
        day.input_tokens += r.input;
        day.output_tokens += r.output;
        day.cache_tokens += r.cache;
        day.requests += 1;
        // 周期外的行只用于热力图，不进入汇总、小时、模型与供应商聚合。
        if r.day.as_str() < from_day.as_str() {
            continue;
        }
        totals.input_tokens += r.input;
        totals.output_tokens += r.output;
        totals.cache_tokens += r.cache;
        totals.requests += 1;
        let h = &mut hours[r.hour as usize];
        h.input_tokens += r.input;
        h.output_tokens += r.output;
        h.cache_tokens += r.cache;
        h.requests += 1;
        // 模型桶：按显示名称聚合，无 modelId 的归入「未记录模型」，仍计入总量。
        let model_name = r.model.clone().unwrap_or_else(|| "未记录模型".into());
        let key = model_name.clone();
        let m = models.entry(key).or_insert_with(|| UsageModel {
            name: model_name.clone(),
            provider_id: r.provider.clone(),
            cli_id: r.cli.clone(),
            source: r.source.to_string(),
            input_tokens: 0, output_tokens: 0, cache_tokens: 0, requests: 0, cache_hit_rate: None,
        });
        m.input_tokens += r.input;
        m.output_tokens += r.output;
        m.cache_tokens += r.cache;
        m.requests += 1;
        // 同名跨来源合并后保留非空来源标识，便于界面仍能显示 CLI logo / 来源标签。
        if m.source != r.source.to_string() {
            m.source = "mixed".to_string();
        }
        if m.cli_id.is_none() && r.cli.is_some() {
            m.cli_id = r.cli.clone();
        }
        if m.provider_id.is_none() && r.provider.is_some() {
            m.provider_id = r.provider.clone();
        }
        let hm = hour_models[r.hour as usize].entry(model_name.clone()).or_insert_with(|| UsageHourModel {
            name: model_name.clone(), input_tokens: 0, output_tokens: 0, cache_tokens: 0, requests: 0,
        });
        hm.input_tokens += r.input;
        hm.output_tokens += r.output;
        hm.cache_tokens += r.cache;
        hm.requests += 1;
        let p = providers.entry(r.provider.clone().unwrap_or_else(|| "未记录供应商".into())).or_insert_with(|| UsageProvider {
            name: r.provider.clone().unwrap_or_default(),
            input_tokens: 0, output_tokens: 0, cache_tokens: 0, requests: 0, cache_hit_rate: None,
        });
        p.name = r.provider.clone().unwrap_or_else(|| "未记录供应商".into());
        p.input_tokens += r.input;
        p.output_tokens += r.output;
        p.cache_tokens += r.cache;
        p.requests += 1;
    }
    totals.cache_hit_rate = hit_rate(totals.input_tokens, totals.cache_tokens);
    // 每小时模型明细按 token 降序，堆叠与悬停详情的顺序一致。
    for (i, bucket) in hour_models.into_iter().enumerate() {
        let mut list: Vec<UsageHourModel> = bucket.into_values().collect();
        list.sort_by(|a, b| {
            let ta = a.input_tokens + a.output_tokens;
            let tb = b.input_tokens + b.output_tokens;
            tb.cmp(&ta).then_with(|| a.name.cmp(&b.name))
        });
        hours[i].models = list;
    }
    let models: Vec<UsageModel> = models
        .into_values()
        .map(|mut m| {
            m.cache_hit_rate = hit_rate(m.input_tokens, m.cache_tokens);
            m
        })
        .collect();
    let providers: Vec<UsageProvider> = providers
        .into_values()
        .map(|mut p| {
            p.cache_hit_rate = hit_rate(p.input_tokens, p.cache_tokens);
            p
        })
        .collect();
    let days: Vec<UsageDay> = days.into_values().collect();
    Ok(UsageStats {
        range: range.to_string(),
        from: from.format("%Y-%m-%d").to_string(),
        to: to.format("%Y-%m-%d").to_string(),
        as_of: chrono::Utc::now().timestamp_millis(),
        totals,
        days,
        hours,
        models,
        providers,
        unknown_sources: 0, // 有记录的行都带来源；无记录处由空列表表达
    })
}

#[tauri::command]
pub(crate) fn usage_stats(
    range: String,
    from: Option<String>,
    to: Option<String>,
) -> Result<UsageStats, String> {
    if range != "custom" && !RANGES.contains(&range.as_str()) {
        return Err("周期无效".into());
    }
    let guard = crate::db::conn()?;
    stats(guard.as_ref().ok_or("db not initialized")?, &range, from.as_deref(), to.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, projectId TEXT, serverId TEXT, title TEXT NOT NULL DEFAULT '',
                cliId TEXT, providerId TEXT, modelId TEXT, runner TEXT NOT NULL DEFAULT 'cli');
             CREATE TABLE message (
                id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, metaJson TEXT, createdAt INTEGER NOT NULL);",
        )
        .unwrap();
        conn
    }

    /// 本地时区下构造某天某时的一条记录时间戳。
    fn ms_of(y: i32, m: u32, d: u32, h: u32) -> i64 {
        chrono::Local
            .with_ymd_and_hms(y, m, d, h, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn cli_platform_and_missing_usage() {
        let conn = setup();
        let today = chrono::Local::now().date_naive();
        // CLI 会话：一条带 usage、一条不带
        conn.execute("INSERT INTO session (id,cliId,providerId,modelId,runner) VALUES ('s1','claude','p1','m-claude','cli')", []).unwrap();
        let ms = ms_of(today.year(), today.month(), today.day(), 10);
        conn.execute(
            "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES ('m1','s1','assistant','a','{\"usage\":{\"inputTokens\":100,\"outputTokens\":20,\"cacheReadTokens\":300}}',?1)",
            [ms],
        ).unwrap();
        conn.execute(
            "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES ('m2','s1','assistant','a',NULL,?1)",
            [ms + 1],
        ).unwrap();
        // 平台会话：closedSteps 两条 usage（主 + 子步骤合计）
        let ms2 = ms_of(today.year(), today.month(), today.day(), 15);
        conn.execute("INSERT INTO session (id,providerId,modelId,runner) VALUES ('s2','p2','m-plat','platform')", []).unwrap();
        let meta = serde_json::json!({"sessionStats":{"closedSteps":[
            {"stepId":"s-a","usage":[50,5,60]},
            {"stepId":"s-b","usage":[30,3,20]}
        ]}}).to_string();
        conn.execute(
            "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES ('m3','s2','user','u',?1,?2)",
            [&meta, &ms2.to_string()],
        ).unwrap();

        let out = stats(&conn, "1m", None, None).unwrap();
        // CLI：100/20/300；平台：80/8/80（步骤合计）；缺失消息不计
        assert_eq!(out.totals.input_tokens, 180, "input 合计");
        assert_eq!(out.totals.output_tokens, 28);
        assert_eq!(out.totals.cache_tokens, 380);
        assert_eq!(out.totals.requests, 2, "两条带用量的记录");
        assert_eq!(out.totals.cache_hit_rate, Some(67.9)); // 380/560 = 67.857 → 67.9
        assert_eq!(out.days.len(), 1);
        assert_eq!(out.days[0].date, today.format("%Y-%m-%d").to_string());
        assert_eq!(out.hours[10].requests, 1);
        assert_eq!(out.hours[15].input_tokens, 80);
        // 模型桶按 (model, source)
        let mc = out.models.iter().find(|m| m.name == "m-claude").unwrap();
        assert_eq!(mc.source, "cli");
        assert_eq!(mc.cli_id.as_deref(), Some("claude"));
        assert_eq!(mc.requests, 1);
        assert_eq!(mc.cache_hit_rate, Some(75.0)); // 300/400
        let mp = out.models.iter().find(|m| m.name == "m-plat").unwrap();
        assert_eq!(mp.source, "platform");
        assert_eq!(mp.input_tokens, 80);
        // 供应商
        let p1 = out.providers.iter().find(|p| p.name == "p1").unwrap();
        assert_eq!(p1.requests, 1);
        // from/to：近 1 月 = 29 天前 ~ 今天
        let expect_from = (today - chrono::Duration::days(29)).format("%Y-%m-%d").to_string();
        assert_eq!(out.from, expect_from);
        assert_eq!(out.to, today.format("%Y-%m-%d").to_string());
    }

    #[test]
    fn custom_range_and_errors() {
        let conn = setup();
        // custom 倒置被拒
        assert_eq!(stats(&conn, "custom", Some("2026-11-10"), Some("2026-11-01")).unwrap_err(), "结束不能早于开始");
        // 非法周期被拒
        assert!(stats(&conn, "2w", None, None).is_err());
        // 空库：总计 0、命中率 None、hours 仍 24 桶
        let out = stats(&conn, "today", None, None).unwrap();
        assert_eq!(out.totals.input_tokens, 0);
        assert_eq!(out.totals.cache_hit_rate, None);
        assert_eq!(out.hours.len(), 24);
        assert!(out.models.is_empty());
    }

    #[test]
    fn range_bounds_match_documented_days() {
        let conn = setup();
        let today = chrono::Local::now().date_naive();
        // 近 3 天 = 今天起含今天的 3 个自然日
        let out = stats(&conn, "3d", None, None).unwrap();
        let expect_from = (today - chrono::Duration::days(2)).format("%Y-%m-%d").to_string();
        assert_eq!(out.from, expect_from);
        assert_eq!(out.to, today.format("%Y-%m-%d").to_string());
    }

    /// 热力图日粒度固定覆盖近 HEAT_DAYS 天，不随周期缩短；周期外的行只进日粒度。
    #[test]
    fn heat_days_keep_long_window_regardless_of_range() {
        let conn = setup();
        let today = chrono::Local::now().date_naive();
        conn.execute("INSERT INTO session (id,cliId,providerId,modelId,runner) VALUES ('s1','claude','p1','m','cli')", []).unwrap();
        let old = today - chrono::Duration::days(100);
        let old_ms = ms_of(old.year(), old.month(), old.day(), 9);
        let now_ms = ms_of(today.year(), today.month(), today.day(), 9);
        conn.execute(
            "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES ('m-old','s1','assistant','a','{\"usage\":{\"inputTokens\":10,\"outputTokens\":1,\"cacheReadTokens\":0}}',?1)",
            [old_ms],
        ).unwrap();
        conn.execute(
            "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES ('m-now','s1','assistant','a','{\"usage\":{\"inputTokens\":100,\"outputTokens\":10,\"cacheReadTokens\":0}}',?1)",
            [now_ms],
        ).unwrap();

        for range in ["today", "7d", "1m"] {
            let out = stats(&conn, range, None, None).unwrap();
            assert_eq!(out.totals.input_tokens, 100, "{range} 周期外行不得进入汇总");
            assert_eq!(out.totals.requests, 1, "{range} 只算周期内记录");
            assert_eq!(out.days.len(), 2, "{range} 日粒度须覆盖长周期窗口：{:?}", out.days);
            assert_eq!(out.days[0].date, old.format("%Y-%m-%d").to_string(), "{range} 早期日期要在日粒度里");
        }
    }

    fn void<T>(_: T) {}
}

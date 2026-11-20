//! CR-044：main 窗口统一关闭门控。仅保存内存 nonce，不访问业务数据。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager};

const MAIN_LABEL: &str = "main";
const CLOSE_REQUEST_EVENT: &str = "app:close-requested";
const CLOSE_REQUEST_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub(crate) struct WindowCloseState(Mutex<ClosePhase>);

#[derive(Default)]
enum ClosePhase {
    #[default]
    Idle,
    Pending {
        label: String,
        token: String,
        created_at: Instant,
    },
    // token 已消费；在 destroy 完成前不允许新请求或重复确认。
    Destroying,
}

impl ClosePhase {
    fn check_label(label: &str) -> Result<(), String> {
        if label == MAIN_LABEL {
            Ok(())
        } else {
            Err("window close commands are only available to main".into())
        }
    }

    fn expire(&mut self, now: Instant) {
        if matches!(self, Self::Pending { created_at, .. }
            if now.saturating_duration_since(*created_at) >= CLOSE_REQUEST_TTL)
        {
            *self = Self::Idle;
        }
    }

    /// None 表示请求已存在，不重发事件、不刷新有效期。
    fn reserve(&mut self, label: &str, now: Instant) -> Result<Option<String>, String> {
        Self::check_label(label)?;
        self.expire(now);
        match self {
            Self::Idle => {
                let token = uuid::Uuid::new_v4().to_string();
                *self = Self::Pending {
                    label: label.into(),
                    token: token.clone(),
                    created_at: now,
                };
                Ok(Some(token))
            }
            Self::Pending { .. } => Ok(None),
            Self::Destroying => Err("window close is already confirmed".into()),
        }
    }

    fn pending(&mut self, label: &str, now: Instant) -> Result<Option<String>, String> {
        Self::check_label(label)?;
        self.expire(now);
        match self {
            Self::Pending {
                label: owner,
                token,
                ..
            } if owner == label => Ok(Some(token.clone())),
            _ => Ok(None),
        }
    }

    fn resolve(
        &mut self,
        label: &str,
        token: &str,
        now: Instant,
        confirm: bool,
    ) -> Result<(), String> {
        Self::check_label(label)?;
        self.expire(now);
        match self {
            Self::Pending {
                label: owner,
                token: pending_token,
                ..
            } if owner == label && pending_token == token => {
                // Mutex 保护本转换；先清 nonce／锁住 phase，再调用原生销毁。
                *self = if confirm {
                    Self::Destroying
                } else {
                    Self::Idle
                };
                Ok(())
            }
            _ => Err("invalid, expired or already consumed window close token".into()),
        }
    }

    fn destroy_failed(&mut self) {
        if matches!(self, Self::Destroying) {
            // 不恢复已消费的 nonce；用户必须发起新的关闭请求。
            *self = Self::Idle;
        }
    }
}

#[derive(Clone, Serialize)]
struct CloseRequestedPayload {
    token: String,
}

/// 启动时的全局 CloseRequested 处理器调用；事件发出前已经保留 pending。
/// emit 失败或监听器尚未就绪均不放行关闭，前端可在注册监听后补读。
pub(crate) fn request_close(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<WindowCloseState>()
        .ok_or("window close state is unavailable")?;
    let token = state
        .0
        .lock()
        .map_err(|_| "window close state lock is unavailable")?
        .reserve(MAIN_LABEL, Instant::now())?;
    if let Some(token) = token {
        app.emit_to(
            MAIN_LABEL,
            CLOSE_REQUEST_EVENT,
            CloseRequestedPayload { token },
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// JS: invoke('window_request_close')。window/app 由 Tauri 注入，不能指定目标标签。
#[tauri::command]
pub fn window_request_close(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    ClosePhase::check_label(window.label())?;
    let state = app
        .try_state::<WindowCloseState>()
        .ok_or("window close state is unavailable")?;
    {
        let phase = state
            .0
            .lock()
            .map_err(|_| "window close state lock is unavailable")?;
        if matches!(*phase, ClosePhase::Destroying) {
            return Err("window close is already confirmed".into());
        }
    }
    // 与 ×、Alt+F4、系统菜单共用启动时的 CloseRequested 拦截。
    window.close().map_err(|e| e.to_string())
}

/// JS: invoke('window_confirm_close', { token })。只能消费 main 当前未过期请求一次。
#[tauri::command]
pub fn window_confirm_close(
    app: tauri::AppHandle,
    window: tauri::Window,
    token: String,
) -> Result<(), String> {
    ClosePhase::check_label(window.label())?;
    let state = app
        .try_state::<WindowCloseState>()
        .ok_or("window close state is unavailable")?;
    state
        .0
        .lock()
        .map_err(|_| "window close state lock is unavailable")?
        .resolve(window.label(), &token, Instant::now(), true)?;

    // Rust 内部调用，不授予前端 core:window:allow-destroy。
    if let Err(error) = window.destroy() {
        state
            .0
            .lock()
            .map_err(|_| "window close state lock is unavailable")?
            .destroy_failed();
        return Err(error.to_string());
    }
    Ok(())
}

/// JS: invoke('window_cancel_close', { token })。取消不销毁、不停止业务。
#[tauri::command]
pub fn window_cancel_close(
    app: tauri::AppHandle,
    window: tauri::Window,
    token: String,
) -> Result<(), String> {
    ClosePhase::check_label(window.label())?;
    let state = app
        .try_state::<WindowCloseState>()
        .ok_or("window close state is unavailable")?;
    let result = state
        .0
        .lock()
        .map_err(|_| "window close state lock is unavailable")?
        .resolve(window.label(), &token, Instant::now(), false);
    result
}

/// JS: invoke('window_pending_close') => string | null。先 listen 再 query，并按 token 去重。
#[tauri::command]
pub fn window_pending_close(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<Option<String>, String> {
    ClosePhase::check_label(window.label())?;
    let state = app
        .try_state::<WindowCloseState>()
        .ok_or("window close state is unavailable")?;
    let result = state
        .0
        .lock()
        .map_err(|_| "window close state lock is unavailable")?
        .pending(window.label(), Instant::now());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserve(phase: &mut ClosePhase, now: Instant) -> String {
        phase.reserve(MAIN_LABEL, now).unwrap().unwrap()
    }

    #[test]
    fn duplicate_requests_keep_one_token_and_original_deadline() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        let token = reserve(&mut phase, now);
        assert!(phase
            .reserve(MAIN_LABEL, now + Duration::from_secs(299))
            .unwrap()
            .is_none());
        assert_eq!(phase.pending(MAIN_LABEL, now).unwrap(), Some(token));
        assert!(phase
            .pending(MAIN_LABEL, now + CLOSE_REQUEST_TTL)
            .unwrap()
            .is_none());
    }

    #[test]
    fn cancel_clears_pending_and_next_request_has_fresh_token() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        let token = reserve(&mut phase, now);
        phase.resolve(MAIN_LABEL, &token, now, false).unwrap();
        assert!(phase.pending(MAIN_LABEL, now).unwrap().is_none());
        let next = reserve(&mut phase, now);
        assert_ne!(next, token);
        assert!(phase.resolve(MAIN_LABEL, &token, now, true).is_err());
        assert_eq!(phase.pending(MAIN_LABEL, now).unwrap(), Some(next));
    }

    #[test]
    fn confirmation_consumes_once_and_blocks_new_requests() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        let token = reserve(&mut phase, now);
        phase.resolve(MAIN_LABEL, &token, now, true).unwrap();
        assert!(phase.pending(MAIN_LABEL, now).unwrap().is_none());
        assert!(phase.resolve(MAIN_LABEL, &token, now, true).is_err());
        assert!(phase.resolve(MAIN_LABEL, &token, now, false).is_err());
        assert!(phase.reserve(MAIN_LABEL, now + CLOSE_REQUEST_TTL).is_err());
    }

    #[test]
    fn invalid_tokens_never_clear_valid_pending() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        let token = reserve(&mut phase, now);
        for invalid in ["", "invalid", "00000000-0000-0000-0000-000000000000"] {
            assert!(phase.resolve(MAIN_LABEL, invalid, now, true).is_err());
            assert!(phase.resolve(MAIN_LABEL, invalid, now, false).is_err());
            assert_eq!(phase.pending(MAIN_LABEL, now).unwrap(), Some(token.clone()));
        }
    }

    #[test]
    fn expired_confirmation_fails_closed_and_clears_pending() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        let token = reserve(&mut phase, now);
        assert!(phase
            .resolve(MAIN_LABEL, &token, now + CLOSE_REQUEST_TTL, true)
            .is_err());
        assert!(matches!(phase, ClosePhase::Idle));
        assert_ne!(reserve(&mut phase, now + CLOSE_REQUEST_TTL), token);
    }

    #[test]
    fn expired_cancel_cannot_affect_a_new_request() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        let token = reserve(&mut phase, now);
        let next = reserve(&mut phase, now + CLOSE_REQUEST_TTL);
        assert!(phase
            .resolve(MAIN_LABEL, &token, now + CLOSE_REQUEST_TTL, false)
            .is_err());
        assert_eq!(
            phase.pending(MAIN_LABEL, now + CLOSE_REQUEST_TTL).unwrap(),
            Some(next)
        );
    }

    #[test]
    fn token_is_valid_just_before_timeout() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        let token = reserve(&mut phase, now);
        phase
            .resolve(
                MAIN_LABEL,
                &token,
                now + CLOSE_REQUEST_TTL - Duration::from_nanos(1),
                true,
            )
            .unwrap();
        assert!(matches!(phase, ClosePhase::Destroying));
    }

    #[test]
    fn commands_reject_other_window_labels_without_mutating_pending() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        assert!(phase.reserve("other", now).is_err());
        assert!(matches!(phase, ClosePhase::Idle));
        let token = reserve(&mut phase, now);
        assert!(phase.pending("other", now).is_err());
        assert!(phase.resolve("other", &token, now, true).is_err());
        assert!(phase.resolve("other", &token, now, false).is_err());
        assert_eq!(phase.pending(MAIN_LABEL, now).unwrap(), Some(token));
    }

    #[test]
    fn absent_request_never_authorizes_confirmation_or_cancel() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        assert!(phase.pending(MAIN_LABEL, now).unwrap().is_none());
        assert!(phase.resolve(MAIN_LABEL, "anything", now, true).is_err());
        assert!(phase.resolve(MAIN_LABEL, "anything", now, false).is_err());
        assert!(matches!(phase, ClosePhase::Idle));
    }

    #[test]
    fn failed_destroy_allows_new_request_but_never_reuses_consumed_token() {
        let now = Instant::now();
        let mut phase = ClosePhase::default();
        let token = reserve(&mut phase, now);
        phase.resolve(MAIN_LABEL, &token, now, true).unwrap();
        phase.destroy_failed();
        assert!(phase.resolve(MAIN_LABEL, &token, now, true).is_err());
        assert_ne!(reserve(&mut phase, now), token);
    }

    #[test]
    fn concurrent_confirmations_have_exactly_one_winner() {
        let now = Instant::now();
        let state = std::sync::Arc::new(WindowCloseState::default());
        let token = reserve(&mut state.0.lock().unwrap(), now);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let state = state.clone();
                let token = token.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    state
                        .0
                        .lock()
                        .unwrap()
                        .resolve(MAIN_LABEL, &token, now, true)
                        .is_ok()
                })
            })
            .collect();
        let winners = workers
            .into_iter()
            .map(|worker| usize::from(worker.join().unwrap()))
            .sum::<usize>();
        assert_eq!(winners, 1);
        assert!(matches!(*state.0.lock().unwrap(), ClosePhase::Destroying));
    }
}

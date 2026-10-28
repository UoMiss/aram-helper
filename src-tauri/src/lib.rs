mod lcu;
mod window_layout;

use lcu::{ActiveGame, FriendSummary, GameResult, LcuConnection, MatchSummary};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// 应用状态
pub struct AppState {
    /// 本地存储路径
    pub history_path: Mutex<PathBuf>,
    /// 缓存的 LCU 连接凭证 (port, token)，避免每次命令都执行 wmic
    pub lcu_credentials: Mutex<Option<(String, String)>>,
    /// 文件 I/O 锁
    pub file_lock: Mutex<()>,
}

// ────── LCU 连接（带缓存） ──────

async fn get_connection(state: &AppState) -> Result<LcuConnection, String> {
    // 先尝试用缓存的凭证
    let cached = state.lcu_credentials.lock().unwrap().clone();
    if let Some((port, token)) = cached {
        match LcuConnection::from_credentials(port.clone(), token.clone()).await {
            Ok(conn) => {
                // 验证连接是否还有效
                if conn.get_current_summoner().await.is_ok() {
                    return Ok(conn);
                }
            }
            Err(_) => {}
        }
        // 缓存失效，清除
        *state.lcu_credentials.lock().unwrap() = None;
    }

    // 重新检测
    let conn = LcuConnection::connect().await.map_err(|e| e.to_string())?;
    // 缓存凭证
    let (port, token) = conn.credentials();
    *state.lcu_credentials.lock().unwrap() = Some((port, token));
    Ok(conn)
}

// ────── 本地存储 ──────

fn load_stored_results(path: &std::path::Path) -> HashMap<i64, GameResult> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_game_result(state: &AppState, result: &GameResult) {
    let path = state.history_path.lock().unwrap().clone();
    if path.as_os_str().is_empty() {
        return;
    }
    // 文件锁保护
    let _lock = state.file_lock.lock().unwrap();
    let mut stored = load_stored_results(&path);
    stored.insert(result.game_id, result.clone());
    if let Ok(json) = serde_json::to_string(&stored) {
        let _ = std::fs::write(&path, json);
    }
}

// ────── Tauri 命令 ──────

#[tauri::command]
async fn check_connection(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let conn = get_connection(&state).await?;
    conn.get_current_summoner().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_gameflow_phase(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let conn = get_connection(&state).await?;
    conn.get_gameflow_phase().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_current_game_type(state: tauri::State<'_, AppState>) -> Result<Option<bool>, String> {
    let conn = get_connection(&state).await?;
    conn.get_current_game_type().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_active_game(state: tauri::State<'_, AppState>) -> Result<Option<ActiveGame>, String> {
    let conn = get_connection(&state).await?;
    conn.get_active_game().await.map_err(|e| e.to_string())
}

/// 获取最近一局原始数据并自动存储到本地
#[tauri::command]
async fn get_last_game_result(state: tauri::State<'_, AppState>) -> Result<GameResult, String> {
    let conn = get_connection(&state).await?;
    let result = conn.get_last_game_result().await.map_err(|e| e.to_string())?;
    save_game_result(&state, &result);
    Ok(result)
}

#[tauri::command]
async fn get_match_list(state: tauri::State<'_, AppState>) -> Result<Vec<MatchSummary>, String> {
    let conn = get_connection(&state).await?;
    conn.get_match_list(20).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_friends(state: tauri::State<'_, AppState>) -> Result<Vec<FriendSummary>, String> {
    let conn = get_connection(&state).await?;
    conn.get_friends().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_friend_match_list(puuid: String, state: tauri::State<'_, AppState>) -> Result<Vec<MatchSummary>, String> {
    let conn = get_connection(&state).await?;
    conn.get_friend_match_list(&puuid, 20).await.map_err(|e| e.to_string())
}

// 好友详情按当前登录账号的好友关系读取，不写入或复用自己的战绩缓存。
#[tauri::command]
async fn get_friend_game_result(game_id: i64, puuid: String, state: tauri::State<'_, AppState>) -> Result<GameResult, String> {
    let conn = get_connection(&state).await?;
    conn.get_friend_game_result(game_id, &puuid).await.map_err(|e| e.to_string())
}

/// 获取指定对局结果（优先从本地存储读取）
#[tauri::command]
async fn get_game_result(game_id: i64, state: tauri::State<'_, AppState>) -> Result<GameResult, String> {
    let path = state.history_path.lock().unwrap().clone();
    if !path.as_os_str().is_empty() {
        let _lock = state.file_lock.lock().unwrap();
        let stored = load_stored_results(&path);
        drop(_lock);
        if let Some(result) = stored.get(&game_id) {
            let my_team = result.players.iter().find(|p| p.is_me).and_then(|p| p.team_id);
            let has_both_teams = my_team.is_some()
                && result.players.iter().any(|p| p.team_id.is_some() && p.team_id != my_team);
            if result.is_custom_game.is_some() && result.players.iter().all(|p| p.team_id.is_some()) && has_both_teams {
                return Ok(result.clone());
            }
        }
    }
    let conn = get_connection(&state).await?;
    let result = conn.get_game_result(game_id).await.map_err(|e| e.to_string())?;
    save_game_result(&state, &result);
    Ok(result)
}

/// 默认贴右上角；切换页面时保留拖动位置，并限制在当前显示器工作区内。
fn update_window_layout(window: &tauri::WebviewWindow, height: u32, initial: bool) -> tauri::Result<()> {
    let monitor = window.current_monitor()?.or(window.primary_monitor()?);
    let Some(monitor) = monitor else {
        return window.set_size(tauri::LogicalSize::new(420.0, height.clamp(160, 820) as f64));
    };
    let area = monitor.work_area();
    let scale = window.scale_factor()?;
    let margin = (12.0 * scale).round() as u32;
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let frame = (outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height));
    let current = if initial { None } else { Some(window.outer_position()?) };
    let desired = ((420.0 * scale).round() as u32, (height.clamp(160, 820) as f64 * scale).round() as u32);
    let size = window_layout::inner_size(desired, (area.size.width, area.size.height), frame, margin);
    window.set_size(tauri::PhysicalSize::new(size.0, size.1))?;
    let outer = window.outer_size()?;
    let (x, y) = window_layout::window_position(
        (area.position.x, area.position.y), (area.size.width, area.size.height),
        (outer.width, outer.height), current.map(|p| (p.x, p.y)), margin,
    );
    window.set_position(tauri::PhysicalPosition::new(x, y))
}

#[tauri::command]
async fn resize_window(window: tauri::WebviewWindow, height: u32) -> Result<(), String> {
    update_window_layout(&window, height, false).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            history_path: Mutex::new(PathBuf::new()),
            lcu_credentials: Mutex::new(None),
            file_lock: Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![
            check_connection,
            get_gameflow_phase,
            get_current_game_type,
            get_active_game,
            get_last_game_result,
            get_match_list,
            get_friends,
            get_friend_match_list,
            get_friend_game_result,
            get_game_result,
            resize_window
        ])
        .on_window_event(|window, event| {
            // 关闭窗口时改为隐藏到托盘（用户从托盘菜单"退出"才真正退出）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            use tauri::Manager;

            // 初始化本地存储路径
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir);
                let history_path = data_dir.join("game_history.json");
                *app.state::<AppState>().history_path.lock().unwrap() = history_path;
            }

            // 系统托盘
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LOL 红包局助手")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘图标 → 显示/聚焦窗口
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = update_window_layout(&window, 420, true) {
                    eprintln!("初始化窗口位置失败：{error}");
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}

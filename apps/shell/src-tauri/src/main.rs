// NEXUS Shell — thin, native, always-on.
// Window/tray, global push-to-talk shortcut, Runner sidecar supervision,
// Stronghold vault, notifications. The Runner does the thinking.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod secrets;
mod sidecar;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn main() {
    let conn = sidecar::RunnerConn::generate();

    // The HUD reads connection info synchronously before any script runs —
    // the token never touches the DOM, network, or disk on the UI side.
    let init_script = format!(
        "window.__NEXUS__ = {{ port: {}, token: \"{}\" }};",
        conn.port, conn.token
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch → focus the existing window instead.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(secrets::stronghold_plugin())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(conn.clone())
        .invoke_handler(tauri::generate_handler![
            commands::runner_conn,
            commands::push_secrets_to_runner
        ])
        .setup(move |app| {
            // 1) Spawn + supervise the Runner sidecar (restarts on crash).
            sidecar::spawn_and_supervise(app.handle().clone(), conn.clone());

            // 2) Global push-to-talk: Ctrl+Shift+Space focuses Nexus and
            //    signals the HUD to start/stop listening.
            let ptt = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            let handle = app.handle().clone();
            app.global_shortcut().on_shortcut(ptt, move |_app, _sc, event| {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                    let phase = match event.state() {
                        ShortcutState::Pressed => "down",
                        ShortcutState::Released => "up",
                    };
                    let _ = win.eval(&format!(
                        "window.dispatchEvent(new CustomEvent('nexus:ptt', {{ detail: '{phase}' }}))"
                    ));
                }
            })?;

            Ok(())
        })
        .append_invoke_initialization_script(init_script)
        .run(tauri::generate_context!())
        .expect("error while running nexus shell");
}

//! Minimal typed IPC surface for the HUD.

use crate::sidecar::RunnerConn;
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

#[derive(Serialize)]
pub struct ConnInfo {
    pub port: u16,
    pub token: String,
}

/// Fallback for the init-script injection (e.g. after a webview reload).
#[tauri::command]
pub fn runner_conn(conn: State<'_, RunnerConn>) -> ConnInfo {
    ConnInfo {
        port: conn.port,
        token: conn.token.clone(),
    }
}

/// Forward Stronghold-unlocked secrets to the Runner's in-memory store
/// over the authed loopback API (never through the DOM or disk).
#[tauri::command]
pub async fn push_secrets_to_runner(
    conn: State<'_, RunnerConn>,
    entries: HashMap<String, String>,
) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/internal/secrets", conn.port);
    let body = serde_json::to_string(&entries).map_err(|e| e.to_string())?;
    let token = conn.token.clone();

    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let host = url
            .strip_prefix("http://")
            .and_then(|r| r.split('/').next())
            .ok_or("bad url")?
            .to_string();
        let mut stream = TcpStream::connect(&host).map_err(|e| e.to_string())?;
        let req = format!(
            "POST /internal/secrets HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        let mut resp = String::new();
        let _ = stream.read_to_string(&mut resp);
        if resp.contains("200") {
            Ok(())
        } else {
            Err(format!("runner rejected secrets push: {}", resp.lines().next().unwrap_or("")))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

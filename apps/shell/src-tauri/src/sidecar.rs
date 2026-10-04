//! Runner sidecar supervision: spawn with env, heartbeat via /health,
//! restart with backoff if it dies. The Runner owns all state; the Shell
//! only keeps it alive.

use rand::RngCore;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Clone)]
pub struct RunnerConn {
    pub port: u16,
    pub token: String,
}

impl RunnerConn {
    pub fn generate() -> Self {
        let mut bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
        Self { port: 4571, token }
    }
}

fn spawn_once(app: &AppHandle, conn: &RunnerConn) -> tauri::Result<()> {
    let data_dir = app
        .path()
        .app_data_dir()
        .expect("no app data dir")
        .join("nexus");
    let resource_dir = app.path().resource_dir().expect("no resource dir");
    let bin_dir = resource_dir.join("binaries");

    let sidecar = app
        .shell()
        .sidecar("nexus-runner")
        .expect("nexus-runner sidecar missing")
        .env("NEXUS_AUTH_TOKEN", &conn.token)
        .env("NEXUS_PORT", conn.port.to_string())
        .env("NEXUS_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env(
            "NEXUS_WHISPER_BIN",
            bin_dir.join("whisper-cli.exe").to_string_lossy().to_string(),
        )
        .env(
            "NEXUS_WHISPER_MODEL",
            bin_dir
                .join("ggml-base.en.bin")
                .to_string_lossy()
                .to_string(),
        )
        .env(
            "NEXUS_PIPER_BIN",
            bin_dir.join("piper.exe").to_string_lossy().to_string(),
        )
        .env(
            "NEXUS_PIPER_VOICE",
            bin_dir
                .join("en_US-lessac-medium.onnx")
                .to_string_lossy()
                .to_string(),
        );

    let (mut rx, _child) = sidecar.spawn()?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    print!("[runner] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprint!("[runner!] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[shell] runner terminated: {status:?}");
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Spawn the Runner and keep it alive: poll /health every 5s; after 3
/// consecutive failures, respawn (bounded exponential backoff).
pub fn spawn_and_supervise(app: AppHandle, conn: RunnerConn) {
    let _ = spawn_once(&app, &conn);

    tauri::async_runtime::spawn(async move {
        let health_url = format!("http://127.0.0.1:{}/health", conn.port);
        let mut failures: u32 = 0;
        let mut backoff_secs: u64 = 2;
        loop {
            tokio_sleep(Duration::from_secs(5)).await;
            let alive = ureq_health(&health_url).await;
            if alive {
                failures = 0;
                backoff_secs = 2;
            } else {
                failures += 1;
                if failures >= 3 {
                    eprintln!("[shell] runner unhealthy — respawning in {backoff_secs}s");
                    tokio_sleep(Duration::from_secs(backoff_secs)).await;
                    backoff_secs = (backoff_secs * 2).min(60);
                    failures = 0;
                    let _ = spawn_once(&app, &conn);
                }
            }
        }
    });
}

async fn tokio_sleep(d: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d))
        .await
        .ok();
}

/// Minimal std-only health probe (no HTTP client dependency).
async fn ureq_health(url: &str) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let Some((host, path)) = rest.split_once('/') else {
        return false;
    };
    let host = host.to_string();
    let path = format!("/{path}");
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut stream) = TcpStream::connect(&host) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        if stream.write_all(req.as_bytes()).is_err() {
            return false;
        }
        let mut buf = String::new();
        let _ = stream.read_to_string(&mut buf);
        buf.contains("200") && buf.contains("alive")
    })
    .await
    .unwrap_or(false)
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tauri_plugin_updater::UpdaterExt;

struct Service(Mutex<Option<CommandChild>>);
static READY: AtomicBool = AtomicBool::new(false);

fn stop_service(app: &tauri::AppHandle) {
    let child = app.state::<Service>().0.lock().unwrap().take();
    if let Some(mut child) = child {
        // Give the JS host time to close PTYs and flush/stop its child services.
        let _ = child.write(b"shutdown\n");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = child.kill();
    }
}

#[tauri::command]
fn ready(window: tauri::WebviewWindow) -> Result<(), String> {
    READY.store(true, Ordering::Release);
    window.show().map_err(|e| e.to_string())
}

#[tauri::command]
fn finish_close(window: tauri::WebviewWindow) -> Result<(), String> {
    READY.store(false, Ordering::Release);
    window.destroy().map_err(|e| e.to_string())?;
    window.app_handle().exit(0);
    Ok(())
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, file: String) -> Result<(), String> {
    if file != "tauri-updater" {
        return Err("Unknown update request".into());
    }
    let feed = option_env!("SULFUR_UPDATE_FEED").unwrap_or("");
    let key = option_env!("SULFUR_UPDATE_PUBKEY").unwrap_or("");
    if feed.is_empty() || key.is_empty() {
        return Err("No signed update feed in this build".into());
    }
    let endpoint = format!(
        "{}/sulfur-{{{{target}}}}-{{{{arch}}}}.json",
        feed.trim_end_matches('/')
    );
    let updater = app
        .updater_builder()
        .on_before_exit({
            let app = app.clone();
            move || {
                READY.store(false, Ordering::Release);
                stop_service(&app);
            }
        })
        .pubkey(if key.trim().starts_with("untrusted comment:") {
            BASE64.encode(key.trim())
        } else if BASE64
            .decode(key.trim())
            .is_ok_and(|bytes| bytes.len() == 42)
        {
            BASE64.encode(format!(
                "untrusted comment: Sulfur update key\n{}\n",
                key.trim()
            ))
        } else {
            key.trim().to_owned()
        })
        .endpoints(vec![endpoint
            .parse::<tauri::Url>()
            .map_err(|e| e.to_string())?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No newer update")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())
}

fn open_window(app: &tauri::AppHandle, origin: &str) -> Result<(), Box<dyn std::error::Error>> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let origin_url: tauri::Url = origin.parse()?;
    // only the hosts capabilities/main.json grants: a capability URL pattern can't name [::1]
    if origin_url.scheme() != "http"
        || !matches!(origin_url.host_str(), Some("127.0.0.1" | "localhost"))
    {
        return Err("The service must use loopback HTTP on 127.0.0.1 or localhost".into());
    }
    let allowed = origin_url.origin().ascii_serialization();
    let script = include_str!("bridge.js").replace("http://127.0.0.1:47615", &allowed);
    let builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(format!("{allowed}/sulfur/").parse()?),
    )
    .title("Sulfur")
    .inner_size(1320.0, 860.0)
    .min_inner_size(640.0, 420.0)
    .decorations(cfg!(target_os = "macos"))
    .visible(false)
    .initialization_script(script)
    .on_navigation(move |url| url.origin().ascii_serialization() == allowed);
    #[cfg(target_os = "windows")]
    let builder = builder.data_directory(
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or(std::env::temp_dir())
            .join("dev.phosphorus.sulfur/EBWebView"),
    );
    #[cfg(target_os = "linux")]
    let builder = builder.data_directory(
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
                    .join(".local/share")
            })
            .join("dev.phosphorus.sulfur"),
    );
    builder.build()?;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.show();
        }
    });
    Ok(())
}

fn main() {
    // Keep the old executable's SSH helper commands usable without opening a
    // window or entering the single-instance desktop plugin.
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "sulfur-language" || arg == "sulfur-sqlite")
        || args.iter().any(|arg| {
            matches!(
                arg.to_str(),
                Some("-headless" | "--headless" | "-headless=true" | "--headless=true")
            )
        })
    {
        let result = (|| -> Result<i32, Box<dyn std::error::Error>> {
            let exe = std::env::current_exe()?;
            let directory = exe.parent().ok_or("No executable directory")?;
            let service = directory.join(if cfg!(windows) {
                "sulfur-service.exe"
            } else {
                "sulfur-service"
            });
            let bridge = if cfg!(target_os = "macos") {
                directory.join("../Resources/resources/lsp-ipc.cjs")
            } else if cfg!(target_os = "linux") {
                directory.join("../lib/sulfur/resources/lsp-ipc.cjs")
            } else {
                directory.join("resources/lsp-ipc.cjs")
            };
            let status = std::process::Command::new(service)
                .args(&args)
                .args([
                    std::ffi::OsStr::new("--dist"),
                    bridge
                        .parent()
                        .ok_or("No resource directory")?
                        .join("dist")
                        .as_os_str(),
                ])
                .env("SULFUR_IPC_BRIDGE", &bridge)
                .status()?;
            Ok(status.code().unwrap_or(1))
        })();
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(Service(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            ready,
            finish_close,
            install_update
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if READY.load(Ordering::Acquire) {
                    api.prevent_close();
                    // scripts run in the window's webview, not the window
                    if let Some(webview) = window.get_webview_window(window.label()) {
                        let _ = webview.eval("window.dispatchEvent(new Event('sulfur-close'))");
                    }
                }
            }
        })
        .setup(|app| {
            if std::env::var_os("SULFUR_SERVICE_EXTERNAL").is_some() {
                open_window(app.handle(), "http://127.0.0.1:47615")?;
                return Ok(());
            }
            let resources = app.path().resource_dir()?;
            let dist = resources.join("resources/dist");
            let bridge = resources.join("resources/lsp-ipc.cjs");
            let (mut events, child) = app
                .shell()
                .sidecar("sulfur-service")?
                .set_process_group(true)
                .args(std::env::args_os().skip(1))
                .args(["--dist", &dist.to_string_lossy()])
                .env("SULFUR_NATIVE", "1")
                .env("SULFUR_IPC_BRIDGE", bridge.to_string_lossy().as_ref())
                .spawn()?;
            *app.state::<Service>().0.lock().unwrap() = Some(child);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut buffered = String::new();
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            buffered.push_str(&String::from_utf8_lossy(&bytes));
                            // The shell plugin emits stdout by line; accept both line and raw framing.
                            if let Ok(value) =
                                serde_json::from_str::<serde_json::Value>(buffered.trim())
                            {
                                if value["type"] == "ready" {
                                    if let Err(error) =
                                        open_window(&handle, value["url"].as_str().unwrap_or(""))
                                    {
                                        eprintln!("{error}");
                                        handle.exit(1);
                                    }
                                    buffered.clear();
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprintln!("{}", String::from_utf8_lossy(&bytes))
                        }
                        CommandEvent::Terminated(_) => {
                            if handle.state::<Service>().0.lock().unwrap().is_some() {
                                READY.store(false, Ordering::Release);
                                handle.exit(1);
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unable to start Sulfur");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if READY.load(Ordering::Acquire) {
                api.prevent_exit();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.dispatchEvent(new Event('sulfur-close'))");
                }
                return;
            }
        }
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            stop_service(app);
        }
    });
}

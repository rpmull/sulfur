#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Sulfur's desktop app: the system's web view around the page its own service
// serves, the service running inside this same process. Run with -headless it
// serves alone (for a browser or a test); `sulfur sulfur-language` and
// `sulfur sulfur-sqlite` are the mesh host helpers a Phosphorus host calls.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use sulfur_service::{Options, Service, StartError};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Running(Mutex<Option<Service>>);
static READY: AtomicBool = AtomicBool::new(false);

/// every open file saved and every shell ended before the process goes
fn stop_service(app: &tauri::AppHandle) {
    let service = app.state::<Running>().0.lock().unwrap().take();
    if let Some(service) = service {
        tauri::async_runtime::block_on(service.stop());
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

/// the release key as Tauri's updater takes it, whichever way it was given
fn update_key(key: &str) -> String {
    let key = key.trim();
    if key.starts_with("untrusted comment:") {
        BASE64.encode(key)
    } else if BASE64.decode(key).is_ok_and(|bytes| bytes.len() == 42) {
        BASE64.encode(format!("untrusted comment: Sulfur update key\n{key}\n"))
    } else {
        key.to_owned()
    }
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
    let endpoint = format!("{}/sulfur-{{{{target}}}}-{{{{arch}}}}.json", feed.trim_end_matches('/'));
    let updater = app
        .updater_builder()
        .on_before_exit({
            let app = app.clone();
            move || {
                READY.store(false, Ordering::Release);
                stop_service(&app);
            }
        })
        .pubkey(update_key(key))
        .endpoints(vec![endpoint.parse::<tauri::Url>().map_err(|e| e.to_string())?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?.ok_or("No newer update")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())
}

fn open_window(app: &tauri::AppHandle, origin: &str) -> Result<(), Box<dyn std::error::Error>> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let origin_url: tauri::Url = origin.parse()?;
    // only the hosts capabilities/main.json grants: a capability URL pattern can't name [::1]
    if origin_url.scheme() != "http" || !matches!(origin_url.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err("The service must use loopback HTTP on 127.0.0.1 or localhost".into());
    }
    let allowed = origin_url.origin().ascii_serialization();
    let script = include_str!("bridge.js").replace("http://127.0.0.1:47615", &allowed);
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("{allowed}/sulfur/").parse()?))
        .title("Sulfur")
        .inner_size(1320.0, 860.0)
        .min_inner_size(640.0, 420.0)
        .decorations(cfg!(target_os = "macos"))
        .visible(false)
        .background_color(tauri::window::Color(30, 30, 30, 255))
        .initialization_script(script)
        .on_navigation(move |url| url.origin().ascii_serialization() == allowed);
    #[cfg(target_os = "windows")]
    let builder = builder.data_directory(
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(std::env::temp_dir())
            .join("dev.phosphorus.sulfur/EBWebView"),
    );
    #[cfg(target_os = "linux")]
    let builder = builder.data_directory(
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/share"))
            .join("dev.phosphorus.sulfur"),
    );
    builder.build()?;
    // the window shown even if the page never says it's ready
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.show();
        }
    });
    Ok(())
}

/// an option's value, as -name value, --name value or --name=value
fn option(args: &[String], name: &str) -> Option<String> {
    for (i, a) in args.iter().enumerate() {
        let bare = a.trim_start_matches('-');
        if a.starts_with('-') && bare == name {
            return args.get(i + 1).cloned();
        }
        if let Some(v) = bare.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
            if a.starts_with('-') {
                return Some(v.to_owned());
            }
        }
    }
    None
}

fn service_options(args: &[String], native: bool) -> Options {
    Options {
        addr: option(args, "addr").unwrap_or_else(|| "127.0.0.1:47615".into()),
        config: option(args, "config").filter(|c| !c.is_empty()).map(PathBuf::from),
        dist: option(args, "dist").map(PathBuf::from),
        version: VERSION.into(),
        native,
        machine: None,
    }
}

/// the service alone, until it's interrupted
fn headless(args: &[String]) -> i32 {
    sulfur_service::util::adopt_login_path();
    tauri::async_runtime::block_on(async {
        let service = match sulfur_service::start(service_options(args, false)).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{e}");
                return 1;
            }
        };
        println!("{}", serde_json::json!({ "type": "ready", "url": service.origin, "version": VERSION }));
        eprintln!("Sulfur {VERSION} on {}", service.origin);
        sulfur_service::util::interrupted().await;
        service.stop().await;
        0
    })
}

fn main() {
    // run by ssh or git as their askpass program: the prompt goes to the page, nothing else starts
    if let Some(code) = sulfur_service::askpass::helper_main() {
        std::process::exit(code);
    }
    if let Ok(exe) = std::env::current_exe() {
        sulfur_service::askpass::set_helper(exe);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("sulfur-language") if args.len() == 2 => {
            std::process::exit(tauri::async_runtime::block_on(sulfur_service::languages::helper_main(&args[1])))
        }
        Some("sulfur-sqlite") => std::process::exit(sulfur_service::sqlite::helper_main()),
        _ => {}
    }
    if args.iter().any(|a| matches!(a.as_str(), "-headless" | "--headless" | "-headless=true" | "--headless=true")) {
        std::process::exit(headless(&args));
    }
    sulfur_service::util::adopt_login_path();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Running(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![ready, finish_close, install_update])
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
        .setup(move |app| {
            if std::env::var_os("SULFUR_SERVICE_EXTERNAL").is_some() {
                open_window(app.handle(), "http://127.0.0.1:47615")?;
                return Ok(());
            }
            let mut options = service_options(&args, true);
            let addr = options.addr.clone();
            // the service listens before the window asks it for the page: binding a
            // loopback port takes about a millisecond
            let started = tauri::async_runtime::block_on(async {
                match sulfur_service::start(Options { addr: addr.clone(), ..service_options(&args, true) }).await {
                    Err(StartError::InUse(_)) => {
                        // another Sulfur already serving this computer: this window opens on it
                        if let Some(origin) = sulfur_service::existing(&addr).await {
                            return Ok(Err(origin));
                        }
                        options.addr = "127.0.0.1:0".into();
                        sulfur_service::start(options).await.map(Ok)
                    }
                    other => other.map(Ok),
                }
            })?;
            match started {
                Ok(service) => {
                    let origin = service.origin.clone();
                    *app.state::<Running>().0.lock().unwrap() = Some(service);
                    open_window(app.handle(), &origin)?;
                }
                Err(origin) => open_window(app.handle(), &origin)?,
            }
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
        if matches!(event, tauri::RunEvent::Exit) {
            stop_service(app);
        }
    });
}

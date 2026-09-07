// M0 scaffold — verify with cargo check once Rust is installed.
//
// INTENT (per PLAN-M0.md): the Tauri shell is a thin host. On startup it
// spawns the Partner core (Node sidecar — packaging decision in
// core/docs/spike-sidecar.md: bundled Node runtime, i.e. `partner-core` IS the
// node binary and the bundled JS lives under Tauri resources), waits for the
// loopback HTTP server on 127.0.0.1:4390, and shows the webview pointed at
// it (window declared in tauri.conf.json). Core child is killed on exit.
//
// M15 (live desktop mode): the shell boots the core LIVE by default —
// persistent whole-file-encrypted DB + OS-keychain key under the per-user
// app-local data dir, skills installed under that same dir, and a per-boot
// device secret handed to the core so the tray can mint the live pairing
// code (GET /v1/pair/device) for the web PairGate. PARTNER_DEMO_MODE=1 keeps
// the old in-memory demo boot (dev/CI/webapp container). Tray = Show pairing
// code / Open Partner / Quit.
//
// Not-yet-implemented (future milestones): autostart, updater, and
// restart/recovery policy when the core dies.

#![cfg_attr(mobile, tauri::mobile_entry_point)]

use std::fs;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Loopback origin the core serves (matches core/src/config.ts PORT default).
pub const CORE_URL: &str = "http://127.0.0.1:4390";
pub const CORE_HOST: &str = "127.0.0.1";
pub const CORE_PORT: u16 = 4390;

/// Sidecar base name registered via `bundle.externalBin`; Tauri renames the
/// per-triple build artifact to this name at bundle time (binaries/README.md).
pub const CORE_SIDECAR: &str = "partner-core";

/// M15: the per-boot secret the shell generates and hands to the core, so the
/// tray can mint pairing codes over the header-guarded device channel.
struct DeviceSecret(String);

/// Strips the `\\?\` verbatim prefix tauri's path resolver returns on Windows
/// (node's CJS loader cannot resolve verbatim main-script paths).
fn normalize_win_path(p: std::path::PathBuf) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if let Some(s) = p.to_str() {
            if let Some(stripped) = s.strip_prefix(r"\\?\") {
                return std::path::PathBuf::from(stripped);
            }
        }
    }
    p
}

/// Polls the loopback port until the core accepts connections.
fn wait_for_core(timeout: Duration) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::net::TcpStream::connect((CORE_HOST, CORE_PORT)).is_ok() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("core sidecar did not listen on {CORE_URL} within {timeout:?}"),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Owns the core child process; `kill()` runs when the app (and this managed
/// state) drops, so the sidecar never outlives the shell.
struct CoreChild(Option<CommandChild>);

impl Drop for CoreChild {
    fn drop(&mut self) {
        // kill(self) consumes the child, so take it out of the Option first.
        if let Some(child) = self.0.take() {
            let _ = child.kill();
        }
    }
}

/// Spawns the core sidecar and forwards its stdout/stderr to the shell logs.
///
/// The sidecar is the platform node runtime binary (renamed partner-core
/// by tauri-build). It needs ONE argument — the bundled core script — which
/// ships under Tauri resources next to the web UI. Bundled-node runtime per
/// core/docs/spike-sidecar.md.
///
/// Resource layout (built by the windows-build workflow):
///   resources/core-bundle.cjs        (esbuild CJS bundle of core/src)
///   resources/node_modules/…         (vendored better-sqlite3 + keyring)
///   resources/web-dist/              (built web UI, served by the core)
///   resources/skills-catalog/        (read-only shipped skill catalog)
///
/// Dev fallbacks: PARTNER_CORE_BUNDLE / PARTNER_STATIC_DIR point at a
/// host-side bundle + web dist when the resources were not staged;
/// PARTNER_NO_SIDECAR skips the spawn entirely (headless gate smoke).
///
/// M15 env policy:
///  - LIVE (default): DEMO_MODE=0, DB_PATH + SKILLS_DIR under the per-user
///    app-local data dir (created here), PARTNER_DEVICE_SECRET set. The OS
///    keychain (native) holds the DB cipher key.
///  - DEMO (PARTNER_DEMO_MODE=1): the historical env-free boot — in-memory
///    DB, fake keychain, /v1/dev/pair-code seam; skills stay under the
///    staged resources dir (throwaway).
fn spawn_core(app: &tauri::App, demo: bool) -> Result<(), Box<dyn std::error::Error>> {
    let res_dir = app.path().resource_dir()?;
    // tauri returns verbatim (`\\?\`-prefixed) paths on Windows; node cannot
    // load a `\\?\C:\...` main script (its loader lstat's `C:` and dies), so
    // normalize before handing paths to the sidecar.
    let res_dir = normalize_win_path(res_dir);
    // NSIS per-user installs place bundle.resources under <exe>/resources;
    // dev runs (and other bundlers) put them flat at resource_dir. Resolve
    // whichever layout actually staged the bundle.
    let staged_root = {
        let nested = res_dir.join("resources");
        if nested.join("core-bundle.cjs").is_file() {
            nested
        } else {
            res_dir.clone()
        }
    };
    let staged_bundle = staged_root.join("core-bundle.cjs");
    let staged_web = staged_root.join("web-dist");
    let bundle: std::path::PathBuf = if staged_bundle.exists() {
        staged_bundle
    } else if let Some(p) = std::env::var_os("PARTNER_CORE_BUNDLE") {
        std::path::PathBuf::from(p)
    } else {
        eprintln!(
            "[shell] core bundle not staged under resources — start the core \
             separately on :4390 or set PARTNER_CORE_BUNDLE"
        );
        return Ok(());
    };
    let web: Option<std::path::PathBuf> = if staged_web.is_dir() {
        Some(staged_web)
    } else {
        std::env::var_os("PARTNER_STATIC_DIR").map(std::path::PathBuf::from)
    };

    let mut cmd = app.shell().sidecar(CORE_SIDECAR)?;
    cmd = cmd.arg(bundle.to_string_lossy().to_string());
    let mut envs: Vec<(String, String)> = vec![
        ("PORT".to_string(), CORE_PORT.to_string()),
        ("HOST".to_string(), CORE_HOST.to_string()),
    ];
    if let Some(dir) = web {
        envs.push(("STATIC_DIR".to_string(), dir.to_string_lossy().to_string()));
    }
    // M15 lifecycle: the shell owns the core. stdin is piped to the sidecar
    // and stays open while the shell lives; the core watches for EOF and
    // exits itself if the shell dies by ANY path (graceful quit, crash,
    // force-kill) — no orphan core ever holds :4390 or the DB lock.
    envs.push(("PARTNER_PARENT_WATCH".to_string(), "1".to_string()));
    if demo {
        // Historical demo boot (PARTNER_DEMO_MODE=1): in-memory + fake keychain.
        envs.push(("DEMO_MODE".to_string(), "1".to_string()));
        // Keep skills out of cwd-dependent paths in packaged runs (staged dir).
        envs.push(("SKILLS_DIR".to_string(), staged_root.join("skills").to_string_lossy().to_string()));
        envs.push((
            "SKILLS_CATALOG_DIR".to_string(),
            staged_root.join("skills-catalog").to_string_lossy().to_string(),
        ));
    } else {
        // M15 live boot: persistent encrypted data under the per-user
        // app-local data dir (LOCALAPPDATA on Windows), not the install dir —
        // upgrades replace resources/ but must never touch user data.
        let data_dir = app.path().app_local_data_dir()?;
        fs::create_dir_all(&data_dir)?;
        let skills_dir = data_dir.join("skills");
        fs::create_dir_all(&skills_dir)?;
        envs.push(("DEMO_MODE".to_string(), "0".to_string()));
        envs.push((
            "DB_PATH".to_string(),
            data_dir.join("partner.db").to_string_lossy().to_string(),
        ));
        envs.push(("SKILLS_DIR".to_string(), skills_dir.to_string_lossy().to_string()));
        envs.push((
            "SKILLS_CATALOG_DIR".to_string(),
            staged_root.join("skills-catalog").to_string_lossy().to_string(),
        ));
        // Per-boot device secret: the tray uses it to mint live pairing codes
        // (header-guarded loopback channel; a fresh secret per boot).
        envs.push((
            "PARTNER_DEVICE_SECRET".to_string(),
            app.state::<DeviceSecret>().0.clone(),
        ));
    }
    for (key, value) in envs.iter() {
        cmd = cmd.env(key, value);
    }

    let (mut rx, child) = cmd.spawn()?;
    app.manage(CoreChild(Some(child)));

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    print!("[core] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Stderr(line) => {
                    eprint!("[core] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[core] terminated unexpectedly: code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// M15: ask the core (over the header-guarded loopback device channel) for a
/// fresh 6-digit pairing code. Returns the code on success.
fn fetch_pairing_code(app: &tauri::AppHandle) -> Result<String, String> {
    let secret = &app.state::<DeviceSecret>().0;
    let url = format!("http://{CORE_HOST}:{CORE_PORT}/v1/pair/device");
    let response = ureq::get(&url)
        .set("x-partner-device", secret)
        .call()
        .map_err(|err| format!("Could not reach the Partner core: {err}."))?;
    if response.status() != 200 {
        return Err(format!("The core refused the request (HTTP {}).", response.status()));
    }
    let body = response
        .into_string()
        .map_err(|err| format!("Bad response from the core: {err}."))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "Unexpected core response.".to_string())?;
    json.get("code")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| "The core did not return a code.".to_string())
}

/// Native dialog showing the live pairing code (or the failure reason).
/// Runs on a worker thread: the plugin's blocking dialog must never freeze
/// the main thread (the tray menu event handler is main-thread).
fn show_pairing_code(app: &tauri::AppHandle) {
    let (title, message, kind) = match fetch_pairing_code(app) {
        Ok(code) => (
            "Partner — pairing code".to_string(),
            format!(
                "Your pairing code is:\n\n    {code}\n\n\
                 It expires in about 2 minutes and can be used once. \
                 Type or paste it into the Partner window or browser you want to pair."
            ),
            MessageDialogKind::Info,
        ),
        Err(reason) => (
            "Partner".to_string(),
            format!("{reason}\n\nIs the core running?"),
            MessageDialogKind::Error,
        ),
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = handle
            .dialog()
            .message(message)
            .title(title)
            .kind(kind)
            .buttons(MessageDialogButtons::Ok)
            .blocking_show();
    });
}

/// M15 tray: Show pairing code / Open Partner / Quit. Built from Rust only —
/// no webview IPC or ACL changes.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_code = MenuItem::with_id(app, "pair-code", "Show pairing code…", true, None::<&str>)?;
    let open_window = MenuItem::with_id(app, "open-window", "Open Partner", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Partner", true, None::<&str>)?;
    let separator_a = PredefinedMenuItem::separator(app)?;
    let separator_b = PredefinedMenuItem::separator(app)?;
    let items: [&dyn tauri::menu::IsMenuItem<tauri::Wry>; 5] =
        [&show_code, &separator_a, &open_window, &separator_b, &quit];
    let menu = Menu::with_items(app, &items)?;
    let icon = app
        .default_window_icon()
        .expect("bundled window icon (tauri.conf.json bundle.icon)")
        .clone();
    TrayIconBuilder::with_id("partner-tray")
        .icon(icon)
        .tooltip("Partner")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "pair-code" => show_pairing_code(app),
            "open-window" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // M15: the packaged shell boots LIVE by default; PARTNER_DEMO_MODE=1
            // restores the historical in-memory demo boot (dev/webapp container/
            // CI smoke). The per-boot device secret is generated here and both
            // the core (env) and the tray (state) read it.
            let demo = std::env::var("PARTNER_DEMO_MODE").map(|value| value == "1").unwrap_or(false);
            let secret = std::env::var("PARTNER_DEVICE_SECRET")
                .ok()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            app.manage(DeviceSecret(secret));

            // PARTNER_NO_SIDECAR (headless gate / CI smoke): the artifact core
            // is started out-of-band on :4390, so the shell must not double-
            // spawn a sidecar. Normal desktop runs keep the default spawn.
            if std::env::var_os("PARTNER_NO_SIDECAR").is_none() {
                spawn_core(app, demo)?;
            } else {
                println!("[shell] PARTNER_NO_SIDECAR set — skipping core sidecar spawn");
            }
            // Give the core a moment to bind before the webview (declared
            // in tauri.conf.json at CORE_URL) finishes its first navigation.
            match wait_for_core(Duration::from_secs(10)) {
                Ok(()) => println!("[shell] core is up at {CORE_URL}"),
                Err(err) => {
                    // Skeleton behaviour: log and let the webview show its
                    // error page. Real impl: retry policy + dialog.
                    eprintln!("[shell] {err}");
                }
            }
            // The tray is the live pairing surface (code dialog) + window/quit
            // controls. Non-fatal: an environment without a tray (headless
            // service sessions) still runs the app, pairing via demo/env paths.
            match build_tray(app) {
                Ok(()) => println!("[shell] tray ready"),
                Err(err) => eprintln!("[shell] tray unavailable: {err}"),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

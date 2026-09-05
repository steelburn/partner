// M0 scaffold — verify with cargo check once Rust is installed.
//
// INTENT (per PLAN-M0.md): the Tauri shell is a thin host. On startup it
// spawns the Partner core (Node sidecar — packaging decision in
// core/docs/spike-sidecar.md: bundled Node runtime, i.e. `partner-core` IS the
// node binary and the bundled JS lives under Tauri resources), waits for the
// loopback HTTP server on 127.0.0.1:4390, and shows the webview pointed at
// it (window declared in tauri.conf.json). Core child is killed on exit.
//
// Not-yet-implemented (future milestones): tray, autostart, updater,
// restart/recovery policy when the core dies, and pairing notification.

#![cfg_attr(mobile, tauri::mobile_entry_point)]

use std::time::Duration;

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Loopback origin the core serves (matches core/src/config.ts PORT default).
pub const CORE_URL: &str = "http://127.0.0.1:4390";
pub const CORE_HOST: &str = "127.0.0.1";
pub const CORE_PORT: u16 = 4390;

/// Sidecar base name registered via `bundle.externalBin`; Tauri renames the
/// per-triple build artifact to this name at bundle time (binaries/README.md).
pub const CORE_SIDECAR: &str = "partner-core";

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
/// Resource layout (built by shell/docker/gate/run.sh on Linux and
/// shell/windows/build-windows.ps1 on Windows):
///   resources/core-bundle.cjs        (esbuild CJS bundle of core/src)
///   resources/node_modules/…         (vendored better-sqlite3 + keyring)
///   resources/web-dist/              (built web UI, served by the core)
///
/// Dev fallbacks: PARTNER_CORE_BUNDLE / PARTNER_STATIC_DIR point at a
/// host-side bundle + web dist when the resources were not staged;
/// PARTNER_NO_SIDECAR skips the spawn entirely (headless gate smoke).
fn spawn_core(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let res_dir = app.path().resource_dir()?;
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
    let mut envs: Vec<(&str, String)> = vec![
        ("PORT", CORE_PORT.to_string()),
        ("HOST", CORE_HOST.to_string()),
    ];
    if let Some(dir) = web {
        envs.push(("STATIC_DIR", dir.to_string_lossy().to_string()));
    }
    // Keep skills out of cwd-dependent paths in packaged runs.
    envs.push(("SKILLS_DIR", staged_root.join("skills").to_string_lossy().to_string()));
    envs.push(("SKILLS_CATALOG_DIR", staged_root.join("skills-catalog").to_string_lossy().to_string()));
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // PARTNER_NO_SIDECAR (headless gate / CI smoke): the artifact core
            // is started out-of-band on :4390, so the shell must not double-
            // spawn a sidecar. Normal desktop runs keep the default spawn.
            if std::env::var_os("PARTNER_NO_SIDECAR").is_none() {
                spawn_core(app)?;
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

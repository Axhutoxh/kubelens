//! In-app updates from the project's GitHub releases.
//!
//! `GET /api/update/check` compares the latest release with this build. `POST /api/update/install`
//! downloads this platform's release asset, checks its size and SHA-256 digest against the
//! release metadata, and hands over to it:
//! - Windows (installed copy): runs the NSIS installer, then closes Kubellens so files can be replaced
//! - macOS: opens the dmg (the user drags the app to Applications)
//! - Linux AppImage: replaces the AppImage in place and restarts it
//! Other installs (portable exe, deb / rpm) get the release page instead.
//!
//! `KUBELLENS_NO_UPDATE_CHECK` turns checks off (managed machines); `KUBELLENS_UPDATE_URL`
//! points the check at another release JSON (mirrors, tests).

use crate::AppState;
use axum::{http::StatusCode, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tokio::io::AsyncWriteExt;

const REPO: &str = "Axhutoxh/kubelens";
const CURRENT: &str = env!("CARGO_PKG_VERSION");

type ApiError = (StatusCode, String);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/check", get(handle_check))
        .route("/install", post(handle_install))
        .route("/open", post(handle_open))
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Kubellens/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(15))
            // The Linux AppImage is ~85 MB
            .timeout(std::time::Duration::from_secs(15 * 60))
            .build()
            .expect("HTTP client")
    })
}

fn override_url() -> Option<String> {
    std::env::var("KUBELLENS_UPDATE_URL").ok().filter(|v| !v.trim().is_empty())
}

fn release_url() -> String {
    override_url().unwrap_or_else(|| format!("https://api.github.com/repos/{REPO}/releases/latest"))
}

/// Release assets may only come from this project's releases (or the override's server).
fn allowed_download(url: &str) -> bool {
    if url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        return true;
    }
    // "http://host:port/path" -> "http://host:port"
    override_url()
        .map(|o| o.splitn(4, '/').take(3).collect::<Vec<_>>().join("/"))
        .is_some_and(|origin| url.starts_with(&format!("{origin}/")))
}

/// "v1.6.0" / "1.6.0" -> (1, 6, 0). Pre-release suffixes are ignored.
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next().unwrap_or(Some(0))?, parts.next().unwrap_or(Some(0))?))
}

fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InstallKind {
    Installer,
    Dmg,
    AppImage,
}

impl InstallKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Installer => "installer",
            Self::Dmg => "dmg",
            Self::AppImage => "appimage",
        }
    }
}

/// The release asset this build can install itself from, if any.
fn platform_asset() -> Option<(&'static str, InstallKind)> {
    if cfg!(target_os = "windows") {
        // Only installed copies (the NSIS uninstaller sits next to the exe); the portable
        // exe and dev builds are updated from the release page
        let installed = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("uninstall.exe").exists()))
            .unwrap_or(false);
        installed.then_some(("kubellens-setup.exe", InstallKind::Installer))
    } else if cfg!(target_os = "macos") {
        Some(("kubellens-macos-universal.dmg", InstallKind::Dmg))
    } else if std::env::var_os("APPIMAGE").is_some() {
        Some(("kubellens-linux-amd64.AppImage", InstallKind::AppImage))
    } else {
        None
    }
}

struct Release {
    tag: String,
    url: String,
    notes: String,
    published: Option<String>,
    asset: Option<Asset>,
}

struct Asset {
    name: String,
    url: String,
    size: u64,
    /// lower-case hex SHA-256, when GitHub provides it
    sha256: Option<String>,
}

async fn fetch_release() -> Result<Release, String> {
    let res = client()
        .get(release_url())
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GitHub returned {} for the latest release", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("Could not read the release data: {e}"))?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("Unexpected release data: {e}"))?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let wanted = platform_asset().map(|(name, _)| name);
    let asset = v.get("assets").and_then(Value::as_array).into_iter().flatten().find_map(|a| {
        let name = a.get("name")?.as_str()?;
        if Some(name) != wanted {
            return None;
        }
        Some(Asset {
            name: name.to_string(),
            url: a.get("browser_download_url")?.as_str()?.to_string(),
            size: a.get("size").and_then(Value::as_u64).unwrap_or(0),
            sha256: a
                .get("digest")
                .and_then(Value::as_str)
                .and_then(|d| d.strip_prefix("sha256:"))
                .map(str::to_ascii_lowercase),
        })
    });
    Ok(Release {
        tag: s("tag_name"),
        url: s("html_url"),
        notes: s("body").chars().take(20_000).collect(),
        published: v.get("published_at").and_then(Value::as_str).map(str::to_string),
        asset,
    })
}

async fn handle_check() -> Result<Json<Value>, ApiError> {
    if std::env::var_os("KUBELLENS_NO_UPDATE_CHECK").is_some() {
        return Ok(Json(json!({ "current": CURRENT, "available": false, "disabled": true })));
    }
    let r = fetch_release().await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let available = is_newer(&r.tag, CURRENT);
    Ok(Json(json!({
        "current": CURRENT,
        "latest": r.tag.trim_start_matches(['v', 'V']),
        "available": available,
        "notes": r.notes,
        "url": r.url,
        "publishedAt": r.published,
        // What "Install" will do on this machine; null means "use the release page"
        "install": r.asset.as_ref().and_then(|_| platform_asset()).map(|(_, k)| k.as_str()),
    })))
}

#[derive(Deserialize)]
struct OpenRequest {
    url: String,
}

/// Opens the release page; only this project's release pages are allowed.
async fn handle_open(Json(req): Json<OpenRequest>) -> Result<Json<Value>, ApiError> {
    if !req.url.starts_with(&format!("https://github.com/{REPO}/releases")) {
        return Err((StatusCode::BAD_REQUEST, "URL not allowed".into()));
    }
    crate::browser::open(&req.url).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "success": true })))
}

/// Downloads the asset to `dest`, checking size and digest; removes the file on failure.
async fn download(asset: &Asset, dest: &std::path::Path) -> Result<(), String> {
    let result = async {
        let mut res = client().get(&asset.url).send().await.map_err(|e| format!("Download failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("Download failed: {}", res.status()));
        }
        let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut len = 0u64;
        while let Some(chunk) = res.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
            hasher.update(&chunk);
            len += chunk.len() as u64;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        file.flush().await.map_err(|e| e.to_string())?;
        if asset.size > 0 && len != asset.size {
            return Err(format!("Download incomplete ({len} of {} bytes)", asset.size));
        }
        if let Some(expected) = &asset.sha256 {
            let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
            if &actual != expected {
                return Err("The download doesn't match the release's checksum; nothing was installed.".into());
            }
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

/// Closes the app shortly after the response has been sent.
fn exit_soon() {
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        match crate::APP_HANDLE.get() {
            Some(app) => app.exit(0),
            None => std::process::exit(0),
        }
    });
}

async fn handle_install() -> Result<Json<Value>, ApiError> {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err((StatusCode::CONFLICT, "An update is already being installed.".into()));
    }
    let result = install().await;
    RUNNING.store(false, Ordering::SeqCst);
    result.map(Json).map_err(|e| (StatusCode::BAD_GATEWAY, e))
}

async fn install() -> Result<Value, String> {
    let (_, kind) = platform_asset().ok_or("This install can't update itself; download the new version from the release page.")?;
    let release = fetch_release().await?;
    if !is_newer(&release.tag, CURRENT) {
        return Err(format!("Kubellens {CURRENT} is already the latest version."));
    }
    let asset = release.asset.ok_or("The latest release has no download for this platform yet.")?;
    if !allowed_download(&asset.url) {
        return Err("Unexpected download location; open the release page instead.".into());
    }
    let latest = release.tag.trim_start_matches(['v', 'V']).to_string();

    match kind {
        InstallKind::Installer | InstallKind::Dmg => {
            let dir = std::env::temp_dir().join(format!("kubellens-update-{latest}"));
            tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
            let path = dir.join(&asset.name);
            download(&asset, &path).await?;
            if kind == InstallKind::Installer {
                std::process::Command::new(&path).spawn().map_err(|e| format!("Could not start the installer: {e}"))?;
                exit_soon();
                Ok(json!({ "success": true, "action": "installer", "message": format!("The Kubellens {latest} installer has started. Kubellens will close so it can be updated.") }))
            } else {
                std::process::Command::new("open").arg(&path).spawn().map_err(|e| format!("Could not open the disk image: {e}"))?;
                Ok(json!({ "success": true, "action": "dmg", "message": format!("Kubellens {latest} is open in Finder. Quit Kubellens, then drag the new version to Applications and replace the old one.") }))
            }
        }
        InstallKind::AppImage => {
            let target = std::path::PathBuf::from(std::env::var_os("APPIMAGE").ok_or("APPIMAGE is not set")?);
            let staging = target.with_file_name(format!(".{}.update", asset.name));
            download(&asset, &staging).await?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            }
            // Rename is atomic on the same file system; the running copy keeps its open inode
            std::fs::rename(&staging, &target).map_err(|e| format!("Could not replace {}: {e}", target.display()))?;
            std::process::Command::new(&target).spawn().map_err(|e| format!("Updated, but could not restart: {e}"))?;
            exit_soon();
            Ok(json!({ "success": true, "action": "appimage", "message": format!("Updated to Kubellens {latest}. Restarting…") }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("v1.6.0", "1.5.0"));
        assert!(is_newer("v1.10.0", "1.9.3"));
        assert!(is_newer("2.0", "1.99.99"));
        assert!(!is_newer("v1.5.0", "1.5.0"));
        assert!(!is_newer("v1.4.9", "1.5.0"));
        assert!(!is_newer("v1.6.0-beta.1", "1.6.0"));
        assert!(!is_newer("nightly", "1.5.0"));
    }

    #[test]
    fn only_downloads_from_this_projects_releases() {
        assert!(allowed_download(&format!("https://github.com/{REPO}/releases/download/v1.6.0/kubellens-setup.exe")));
        assert!(!allowed_download("https://github.com/someone/else/releases/download/v1/kubellens-setup.exe"));
        assert!(!allowed_download("https://example.com/kubellens-setup.exe"));
    }
}

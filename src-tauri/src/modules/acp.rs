//! Agent Client Protocol (ACP) host — Xterax as Client.
//!
//! Spawns agent subprocesses and speaks JSON-RPC over stdio. Client methods
//! (fs, terminal, permissions) are handled in-process or bridged to the UI.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shared_child::SharedChild;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Notify, RwLock};
use tokio::time::timeout;

use crate::modules::shell::ringbuffer::BoundedRingBuffer;
use crate::modules::workspace::WorkspaceRegistry;

// ---------------------------------------------------------------------------
// Public IPC types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub enabled: bool,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpMcpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<AcpEnvVar>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpEnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpConnectionStatus {
    pub connection_id: String,
    pub agent_id: String,
    pub name: String,
    pub connected: bool,
    pub protocol_version: Option<u64>,
    pub agent_info: Option<Value>,
    pub agent_capabilities: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionResult {
    pub connection_id: String,
    pub session_id: String,
    pub modes: Option<Value>,
    pub config_options: Option<Value>,
    /// Top-level session models (Claude ACP / Zed). Preferred for the model picker.
    pub models: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptResult {
    pub stop_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionResponse {
    pub request_id: u64,
    pub outcome: String,
    #[serde(default)]
    pub option_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpUpdateEvent {
    connection_id: String,
    session_id: String,
    update: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpPermissionEvent {
    connection_id: String,
    request_id: u64,
    session_id: String,
    tool_call: Value,
    options: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpStatusEvent {
    connection_id: String,
    agent_id: String,
    kind: String,
    message: Option<String>,
}

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

fn secret_basename_blocked(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let exact = [
        ".env",
        "known_hosts",
        "authorized_keys",
        "htpasswd",
        ".netrc",
        "_netrc",
        "credentials",
        ".pgpass",
        ".npmrc",
        ".pypirc",
    ];
    if exact.iter().any(|p| lower == *p) {
        return true;
    }
    if lower.starts_with(".env.") {
        return true;
    }
    for ext in [".pem", ".key", ".p12", ".pfx", ".asc", ".gpg", ".keystore", ".jks"] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    if lower.starts_with("id_rsa")
        || lower.starts_with("id_dsa")
        || lower.starts_with("id_ecdsa")
        || lower.starts_with("id_ed25519")
    {
        return true;
    }
    if (lower.starts_with("secrets.") || lower.starts_with("secret."))
        && (lower.ends_with(".json")
            || lower.ends_with(".yml")
            || lower.ends_with(".yaml")
            || lower.ends_with(".toml")
            || lower.ends_with(".env"))
    {
        return true;
    }
    if lower.ends_with(".json")
        && (lower.contains("service-account") || lower.contains("service_account"))
    {
        return true;
    }
    false
}

fn protected_dir_segment(segment: &str) -> bool {
    matches!(
        segment.to_ascii_lowercase().as_str(),
        ".ssh"
            | ".gnupg"
            | ".aws"
            | ".azure"
            | ".kube"
            | ".docker"
            | ".git"
            | ".terraform.d"
            | "keychains"
            | "cookies"
    )
}

/// Deny secret / protected paths. Paths must be absolute.
pub fn check_path_allowed(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    if !Path::new(path).is_absolute() {
        return Err("path must be absolute".into());
    }
    let normalized = path.replace('\\', "/");
    for part in normalized.split('/').filter(|s| !s.is_empty()) {
        if protected_dir_segment(part) {
            return Err(format!("access denied to protected path: {path}"));
        }
        if secret_basename_blocked(part) {
            return Err(format!("access denied to secret path: {path}"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

struct AcpTerminal {
    child: Arc<SharedChild>,
    buffer: std::sync::Mutex<BoundedRingBuffer>,
    exited: AtomicBool,
    exit_code: AtomicI32,
    exit_unknown: AtomicBool,
    notify: Notify,
    output_byte_limit: usize,
}

impl AcpTerminal {
    fn output_snapshot(&self) -> (String, bool, Option<Option<i32>>) {
        let buf = self.buffer.lock().expect("terminal buffer");
        let (bytes, _, dropped) = buf.read_from(0);
        let truncated = dropped > 0 || bytes.len() >= self.output_byte_limit;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let exited = self.exited.load(Ordering::Acquire);
        let exit = if exited {
            if self.exit_unknown.load(Ordering::Acquire) {
                Some(None)
            } else {
                Some(Some(self.exit_code.load(Ordering::Acquire)))
            }
        } else {
            None
        };
        (text, truncated, exit)
    }

    fn kill(&self) {
        let _ = self.child.kill();
    }
}

impl Drop for AcpTerminal {
    fn drop(&mut self) {
        self.kill();
    }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
type PermissionMap = Arc<Mutex<HashMap<u64, oneshot::Sender<PermissionOutcome>>>>;

#[derive(Debug, Clone)]
struct PermissionOutcome {
    outcome: String,
    option_id: Option<String>,
}

struct AcpConnection {
    #[allow(dead_code)]
    connection_id: String,
    config: AcpAgentConfig,
    child: Mutex<tokio::process::Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: AtomicU64,
    pending: PendingMap,
    pending_permissions: PermissionMap,
    #[allow(dead_code)]
    terminals: Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
    reader_dead: Arc<AtomicBool>,
}

impl AcpConnection {
    async fn write_msg(&self, msg: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(msg).map_err(|e| format!("serialize: {e}"))?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {e}"))?;
        stdin.flush().await.map_err(|e| format!("flush stdin: {e}"))?;
        Ok(())
    }

    async fn rpc(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        if self.reader_dead.load(Ordering::Acquire) {
            return Err("agent process is no longer running".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            self.pending.lock().await.insert(id, tx);
        }
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params.unwrap_or(Value::Null),
        });
        if let Err(e) = self.write_msg(&req).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        timeout(Duration::from_secs(600), rx)
            .await
            .map_err(|_| format!("timeout waiting for {method}"))?
            .map_err(|_| format!("channel closed waiting for {method}"))?
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        self.write_msg(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params.unwrap_or(Value::Null),
        }))
        .await
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct AcpState {
    connections: RwLock<HashMap<String, Arc<AcpConnection>>>,
}

impl Default for AcpState {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpState {
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
        }
    }
}

static STATUS: OnceLock<std::sync::Mutex<HashMap<String, AcpConnectionStatus>>> = OnceLock::new();

fn status_map() -> &'static std::sync::Mutex<HashMap<String, AcpConnectionStatus>> {
    STATUS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{t:x}")
}

// ---------------------------------------------------------------------------
// Reader loop
// ---------------------------------------------------------------------------

async fn fail_all_pending(pending: &PendingMap, msg: &str) {
    for (_, tx) in pending.lock().await.drain() {
        let _ = tx.send(Err(msg.to_string()));
    }
}

#[allow(clippy::too_many_arguments)]
async fn reader_loop(
    connection_id: String,
    agent_id: String,
    mut stdout: tokio::process::ChildStdout,
    pending: PendingMap,
    pending_permissions: PermissionMap,
    stdin: Arc<Mutex<ChildStdin>>,
    terminals: Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
    reader_dead: Arc<AtomicBool>,
    app: AppHandle,
    workspace_roots: Arc<std::sync::Mutex<Vec<PathBuf>>>,
) {
    let mut lines = BufReader::new(&mut stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("[acp] unparseable line from {connection_id}: {e}");
                        continue;
                    }
                };
                handle_incoming(
                    &connection_id,
                    &agent_id,
                    value,
                    &pending,
                    &pending_permissions,
                    &stdin,
                    &terminals,
                    &app,
                    &workspace_roots,
                )
                .await;
            }
            Ok(None) => {
                reader_dead.store(true, Ordering::Release);
                let _ = app.emit(
                    "xterax:acp-status",
                    AcpStatusEvent {
                        connection_id: connection_id.clone(),
                        agent_id: agent_id.clone(),
                        kind: "exited".into(),
                        message: Some("agent process closed stdout".into()),
                    },
                );
                fail_all_pending(&pending, "agent process closed").await;
                break;
            }
            Err(e) => {
                reader_dead.store(true, Ordering::Release);
                log::warn!("[acp] read error {connection_id}: {e}");
                let _ = app.emit(
                    "xterax:acp-status",
                    AcpStatusEvent {
                        connection_id: connection_id.clone(),
                        agent_id: agent_id.clone(),
                        kind: "error".into(),
                        message: Some(e.to_string()),
                    },
                );
                fail_all_pending(&pending, &e.to_string()).await;
                break;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_incoming(
    connection_id: &str,
    agent_id: &str,
    value: Value,
    pending: &PendingMap,
    pending_permissions: &PermissionMap,
    stdin: &Arc<Mutex<ChildStdin>>,
    terminals: &Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
    app: &AppHandle,
    workspace_roots: &Arc<std::sync::Mutex<Vec<PathBuf>>>,
) {
    let method = value.get("method").and_then(|m| m.as_str());
    let id = value.get("id").cloned();

    if method.is_none() {
        if let Some(rid) = value.get("id").and_then(|i| i.as_u64()) {
            let outcome = if let Some(err) = value.get("error") {
                Err(err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("rpc error")
                    .to_string())
            } else {
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            };
            if let Some(tx) = pending.lock().await.remove(&rid) {
                let _ = tx.send(outcome);
            }
        }
        return;
    }

    let method = method.unwrap();

    if id.is_none() {
        if method == "session/update" {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            let session_id = params
                .get("sessionId")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let update = params.get("update").cloned().unwrap_or(Value::Null);
            let _ = app.emit(
                "xterax:acp-update",
                AcpUpdateEvent {
                    connection_id: connection_id.to_string(),
                    session_id,
                    update,
                },
            );
        } else {
            log::debug!("[acp] notification {method} from {agent_id}");
        }
        return;
    }

    let req_id = id.unwrap();
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let result = dispatch_client_method(
        method,
        params,
        connection_id,
        req_id.clone(),
        pending_permissions,
        terminals,
        app,
        workspace_roots,
    )
    .await;

    let response = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": req_id, "result": r }),
        Err(e) => json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": { "code": -32000, "message": e },
        }),
    };
    let Ok(mut line) = serde_json::to_string(&response) else {
        return;
    };
    line.push('\n');
    let mut guard = stdin.lock().await;
    if let Err(e) = guard.write_all(line.as_bytes()).await {
        log::warn!("[acp] write response: {e}");
    }
    let _ = guard.flush().await;
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_client_method(
    method: &str,
    params: Value,
    connection_id: &str,
    req_id: Value,
    pending_permissions: &PermissionMap,
    terminals: &Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
    app: &AppHandle,
    workspace_roots: &Arc<std::sync::Mutex<Vec<PathBuf>>>,
) -> Result<Value, String> {
    match method {
        "fs/read_text_file" => fs_read_text_file(&params),
        "fs/write_text_file" => fs_write_text_file(&params, workspace_roots),
        "session/request_permission" => {
            request_permission(connection_id, req_id, params, pending_permissions, app).await
        }
        "terminal/create" => terminal_create(params, terminals).await,
        "terminal/output" => terminal_output(&params, terminals).await,
        "terminal/wait_for_exit" => terminal_wait(&params, terminals).await,
        "terminal/kill" => terminal_kill(&params, terminals).await,
        "terminal/release" => terminal_release(&params, terminals).await,
        other => Err(format!("unsupported client method: {other}")),
    }
}

fn fs_read_text_file(params: &Value) -> Result<Value, String> {
    let path = params
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("missing path")?;
    check_path_allowed(path)?;
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("file too large (>10MB)".into());
    }
    let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut text = content;
    if let Some(line) = params.get("line").and_then(|v| v.as_u64()) {
        let start = (line as usize).saturating_sub(1);
        let lines: Vec<&str> = text.lines().collect();
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(usize::MAX);
        text = lines
            .into_iter()
            .skip(start)
            .take(limit)
            .collect::<Vec<_>>()
            .join("\n");
    }
    Ok(json!({ "content": text }))
}

fn path_under_roots(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn fs_write_text_file(
    params: &Value,
    workspace_roots: &Arc<std::sync::Mutex<Vec<PathBuf>>>,
) -> Result<Value, String> {
    let path = params
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("missing path")?;
    let content = params
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or("missing content")?;
    check_path_allowed(path)?;
    let p = PathBuf::from(path);
    if let Some(parent) = p.parent() {
        if parent.exists() {
            if let Ok(canon) = std::fs::canonicalize(parent) {
                let roots = workspace_roots.lock().expect("roots");
                if !path_under_roots(&canon, &roots) {
                    return Err(format!("path is outside authorized workspace: {path}"));
                }
            }
        }
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

async fn request_permission(
    connection_id: &str,
    req_id: Value,
    params: Value,
    pending_permissions: &PermissionMap,
    app: &AppHandle,
) -> Result<Value, String> {
    let request_id = req_id
        .as_u64()
        .ok_or("permission request id must be a number")?;
    let session_id = params
        .get("sessionId")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let options = params.get("options").cloned().unwrap_or(json!([]));

    let (tx, rx) = oneshot::channel();
    pending_permissions.lock().await.insert(request_id, tx);

    let _ = app.emit(
        "xterax:acp-permission",
        AcpPermissionEvent {
            connection_id: connection_id.to_string(),
            request_id,
            session_id,
            tool_call,
            options,
        },
    );

    let outcome = timeout(Duration::from_secs(600), rx)
        .await
        .map_err(|_| "permission request timed out".to_string())?
        .map_err(|_| "permission channel closed".to_string())?;

    if outcome.outcome == "cancelled" {
        Ok(json!({ "outcome": { "outcome": "cancelled" } }))
    } else {
        Ok(json!({
            "outcome": {
                "outcome": "selected",
                "optionId": outcome.option_id.unwrap_or_default(),
            }
        }))
    }
}

async fn terminal_create(
    params: Value,
    terminals: &Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
) -> Result<Value, String> {
    let command = params
        .get("command")
        .and_then(|c| c.as_str())
        .ok_or("missing command")?
        .to_string();
    let args: Vec<String> = params
        .get("args")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let cwd = params
        .get("cwd")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let output_byte_limit = params
        .get("outputByteLimit")
        .and_then(|v| v.as_u64())
        .unwrap_or(1024 * 1024) as usize;

    let mut cmd = std::process::Command::new(&command);
    cmd.args(&args);
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(env_arr) = params.get("env").and_then(|e| e.as_array()) {
        for item in env_arr {
            if let (Some(n), Some(v)) = (
                item.get("name").and_then(|x| x.as_str()),
                item.get("value").and_then(|x| x.as_str()),
            ) {
                cmd.env(n, v);
            }
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let shared = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?);
    let stdout = shared.take_stdout().ok_or("no stdout")?;
    let stderr = shared.take_stderr().ok_or("no stderr")?;
    let wait_child = shared.clone();

    let term = Arc::new(AcpTerminal {
        child: shared,
        buffer: std::sync::Mutex::new(BoundedRingBuffer::new(output_byte_limit.max(4096))),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
        notify: Notify::new(),
        output_byte_limit: output_byte_limit.max(4096),
    });

    let term_out = term.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut out = stdout;
        let mut err = stderr;
        let mut buf = [0u8; 8192];
        loop {
            match out.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut b) = term_out.buffer.lock() {
                        b.push(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
        let mut buf2 = [0u8; 8192];
        loop {
            match err.read(&mut buf2) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut b) = term_out.buffer.lock() {
                        b.push(&buf2[..n]);
                    }
                }
                Err(_) => break,
            }
        }
        match wait_child.wait() {
            Ok(status) => {
                term_out.exited.store(true, Ordering::Release);
                if let Some(code) = status.code() {
                    term_out.exit_code.store(code, Ordering::Release);
                } else {
                    term_out.exit_unknown.store(true, Ordering::Release);
                }
            }
            Err(_) => {
                term_out.exited.store(true, Ordering::Release);
                term_out.exit_unknown.store(true, Ordering::Release);
            }
        }
        term_out.notify.notify_waiters();
    });

    let terminal_id = format!("term_{}", uuid_simple());
    terminals.lock().await.insert(terminal_id.clone(), term);
    Ok(json!({ "terminalId": terminal_id }))
}

async fn terminal_output(
    params: &Value,
    terminals: &Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
) -> Result<Value, String> {
    let tid = params
        .get("terminalId")
        .and_then(|t| t.as_str())
        .ok_or("missing terminalId")?;
    let map = terminals.lock().await;
    let term = map
        .get(tid)
        .ok_or_else(|| format!("unknown terminal {tid}"))?;
    let (output, truncated, exit) = term.output_snapshot();
    let mut result = json!({ "output": output, "truncated": truncated });
    if let Some(code) = exit {
        result["exitStatus"] = json!({ "exitCode": code, "signal": null });
    }
    Ok(result)
}

async fn terminal_wait(
    params: &Value,
    terminals: &Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
) -> Result<Value, String> {
    let tid = params
        .get("terminalId")
        .and_then(|t| t.as_str())
        .ok_or("missing terminalId")?
        .to_string();
    let term = {
        let map = terminals.lock().await;
        map.get(&tid)
            .cloned()
            .ok_or_else(|| format!("unknown terminal {tid}"))?
    };
    while !term.exited.load(Ordering::Acquire) {
        term.notify.notified().await;
    }
    let code = if term.exit_unknown.load(Ordering::Acquire) {
        None
    } else {
        Some(term.exit_code.load(Ordering::Acquire))
    };
    Ok(json!({ "exitCode": code, "signal": null }))
}

async fn terminal_kill(
    params: &Value,
    terminals: &Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
) -> Result<Value, String> {
    let tid = params
        .get("terminalId")
        .and_then(|t| t.as_str())
        .ok_or("missing terminalId")?;
    let map = terminals.lock().await;
    let term = map
        .get(tid)
        .ok_or_else(|| format!("unknown terminal {tid}"))?;
    term.kill();
    Ok(json!({}))
}

async fn terminal_release(
    params: &Value,
    terminals: &Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
) -> Result<Value, String> {
    let tid = params
        .get("terminalId")
        .and_then(|t| t.as_str())
        .ok_or("missing terminalId")?;
    let mut map = terminals.lock().await;
    if let Some(term) = map.remove(tid) {
        term.kill();
    }
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async fn spawn_agent(config: &AcpAgentConfig) -> Result<tokio::process::Child, String> {
    if config.command.trim().is_empty() {
        return Err("empty command".into());
    }
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args);
    // Inherit the full process environment so agents see the same HOME,
    // PATH, and Claude/Codex auth as a terminal launched from the same user.
    // User-configured env wins on key collision.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.envs(&config.env);
    if let Some(ref cwd) = config.cwd {
        if !cwd.trim().is_empty() {
            cmd.current_dir(cwd);
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Keep process in the same process group semantics; do not strip env.
    cmd.kill_on_drop(true);
    cmd.spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", config.command))
}

fn collect_workspace_roots(registry: &WorkspaceRegistry) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        if let Ok(c) = registry.authorize(&home) {
            roots.push(c);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Ok(c) = registry.authorize(&cwd) {
            roots.push(c);
        }
    }
    roots
}

#[tauri::command]
pub async fn acp_connect(
    app: AppHandle,
    state: State<'_, AcpState>,
    registry: State<'_, WorkspaceRegistry>,
    config: AcpAgentConfig,
) -> Result<AcpConnectionStatus, String> {
    {
        let mut conns = state.connections.write().await;
        let stale: Vec<String> = conns
            .iter()
            .filter(|(_, c)| c.config.id == config.id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(c) = conns.remove(&id) {
                let mut child = c.child.lock().await;
                let _ = child.kill().await;
                if let Ok(mut m) = status_map().lock() {
                    m.remove(&id);
                }
            }
        }
    }

    let mut child = spawn_agent(&config).await?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    if let Some(stderr) = child.stderr.take() {
        let agent_name = config.name.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[acp:{}] {line}", agent_name);
            }
        });
    }

    let connection_id = format!("acp_{}", uuid_simple());
    let stdin = Arc::new(Mutex::new(stdin));
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_permissions: PermissionMap = Arc::new(Mutex::new(HashMap::new()));
    let terminals: Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let reader_dead = Arc::new(AtomicBool::new(false));
    let workspace_roots = Arc::new(std::sync::Mutex::new(collect_workspace_roots(&registry)));

    {
        let connection_id = connection_id.clone();
        let agent_id = config.id.clone();
        let pending = pending.clone();
        let pending_permissions = pending_permissions.clone();
        let stdin = stdin.clone();
        let terminals = terminals.clone();
        let reader_dead = reader_dead.clone();
        let app = app.clone();
        let workspace_roots = workspace_roots.clone();
        tokio::spawn(async move {
            reader_loop(
                connection_id,
                agent_id,
                stdout,
                pending,
                pending_permissions,
                stdin,
                terminals,
                reader_dead,
                app,
                workspace_roots,
            )
            .await;
        });
    }

    let conn = Arc::new(AcpConnection {
        connection_id: connection_id.clone(),
        config: config.clone(),
        child: Mutex::new(child),
        stdin,
        next_id: AtomicU64::new(1),
        pending,
        pending_permissions,
        terminals,
        reader_dead,
    });

    let init_params = json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": true, "writeTextFile": true },
            "terminal": true,
            "session": {
                "configOptions": {
                    "boolean": {}
                }
            }
        },
        "clientInfo": {
            "name": "xterax",
            "title": "Xterax",
            "version": env!("CARGO_PKG_VERSION"),
        },
    });

    let init_result = match conn.rpc("initialize", Some(init_params)).await {
        Ok(r) => r,
        Err(e) => {
            let mut child = conn.child.lock().await;
            let _ = child.kill().await;
            return Ok(AcpConnectionStatus {
                connection_id,
                agent_id: config.id,
                name: config.name,
                connected: false,
                protocol_version: None,
                agent_info: None,
                agent_capabilities: None,
                error: Some(format!("initialize failed: {e}")),
            });
        }
    };

    let status = AcpConnectionStatus {
        connection_id: connection_id.clone(),
        agent_id: config.id.clone(),
        name: config.name.clone(),
        connected: true,
        protocol_version: init_result.get("protocolVersion").and_then(|v| v.as_u64()),
        agent_info: init_result.get("agentInfo").cloned(),
        agent_capabilities: init_result.get("agentCapabilities").cloned(),
        error: None,
    };

    state
        .connections
        .write()
        .await
        .insert(connection_id.clone(), conn);
    if let Ok(mut m) = status_map().lock() {
        m.insert(connection_id.clone(), status.clone());
    }

    let _ = app.emit(
        "xterax:acp-status",
        AcpStatusEvent {
            connection_id,
            agent_id: config.id,
            kind: "connected".into(),
            message: None,
        },
    );
    Ok(status)
}

#[tauri::command]
pub async fn acp_disconnect(
    app: AppHandle,
    state: State<'_, AcpState>,
    connection_id: String,
) -> Result<(), String> {
    let conn = {
        let mut conns = state.connections.write().await;
        conns.remove(&connection_id)
    };
    if let Some(c) = conn {
        let agent_id = c.config.id.clone();
        {
            let mut perms = c.pending_permissions.lock().await;
            for (_, tx) in perms.drain() {
                let _ = tx.send(PermissionOutcome {
                    outcome: "cancelled".into(),
                    option_id: None,
                });
            }
        }
        {
            let mut child = c.child.lock().await;
            let _ = child.kill().await;
        }
        if let Ok(mut m) = status_map().lock() {
            m.remove(&connection_id);
        }
        let _ = app.emit(
            "xterax:acp-status",
            AcpStatusEvent {
                connection_id,
                agent_id,
                kind: "disconnected".into(),
                message: None,
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_list_connections(
    state: State<'_, AcpState>,
) -> Result<Vec<AcpConnectionStatus>, String> {
    let conns = state.connections.read().await;
    let mut out = Vec::new();
    let statuses = status_map().lock().map(|m| m.clone()).unwrap_or_default();
    for id in conns.keys() {
        if let Some(s) = statuses.get(id) {
            let mut s = s.clone();
            if let Some(c) = conns.get(id) {
                s.connected = !c.reader_dead.load(Ordering::Acquire);
            }
            out.push(s);
        } else if let Some(c) = conns.get(id) {
            out.push(AcpConnectionStatus {
                connection_id: id.clone(),
                agent_id: c.config.id.clone(),
                name: c.config.name.clone(),
                connected: !c.reader_dead.load(Ordering::Acquire),
                protocol_version: None,
                agent_info: None,
                agent_capabilities: None,
                error: None,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn acp_session_new(
    state: State<'_, AcpState>,
    connection_id: String,
    cwd: String,
    mcp_servers: Option<Vec<AcpMcpServer>>,
) -> Result<AcpSessionResult, String> {
    if !Path::new(&cwd).is_absolute() {
        return Err("cwd must be absolute".into());
    }
    let conn = {
        let conns = state.connections.read().await;
        conns
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| format!("connection {connection_id} not found"))?
    };

    let mcp = mcp_servers.unwrap_or_default();
    let mcp_json: Vec<Value> = mcp
        .into_iter()
        .map(|s| {
            json!({
                "name": s.name,
                "command": s.command,
                "args": s.args,
                "env": s.env,
            })
        })
        .collect();

    let result = conn
        .rpc(
            "session/new",
            Some(json!({
                "cwd": cwd,
                "mcpServers": mcp_json,
            })),
        )
        .await?;

    let session_id = result
        .get("sessionId")
        .and_then(|s| s.as_str())
        .ok_or("session/new missing sessionId")?
        .to_string();

    Ok(AcpSessionResult {
        connection_id,
        session_id,
        modes: result.get("modes").cloned(),
        config_options: result
            .get("configOptions")
            .or_else(|| result.get("config_options"))
            .cloned(),
        models: result.get("models").cloned(),
    })
}

#[tauri::command]
pub async fn acp_prompt(
    state: State<'_, AcpState>,
    connection_id: String,
    session_id: String,
    prompt: Vec<Value>,
) -> Result<AcpPromptResult, String> {
    let conn = {
        let conns = state.connections.read().await;
        conns
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| format!("connection {connection_id} not found"))?
    };

    let result = conn
        .rpc(
            "session/prompt",
            Some(json!({
                "sessionId": session_id,
                "prompt": prompt,
            })),
        )
        .await?;

    let stop_reason = result
        .get("stopReason")
        .and_then(|s| s.as_str())
        .unwrap_or("end_turn")
        .to_string();

    Ok(AcpPromptResult { stop_reason })
}

#[tauri::command]
pub async fn acp_cancel(
    state: State<'_, AcpState>,
    connection_id: String,
    session_id: String,
) -> Result<(), String> {
    let conn = {
        let conns = state.connections.read().await;
        conns
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| format!("connection {connection_id} not found"))?
    };

    {
        let mut perms = conn.pending_permissions.lock().await;
        for (_, tx) in perms.drain() {
            let _ = tx.send(PermissionOutcome {
                outcome: "cancelled".into(),
                option_id: None,
            });
        }
    }

    conn.notify("session/cancel", Some(json!({ "sessionId": session_id })))
        .await
}

#[tauri::command]
pub async fn acp_respond_permission(
    state: State<'_, AcpState>,
    connection_id: String,
    response: AcpPermissionResponse,
) -> Result<(), String> {
    let conn = {
        let conns = state.connections.read().await;
        conns
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| format!("connection {connection_id} not found"))?
    };
    let mut perms = conn.pending_permissions.lock().await;
    if let Some(tx) = perms.remove(&response.request_id) {
        let _ = tx.send(PermissionOutcome {
            outcome: response.outcome,
            option_id: response.option_id,
        });
        Ok(())
    } else {
        Err(format!(
            "no pending permission request {}",
            response.request_id
        ))
    }
}

#[tauri::command]
pub async fn acp_set_mode(
    state: State<'_, AcpState>,
    connection_id: String,
    session_id: String,
    mode_id: String,
) -> Result<Value, String> {
    let conn = {
        let conns = state.connections.read().await;
        conns
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| format!("connection {connection_id} not found"))?
    };
    conn.rpc(
        "session/set_mode",
        Some(json!({
            "sessionId": session_id,
            "modeId": mode_id,
        })),
    )
    .await
}

#[tauri::command]
pub async fn acp_set_config_option(
    state: State<'_, AcpState>,
    connection_id: String,
    session_id: String,
    config_id: String,
    value: Value,
) -> Result<Value, String> {
    let conn = {
        let conns = state.connections.read().await;
        conns
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| format!("connection {connection_id} not found"))?
    };
    let mut params = json!({
        "sessionId": session_id,
        "configId": config_id,
        "value": value,
    });
    if value.is_boolean() {
        params["type"] = json!("boolean");
    }
    conn.rpc("session/set_config_option", Some(params)).await
}

pub async fn shutdown_all(state: &AcpState) {
    let mut conns = state.connections.write().await;
    for (_, c) in conns.drain() {
        let mut child = c.child.lock().await;
        let _ = child.kill().await;
    }
    if let Ok(mut m) = status_map().lock() {
        m.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_env_files() {
        assert!(check_path_allowed("/tmp/project/.env").is_err());
        assert!(check_path_allowed("/tmp/project/.env.local").is_err());
    }

    #[test]
    fn blocks_ssh_dir() {
        assert!(check_path_allowed("/Users/me/.ssh/id_rsa").is_err());
    }

    #[test]
    fn allows_normal_source() {
        assert!(check_path_allowed("/tmp/project/src/main.rs").is_ok());
    }

    #[test]
    fn requires_absolute() {
        assert!(check_path_allowed("relative/path.rs").is_err());
    }
}

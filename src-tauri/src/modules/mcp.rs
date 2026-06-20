use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Mirrors `McpServerConfig` from the TypeScript side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub enabled: bool,
}

/// Tool definition returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Lightweight status for the settings UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub id: String,
    pub name: String,
    pub connected: bool,
    pub tool_count: usize,
    pub error: Option<String>,
}

/// Result of a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolResult {
    pub content: Vec<McpContent>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
    pub data: Option<String>,
    pub mime_type: Option<String>,
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 primitives
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i32,
    message: String,
    #[allow(dead_code)]
    data: Option<Value>,
}

// ---------------------------------------------------------------------------
// Session: one running MCP server
// ---------------------------------------------------------------------------

struct McpSession {
    config: McpServerConfig,
    child: Child,
    next_id: u64,
    tools: Vec<McpToolDef>,
}

impl McpSession {
    /// Write a JSON-RPC request and read back the response with matching id.
    async fn rpc(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;

        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        };

        let mut line = serde_json::to_string(&req).map_err(|e| format!("serialize: {e}"))?;
        line.push('\n');

        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or("stdin not available")?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {e}"))?;

        let stdout = self
            .child
            .stdout
            .as_mut()
            .ok_or("stdout not available")?;
        let mut reader = BufReader::new(stdout).lines();

        // Read lines until we find our response, skipping notifications.
        loop {
            let line_result = timeout(Duration::from_secs(30), reader.next_line())
                .await
                .map_err(|_| format!("timeout waiting for response to {method}"))?;

            let line_result = match line_result {
                Ok(Some(r)) => r,
                Ok(None) => return Err("server closed stdout unexpectedly".into()),
                Err(e) => return Err(format!("read stdout: {e}")),
            };

            let line = line_result;

            let resp: JsonRpcResponse = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("[mcp] unparseable line from {}: {e}", self.config.name);
                    continue;
                }
            };

            // Notifications have no id — skip them.
            let Some(resp_id) = resp.id else {
                log::debug!(
                    "[mcp] notification from {}: {}",
                    self.config.name,
                    line.chars().take(200).collect::<String>()
                );
                continue;
            };

            if resp_id != id {
                // Response for a different request (shouldn't happen with
                // serialised access, but be safe).
                log::warn!(
                    "[mcp] unexpected response id {resp_id} (expected {id}) from {}",
                    self.config.name
                );
                continue;
            }

            if let Some(err) = resp.error {
                return Err(format!("{} error {}: {}", method, err.code, err.message));
            }

            return resp.result.ok_or_else(|| format!("{method} returned null result"));
        }
    }

    /// MCP initialization handshake.
    async fn initialize(&mut self) -> Result<Value, String> {
        let params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "clientInfo": {
                "name": "Xterax",
                "version": env!("CARGO_PKG_VERSION")
            }
        });
        let result = self.rpc("initialize", Some(params)).await?;

        // Send the `initialized` notification (no id).
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let mut line = serde_json::to_string(&notif).map_err(|e| format!("serialize: {e}"))?;
        line.push('\n');
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or("stdin not available")?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write initialized: {e}"))?;

        Ok(result)
    }

    async fn list_tools(&mut self) -> Result<Vec<McpToolDef>, String> {
        let result = self.rpc("tools/list", None).await?;
        let tools: Vec<McpToolDef> = result
            .get("tools")
            .cloned()
            .unwrap_or_default()
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        Some(McpToolDef {
                            name: t.get("name")?.as_str()?.into(),
                            description: t.get("description")?.as_str().unwrap_or("").into(),
                            input_schema: t.get("inputSchema").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.tools = tools.clone();
        Ok(tools)
    }

    async fn call_tool(
        &mut self,
        tool_name: &str,
        args: Value,
    ) -> Result<McpToolResult, String> {
        let params = serde_json::json!({
            "name": tool_name,
            "arguments": args
        });
        let result = self.rpc("tools/call", Some(params)).await?;

        // Parse the result into McpToolResult.
        // MCP returns { content: [...] } with optional isError.
        let content: Vec<McpContent> = result
            .get("content")
            .cloned()
            .unwrap_or_default()
            .as_array()
            .map(|arr| {
                arr.iter()
                    .map(|c| McpContent {
                        content_type: c["type"].as_str().unwrap_or("text").into(),
                        text: c["text"].as_str().map(|s| s.into()),
                        data: c["data"].as_str().map(|s| s.into()),
                        mime_type: c["mimeType"].as_str().map(|s| s.into()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let is_error = result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        Ok(McpToolResult {
            content,
            is_error,
        })
    }
}

// ---------------------------------------------------------------------------
// Tauri state
// ---------------------------------------------------------------------------

pub struct McpState {
    /// `Arc<Mutex<McpSession>>` lets us hold a reference to a session while
    /// locking only that session's mutex for RPC calls.
    sessions: Mutex<HashMap<String, Arc<Mutex<McpSession>>>>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

// ---------------------------------------------------------------------------
// Helper: spawn a server process
// ---------------------------------------------------------------------------

async fn spawn_server(config: &McpServerConfig) -> Result<Child, String> {
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args);
    cmd.envs(&config.env);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", config.command))?;

    Ok(child)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mcp_connect(
    state: tauri::State<'_, McpState>,
    config: McpServerConfig,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;

    // Kill any existing session for this server id.
    if let Some(existing) = sessions.remove(&config.id) {
        let mut session = existing.lock().await;
        let _ = session.child.kill().await;
    }

    let child = spawn_server(&config).await?;

    let server_id = config.id.clone();
    let session = McpSession {
        config,
        child,
        next_id: 1,
        tools: Vec::new(),
    };

    let handle = Arc::new(Mutex::new(session));

    // Run the initialization handshake.
    {
        let mut s = handle.lock().await;
        s.initialize().await?;
        s.list_tools().await?;
    }

    sessions.insert(server_id, handle);

    Ok(())
}

#[tauri::command]
pub async fn mcp_disconnect(
    state: tauri::State<'_, McpState>,
    server_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(handle) = sessions.remove(&server_id) {
        let mut session = handle.lock().await;
        let _ = session.child.kill().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_list_tools(
    state: tauri::State<'_, McpState>,
    server_id: String,
) -> Result<Vec<McpToolDef>, String> {
    let sessions = state.sessions.lock().await;
    let handle = sessions
        .get(&server_id)
        .ok_or_else(|| format!("server {server_id} not connected"))?;
    let mut session = handle.lock().await;
    session.list_tools().await
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: tauri::State<'_, McpState>,
    server_id: String,
    tool_name: String,
    args: Value,
) -> Result<McpToolResult, String> {
    let sessions = state.sessions.lock().await;
    let handle = sessions
        .get(&server_id)
        .ok_or_else(|| format!("server {server_id} not connected"))?;
    let mut session = handle.lock().await;
    session.call_tool(&tool_name, args).await
}

#[tauri::command]
pub async fn mcp_get_status(
    state: tauri::State<'_, McpState>,
) -> Result<Vec<McpServerStatus>, String> {
    let sessions = state.sessions.lock().await;
    let mut statuses = Vec::with_capacity(sessions.len());
    for (id, handle) in sessions.iter() {
        let session = handle.lock().await;
        statuses.push(McpServerStatus {
            id: id.clone(),
            name: session.config.name.clone(),
            connected: true,
            tool_count: session.tools.len(),
            error: None,
        });
    }
    Ok(statuses)
}

/// Start all enabled servers from the given configs. Called on app startup
/// or when the user saves MCP settings.
#[tauri::command]
pub async fn mcp_sync_servers(
    state: tauri::State<'_, McpState>,
    configs: Vec<McpServerConfig>,
) -> Result<Vec<McpServerStatus>, String> {
    // Phase 1: kill servers not in config, collect existing ids.
    let (to_kill, existing_ids) = {
        let mut sessions = state.sessions.lock().await;
        let config_ids: std::collections::HashSet<String> =
            configs.iter().map(|c| c.id.clone()).collect();

        let to_remove: Vec<String> = sessions
            .keys()
            .filter(|id| !config_ids.contains(*id))
            .cloned()
            .collect();
        let to_kill: Vec<Option<Arc<Mutex<McpSession>>>> = to_remove
            .iter()
            .map(|id| sessions.remove(id))
            .collect();
        let existing_ids: std::collections::HashSet<String> =
            sessions.keys().cloned().collect();
        (to_kill, existing_ids)
    };

    // Kill removed sessions outside the lock.
    for handle in to_kill.into_iter().flatten() {
        let mut session = handle.lock().await;
        let _ = session.child.kill().await;
    }

    let mut statuses = Vec::new();

    for config in &configs {
        // Skip disabled servers.
        if !config.enabled {
            // Kill if previously connected.
            if existing_ids.contains(&config.id) {
                let handle = {
                    let mut sessions = state.sessions.lock().await;
                    sessions.remove(&config.id)
                };
                if let Some(handle) = handle {
                    let mut session = handle.lock().await;
                    let _ = session.child.kill().await;
                }
            }
            statuses.push(McpServerStatus {
                id: config.id.clone(),
                name: config.name.clone(),
                connected: false,
                tool_count: 0,
                error: None,
            });
            continue;
        }

        // Already connected — report cached status.
        if existing_ids.contains(&config.id) {
            let sessions = state.sessions.lock().await;
            if let Some(handle) = sessions.get(&config.id) {
                let session = handle.lock().await;
                statuses.push(McpServerStatus {
                    id: config.id.clone(),
                    name: config.name.clone(),
                    connected: true,
                    tool_count: session.tools.len(),
                    error: None,
                });
            }
            continue;
        }

        // Try to connect (no lock held during async IO).
        match spawn_server(config).await {
            Ok(child) => {
                let mut session = McpSession {
                    config: config.clone(),
                    child,
                    next_id: 1,
                    tools: Vec::new(),
                };
                match session.initialize().await {
                    Ok(_) => match session.list_tools().await {
                        Ok(_) => {
                            let count = session.tools.len();
                            {
                                let mut sessions = state.sessions.lock().await;
                                sessions.insert(
                                    config.id.clone(),
                                    Arc::new(Mutex::new(session)),
                                );
                            }
                            statuses.push(McpServerStatus {
                                id: config.id.clone(),
                                name: config.name.clone(),
                                connected: true,
                                tool_count: count,
                                error: None,
                            });
                        }
                        Err(e) => {
                            let _ = session.child.kill().await;
                            statuses.push(McpServerStatus {
                                id: config.id.clone(),
                                name: config.name.clone(),
                                connected: false,
                                tool_count: 0,
                                error: Some(format!("tools/list failed: {e}")),
                            });
                        }
                    },
                    Err(e) => {
                        let _ = session.child.kill().await;
                        statuses.push(McpServerStatus {
                            id: config.id.clone(),
                            name: config.name.clone(),
                            connected: false,
                            tool_count: 0,
                            error: Some(format!("initialize failed: {e}")),
                        });
                    }
                }
            }
            Err(e) => {
                statuses.push(McpServerStatus {
                    id: config.id.clone(),
                    name: config.name.clone(),
                    connected: false,
                    tool_count: 0,
                    error: Some(e),
                });
            }
        }
    }

    Ok(statuses)
}

/// Kill all MCP server processes. Called on app shutdown.
pub async fn shutdown_all(state: &McpState) {
    let mut sessions = state.sessions.lock().await;
    for (_, handle) in sessions.drain() {
        let mut session = handle.lock().await;
        let _ = session.child.kill().await;
    }
}

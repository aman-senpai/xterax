import { tool } from "ai";
import { z } from "zod";
import { mcpCallTool, type McpToolDef } from "./client";

// ---------------------------------------------------------------------------
// Per-server tool cache, keyed by `${serverId}::${toolName}`.
// Populated by mcpSyncAndCache() — call after settings change or on app start.
// ---------------------------------------------------------------------------

type CachedTool = McpToolDef & { serverId: string; serverName: string };

const toolCache = new Map<string, CachedTool>();

export function cacheMcpTools(
  serverId: string,
  serverName: string,
  tools: McpToolDef[],
): void {
  for (const t of tools) {
    toolCache.set(`${serverId}::${t.name}`, { ...t, serverId, serverName });
  }
}

export function clearMcpToolCache(): void {
  toolCache.clear();
}

export function clearMcpServerTools(serverId: string): void {
  for (const key of toolCache.keys()) {
    if (key.startsWith(`${serverId}::`)) toolCache.delete(key);
  }
}

export function getCachedMcpTools(): CachedTool[] {
  return Array.from(toolCache.values());
}

// ---------------------------------------------------------------------------
// Build AI SDK tool definitions from cached MCP tools
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema object (from MCP tool input_schema) into a zod schema.
 *
 * Limited conversion — handles the common subset used by MCP servers:
 * - `type: "object"` with `properties` and `required`
 * - `type: "string" | "number" | "boolean" | "array"`
 * - Falls back to `z.record(z.unknown(), z.unknown())` for complex schemas.
 */
function jsonSchemaToZod(
  schema: Record<string, unknown> | null | undefined,
): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") {
    return z.record(z.string(), z.unknown());
  }

  const s = schema as Record<string, unknown>;

  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, Record<string, unknown>>;
    const required = Array.isArray(s.required) ? s.required : [];
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, prop] of Object.entries(props)) {
      let field = jsonSchemaPropToZod(prop);
      if (!required.includes(key)) {
        field = field.optional();
      }
      shape[key] = field;
    }
    return z.object(shape);
  }

  // Fallback for non-object schemas.
  return z.record(z.string(), z.unknown());
}

function jsonSchemaPropToZod(
  prop: Record<string, unknown> | undefined,
): z.ZodTypeAny {
  if (!prop || typeof prop !== "object") return z.unknown();

  const type = prop.type as string | undefined;

  switch (type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      if (prop.properties && typeof prop.properties === "object") {
        return jsonSchemaToZod(prop);
      }
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

/**
 * Return AI SDK tool definitions for all currently cached MCP tools.
 * Call `cacheMcpTools()` first (via `mcpListTools` from the Rust backend).
 */
/** Turn a server name into a safe tool-name segment. */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 20) || "mcp";
}

export function buildMcpTools() {
  const tools: Record<string, ReturnType<typeof tool>> = {};

  for (const cached of toolCache.values()) {
    // Use server name (slugified) as prefix so tool names are readable.
    const prefix = `mcp__${slugifyName(cached.serverName)}__`;
    const toolName = `${prefix}${cached.name}`;

    // Replace characters incompatible with AI SDK tool names (must be
    // alphanumeric + underscore + dash).
    const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");

    // Dynamic MCP tools can't be fully typed — input schema is runtime-built.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools[safeName] = tool({
      description: `[MCP:${cached.serverName}] ${cached.description || cached.name}`,
      inputSchema: jsonSchemaToZod(
        cached.input_schema as Record<string, unknown> | undefined,
      ) as any,
      // MCP tools can mutate remote systems — always require approval (or
      // session auto-approve / read-only deny via resolveToolPolicy).
      needsApproval: true,
      execute: async (input: Record<string, unknown>) => {
        try {
          const result = await mcpCallTool(
            cached.serverId,
            cached.name,
            input,
          );
          if (result.is_error) {
            const errorText = result.content
              .map((c) => c.text ?? "")
              .join("\n");
            return { error: errorText || "MCP tool returned an error" };
          }
          return {
            content: result.content,
            serverId: cached.serverId,
            toolName: cached.name,
          };
        } catch (e) {
          return {
            error: `MCP tool call failed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      },
    }) as any;
  }

  return tools;
}

# Apidog Sync MCP Server v2

MCP server for **reading, writing, and organizing** API documentation in Apidog. Works across Claude Desktop, Claude CLI, Cursor, and Antigravity.

Built on a validated POC: Export → Find → Diff → Merge → Import → Verify.

## Tools

### Read
| Tool | Description |
|------|-------------|
| `apidog_export_spec` | Export full OpenAPI spec |
| `apidog_list_endpoints` | List endpoints (filterable by tag/path/folder/status) |
| `apidog_get_endpoint` | Get full details of a specific endpoint |
| `apidog_search_endpoints` | Fuzzy search by keyword across path/summary/tags/folder |

### Write
| Tool | Description |
|------|-------------|
| `apidog_upsert_endpoint` | Create or update a single endpoint (with diff + verify) |
| `apidog_upsert_endpoints` | Batch create/update multiple endpoints |
| `apidog_delete_endpoint` | Remove an endpoint |
| `apidog_upsert_schema` | Create or update a component schema |
| `apidog_import_spec` | Import a full or partial OpenAPI spec |

### Organize
| Tool | Description |
|------|-------------|
| `apidog_analyze_folders` | Analyze current folder structure and stats |
| `apidog_propose_reorganization` | Propose better folder organization (dry-run, no changes) |
| `apidog_apply_reorganization` | Apply a user-validated reorganization plan |

## Setup

### 1. Install

```bash
cd apidog-sync-mcp-server
npm install
```

### 2. Get credentials

- **Access Token**: Apidog → Account Settings → API Access Token → New
- **Project ID**: Found in your project URL or project settings

### 3. Configure your clients

Same config block everywhere — just the file path differs:

```json
{
  "mcpServers": {
    "apidog": {
      "command": "node",
      "args": ["/absolute/path/to/apidog-sync-mcp-server/src/index.js"],
      "env": {
        "APIDOG_ACCESS_TOKEN": "your-token",
        "APIDOG_PROJECT_ID": "your-project-id"
      }
    }
  }
}
```

| Client | Config file |
|--------|-------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude CLI | `~/.claude.json` (global) or `.mcp.json` (per-project) |
| Cursor | `.cursor/mcp.json` |
| Antigravity | MCP settings panel |

### Multiple projects

```json
{
  "mcpServers": {
    "apidog-talentflow": {
      "command": "node",
      "args": ["/path/to/src/index.js"],
      "env": {
        "APIDOG_ACCESS_TOKEN": "your-token",
        "APIDOG_PROJECT_ID": "talentflow-id"
      }
    },
    "apidog-profynd": {
      "command": "node",
      "args": ["/path/to/src/index.js"],
      "env": {
        "APIDOG_ACCESS_TOKEN": "your-token",
        "APIDOG_PROJECT_ID": "profynd-id"
      }
    }
  }
}
```

## Usage Examples

### Updating an endpoint after a route change

> "I updated the validation rules on the peppol endpoint, the description should say the format must be scheme:identifier with a single colon. Update the docs."

The agent will:
1. Search for the peppol endpoint (`apidog_search_endpoints`)
2. Get the current format (`apidog_get_endpoint`)
3. Build the updated operation matching the exact existing format
4. Push the update with diff showing what changed (`apidog_upsert_endpoint`)
5. Verify the update landed

### Reorganizing folders

> "Analyze my API folder structure and suggest a better organization"

The agent will:
1. Analyze current folders (`apidog_analyze_folders`)
2. Propose reorganization (`apidog_propose_reorganization`)
3. Present the plan and wait for your approval
4. Apply only after you confirm (`apidog_apply_reorganization`)

### Batch updates from route changes

> "I added 3 new routes for invoice management: POST /api/v1/invoices, GET /api/v1/invoices/{id}, DELETE /api/v1/invoices/{id}. Add them to the docs."

The agent will:
1. Check existing endpoints to learn the format
2. Build all 3 operations matching the project format
3. Batch upsert them (`apidog_upsert_endpoints`)

## Reorganization Strategies

| Strategy | Description |
|----------|-------------|
| `path-based` | Infer folders from URL paths: `/api/v1/admin/billing/...` → `Admin/Billing` |
| `preserve-top-level` | Keep existing top-level folders, reorganize sub-levels |
| `flat` | Single level by main resource name |

Custom mappings let you override specific prefixes:
```json
{
  "customMappings": {
    "/api/v1/admin": "Administration",
    "/auth": "Authentication",
    "/api/v1/public": "Public API"
  }
}
```

## Apidog Extensions

Fully supports:
- **`x-apidog-folder`** — Folder path: `"Safetytracker V1/Super Admin/Billing"`
- **`x-apidog-status`** — Lifecycle: `designing`, `developing`, `released`, `deprecated`
- **`x-apidog-maintainer`** — Team member assignment
- **`x-apidog-orders`** — Field ordering in schema objects
- **`x-apidog-ignore-properties`** — Hidden properties
- **`x-apidog-name`** — Response display names
- **`x-apidog-ordering`** — Response ordering

## How Writes Work

Every write operation follows the POC-validated flow:

```
Export current spec (preserves all formatting)
    ↓
Find target endpoint (exact match or fuzzy search)
    ↓
Compute diff (show what changed)
    ↓
Merge into full spec (deep merge, preserve untouched endpoints)
    ↓
Import with OVERWRITE_EXISTING
    ↓
Verify (re-export and confirm)
```

No endpoints are lost. No formatting is changed on untouched endpoints.

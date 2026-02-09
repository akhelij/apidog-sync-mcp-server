#!/usr/bin/env node

/**
 * Apidog Sync MCP Server v2
 * 
 * Built on the validated POC flow: Export → Find → Diff → Merge → Import → Verify
 * 
 * Tools:
 *   READ:
 *     - apidog_export_spec         → Export full OpenAPI spec
 *     - apidog_list_endpoints      → List all endpoints (filterable)
 *     - apidog_get_endpoint        → Get full details of a specific endpoint
 *     - apidog_search_endpoints    → Fuzzy search by path/summary/tag
 * 
 *   WRITE:
 *     - apidog_upsert_endpoint     → Create or update a single endpoint (with diff)
 *     - apidog_upsert_endpoints    → Batch create/update multiple endpoints
 *     - apidog_delete_endpoint     → Remove an endpoint
 *     - apidog_upsert_schema       → Create or update a component schema
 *     - apidog_import_spec         → Import a full or partial OpenAPI spec
 * 
 *   ORGANIZE:
 *     - apidog_analyze_folders     → Analyze current folder structure
 *     - apidog_propose_reorganization → Propose better folder organization (dry-run)
 *     - apidog_apply_reorganization   → Apply a validated reorganization plan
 * 
 * Configuration:
 *   APIDOG_ACCESS_TOKEN  — env or --access-token=xxx
 *   APIDOG_PROJECT_ID    — env or --project-id=xxx
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ApidogClient } from './apidog-client.js';
import { deepDiff, formatDiff } from './diff.js';
import {
  analyzeFolders,
  proposeReorganization,
  applyReorganization,
} from './folder-organizer.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function getConfig() {
  const args = process.argv.slice(2);
  let accessToken = process.env.APIDOG_ACCESS_TOKEN;
  let projectId = process.env.APIDOG_PROJECT_ID;

  for (const arg of args) {
    if (arg.startsWith('--access-token=')) accessToken = arg.split('=').slice(1).join('=');
    if (arg.startsWith('--project-id=')) projectId = arg.split('=').slice(1).join('=');
  }

  if (!accessToken) throw new Error('APIDOG_ACCESS_TOKEN is required');
  if (!projectId) throw new Error('APIDOG_PROJECT_ID is required');

  return { accessToken, projectId };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  // ── READ TOOLS ──────────────────────────────────────────────────────────
  {
    name: 'apidog_export_spec',
    description: 'Export the full OpenAPI spec from Apidog including all endpoints, schemas, tags, and Apidog extensions (x-apidog-folder, x-apidog-status, x-apidog-maintainer). Use this to understand the current documentation state before making changes.',
    inputSchema: {
      type: 'object',
      properties: {
        oasVersion: { type: 'string', enum: ['3.0', '3.1'], default: '3.1', description: 'OpenAPI version' },
        includeExtensions: { type: 'boolean', default: true, description: 'Include x-apidog-* extensions' },
      },
    },
  },
  {
    name: 'apidog_list_endpoints',
    description: 'List all API endpoints. Returns method, path, summary, tags, folder, status, and maintainer for each. Filterable by tag, path substring, folder, or status.',
    inputSchema: {
      type: 'object',
      properties: {
        filterTag: { type: 'string', description: 'Filter by tag name' },
        filterPath: { type: 'string', description: 'Filter by path substring' },
        filterFolder: { type: 'string', description: 'Filter by folder (substring match)' },
        filterStatus: { type: 'string', description: 'Filter by status (e.g. released, deprecated)' },
      },
    },
  },
  {
    name: 'apidog_get_endpoint',
    description: 'Get full details of a specific endpoint by method and path. Returns the complete operation object including parameters, request body, responses, examples, and all Apidog extensions. Also returns any referenced component schemas for context. ALWAYS use this before updating an endpoint to understand the existing format.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
        path: { type: 'string', description: 'Endpoint path, e.g. /api/v1/users/{id}' },
      },
      required: ['method', 'path'],
    },
  },
  {
    name: 'apidog_search_endpoints',
    description: 'Search endpoints by keyword across path, summary, description, tags, and folder. Returns matching endpoints ranked by relevance. Use this when you are not sure of the exact path — for example, the user says "the peppol endpoint" and you need to find it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword (searches path, summary, description, tags, folder)' },
        method: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete'], description: 'Optional: filter by HTTP method' },
      },
      required: ['query'],
    },
  },

  // ── WRITE TOOLS ─────────────────────────────────────────────────────────
  {
    name: 'apidog_upsert_endpoint',
    description: `Create or update a single API endpoint. This is the primary write tool.

WORKFLOW (validated in POC):
1. Exports current spec to preserve existing format
2. Finds the target endpoint — reports if it exists (UPDATE) or not (CREATE)
3. Computes a diff showing exactly what changed
4. Merges the endpoint into the full spec
5. Imports back to Apidog with OVERWRITE_EXISTING
6. Verifies the update landed correctly

IMPORTANT: The operation object must match the Apidog OpenAPI format including x-apidog-* extensions. Always call apidog_get_endpoint first on a similar endpoint to learn the exact format used in this project.

The operation must include x-apidog-orders and x-apidog-ignore-properties arrays in schema objects to match the existing format. See existing endpoints for reference.`,
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
        path: { type: 'string', description: 'Endpoint path' },
        operation: {
          type: 'object',
          description: 'Full OpenAPI operation object. Must include: summary, description, tags, parameters, requestBody (if applicable), responses, security, x-apidog-folder, x-apidog-status. Match the exact format of existing endpoints.',
        },
      },
      required: ['method', 'path', 'operation'],
    },
  },
  {
    name: 'apidog_upsert_endpoints',
    description: 'Batch create or update multiple endpoints in a single import. More efficient than calling apidog_upsert_endpoint multiple times. Each entry needs method, path, and the full operation object.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string' },
              path: { type: 'string' },
              operation: { type: 'object' },
            },
            required: ['method', 'path', 'operation'],
          },
          description: 'Array of endpoints to upsert',
        },
      },
      required: ['endpoints'],
    },
  },
  {
    name: 'apidog_delete_endpoint',
    description: 'Remove an endpoint from Apidog. Exports current spec, removes the endpoint, and re-imports. All other endpoints remain untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
        path: { type: 'string' },
      },
      required: ['method', 'path'],
    },
  },
  {
    name: 'apidog_upsert_schema',
    description: 'Create or update a component schema (data model) in Apidog. The schema is merged into components/schemas. Use $ref to reference from endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Schema name, e.g. "User", "Invoice"' },
        schema: { type: 'object', description: 'JSON Schema object' },
      },
      required: ['name', 'schema'],
    },
  },
  {
    name: 'apidog_import_spec',
    description: 'Import a full or partial OpenAPI spec. If mergeWithExisting is true (default), exports current spec first and merges. Use for bulk updates or importing from external sources like Scramble.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'OpenAPI 3.x spec object' },
        mergeWithExisting: { type: 'boolean', default: true, description: 'Merge with current spec (true) or replace (false)' },
        overwriteBehavior: { type: 'string', enum: ['OVERWRITE_EXISTING', 'KEEP_EXISTING', 'ALWAYS_ADD'], default: 'OVERWRITE_EXISTING' },
      },
      required: ['spec'],
    },
  },

  // ── ORGANIZE TOOLS ──────────────────────────────────────────────────────
  {
    name: 'apidog_analyze_folders',
    description: 'Analyze the current folder structure of all endpoints. Returns folder tree, endpoint counts per folder, and endpoints with no folder assigned. Use this as a first step before proposing reorganization.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'apidog_propose_reorganization',
    description: `Propose a better folder organization for all endpoints. Returns a DRY-RUN plan showing what would change — nothing is applied yet. The user MUST validate the plan before calling apidog_apply_reorganization.

Strategies:
- "path-based": Infer folders from URL paths (e.g. /api/v1/admin/billing/... → Admin/Billing)
- "preserve-top-level": Keep existing top-level folders, reorganize sub-levels from URL paths
- "flat": Single level based on main resource name

You can also provide customMappings to override specific path prefixes.

ALWAYS present the plan to the user and ask for confirmation before applying.`,
    inputSchema: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          enum: ['path-based', 'preserve-top-level', 'flat'],
          default: 'path-based',
          description: 'Organization strategy',
        },
        groupByVersion: { type: 'boolean', default: false, description: 'Group by API version (v1/, v2/)' },
        stripApiPrefix: { type: 'boolean', default: true, description: 'Remove /api prefix from folder names' },
        maxDepth: { type: 'integer', default: 3, description: 'Maximum folder depth' },
        customMappings: {
          type: 'object',
          description: 'Manual overrides: { "/api/v1/admin": "Administration", "/auth": "Authentication" }',
        },
      },
    },
  },
  {
    name: 'apidog_apply_reorganization',
    description: 'Apply a previously proposed and user-validated folder reorganization plan. Takes the changes array from apidog_propose_reorganization. ONLY call this after the user has explicitly approved the plan.',
    inputSchema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string' },
              path: { type: 'string' },
              newFolder: { type: 'string' },
            },
            required: ['method', 'path', 'newFolder'],
          },
          description: 'The changes array from the proposal — each entry moves an endpoint to a new folder',
        },
      },
      required: ['changes'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
async function handleTool(client, name, args) {
  switch (name) {

    // ── READ ──────────────────────────────────────────────────────────────

    case 'apidog_export_spec': {
      const spec = await client.exportSpec({
        oasVersion: args.oasVersion || '3.1',
        includeExtensions: args.includeExtensions !== false,
      });
      return JSON.stringify(spec, null, 2);
    }

    case 'apidog_list_endpoints': {
      const spec = await client.exportSpec({ includeExtensions: true });
      let endpoints = ApidogClient.parseEndpoints(spec);

      if (args.filterTag) endpoints = endpoints.filter(e => e.tags.includes(args.filterTag));
      if (args.filterPath) endpoints = endpoints.filter(e => e.path.includes(args.filterPath));
      if (args.filterFolder) endpoints = endpoints.filter(e => (e.folder || '').includes(args.filterFolder));
      if (args.filterStatus) endpoints = endpoints.filter(e => e.status === args.filterStatus);

      const list = endpoints.map(e => ({
        method: e.method,
        path: e.path,
        summary: e.summary,
        tags: e.tags,
        folder: e.folder,
        status: e.status,
        deprecated: e.deprecated,
      }));

      return JSON.stringify({ total: list.length, endpoints: list }, null, 2);
    }

    case 'apidog_get_endpoint': {
      const spec = await client.exportSpec({ includeExtensions: true });
      const pathObj = spec.paths?.[args.path];
      if (!pathObj) {
        return JSON.stringify({
          error: `Path "${args.path}" not found.`,
          availablePaths: Object.keys(spec.paths || {}).sort(),
        });
      }
      const operation = pathObj[args.method];
      if (!operation) {
        return JSON.stringify({
          error: `Method "${args.method}" not found on "${args.path}".`,
          availableMethods: Object.keys(pathObj),
        });
      }

      // Collect referenced schemas
      const referencedSchemas = {};
      const specStr = JSON.stringify(operation);
      const refs = [...specStr.matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map(m => m[1]);
      for (const ref of refs) {
        if (spec.components?.schemas?.[ref]) {
          referencedSchemas[ref] = spec.components.schemas[ref];
        }
      }

      return JSON.stringify({ path: args.path, method: args.method, operation, referencedSchemas }, null, 2);
    }

    case 'apidog_search_endpoints': {
      const spec = await client.exportSpec({ includeExtensions: true });
      const allEndpoints = ApidogClient.parseEndpoints(spec);
      const query = args.query.toLowerCase();

      let results = allEndpoints.map(ep => {
        let score = 0;
        const searchFields = [
          ep.path,
          ep.summary,
          ep.description,
          ...(ep.tags || []),
          ep.folder || '',
        ].map(f => f.toLowerCase());

        for (const field of searchFields) {
          if (field.includes(query)) score += 10;
          // Also check individual words
          for (const word of query.split(/[\s\-_\/]+/)) {
            if (word && field.includes(word)) score += 3;
          }
        }

        return { ...ep, score };
      }).filter(ep => ep.score > 0);

      if (args.method) {
        results = results.filter(ep => ep.method.toLowerCase() === args.method.toLowerCase());
      }

      results.sort((a, b) => b.score - a.score);

      const list = results.slice(0, 15).map(e => ({
        method: e.method,
        path: e.path,
        summary: e.summary,
        tags: e.tags,
        folder: e.folder,
        status: e.status,
        score: e.score,
      }));

      return JSON.stringify({ query: args.query, total: list.length, results: list }, null, 2);
    }

    // ── WRITE ─────────────────────────────────────────────────────────────

    case 'apidog_upsert_endpoint': {
      // POC-validated flow: Export → Find → Diff → Merge → Import → Verify
      const spec = await client.exportSpec({ includeExtensions: true });
      const existingOp = spec.paths?.[args.path]?.[args.method];
      const action = existingOp ? 'UPDATE' : 'CREATE';

      // Diff
      let diffText = '';
      if (existingOp) {
        const changes = deepDiff(existingOp, args.operation);
        diffText = formatDiff(changes);
      }

      // Merge
      if (!spec.paths[args.path]) spec.paths[args.path] = {};
      spec.paths[args.path][args.method] = args.operation;

      // Ensure tags
      if (!spec.tags) spec.tags = [];
      const existingTags = new Set(spec.tags.map(t => t.name));
      for (const tag of (args.operation.tags || [])) {
        if (!existingTags.has(tag)) spec.tags.push({ name: tag });
      }

      // Import
      const importResult = await client.importSpec(spec);
      const counters = importResult?.data?.counters || {};

      // Verify
      const verifySpec = await client.exportSpec({ includeExtensions: true });
      const verified = !!verifySpec.paths?.[args.path]?.[args.method];

      return JSON.stringify({
        success: verified,
        action,
        endpoint: `${args.method.toUpperCase()} ${args.path}`,
        diff: diffText || '(new endpoint)',
        counters,
        verified,
      }, null, 2);
    }

    case 'apidog_upsert_endpoints': {
      const spec = await client.exportSpec({ includeExtensions: true });
      const results = [];

      for (const ep of args.endpoints) {
        const existed = !!spec.paths?.[ep.path]?.[ep.method];
        if (!spec.paths[ep.path]) spec.paths[ep.path] = {};
        spec.paths[ep.path][ep.method] = ep.operation;

        // Ensure tags
        if (!spec.tags) spec.tags = [];
        const existingTags = new Set(spec.tags.map(t => t.name));
        for (const tag of (ep.operation.tags || [])) {
          if (!existingTags.has(tag)) spec.tags.push({ name: tag });
        }

        results.push({
          endpoint: `${ep.method.toUpperCase()} ${ep.path}`,
          action: existed ? 'UPDATE' : 'CREATE',
        });
      }

      const importResult = await client.importSpec(spec);

      return JSON.stringify({
        success: true,
        endpoints: results,
        counters: importResult?.data?.counters || {},
      }, null, 2);
    }

    case 'apidog_delete_endpoint': {
      const spec = await client.exportSpec({ includeExtensions: true });

      if (!spec.paths?.[args.path]) {
        return JSON.stringify({ error: `Path "${args.path}" not found` });
      }
      if (!spec.paths[args.path][args.method]) {
        return JSON.stringify({ error: `Method "${args.method}" not found on "${args.path}"` });
      }

      delete spec.paths[args.path][args.method];
      if (Object.keys(spec.paths[args.path]).length === 0) {
        delete spec.paths[args.path];
      }

      const result = await client.importSpec(spec);
      return JSON.stringify({
        success: true,
        action: 'DELETE',
        endpoint: `${args.method.toUpperCase()} ${args.path}`,
        counters: result?.data?.counters,
      }, null, 2);
    }

    case 'apidog_upsert_schema': {
      const partialSpec = {
        openapi: '3.1.0',
        info: { title: 'Schema Update', version: '1.0.0' },
        paths: {},
        components: { schemas: { [args.name]: args.schema } },
      };
      const result = await client.mergeAndImport(partialSpec);
      return JSON.stringify({
        success: true,
        action: 'UPSERT_SCHEMA',
        schema: args.name,
        counters: result.importResult?.data?.counters,
      }, null, 2);
    }

    case 'apidog_import_spec': {
      let result;
      if (args.mergeWithExisting !== false) {
        result = await client.mergeAndImport(args.spec);
      } else {
        result = await client.importSpec(args.spec, {
          endpointOverwriteBehavior: args.overwriteBehavior || 'OVERWRITE_EXISTING',
          schemaOverwriteBehavior: args.overwriteBehavior || 'OVERWRITE_EXISTING',
        });
      }
      return JSON.stringify(result.importResult || result, null, 2);
    }

    // ── ORGANIZE ──────────────────────────────────────────────────────────

    case 'apidog_analyze_folders': {
      const spec = await client.exportSpec({ includeExtensions: true });
      const endpoints = ApidogClient.parseEndpoints(spec);
      const analysis = analyzeFolders(endpoints);

      // Build a tree view
      const folderTree = {};
      for (const [folder, eps] of Object.entries(analysis.folders)) {
        folderTree[folder] = eps.map(e => `${e.method} ${e.path}`);
      }

      return JSON.stringify({
        totalEndpoints: analysis.totalEndpoints,
        totalFolders: analysis.totalFolders,
        unfolderedCount: analysis.unfolderedCount,
        unfoldered: analysis.unfoldered.map(e => `${e.method} ${e.path}`),
        folderTree,
        folderSizes: Object.fromEntries(
          Object.entries(analysis.folders)
            .map(([f, eps]) => [f, eps.length])
            .sort((a, b) => b[1] - a[1])
        ),
      }, null, 2);
    }

    case 'apidog_propose_reorganization': {
      const spec = await client.exportSpec({ includeExtensions: true });
      const endpoints = ApidogClient.parseEndpoints(spec);
      const plan = proposeReorganization(endpoints, {
        strategy: args.strategy || 'path-based',
        groupByVersion: args.groupByVersion || false,
        stripApiPrefix: args.stripApiPrefix !== false,
        maxDepth: args.maxDepth || 3,
        customMappings: args.customMappings || {},
      });

      return JSON.stringify({
        _notice: 'THIS IS A DRY-RUN. No changes have been made. Present this plan to the user and ask for approval before calling apidog_apply_reorganization.',
        strategy: plan.strategy,
        totalEndpoints: plan.totalEndpoints,
        changesCount: plan.changesCount,
        unchangedCount: plan.unchangedCount,
        proposedFolderStructure: plan.proposedFolders,
        changes: plan.changes,
      }, null, 2);
    }

    case 'apidog_apply_reorganization': {
      const spec = await client.exportSpec({ includeExtensions: true });

      // Apply folder changes
      let applied = 0;
      for (const change of args.changes) {
        const method = change.method.toLowerCase();
        if (spec.paths?.[change.path]?.[method]) {
          spec.paths[change.path][method]['x-apidog-folder'] = change.newFolder;
          applied++;
        }
      }

      // Import
      const result = await client.importSpec(spec, {
        endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
        updateFolderOfChangedEndpoint: true,
      });

      return JSON.stringify({
        success: true,
        action: 'REORGANIZE_FOLDERS',
        endpointsUpdated: applied,
        totalChangesRequested: args.changes.length,
        counters: result?.data?.counters,
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
async function main() {
  const config = getConfig();
  const client = new ApidogClient(config.accessToken, config.projectId);

  const server = new Server(
    { name: 'apidog-sync-mcp-server', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleTool(client, name, args || {});
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Apidog Sync MCP Server v2 running');
  console.error(`Project: ${config.projectId}`);
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});

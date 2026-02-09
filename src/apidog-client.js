/**
 * Apidog API Client
 * 
 * Battle-tested from POC — uses the exact export/import flow
 * that was validated against a real Apidog project.
 * 
 * Strategy for writes:
 * 1. Export current spec (preserves existing format, folders, statuses, x-apidog-* extensions)
 * 2. Merge changes into the spec
 * 3. Import back with OVERWRITE_EXISTING
 */

const APIDOG_BASE_URL = 'https://api.apidog.com';
const API_VERSION = '2024-03-28';

export class ApidogClient {
  constructor(accessToken, projectId) {
    this.accessToken = accessToken;
    this.projectId = projectId;
  }

  get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.accessToken}`,
      'X-Apidog-Api-Version': API_VERSION,
    };
  }

  /**
   * Export the full OpenAPI spec from Apidog.
   * Always includes x-apidog-* extensions to preserve format.
   */
  async exportSpec({ oasVersion = '3.1', includeExtensions = true } = {}) {
    const url = `${APIDOG_BASE_URL}/v1/projects/${this.projectId}/export-openapi?locale=en-US`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        scope: { type: 'ALL' },
        options: {
          includeApidogExtensionProperties: includeExtensions,
          addFoldersToTags: false,
        },
        oasVersion,
        exportFormat: 'JSON',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Apidog export failed (${res.status}): ${errText}`);
    }

    return res.json();
  }

  /**
   * Import an OpenAPI spec into Apidog.
   * Uses OVERWRITE_EXISTING — validated in POC to preserve untouched endpoints.
   */
  async importSpec(spec, options = {}) {
    const url = `${APIDOG_BASE_URL}/v1/projects/${this.projectId}/import-openapi?locale=en-US`;

    const {
      targetEndpointFolderId = 0,
      targetSchemaFolderId = 0,
      endpointOverwriteBehavior = 'OVERWRITE_EXISTING',
      schemaOverwriteBehavior = 'OVERWRITE_EXISTING',
      updateFolderOfChangedEndpoint = false,
      prependBasePath = false,
    } = options;

    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        input: typeof spec === 'string' ? spec : JSON.stringify(spec),
        options: {
          targetEndpointFolderId,
          targetSchemaFolderId,
          endpointOverwriteBehavior,
          schemaOverwriteBehavior,
          updateFolderOfChangedEndpoint,
          prependBasePath,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Apidog import failed (${res.status}): ${errText}`);
    }

    return res.json();
  }

  /**
   * Export → Merge → Import cycle.
   * This is the core write operation validated in the POC.
   */
  async mergeAndImport(partialSpec) {
    // 1. Export current spec with extensions
    const currentSpec = await this.exportSpec({ includeExtensions: true });

    // 2. Merge paths
    if (partialSpec.paths) {
      if (!currentSpec.paths) currentSpec.paths = {};
      for (const [path, methods] of Object.entries(partialSpec.paths)) {
        if (!currentSpec.paths[path]) {
          currentSpec.paths[path] = methods;
        } else {
          for (const [method, operation] of Object.entries(methods)) {
            currentSpec.paths[path][method] = operation;
          }
        }
      }
    }

    // 3. Merge schemas
    if (partialSpec.components?.schemas) {
      if (!currentSpec.components) currentSpec.components = {};
      if (!currentSpec.components.schemas) currentSpec.components.schemas = {};
      Object.assign(currentSpec.components.schemas, partialSpec.components.schemas);
    }

    // 4. Merge tags
    if (partialSpec.tags) {
      if (!currentSpec.tags) currentSpec.tags = [];
      const existingTagNames = new Set(currentSpec.tags.map(t => t.name));
      for (const tag of partialSpec.tags) {
        if (!existingTagNames.has(tag.name)) {
          currentSpec.tags.push(tag);
        }
      }
    }

    // 5. Import
    const result = await this.importSpec(currentSpec);
    return { mergedSpec: currentSpec, importResult: result };
  }

  /**
   * Parse all endpoints from a spec into a flat list.
   */
  static parseEndpoints(spec) {
    const endpoints = [];
    for (const [path, methods] of Object.entries(spec.paths || {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
          endpoints.push({
            method: method.toUpperCase(),
            path,
            summary: op.summary || '',
            description: op.description || '',
            tags: op.tags || [],
            deprecated: op.deprecated || false,
            folder: op['x-apidog-folder'] || null,
            status: op['x-apidog-status'] || null,
            maintainer: op['x-apidog-maintainer'] || null,
            operation: op,
          });
        }
      }
    }
    return endpoints;
  }
}

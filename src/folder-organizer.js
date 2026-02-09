/**
 * Folder Organizer
 * 
 * Analyzes the current folder structure of Apidog endpoints
 * and proposes better organization based on route patterns.
 * 
 * Strategy:
 * - Parse all endpoints and their current folders
 * - Detect patterns from URL paths (e.g., /api/v1/admin/billing → Admin/Billing)
 * - Group by common prefixes, resource names, and API versions
 * - Produce a reorganization plan (old folder → new folder)
 * - The user validates before anything is applied
 */

/**
 * Analyze current folder structure and return stats.
 */
export function analyzeFolders(endpoints) {
  const folders = {};
  const noFolder = [];

  for (const ep of endpoints) {
    const folder = ep.folder || ep.operation?.['x-apidog-folder'] || null;
    if (folder) {
      if (!folders[folder]) folders[folder] = [];
      folders[folder].push(ep);
    } else {
      noFolder.push(ep);
    }
  }

  return {
    totalEndpoints: endpoints.length,
    totalFolders: Object.keys(folders).length,
    unfolderedCount: noFolder.length,
    folders,
    unfoldered: noFolder,
  };
}

/**
 * Infer a folder path from an endpoint's URL path.
 * 
 * Examples:
 *   /api/v1/admin/billing/validate-peppol-id → "API V1/Admin/Billing"
 *   /api/v1/users/{id}                       → "API V1/Users"
 *   /api/v1/users/{id}/documents              → "API V1/Users/Documents"
 *   /auth/login                               → "Auth"
 */
export function inferFolderFromPath(urlPath, options = {}) {
  const {
    stripApiPrefix = true,
    stripVersion = false,
    maxDepth = 3,
    capitalizeSegments = true,
  } = options;

  let segments = urlPath.split('/').filter(Boolean);

  // Remove 'api' prefix if desired
  if (stripApiPrefix && segments[0]?.toLowerCase() === 'api') {
    segments.shift();
  }

  // Optionally strip version segment (v1, v2, etc.)
  if (stripVersion && /^v\d+$/i.test(segments[0])) {
    segments.shift();
  }

  // Remove path parameters ({id}, {userId}, etc.)
  segments = segments.filter(s => !s.startsWith('{'));

  // Remove the last segment if it looks like an action (verb-based)
  // e.g., validate-peppol-id, reset-password, send-invite
  // Keep it only if we'd have 0 segments without it
  if (segments.length > 1) {
    const last = segments[segments.length - 1];
    if (last.includes('-') && segments.length > 1) {
      // Likely an action, remove it from folder path
      segments.pop();
    }
  }

  // Limit depth
  segments = segments.slice(0, maxDepth);

  // Capitalize and clean up
  if (capitalizeSegments) {
    segments = segments.map(s =>
      s.split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
    );
  }

  return segments.join('/');
}

/**
 * Propose a complete folder reorganization.
 * 
 * Returns a plan with:
 * - current: current folder → endpoints mapping
 * - proposed: proposed folder → endpoints mapping
 * - changes: list of individual moves (endpoint, oldFolder, newFolder)
 * - unchanged: endpoints that stay in the same folder
 */
export function proposeReorganization(endpoints, options = {}) {
  const {
    strategy = 'path-based',      // 'path-based' | 'preserve-top-level' | 'flat'
    groupByVersion = false,        // Group by API version (v1, v2)
    stripApiPrefix = true,
    maxDepth = 3,
    customMappings = {},           // Manual overrides: { pathPrefix: folderName }
  } = options;

  const changes = [];
  const unchanged = [];
  const proposedFolders = {};

  for (const ep of endpoints) {
    const currentFolder = ep.folder || ep.operation?.['x-apidog-folder'] || null;
    let newFolder;

    // Check custom mappings first
    const matchedMapping = Object.entries(customMappings).find(([prefix]) =>
      ep.path.startsWith(prefix)
    );
    if (matchedMapping) {
      newFolder = matchedMapping[1];
    } else {
      switch (strategy) {
        case 'path-based':
          newFolder = inferFolderFromPath(ep.path, {
            stripApiPrefix,
            stripVersion: !groupByVersion,
            maxDepth,
          });
          break;

        case 'preserve-top-level':
          // Keep existing top-level folder, reorganize sub-levels
          if (currentFolder) {
            const topLevel = currentFolder.split('/')[0];
            const inferredSub = inferFolderFromPath(ep.path, { stripApiPrefix, stripVersion: true, maxDepth: maxDepth - 1 });
            newFolder = `${topLevel}/${inferredSub}`;
          } else {
            newFolder = inferFolderFromPath(ep.path, { stripApiPrefix, stripVersion: !groupByVersion, maxDepth });
          }
          break;

        case 'flat':
          // Just one level deep based on the main resource
          const segments = ep.path.split('/').filter(s => s && !s.startsWith('{') && s.toLowerCase() !== 'api' && !/^v\d+$/i.test(s));
          newFolder = segments[0]
            ? segments[0].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
            : 'Other';
          break;

        default:
          newFolder = inferFolderFromPath(ep.path, { stripApiPrefix, maxDepth });
      }
    }

    if (!newFolder || newFolder.trim() === '') newFolder = 'Other';

    if (!proposedFolders[newFolder]) proposedFolders[newFolder] = [];
    proposedFolders[newFolder].push(ep);

    if (currentFolder === newFolder) {
      unchanged.push({ method: ep.method, path: ep.path, folder: currentFolder });
    } else {
      changes.push({
        method: ep.method,
        path: ep.path,
        summary: ep.summary,
        oldFolder: currentFolder || '(none)',
        newFolder,
      });
    }
  }

  return {
    strategy,
    totalEndpoints: endpoints.length,
    changesCount: changes.length,
    unchangedCount: unchanged.length,
    proposedFolders: Object.fromEntries(
      Object.entries(proposedFolders).map(([folder, eps]) => [
        folder,
        eps.map(e => ({ method: e.method, path: e.path, summary: e.summary })),
      ])
    ),
    changes,
    unchanged,
  };
}

/**
 * Apply a folder reorganization plan to a spec.
 * Returns a new spec with updated x-apidog-folder values.
 */
export function applyReorganization(spec, plan) {
  const updatedSpec = JSON.parse(JSON.stringify(spec));

  for (const change of plan.changes) {
    const method = change.method.toLowerCase();
    const path = change.path;

    if (updatedSpec.paths?.[path]?.[method]) {
      updatedSpec.paths[path][method]['x-apidog-folder'] = change.newFolder;
    }
  }

  return updatedSpec;
}

/**
 * Diff Utility
 * 
 * Compares two OpenAPI operation objects and produces a structured diff.
 * Extracted from the validated POC flow.
 */

/**
 * Deep diff two objects, producing a list of changes.
 */
export function deepDiff(oldObj, newObj, path = '') {
  const changes = [];
  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);

  for (const key of allKeys) {
    const fullPath = path ? `${path}.${key}` : key;
    const oldVal = oldObj?.[key];
    const newVal = newObj?.[key];

    // Skip Apidog internal links
    if (key === 'x-run-in-apidog') continue;

    if (oldVal === undefined && newVal !== undefined) {
      changes.push({ type: 'added', path: fullPath, value: newVal });
    } else if (oldVal !== undefined && newVal === undefined) {
      changes.push({ type: 'removed', path: fullPath, value: oldVal });
    } else if (typeof oldVal === 'object' && typeof newVal === 'object' && oldVal !== null && newVal !== null) {
      if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes.push({ type: 'changed', path: fullPath, oldValue: oldVal, newValue: newVal });
        }
      } else {
        changes.push(...deepDiff(oldVal, newVal, fullPath));
      }
    } else if (oldVal !== newVal) {
      changes.push({ type: 'changed', path: fullPath, oldValue: oldVal, newValue: newVal });
    }
  }

  return changes;
}

/**
 * Format a diff into a readable text summary.
 */
export function formatDiff(changes) {
  if (changes.length === 0) return 'No changes detected.';

  const groups = {};
  for (const change of changes) {
    const section = change.path.split('.')[0];
    if (!groups[section]) groups[section] = [];
    groups[section].push(change);
  }

  const lines = [`${changes.length} change(s) detected:\n`];

  for (const [section, sectionChanges] of Object.entries(groups)) {
    lines.push(`${section}:`);
    for (const change of sectionChanges) {
      const shortPath = change.path.replace(`${section}.`, '');
      switch (change.type) {
        case 'added':
          lines.push(`  + ${shortPath}: ${truncate(JSON.stringify(change.value))}`);
          break;
        case 'removed':
          lines.push(`  - ${shortPath}: ${truncate(JSON.stringify(change.value))}`);
          break;
        case 'changed':
          lines.push(`  ~ ${shortPath}:`);
          lines.push(`      old: ${truncate(JSON.stringify(change.oldValue))}`);
          lines.push(`      new: ${truncate(JSON.stringify(change.newValue))}`);
          break;
      }
    }
  }

  return lines.join('\n');
}

function truncate(str, max = 150) {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

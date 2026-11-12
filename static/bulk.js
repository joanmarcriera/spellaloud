// bulk.js - pure helpers for deleting many words at once on the parent page (Vikunja #6328).
// The browser build has one all-or-nothing store route (POST /api/words/delete); the LAN server has none, so
// there it is one DELETE per word. Kept out of parent.js so node can test it.

/** The API calls that delete `ids`: [[method, path, body?], ...]. `mode` is the transport mode ('local' = browser build). */
export function bulkDeletePlan(ids, mode) {
  const list = [...new Set(ids)];
  if (!list.length) return [];
  return mode === 'local' ? [['POST', '/api/words/delete', { ids: list }]] : list.map((id) => ['DELETE', `/api/words/${id}`]);
}

/** One confirm for the whole selection: says how many, names a few, and warns the clips and history go too. */
export function bulkConfirmText(labels) {
  const n = labels.length;
  const shown = labels.slice(0, 5).map((l) => `"${l}"`).join(', ') + (n > 5 ? `, and ${n - 5} more` : '');
  return `Delete ${n} word${n === 1 ? '' : 's'} (${shown})? Their recordings and any practice history will be deleted too. This cannot be undone.`;
}

/** Select-all state for the header box: 'none' | 'some' | 'all' (an empty week is 'none'). */
export function selectionState(selectedCount, total) {
  if (!total || !selectedCount) return 'none';
  return selectedCount >= total ? 'all' : 'some';
}

/** The label on the Delete button: shows the count once something is selected. */
export const bulkButtonText = (n) => (n > 0 ? `Delete selected (${n})` : 'Delete selected');

// Turn free-text user input into a safe FTS5 MATCH query with prefix matching per term.
function buildFtsQuery(q) {
  if (!q) return null;
  const terms = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/["*]/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  if (!terms.length) return null;
  return terms.join(' AND ');
}

module.exports = { buildFtsQuery };

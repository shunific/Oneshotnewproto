function canonicalSession(value) {
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, key === 'startTime' && Number.isFinite(Date.parse(value[key])) ? new Date(value[key]).toISOString() : normalize(value[key])]));
  };
  return JSON.stringify(normalize(value));
}
module.exports = { canonicalSession };

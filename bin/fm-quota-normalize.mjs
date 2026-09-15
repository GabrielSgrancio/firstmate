#!/usr/bin/env node

const SUPPORTED_SCHEMA_VERSIONS = new Set([3, 5]);

function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}
function normalizeWindow(window) {
  const percentRemaining = window.percentRemaining ??
    (finitePercent(window.percentUsed) ? 100 - window.percentUsed : null);
  return {
    id: typeof window.id === 'string' ? window.id : null,
    percent_remaining: finitePercent(percentRemaining) ? percentRemaining : null,
    percent_used: finitePercent(window.percentUsed) ? window.percentUsed : null,
    reset_at: window.resetsAt ?? window.resetAt ?? null
  };
}

export function normalizeQuotaAxiSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('quota-axi output must be an object');
  }
  const schemaVersion = Number(raw.schemaVersion);
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new Error(`unsupported quota-axi schema version: ${raw.schemaVersion ?? 'missing'}`);
  }
  if (!Array.isArray(raw.providers)) {
    throw new Error('quota-axi output providers must be an array');
  }

  const providers = raw.providers.map((provider) => {
    if (!provider || typeof provider.provider !== 'string' || !provider.provider) {
      throw new Error('quota-axi provider identity is invalid');
    }
    const semantics = provider.quotaSemantics || {};
    const availability = Array.isArray(semantics.effectiveAvailability)
      ? semantics.effectiveAvailability.map((entry) => ({
        scope: entry.scope,
        status: entry.status,
        effectivePercentRemaining: finitePercent(entry.effectivePercentRemaining)
          ? entry.effectivePercentRemaining
          : null,
        runway: entry.runway || { status: 'unknown' }
      }))
      : [];
    return {
      provider: provider.provider,
      state: provider.state || { status: 'unknown', stale: true },
      quotaSemantics: {
        status: ['known', 'partial', 'unknown'].includes(semantics.status)
          ? semantics.status
          : 'unknown',
        effectiveAvailability: availability
      },
      windows: Array.isArray(provider.windows) ? provider.windows.map(normalizeWindow) : [],
      provenance: {
        source: 'quota-axi',
        schema_version: schemaVersion,
        generated_at: raw.generatedAt || null
      }
    };
  });

  return {
    schemaVersion,
    generatedAt: raw.generatedAt || null,
    providers
  };
}

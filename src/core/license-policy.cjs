'use strict';

// The desktop licence client is the only authority for signed, trusted-clock
// status. The worker exposes a small public snapshot, never keys or receipts.
const PUBLIC_FIELDS = ['status', 'plan', 'trialStartedAt', 'expiresAt', 'remainingMs',
  'offlineUntil', 'offlineRemainingMs', 'reasonCode', 'reason', 'serverConfigured',
  'lastValidatedAt', 'deviceLabel', 'activationRequired', 'warning', 'warningDays'];

function unavailableStatus() {
  return { allowed: false, status: 'unavailable', plan: null, remainingMs: 0,
    serverConfigured: false, reasonCode: 'LICENSE_SERVICE_UNAVAILABLE',
    reason: 'O serviço de licença não está disponível. Abra Licença para validar ou ativar; seus dados foram preservados.' };
}

function confirmedLicenseExpiry(value) {
  return Boolean(value && value.allowed === false &&
    (value.status === 'expired' || ['LICENSE_EXPIRED', 'LICENSE_TRIAL_EXPIRED', 'TRIAL_EXPIRED'].includes(value.reasonCode)));
}

function publicLicenseStatus(value, { resumeRequired = false } = {}) {
  if (!value || typeof value !== 'object') value = unavailableStatus();
  const result = { allowed: value.allowed === true, autoResumeRequired: resumeRequired === true, totalBlocked: confirmedLicenseExpiry(value) };
  for (const field of PUBLIC_FIELDS) {
    const entry = value[field];
    if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) result[field] = typeof entry === 'string' ? entry.slice(0, 1000) : entry;
  }
  return result;
}

function licenseError(status, operation = 'operation') {
  const code = typeof status?.reasonCode === 'string' && /^LICENSE_[A-Z0-9_]{1,64}$/.test(status.reasonCode)
    ? status.reasonCode : 'LICENSE_REQUIRED';
  const error = new Error(status?.reason || 'O teste ou a licença não permite novos envios. Abra Licença para ativar ou validar. Seus dados foram preservados.');
  return Object.assign(error, { code, operation, definitive: true, safeToRetry: false, submitted: false });
}

function unavailableLicenseService() {
  return {
    initialize: async () => unavailableStatus(),
    getStatus: unavailableStatus,
    assertAllowed(operation) { throw licenseError(unavailableStatus(), operation); },
    activate: async () => { throw licenseError(unavailableStatus(), 'activate'); },
    validate: async () => { throw licenseError(unavailableStatus(), 'validate'); },
    tick: async () => unavailableStatus()
  };
}

module.exports = { publicLicenseStatus, unavailableLicenseService, licenseError, confirmedLicenseExpiry };

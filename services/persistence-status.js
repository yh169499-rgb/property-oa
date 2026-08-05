const state = {
  remoteEnabled: false,
  pendingUpload: false,
  lastSyncAt: null,
  lastSyncError: null,
  lastRemoteObject: null,
};

function configurePersistence(enabled) {
  state.remoteEnabled = Boolean(enabled);
  if (!state.remoteEnabled) state.pendingUpload = false;
}

function markUploadPending() {
  state.pendingUpload = true;
}

function markUploadSuccess(result) {
  state.pendingUpload = false;
  state.lastSyncAt = new Date().toISOString();
  state.lastSyncError = null;
  state.lastRemoteObject = result?.backupPath || null;
}

function markUploadError(error) {
  state.pendingUpload = false;
  state.lastSyncError = error?.message || String(error);
}

function getPersistenceStatus() {
  return { ...state };
}

module.exports = {
  configurePersistence,
  markUploadPending,
  markUploadSuccess,
  markUploadError,
  getPersistenceStatus,
};
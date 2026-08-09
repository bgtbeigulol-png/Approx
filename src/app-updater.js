import {
  applyUpdate as applyAvailableUpdate,
  checkForUpdate,
  formatUpdateFailure,
} from './updater.js';

export const updaterMethods = {
  async checkForUpdates({ force = false } = {}) {
    if (this._updateCheck) return this._updateCheck;
    if (!force && this.preferences.updateNotifications === false && !this.preferences.autoUpdate) return null;
    this.st.update.checking = true;
    if (force) this.toast('checking for updates', 'info');
    this.s.invalidate();
    this.requestFrame?.();
    const checker = this._checkForUpdate || checkForUpdate;
    this._updateCheck = checker().then(async (result) => {
      this.st.update.checking = false;
      this.st.update.info = result;
      this.st.update.checkedAt = Date.now();
      if (result.reason) {
        if (force) this.toast(`update check failed · ${formatUpdateFailure(result)}`, 'warn');
      } else if (result.available) {
        if (this.preferences.autoUpdate) return this.applyUpdate(result);
        const identity = updateIdentity(result);
        const hidden = identity && this.preferences.hiddenUpdateVersion === identity;
        if (this.preferences.updateNotifications !== false && !hidden) {
          const source = result.channel === 'npm' ? 'npm' : result.upstream || 'Git';
          this.toast(`update ${result.version || result.remote.slice(0, 7)} available via ${source} · /update install`, 'info');
        }
      } else if (force) {
        this.toast(`Approx ${result.currentVersion || result.version || ''} is up to date via ${result.channel}`.replace(/\s+/g, ' '), 'ok');
      }
      this.persistPreferences();
      this.s.invalidate();
      this.requestFrame?.();
      return result;
    }).catch((error) => {
      const message = String(error?.message ?? error);
      this.st.update.checking = false;
      this.st.update.info = {
        available: false,
        channel: 'update',
        reason: 'check-failed',
        error: message,
      };
      this.st.update.checkedAt = Date.now();
      this.toast(`update check failed · ${message}`, 'warn');
      this.persistPreferences();
      this.s.invalidate();
      this.requestFrame?.();
      return this.st.update.info;
    }).finally(() => { this._updateCheck = null; });
    return this._updateCheck;
  },

  async applyUpdate(check = null) {
    this.st.update.updating = true;
    this.toast('installing latest update', 'info');
    this.s.invalidate();
    this.requestFrame?.();
    const apply = this._applyAvailableUpdate || applyAvailableUpdate;
    let result;
    try {
      result = await apply({ check: check?.available ? check : undefined });
    } catch (error) {
      result = {
        updated: false,
        reason: 'update-failed',
        error: String(error?.message ?? error),
      };
    }
    this.st.update.updating = false;
    if (result.updated && !result.dependencyWarning) {
      this.st.update.info = { available: false, ...result };
      this.toast(`Approx ${result.version || ''} updated via ${result.channel} · restart to load it`.replace(/\s+/g, ' '), 'ok');
    } else if (result.updated) {
      this.st.update.info = { available: false, ...result };
      this.toast(`source updated · dependency sync failed: ${result.dependencyWarning}`, 'warn');
    } else {
      this.st.update.info = result;
      this.toast(`update stopped · ${formatUpdateFailure(result)}`, 'warn');
    }
    this.persistPreferences();
    this.s.invalidate();
    this.requestFrame?.();
    return result;
  },

  commandUpdate(arg = '') {
    const action = String(arg).trim().toLowerCase();
    if (action === 'hide') {
      this.preferences.hiddenUpdateVersion = updateIdentity(this.st.update.info) || 'current';
      delete this.preferences.updateNoticeHidden;
      this.persistPreferences();
      return this.toast('this update notice is hidden', 'ok');
    }
    if (action === 'show') {
      delete this.preferences.hiddenUpdateVersion;
      delete this.preferences.updateNoticeHidden;
      this.persistPreferences();
      return this.toast('update notices enabled', 'ok');
    }
    if (action === 'install' || action === 'apply') return void this.applyUpdate();
    return void this.checkForUpdates({ force: true });
  },

  setAutoUpdate(enabled) {
    this.preferences.autoUpdate = !!enabled;
    this.persistPreferences();
    this.s.invalidate();
  },

  setUpdateNotifications(enabled) {
    this.preferences.updateNotifications = !!enabled;
    if (enabled) {
      delete this.preferences.hiddenUpdateVersion;
      delete this.preferences.updateNoticeHidden;
    }
    this.persistPreferences();
    this.s.invalidate();
  },
};

function updateIdentity(result = {}) {
  return String(result?.version || result?.remote || '');
}

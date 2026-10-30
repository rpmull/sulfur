// Auto Save, as VS Code's files.autoSave: afterDelay saves a file some time after it was
// last edited; onFocusChange when its editor loses the focus (another tab, another view);
// onWindowChange when the window does. Pure but for the timers it's given, so the
// workbench's tabs are its only state.
export const AUTO_SAVE_MODES = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'];

export function autoSaver({ save, setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout }) {
  const timers = new Map();
  const drop = (tab) => { if (timers.has(tab)) { cancel(timers.get(tab)); timers.delete(tab); } };
  return {
    // a tab's state changed: dirty or clean, under the mode and delay set now
    changed(tab, dirty, mode, delay = 1000) {
      drop(tab);
      if (!dirty || mode !== 'afterDelay') return;
      timers.set(tab, later(() => { timers.delete(tab); save(tab, mode); }, Math.max(100, Number(delay) || 1000)));
    },
    // the focus left: why 'window' for the whole window, 'editor' for the tab or view
    focusLost(tabs, mode, why = 'editor') {
      if (mode !== 'onFocusChange' && !(mode === 'onWindowChange' && why === 'window')) return [];
      const saved = [];
      for (const tab of tabs) { drop(tab); save(tab, mode); saved.push(tab); }
      return saved;
    },
    pending: (tab) => timers.has(tab),
    forget: drop,
    dispose() { for (const tab of [...timers.keys()]) drop(tab); },
  };
}

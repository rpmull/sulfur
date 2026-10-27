(() => {
  if (location.origin !== 'http://127.0.0.1:47615') return;
  const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
  const native = () => window.__TAURI__.window.getCurrentWindow();
  window.sulfurApp = {
    os: /Windows/.test(navigator.userAgent)
      ? 'windows'
      : /Mac/.test(navigator.platform)
        ? 'darwin'
        : 'linux',
    decorated: /Mac/.test(navigator.platform),
    minimize: () => native().minimize(),
    toggleMaximize: () => native().toggleMaximize(),
    isMaximized: () => native().isMaximized(),
    startDragging: () => native().startDragging(),
    setTitle: (title) => native().setTitle(title),
    destroy: () => invoke('finish_close'),
    ready: () => invoke('ready'),
    installUpdate: (file) => invoke('install_update', { file }),
    openUrl: (url) => {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol))
        return Promise.reject(new Error('not a web address'));
      return invoke('plugin:opener|open_url', { url: parsed.href, with: null });
    },
    pick: (options = {}) =>
      invoke('plugin:dialog|open', {
        options: {
          directory: !!options.directory,
          multiple: false,
          title: options.title,
          defaultPath: options.defaultPath || undefined,
        },
      }),
  };
})();

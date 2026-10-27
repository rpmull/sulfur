import library from '../assets/themes.json';
const rule = (selector, values) =>
  `${selector} {${Object.keys(values)
    .sort()
    .map((k) => ` ${k}: ${values[k]};`)
    .join('')} }\n`;
export function themeCSS() {
  let css = '/* generated from assets/themes.json */\n';
  const base = library.base;
  for (const theme of library.themes)
    for (const mode of ['dark', 'light', 'oled']) {
      const suffix = mode === 'dark' ? '' : `[data-theme="${mode}"]`;
      let on = `[data-palette="${theme.id}"]${suffix}`;
      if (theme.id === 'phosphorus') on += `, :not([data-palette])${suffix}`;
      css += rule(`:root:where(${on})`, {
        ...base.dark,
        ...theme.dark,
        ...(mode === 'dark' ? {} : { ...base[mode], ...theme[mode] }),
      });
      css += rule(`:where(:root:where(${on})) .ide-win`, {
        ...base.ide?.dark,
        ...(mode === 'dark' ? {} : base.ide?.[mode]),
        ...theme.ide?.dark,
        ...(mode === 'dark' ? {} : theme.ide?.[mode]),
      });
      for (const selector of Object.keys(theme.scopes || {}).sort())
        css += rule(`:where(:root:where(${on})) ${selector}`, {
          ...theme.scopes[selector].dark,
          ...(mode === 'dark' ? {} : theme.scopes[selector][mode]),
        });
    }
  return css;
}

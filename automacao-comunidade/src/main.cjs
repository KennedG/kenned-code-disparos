'use strict';
const { createDesktop } = require('./desktop/runtime.cjs');
// Electron loads CommonJS entry points through its bootstrap; require.main
// need not equal this module (including launches by the installer/Playwright).
if (process.versions.electron && process.type === 'browser') {
  const electron = require('electron');
  createDesktop(electron).catch(error => {
    electron.dialog.showErrorBox('Automação Comunidade', `Não foi possível abrir o aplicativo. Seus dados foram preservados.\n\n${error.message}`);
    electron.app.quit();
  });
}
module.exports = { createDesktop };

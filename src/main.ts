import {
  app,
  BrowserWindow,
  desktopCapturer,
  Menu,
  MenuItem,
  globalShortcut,
  Tray,
  nativeImage,
  autoUpdater,
  dialog,
  systemPreferences,
  MenuItemConstructorOptions,
  Event,
  Input,
} from 'electron';
import {autoUpdater as electronUpdater} from 'electron-updater';
import log from 'electron-log';
import path from 'path';
import fs from 'fs';

// Configure logging
log.transports.file.level = 'info';
electronUpdater.logger = log;

// Implement single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let noiseCancellationEnabled = false;

const toggleMute = (): void => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents
      .executeJavaScript(
        `
            (function() {
                // Search for button where title contains "mute microphone" (case-insensitive)
                const muteButton = document.querySelector('button[title*="mute microphone" i]');
                if (muteButton) {
                    muteButton.click();
                    console.log("Toggled mute");
                } else {
                    console.log("Mute button not found (title='*mute microphone*')");
                }
            })()
        `
      )
      .catch((err: unknown) => console.error('Failed to toggle mute:', err));
  }
};

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1024,
    height: 800,
    title: `Danny DeClient v${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      sandbox: false,
    },
  });

  win.on('page-title-updated', (e: Event) => {
    e.preventDefault();
  });

  win.removeMenu();

  if (process.platform === 'linux') {
    // Linux: no system picker available — use custom picker with audio toggle.
    // Each source is listed twice: video-only and video + system audio loopback.
    win.webContents.session.setDisplayMediaRequestHandler(
      (request, callback) => {
        desktopCapturer
          .getSources({types: ['screen', 'window']})
          .then((sources) => {
            console.log(
              'Got sources for screen sharing:',
              sources.map((s) => s.name)
            );

            const menuItems: Electron.MenuItemConstructorOptions[] = [];
            for (const source of sources) {
              menuItems.push({
                label: `${source.name} (without audio)`,
                click: () => {
                  console.log('Selected source (video only):', source.name);
                  callback({video: source});
                },
              });
              menuItems.push({
                label: `${source.name} (with audio)`,
                click: () => {
                  console.log('Selected source (with audio):', source.name);
                  callback({video: source, audio: 'loopback'});
                },
              });
              menuItems.push({type: 'separator'});
            }

            const menu = Menu.buildFromTemplate(menuItems);
            menu.popup();
          })
          .catch((err: unknown) => {
            console.error('Error getting sources:', err);
          });
      }
    );
  } else if (process.platform === 'darwin') {
    // macOS: use the OS native picker (ScreenCaptureKit) which respects restrictOwnAudio,
    // filtering out our own tab's voice chat audio from the loopback capture.
    win.webContents.session.setDisplayMediaRequestHandler(
      (_request, _callback) => {
        // Don't call callback — let the system picker handle it
        console.log('System picker requested');
      },
      {useSystemPicker: true}
    );
  } else if (process.platform === 'win32') {
    // Windows: custom picker with system audio loopback via Electron's built-in support
    win.webContents.session.setDisplayMediaRequestHandler(
      (request, callback) => {
        desktopCapturer
          .getSources({types: ['screen', 'window']})
          .then((sources) => {
            console.log(
              '[DannyDeClient] Windows sources:',
              sources.map((s) => s.name)
            );

            const menuItems: Electron.MenuItemConstructorOptions[] = [];
            for (const source of sources) {
              menuItems.push({
                label: `${source.name} (with audio)`,
                click: () => {
                  console.log('[DannyDeClient] Selected (with audio):', source.name);
                  callback({video: source, audio: 'loopback'});
                },
              });
              menuItems.push({
                label: `${source.name} (without audio)`,
                click: () => {
                  console.log('[DannyDeClient] Selected (no audio):', source.name);
                  callback({video: source});
                },
              });
              menuItems.push({type: 'separator'});
            }

            const menu = Menu.buildFromTemplate(menuItems);
            menu.popup();
          })
          .catch((err: unknown) => {
            console.error('[DannyDeClient] Error getting sources:', err);
          });
      }
    );
  }

  if (process.platform === 'darwin') {
    // macOS: inject restrictOwnAudio into getDisplayMedia constraints.
    // Works because useSystemPicker uses ScreenCaptureKit which respects this.
    win.webContents.on('did-finish-load', () => {
      win.webContents
        .executeJavaScript(
          `
          (function() {
            const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getDisplayMedia = function(constraints) {
              constraints = constraints || {};
              if (constraints.audio === true) {
                constraints.audio = { restrictOwnAudio: true };
              } else if (constraints.audio && typeof constraints.audio === 'object') {
                constraints.audio.restrictOwnAudio = true;
              } else if (!constraints.audio) {
                constraints.audio = { restrictOwnAudio: true };
              }
              console.log('[DannyDeClient] getDisplayMedia called with restrictOwnAudio');
              return orig(constraints);
            };
            console.log('[DannyDeClient] restrictOwnAudio wrapper installed');
          })();
          `
        )
        .catch((err: unknown) =>
          console.error('Failed to inject restrictOwnAudio wrapper:', err)
        );
    });
  }

  // Handle permission requests
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      console.log('Permission requested:', permission);
      const allowedPermissions = [
        'media',
        'display-capture',
        'mediaKeySystem',
        'clipboard-read',
        'clipboard-write',
        'notifications',
        'speaker-selection',
      ];
      if (allowedPermissions.includes(permission)) {
        callback(true);
      } else {
        console.log('Permission denied by handler:', permission);
        callback(false);
      }
    }
  );

  // Handle permission checks (synchronous)
  win.webContents.session.setPermissionCheckHandler(
    (_webContents, permission) => {
      const allowedPermissions = [
        'media',
        'display-capture',
        'mediaKeySystem',
        'clipboard-read',
        'clipboard-write',
        'notifications',
        'speaker-selection',
      ];
      if (allowedPermissions.includes(permission)) {
        return true;
      }
      console.log('Permission check denied:', permission);
      return false;
    }
  );

  win.setTitle(`Danny DeClient v${app.getVersion()}`);
  void win.loadURL('https://chat.dannydedisco.eu');

  // Enable DevTools via F12 or Ctrl+Shift+I (Development only)
  win.webContents.on('before-input-event', (event: Event, input: Input) => {
    if (!app.isPackaged) {
      if (input.key === 'F12' && input.type === 'keyDown') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
      if (
        input.control &&
        input.shift &&
        input.key.toLowerCase() === 'i' &&
        input.type === 'keyDown'
      ) {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    }

    // Add local listener as a fallback (especially for Linux/Wayland)
    if (input.key === 'F4' && input.type === 'keyDown') {
      console.log('Local F4 pressed');
      toggleMute();
      event.preventDefault();
    }
  });

  win.on('close', (event: Event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  // Check permissions on macOS
  if (process.platform === 'darwin') {
    const checkMediaAccess = async (): Promise<void> => {
      try {
        const micStatus =
          systemPreferences.getMediaAccessStatus('microphone');
        console.log('Microphone access status:', micStatus);
        if (micStatus === 'not-determined' || micStatus === 'unknown') {
          const access =
            await systemPreferences.askForMediaAccess('microphone');
          console.log(
            'Microphone access requested:',
            access ? 'granted' : 'denied'
          );
        }

        const cameraStatus =
          systemPreferences.getMediaAccessStatus('camera');
        console.log('Camera access status:', cameraStatus);
        if (cameraStatus === 'not-determined' || cameraStatus === 'unknown') {
          const access = await systemPreferences.askForMediaAccess('camera');
          console.log(
            'Camera access requested:',
            access ? 'granted' : 'denied'
          );
        }
      } catch (err) {
        console.error('Failed to check media access:', err);
      }
    };

    void checkMediaAccess();

    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    console.log('Screen recording access status:', screenStatus);
  }

  return win;
};

app.setAppUserModelId('com.carfizzy.danny-de-client');

// Explicitly disable GlobalShortcutsPortal to force X11/XWayland path on Linux
app.commandLine.appendSwitch('disable-features', 'GlobalShortcutsPortal');

// Enable system audio loopback for screen sharing
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride'
  );
} else if (process.platform === 'linux') {
  app.commandLine.appendSwitch(
    'enable-features',
    'PulseaudioLoopbackForScreenShare'
  );
} else if (process.platform === 'win32') {
  app.commandLine.appendSwitch(
    'enable-features',
    'WASAPIAudioLoopbackForScreenShare'
  );
}


app.whenReady().then(() => {
  // Load persisted settings
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');

  const loadSettings = (): { noiseCancellationEnabled: boolean } => {
    try {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
        noiseCancellationEnabled: boolean;
      };
    } catch {
      return {noiseCancellationEnabled: false};
    }
  };

  const saveSettings = (): void => {
    try {
      fs.writeFileSync(settingsPath, JSON.stringify({noiseCancellationEnabled}));
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  };

  noiseCancellationEnabled = loadSettings().noiseCancellationEnabled;

  mainWindow = createWindow();

  // Send persisted NC state to the renderer once the page has loaded
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('nc-toggle', noiseCancellationEnabled);
  });

  if (app.isPackaged) {
    // Configure autoUpdater
    if (process.platform === 'linux') {
      void electronUpdater.checkForUpdatesAndNotify();
    } else {
      const server = 'https://dannydeclient-updates.vercel.app';
      const feedURL = `${server}/update/${process.platform}/${app.getVersion()}`;

      try {
        autoUpdater.setFeedURL({url: feedURL});

        autoUpdater.on(
          'update-downloaded',
          (_event, releaseNotes: string, releaseName: string) => {
            const dialogOpts = {
              type: 'info' as const,
              buttons: ['Restart', 'Later'],
              title: 'Application Update',
              message:
                process.platform === 'win32' ? releaseNotes : releaseName,
              detail:
                'A new version has been downloaded. Restart the application to apply the updates.',
            };

            dialog.showMessageBox(dialogOpts).then((returnValue) => {
              if (returnValue.response === 0) autoUpdater.quitAndInstall();
            });
          }
        );

        autoUpdater.on('error', (message: Error) => {
          console.error('There was a problem updating the application');
          console.error(message);
        });

        // Check for updates immediately on startup
        autoUpdater.checkForUpdates();
      } catch (err) {
        console.error('Failed to set up autoUpdater:', err);
      }
    }
  }

  const iconName = process.platform === 'win32' ? 'image.ico' : 'image.png';
  const iconPath = path.join(__dirname, '..', iconName);
  let icon = nativeImage.createFromPath(iconPath);

  if (icon.isEmpty()) {
    console.log(`Icon file not found at ${iconPath}, using fallback icon`);
    const fallbackIcon =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAACpJREFUOE9jZKAQMFKon2HUAIbRMAAmMpylp6f/TxFmYmKCm0ZSDIxmAAByEwUeW2u71AAAAABJRU5ErkJggg==';
    icon = nativeImage.createFromDataURL(fallbackIcon);
  }

  tray = new Tray(icon);

  const buildAppMenu = (): Menu =>
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
          {
            label: app.name,
            submenu: [
              {role: 'about' as const},
              {
                label: 'Check for Updates...',
                click: () => {
                  if (!app.isPackaged) {
                    void dialog.showMessageBox({
                      type: 'info',
                      title: 'Update Check',
                      message: 'Cannot check for updates in development mode.',
                      detail: 'Please package the application first.',
                    });
                    return;
                  }
                  autoUpdater.checkForUpdates();
                  void dialog.showMessageBox({
                    type: 'info',
                    title: 'Update Check',
                    message: 'Checking for updates...',
                    detail: 'If an update is available, you will be notified.',
                  });
                },
              },
              {type: 'separator' as const},
              {
                label: 'Noise Cancellation',
                type: 'checkbox' as const,
                checked: noiseCancellationEnabled,
                click(item: MenuItem) {
                  noiseCancellationEnabled = item.checked;
                  mainWindow?.webContents.send(
                    'nc-toggle',
                    noiseCancellationEnabled
                  );
                  saveSettings();
                  Menu.setApplicationMenu(buildAppMenu());
                  tray?.setContextMenu(buildContextMenu());
                },
              },
              {type: 'separator' as const},
              {role: 'services' as const},
              {type: 'separator' as const},
              {role: 'hide' as const},
              {role: 'hideOthers' as const},
              {role: 'unhide' as const},
              {type: 'separator' as const},
              {role: 'quit' as const},
            ],
          },
        ]
        : []) as MenuItemConstructorOptions[],
    ]);

  const buildContextMenu = (): Menu =>
    Menu.buildFromTemplate([
      {
        label: 'Noise Cancellation',
        type: 'checkbox',
        checked: noiseCancellationEnabled,
        click(item) {
          noiseCancellationEnabled = item.checked;
          mainWindow?.webContents.send('nc-toggle', noiseCancellationEnabled);
          saveSettings();
          tray?.setContextMenu(buildContextMenu());
          if (process.platform === 'darwin') {
            Menu.setApplicationMenu(buildAppMenu());
          }
        },
      },
      {type: 'separator'},
      {label: 'Show App', click: () => mainWindow?.show()},
      {
        label: 'Check for Updates',
        click: () => {
          if (!app.isPackaged) {
            void dialog.showMessageBox({
              type: 'info',
              title: 'Update Check',
              message: 'Cannot check for updates in development mode.',
              detail: 'Please package the application first.',
            });
            return;
          }

          if (process.platform === 'linux') {
            void electronUpdater.checkForUpdatesAndNotify();
          } else {
            autoUpdater.checkForUpdates();
          }

          void dialog.showMessageBox({
            type: 'info',
            title: 'Update Check',
            message: 'Checking for updates...',
            detail: 'If an update is available, you will be notified.',
          });
        },
      },
      {
        label: 'Exit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

  tray.setToolTip('Danny DeClient');
  tray.setContextMenu(buildContextMenu());
  Menu.setApplicationMenu(buildAppMenu());

  tray.on('click', () => {
    mainWindow?.show();
  });

  // Register global shortcut for mute toggle
  try {
    const ret = globalShortcut.register('F4', () => {
      console.log('Global F4 pressed');
      toggleMute();
    });

    if (!ret) {
      console.log('Global shortcut registration failed');
    } else {
      console.log('Global shortcut registered successfully');
    }
  } catch (error) {
    console.error('Error registering global shortcut:', error);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    } else {
      mainWindow?.show();
    }
  });

  // Handle second instance launch
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    // We do not quit here because we have a tray icon
  }
});

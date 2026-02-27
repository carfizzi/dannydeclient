const {app, BrowserWindow, desktopCapturer, Menu, globalShortcut, Tray, nativeImage, autoUpdater, dialog, systemPreferences, shell} = require('electron')
const { autoUpdater: electronUpdater } = require('electron-updater')
const log = require('electron-log')
const path = require('path')

// Configure logging
log.transports.file.level = 'info'
electronUpdater.logger = log

// Implement single instance lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    app.quit()
    return
}

let mainWindow = null
let tray = null
let isQuitting = false

const toggleMute = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`
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
        `).catch(err => console.error("Failed to toggle mute:", err));
    }
}

const createWindow = () => {
    const win = new BrowserWindow({
        width: 1024,
        height: 800,
        title: `Danny DeClient v${app.getVersion()}`
    })

    win.on('page-title-updated', (e) => {
        e.preventDefault()
    })

    win.removeMenu()

    // Handle screen share requests
    win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({types: ['screen', 'window']}).then((sources) => {
            console.log('Got sources for screen sharing:', sources.map(s => s.name))
            const menu = Menu.buildFromTemplate(
                sources.map((source) => ({
                    label: source.name,
                    click: () => {
                        console.log('Selected source:', source.id, source.name)
                        // The callback expects video to be a DesktopCapturerSource
                        // Removing audio: 'loopback' as it might be causing the track to end immediately on macOS if not supported
                        callback({video: source})
                    },
                }))
            )
            menu.popup()
        }).catch((err) => {
            console.error('Error getting sources:', err)
        })
    })

    // Handle permission requests
    win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
        console.log('Permission requested:', permission, details)
        const allowedPermissions = ['media', 'display-capture', 'mediaKeySystem', 'clipboard-read', 'clipboard-write']
        if (allowedPermissions.includes(permission)) {
            callback(true)
        } else {
            console.log('Permission denied by handler:', permission)
            callback(false)
        }
    })

    // Handle permission checks (synchronous)
    win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        const allowedPermissions = ['media', 'display-capture', 'mediaKeySystem', 'clipboard-read', 'clipboard-write']
        if (allowedPermissions.includes(permission)) {
            return true
        }
        console.log('Permission check denied:', permission)
        return false
    })


    win.setTitle(`Danny DeClient v${app.getVersion()}`)
    void win.loadURL('https://chat.dannydedisco.eu')

    // Enable DevTools via F12 or Ctrl+Shift+I
    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            win.webContents.toggleDevTools()
            event.preventDefault()
        }
        if (input.control && input.shift && input.key.toLowerCase() === 'i' && input.type === 'keyDown') {
            win.webContents.toggleDevTools()
            event.preventDefault()
        }

        // Add local - listener as a fallback (especially for Linux/Wayland)
        if (input.key === 'F4' && input.type === 'keyDown') {
            console.log('Local F4 pressed')
            toggleMute();
            event.preventDefault();
        }
    })

    win.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault()
            win.hide()
            return false
        }
    })

    // Check permissions on macOS
    if (process.platform === 'darwin') {
        const checkMediaAccess = async () => {
            try {
                const micStatus = systemPreferences.getMediaAccessStatus('microphone')
                console.log('Microphone access status:', micStatus)
                if (micStatus === 'not-determined' || micStatus === 'unknown') {
                    const access = await systemPreferences.askForMediaAccess('microphone')
                    console.log('Microphone access requested:', access ? 'granted' : 'denied')
                }
                
                const cameraStatus = systemPreferences.getMediaAccessStatus('camera')
                console.log('Camera access status:', cameraStatus)
                if (cameraStatus === 'not-determined' || cameraStatus === 'unknown') {
                    const access = await systemPreferences.askForMediaAccess('camera')
                    console.log('Camera access requested:', access ? 'granted' : 'denied')
                }
            } catch (err) {
                console.error('Failed to check media access:', err)
            }
        }
        
        checkMediaAccess()
        
        const screenStatus = systemPreferences.getMediaAccessStatus('screen')
        console.log('Screen recording access status:', screenStatus)
    }

    // Add debug menu
    const menuTemplate = [
        ...(process.platform === 'darwin' ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),
        {
            label: 'Debug',
            submenu: [
                {
                    label: 'Check Microphone Permission',
                    click: async () => {
                         const status = systemPreferences.getMediaAccessStatus('microphone')
                         console.log('Manual check - Mic status:', status)
                         // Try to trigger prompt if not already denied
                         let access = false
                         try {
                             access = await systemPreferences.askForMediaAccess('microphone')
                         } catch (e) {
                             console.error('Error asking for mic access:', e)
                         }
                         
                         console.log('Manual request - Mic access:', access)
                         
                         if (!access) {
                             const {response} = await dialog.showMessageBox({
                                 type: 'warning',
                                 title: 'Microphone Access Denied',
                                 message: 'Microphone access is denied or not granted.',
                                 detail: `Current status: ${status}\n\nPlease enable Microphone access in System Settings > Privacy & Security.`,
                                 buttons: ['Open Settings', 'Cancel'],
                                 defaultId: 0
                             })
                             
                             if (response === 0) {
                                 systemPreferences.openSystemPreferences('security', 'Microphone')
                             }
                         }
                    }
                },
                {
                    label: 'Open DevTools',
                    click: () => win.webContents.openDevTools()
                }
            ]
        }
    ]
    const menu = Menu.buildFromTemplate(menuTemplate)
    Menu.setApplicationMenu(menu)

    return win
}

app.whenReady().then(() => {
    mainWindow = createWindow();

    app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

    if (app.isPackaged) {
        // Configure autoUpdater
        if (process.platform === 'linux') {
             electronUpdater.checkForUpdatesAndNotify()
        } else {
            const server = 'https://dannydeclient-updates.vercel.app'
            const feedURL = `${server}/update/${process.platform}/${app.getVersion()}`
            
            // Note: Squirrel (Windows) and Darwin handle updates differently. 
            // Hazel server handles the differences automatically.
            // Windows receives the RELEASES file.
            // macOS receives the update JSON.
            
            try {
                autoUpdater.setFeedURL({ url: feedURL })
                
                autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) => {
                    const dialogOpts = {
                        type: 'info',
                        buttons: ['Restart', 'Later'],
                        title: 'Application Update',
                        message: process.platform === 'win32' ? releaseNotes : releaseName,
                        detail: 'A new version has been downloaded. Restart the application to apply the updates.'
                    }
                
                    dialog.showMessageBox(dialogOpts).then((returnValue) => {
                        if (returnValue.response === 0) autoUpdater.quitAndInstall()
                    })
                })
                
                autoUpdater.on('error', (message) => {
                    console.error('There was a problem updating the application')
                    console.error(message)
                })
                
                // Check for updates immediately on startup
                autoUpdater.checkForUpdates()
            } catch (err) {
                console.error('Failed to set up autoUpdater:', err)
            }
        }
    }

    const iconName = process.platform === 'win32' ? 'image.ico' : 'image.png'
    const iconPath = path.join(__dirname, iconName)
    let icon = nativeImage.createFromPath(iconPath)

    if (icon.isEmpty()) {
        console.log(`Icon file not found at ${iconPath}, using fallback icon`)
        // Create a simple 16x16 transparent icon with a dot (base64)
        // This is a minimal valid PNG
        const fallbackIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAACpJREFUOE9jZKAQMFKon2HUAIbRMAAmMpylp6f/TxFmYmKCm0ZSDIxmAAByEwUeW2u71AAAAABJRU5ErkJggg=='
        icon = nativeImage.createFromDataURL(fallbackIcon)
    }

    tray = new Tray(icon)
    const contextMenu = Menu.buildFromTemplate([
        {label: 'Show App', click: () => mainWindow.show()},
        {
            label: 'Check for Updates', click: () => {
                if (!app.isPackaged) {
                    dialog.showMessageBox({
                        type: 'info',
                        title: 'Update Check',
                        message: 'Cannot check for updates in development mode.',
                        detail: 'Please package the application first.'
                    })
                    return
                }
                
                if (process.platform === 'linux') {
                    electronUpdater.checkForUpdatesAndNotify()
                } else {
                    autoUpdater.checkForUpdates()
                }
                
                dialog.showMessageBox({
                    type: 'info',
                    title: 'Update Check',
                    message: 'Checking for updates...',
                    detail: 'If an update is available, you will be notified.'
                })
            }
        },
        {
            label: 'Exit', click: () => {
                isQuitting = true
                app.quit()
            }
        }
    ])
    tray.setToolTip('Danny DeClient')
    tray.setContextMenu(contextMenu)

    tray.on('click', () => {
        mainWindow.show()
    })

    // Register global shortcut for mute toggle (-)
    // Note: On Linux, this might require specific permissions or fail if another app has grabbed the key.
    try {
        const ret = globalShortcut.register('F4', () => {
            console.log('Global F4 pressed');
            toggleMute();
        })

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
            mainWindow = createWindow()
        } else {
            mainWindow.show()
        }
    })

    // Handle second instance launch
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.show()
            mainWindow.focus()
        }
    })
})

app.on('before-quit', () => {
    isQuitting = true;
})

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
})

app.on('window-all-closed', () => {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        // We do not quit here because we have a tray icon
        // app.quit() 
    }
})


const {app, BrowserWindow, desktopCapturer, Menu, globalShortcut, Tray, nativeImage} = require('electron')
const path = require('path')

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
        height: 800
    })

    win.removeMenu()

    // Handle screen share requests
    win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
            const menu = Menu.buildFromTemplate(
                sources.map((source) => ({
                    label: source.name,
                    click: () => {
                        // Pass video source only. If audio is not provided, it defaults to no audio.
                        callback({ video: source }) 
                    },
                }))
            )
            menu.popup()
        })
    })

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

        // Add local F4 listener as a fallback (especially for Linux/Wayland)
        if (input.key === 'F4' && input.type === 'keyDown') {
             console.log('Local F4 pressed')
             toggleMute()
             event.preventDefault()
        }
    })

    win.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault()
            win.hide()
            return false
        }
    })

    return win
}

app.whenReady().then(() => {
    mainWindow = createWindow()

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
        { label: 'Show App', click: () => mainWindow.show() },
        { label: 'Exit', click: () => {
            isQuitting = true
            app.quit()
        }}
    ])
    tray.setToolTip('Danny DeClient')
    tray.setContextMenu(contextMenu)
    
    tray.on('click', () => {
        mainWindow.show()
    })

    // Register global shortcut for mute toggle (F4)
    // Note: On Linux, this might require specific permissions or fail if another app has grabbed the key.
    try {
        const ret = globalShortcut.register('F4', () => {
            console.log('Global F4 pressed')
            toggleMute()
        })

        if (!ret) {
            console.log('Global shortcut registration failed')
        } else {
            console.log('Global shortcut registered successfully')
        }
    } catch (error) {
        console.error('Error registering global shortcut:', error)
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createWindow()
        } else {
            mainWindow.show()
        }
    })
})

app.on('before-quit', () => {
    isQuitting = true
})

app.on('will-quit', () => {
    globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        // We do not quit here because we have a tray icon
        // app.quit() 
    }
})


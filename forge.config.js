const {FusesPlugin} = require('@electron-forge/plugin-fuses');
const {FuseV1Options, FuseVersion} = require('@electron/fuses');

module.exports = {
    packagerConfig: {
        asar: true,
        icon: './image',
        ignore: [
             /locales/,
             /.*\.pak/
        ],
        extendInfo: {
            NSMicrophoneUsageDescription: "This app needs access to the microphone for audio calls.",
            NSCameraUsageDescription: "This app needs access to the camera for video calls.",
        }
    },
    rebuildConfig: {},
    makers: [
        // Only build installer on Windows or if Wine is installed (skipped for macOS without Wine)
        ...(process.platform === 'win32' ? [{
            name: '@electron-forge/maker-squirrel',
            config: {
                setupIcon: './image.ico'
            },
        }] : []),
        {
            name: '@electron-forge/maker-zip',
            platforms: ['darwin', 'win32', 'linux'],
        },
        ...(process.platform === 'linux' ? [
            {
                name: '@electron-forge/maker-deb',
                config: {
                    options: {
                        icon: './image.png'
                    }
                },
            },
            {
                name: '@electron-forge/maker-rpm',
                config: {
                    options: {
                        icon: './image.png'
                    }
                },
            },
        ] : []),
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-auto-unpack-natives',
            config: {},
        },
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
};

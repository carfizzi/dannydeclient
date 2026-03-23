{
  "targets": [
    {
      "target_name": "wasapi_loopback",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/wasapi_loopback.cpp",
            "src/addon.cpp"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": [
            "NAPI_VERSION=8",
            "NAPI_DISABLE_CPP_EXCEPTIONS"
          ],
          "libraries": [
            "-lmmdevapi",
            "-lole32"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}

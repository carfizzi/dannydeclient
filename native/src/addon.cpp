#include <napi.h>

#ifdef _WIN32
#include "wasapi_loopback.h"

static WasapiLoopbackCapture* g_capture = nullptr;

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected 3 arguments: excludePid, sampleRate, channels")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    DWORD excludePid = info[0].As<Napi::Number>().Uint32Value();
    DWORD sampleRate = info[1].As<Napi::Number>().Uint32Value();
    DWORD channels = info[2].As<Napi::Number>().Uint32Value();

    if (g_capture) {
        g_capture->stop();
        delete g_capture;
    }

    g_capture = new WasapiLoopbackCapture();
    bool ok = g_capture->start(excludePid, sampleRate, channels);

    if (!ok) {
        delete g_capture;
        g_capture = nullptr;
        return Napi::Boolean::New(env, false);
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value ReadAudio(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_capture || !g_capture->isCapturing()) {
        return env.Null();
    }

    // Read up to ~20ms of audio at 48kHz stereo = 1920 samples * 2 channels = 3840 floats
    const size_t maxSamples = 3840;
    float buffer[maxSamples];

    size_t read = g_capture->readAudio(buffer, maxSamples);
    if (read == 0) {
        return env.Null();
    }

    Napi::Float32Array result = Napi::Float32Array::New(env, read);
    memcpy(result.Data(), buffer, read * sizeof(float));
    return result;
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (g_capture) {
        g_capture->stop();
        delete g_capture;
        g_capture = nullptr;
    }

    return env.Undefined();
}

Napi::Value IsCapturing(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, g_capture && g_capture->isCapturing());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("readAudio", Napi::Function::New(env, ReadAudio));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("isCapturing", Napi::Function::New(env, IsCapturing));
    return exports;
}

NODE_API_MODULE(wasapi_loopback, Init)

#else

// Non-Windows stub — module loads but does nothing
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return exports;
}

NODE_API_MODULE(wasapi_loopback, Init)

#endif // _WIN32

#pragma once

#ifdef _WIN32

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

// Forward declare the activation params structures (Windows 10 20348+)
#ifndef AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
#define AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK 1

typedef enum {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;

typedef struct {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    };
} AUDIOCLIENT_ACTIVATION_PARAMS;

#ifndef AUDIOCLIENT_ACTIVATION_TYPE
typedef enum {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK_TYPE = 1
} AUDIOCLIENT_ACTIVATION_TYPE;
#endif

#endif // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK

// Simple lock-free(ish) ring buffer for float32 PCM data
class RingBuffer {
public:
    explicit RingBuffer(size_t capacity);
    size_t write(const float* data, size_t frames, int channels);
    size_t read(float* data, size_t maxSamples);
    size_t available() const;

private:
    std::vector<float> buffer_;
    std::atomic<size_t> head_{0};
    std::atomic<size_t> tail_{0};
    size_t capacity_;
};

// Completion handler for ActivateAudioInterfaceAsync
class ActivateAudioInterfaceHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    ActivateAudioInterfaceHandler();

    // IUnknown
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override;

    // IActivateAudioInterfaceCompletionHandler
    HRESULT STDMETHODCALLTYPE ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* activateOperation) override;

    HRESULT Wait(DWORD timeoutMs);
    HRESULT GetResult(IAudioClient** ppAudioClient);

private:
    std::atomic<ULONG> refCount_{1};
    HANDLE completionEvent_;
    HRESULT activateResult_{E_FAIL};
    IUnknown* activatedInterface_{nullptr};
};

class WasapiLoopbackCapture {
public:
    WasapiLoopbackCapture();
    ~WasapiLoopbackCapture();

    bool start(DWORD excludePid, DWORD sampleRate, DWORD channels);
    void stop();
    size_t readAudio(float* buffer, size_t maxSamples);
    bool isCapturing() const { return capturing_.load(); }

private:
    void captureThread();

    IAudioClient* audioClient_{nullptr};
    IAudioCaptureClient* captureClient_{nullptr};
    WAVEFORMATEX* mixFormat_{nullptr};

    std::unique_ptr<RingBuffer> ringBuffer_;
    std::thread thread_;
    std::atomic<bool> capturing_{false};
    std::atomic<bool> shouldStop_{false};

    DWORD requestedSampleRate_{48000};
    DWORD requestedChannels_{2};
};

#endif // _WIN32

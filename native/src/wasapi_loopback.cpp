#ifdef _WIN32

#include "wasapi_loopback.h"
#include <functiondiscoverykeys_devpkey.h>
#include <combaseapi.h>
#include <algorithm>
#include <cstring>

// Virtual audio device ID for process loopback
static const WCHAR VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK[] =
    L"VAD\\Process_Loopback";

// --- RingBuffer ---

RingBuffer::RingBuffer(size_t capacity)
    : buffer_(capacity, 0.0f), capacity_(capacity) {}

size_t RingBuffer::write(const float* data, size_t frames, int channels) {
    size_t samples = frames * channels;
    size_t h = head_.load(std::memory_order_relaxed);
    size_t t = tail_.load(std::memory_order_acquire);

    size_t free = (t + capacity_ - h - 1) % capacity_;
    size_t toWrite = std::min(samples, free);

    for (size_t i = 0; i < toWrite; i++) {
        buffer_[(h + i) % capacity_] = data[i];
    }

    head_.store((h + toWrite) % capacity_, std::memory_order_release);
    return toWrite;
}

size_t RingBuffer::read(float* data, size_t maxSamples) {
    size_t h = head_.load(std::memory_order_acquire);
    size_t t = tail_.load(std::memory_order_relaxed);

    size_t avail = (h + capacity_ - t) % capacity_;
    size_t toRead = std::min(maxSamples, avail);

    for (size_t i = 0; i < toRead; i++) {
        data[i] = buffer_[(t + i) % capacity_];
    }

    tail_.store((t + toRead) % capacity_, std::memory_order_release);
    return toRead;
}

size_t RingBuffer::available() const {
    size_t h = head_.load(std::memory_order_acquire);
    size_t t = tail_.load(std::memory_order_acquire);
    return (h + capacity_ - t) % capacity_;
}

// --- ActivateAudioInterfaceHandler ---

ActivateAudioInterfaceHandler::ActivateAudioInterfaceHandler() {
    completionEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
}

ULONG STDMETHODCALLTYPE ActivateAudioInterfaceHandler::AddRef() {
    return ++refCount_;
}

ULONG STDMETHODCALLTYPE ActivateAudioInterfaceHandler::Release() {
    ULONG count = --refCount_;
    if (count == 0) {
        delete this;
    }
    return count;
}

HRESULT STDMETHODCALLTYPE ActivateAudioInterfaceHandler::QueryInterface(
    REFIID riid, void** ppvObject) {
    if (riid == __uuidof(IUnknown) ||
        riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
        *ppvObject = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        AddRef();
        return S_OK;
    }
    *ppvObject = nullptr;
    return E_NOINTERFACE;
}

HRESULT STDMETHODCALLTYPE ActivateAudioInterfaceHandler::ActivateCompleted(
    IActivateAudioInterfaceAsyncOperation* activateOperation) {
    HRESULT hrActivate = E_FAIL;
    activateOperation->GetActivateResult(&hrActivate, &activatedInterface_);
    activateResult_ = hrActivate;
    SetEvent(completionEvent_);
    return S_OK;
}

HRESULT ActivateAudioInterfaceHandler::Wait(DWORD timeoutMs) {
    DWORD result = WaitForSingleObject(completionEvent_, timeoutMs);
    if (result != WAIT_OBJECT_0) return E_TIMEOUT;
    return activateResult_;
}

HRESULT ActivateAudioInterfaceHandler::GetResult(IAudioClient** ppAudioClient) {
    if (!activatedInterface_) return E_FAIL;
    return activatedInterface_->QueryInterface(
        __uuidof(IAudioClient), reinterpret_cast<void**>(ppAudioClient));
}

// --- WasapiLoopbackCapture ---

WasapiLoopbackCapture::WasapiLoopbackCapture() {}

WasapiLoopbackCapture::~WasapiLoopbackCapture() {
    stop();
}

bool WasapiLoopbackCapture::start(DWORD excludePid, DWORD sampleRate, DWORD channels) {
    if (capturing_.load()) return false;

    requestedSampleRate_ = sampleRate;
    requestedChannels_ = channels;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) return false;

    // Set up activation params for process loopback with exclusion
    AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
    activationParams.ActivationType =
        static_cast<AUDIOCLIENT_ACTIVATION_TYPE>(AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK);
    activationParams.ProcessLoopbackParams.TargetProcessId = excludePid;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activateParamsProp = {};
    activateParamsProp.vt = VT_BLOB;
    activateParamsProp.blob.cbSize = sizeof(activationParams);
    activateParamsProp.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

    auto handler = new ActivateAudioInterfaceHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateParamsProp,
        handler,
        &asyncOp);

    if (FAILED(hr)) {
        handler->Release();
        return false;
    }

    hr = handler->Wait(5000);
    if (FAILED(hr)) {
        handler->Release();
        if (asyncOp) asyncOp->Release();
        return false;
    }

    hr = handler->GetResult(&audioClient_);
    handler->Release();
    if (asyncOp) asyncOp->Release();

    if (FAILED(hr) || !audioClient_) return false;

    // Get the mix format and initialize
    hr = audioClient_->GetMixFormat(&mixFormat_);
    if (FAILED(hr)) return false;

    // Initialize with loopback + auto-convert to our desired format
    hr = audioClient_->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        0,   // buffer duration (0 = default)
        0,   // periodicity
        mixFormat_,
        nullptr);

    if (FAILED(hr)) return false;

    hr = audioClient_->GetService(
        __uuidof(IAudioCaptureClient),
        reinterpret_cast<void**>(&captureClient_));

    if (FAILED(hr)) return false;

    // Ring buffer: ~500ms at 48kHz stereo (generous)
    size_t ringSize = sampleRate * channels; // 1 second
    ringBuffer_ = std::make_unique<RingBuffer>(ringSize);

    shouldStop_.store(false);
    capturing_.store(true);

    hr = audioClient_->Start();
    if (FAILED(hr)) {
        capturing_.store(false);
        return false;
    }

    thread_ = std::thread(&WasapiLoopbackCapture::captureThread, this);
    return true;
}

void WasapiLoopbackCapture::stop() {
    if (!capturing_.load()) return;

    shouldStop_.store(true);
    if (thread_.joinable()) thread_.join();

    if (audioClient_) {
        audioClient_->Stop();
        audioClient_->Release();
        audioClient_ = nullptr;
    }
    if (captureClient_) {
        captureClient_->Release();
        captureClient_ = nullptr;
    }
    if (mixFormat_) {
        CoTaskMemFree(mixFormat_);
        mixFormat_ = nullptr;
    }

    capturing_.store(false);
}

void WasapiLoopbackCapture::captureThread() {
    while (!shouldStop_.load()) {
        UINT32 packetLength = 0;
        HRESULT hr = captureClient_->GetNextPacketSize(&packetLength);
        if (FAILED(hr)) break;

        while (packetLength > 0) {
            BYTE* data = nullptr;
            UINT32 numFrames = 0;
            DWORD flags = 0;

            hr = captureClient_->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;

            if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data && numFrames > 0) {
                // Data is in mix format — AUTOCONVERTPCM should give us float32
                ringBuffer_->write(
                    reinterpret_cast<const float*>(data),
                    numFrames,
                    mixFormat_->nChannels);
            }

            captureClient_->ReleaseBuffer(numFrames);

            hr = captureClient_->GetNextPacketSize(&packetLength);
            if (FAILED(hr)) break;
        }

        Sleep(10); // ~10ms capture interval
    }
}

size_t WasapiLoopbackCapture::readAudio(float* buffer, size_t maxSamples) {
    if (!ringBuffer_) return 0;
    return ringBuffer_->read(buffer, maxSamples);
}

#endif // _WIN32

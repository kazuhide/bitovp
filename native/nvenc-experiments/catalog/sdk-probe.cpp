#include <cstddef>
#include <ffnvcodec/dynlink_cuda.h>
#include <ffnvcodec/nvEncodeAPI.h>

#include <dlfcn.h>

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

using Library = std::unique_ptr<void, int (*)(void*)>;

Library open_library(const char* name) {
    void* handle = dlopen(name, RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        throw std::runtime_error(std::string("cannot load ") + name);
    }
    return Library(handle, dlclose);
}

template <class Function>
Function symbol(const Library& library, const char* name) {
    void* address = dlsym(library.get(), name);
    if (!address) {
        throw std::runtime_error(std::string("driver symbol unavailable: ") + name);
    }
    return reinterpret_cast<Function>(address);
}

void check(int status, const char* operation) {
    if (status != 0) {
        throw std::runtime_error(std::string(operation) + " failed with status " +
                                 std::to_string(status));
    }
}

template <class Item, class Count, class Query>
std::vector<Item> query_list(const char* operation, Count count, Query query) {
    std::uint32_t size = 0;
    check(count(&size), operation);
    if (size == 0) {
        return {};
    }
    std::vector<Item> items(size);
    std::uint32_t written = 0;
    check(query(items.data(), size, &written), operation);
    if (written > size) {
        throw std::runtime_error(std::string(operation) + " returned an invalid count");
    }
    items.resize(written);
    return items;
}

template <class Item, class Write>
void write_list(std::ostream& out, const std::vector<Item>& items, Write write) {
    out << '[';
    bool first = true;
    for (const Item& item : items) {
        if (!first) {
            out << ',';
        }
        first = false;
        write(item);
    }
    out << ']';
}

std::string cuda_uuid(const CUuuid& uuid) {
    std::ostringstream out;
    out << "GPU-" << std::hex << std::setfill('0');
    for (int index = 0; index < 16; ++index) {
        if (index == 4 || index == 6 || index == 8 || index == 10) {
            out << '-';
        }
        out << std::setw(2) << static_cast<unsigned>(static_cast<unsigned char>(uuid.bytes[index]));
    }
    return out.str();
}

std::string guid_text(const GUID& guid) {
    std::ostringstream out;
    out << std::hex << std::setfill('0')
        << std::setw(8) << guid.Data1 << '-'
        << std::setw(4) << guid.Data2 << '-'
        << std::setw(4) << guid.Data3 << '-';
    for (int index = 0; index < 8; ++index) {
        if (index == 2) {
            out << '-';
        }
        out << std::setw(2) << static_cast<unsigned>(guid.Data4[index]);
    }
    return out.str();
}

bool same_guid(const GUID& left, const GUID& right) {
    return left.Data1 == right.Data1 && left.Data2 == right.Data2 && left.Data3 == right.Data3 &&
           std::memcmp(left.Data4, right.Data4, sizeof(left.Data4)) == 0;
}

const char* codec_name(const GUID& guid) {
    if (same_guid(guid, NV_ENC_CODEC_H264_GUID)) {
        return "H264";
    }
    if (same_guid(guid, NV_ENC_CODEC_HEVC_GUID)) {
        return "HEVC";
    }
    if (same_guid(guid, NV_ENC_CODEC_AV1_GUID)) {
        return "AV1";
    }
    return nullptr;
}

struct Capability {
    const char* key;
    NV_ENC_CAPS value;
};

constexpr Capability capabilities[] = {
    {"NV_ENC_CAPS_NUM_MAX_BFRAMES", NV_ENC_CAPS_NUM_MAX_BFRAMES},
    {"NV_ENC_CAPS_SUPPORTED_RATECONTROL_MODES", NV_ENC_CAPS_SUPPORTED_RATECONTROL_MODES},
    {"NV_ENC_CAPS_WIDTH_MIN", NV_ENC_CAPS_WIDTH_MIN},
    {"NV_ENC_CAPS_WIDTH_MAX", NV_ENC_CAPS_WIDTH_MAX},
    {"NV_ENC_CAPS_HEIGHT_MIN", NV_ENC_CAPS_HEIGHT_MIN},
    {"NV_ENC_CAPS_HEIGHT_MAX", NV_ENC_CAPS_HEIGHT_MAX},
    {"NV_ENC_CAPS_SUPPORT_YUV444_ENCODE", NV_ENC_CAPS_SUPPORT_YUV444_ENCODE},
    {"NV_ENC_CAPS_SUPPORT_10BIT_ENCODE", NV_ENC_CAPS_SUPPORT_10BIT_ENCODE},
    {"NV_ENC_CAPS_SUPPORT_LOOKAHEAD", NV_ENC_CAPS_SUPPORT_LOOKAHEAD},
    {"NV_ENC_CAPS_SUPPORT_TEMPORAL_AQ", NV_ENC_CAPS_SUPPORT_TEMPORAL_AQ},
    {"NV_ENC_CAPS_SUPPORT_WEIGHTED_PREDICTION", NV_ENC_CAPS_SUPPORT_WEIGHTED_PREDICTION},
    {"NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE", NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE},
};

void write_caps(std::ostream& out, const NV_ENCODE_API_FUNCTION_LIST& api, void* encoder,
                const GUID& codec) {
    out << '{';
    bool first = true;
    for (const auto& capability : capabilities) {
        if (!first) {
            out << ',';
        }
        first = false;
        NV_ENC_CAPS_PARAM query{};
        query.version = NV_ENC_CAPS_PARAM_VER;
        query.capsToQuery = capability.value;
        int value = 0;
        out << '"' << capability.key << "\":";
        if (api.nvEncGetEncodeCaps(encoder, codec, &query, &value) == NV_ENC_SUCCESS) {
            out << value;
        } else {
            out << "null";
        }
    }
    out << '}';
}

void write_encoder(std::ostream& out, const NV_ENCODE_API_FUNCTION_LIST& api, void* encoder,
                   const GUID& codec) {
    const auto formats = query_list<NV_ENC_BUFFER_FORMAT>(
        "NVENC input formats",
        [&](std::uint32_t* count) { return api.nvEncGetInputFormatCount(encoder, codec, count); },
        [&](NV_ENC_BUFFER_FORMAT* items, std::uint32_t size, std::uint32_t* written) {
            return api.nvEncGetInputFormats(encoder, codec, items, size, written);
        });
    const auto presets = query_list<GUID>(
        "NVENC preset GUIDs",
        [&](std::uint32_t* count) { return api.nvEncGetEncodePresetCount(encoder, codec, count); },
        [&](GUID* items, std::uint32_t size, std::uint32_t* written) {
            return api.nvEncGetEncodePresetGUIDs(encoder, codec, items, size, written);
        });
    // Preserve raw format codes from newer drivers, including codes this header does not name.
    static_assert(sizeof(NV_ENC_BUFFER_FORMAT) == sizeof(std::uint32_t));
    std::vector<std::uint32_t> format_codes;
    for (const auto& format : formats) {
        std::uint32_t code;
        std::memcpy(&code, &format, sizeof(code));
        format_codes.push_back(code);
    }
    std::sort(format_codes.begin(), format_codes.end());
    std::vector<std::string> preset_guids;
    for (const GUID& preset : presets) {
        preset_guids.push_back(guid_text(preset));
    }
    std::sort(preset_guids.begin(), preset_guids.end());

    out << "{\"codec\":";
    if (const char* name = codec_name(codec)) {
        out << '"' << name << '"';
    } else {
        out << "null";
    }
    out << ",\"encodeGuid\":\"" << guid_text(codec) << "\",\"inputFormats\":";
    write_list(out, format_codes, [&](std::uint32_t code) { out << code; });
    out << ",\"presetGuids\":";
    write_list(out, preset_guids, [&](const std::string& guid) { out << '"' << guid << '"'; });
    out << ",\"caps\":";
    write_caps(out, api, encoder, codec);
    out << '}';
}

std::string probe(int index) {
    const auto cuda = open_library("libcuda.so.1");
    const auto nvenc = open_library("libnvidia-encode.so.1");
    const auto get_max_version =
        symbol<decltype(&NvEncodeAPIGetMaxSupportedVersion)>(nvenc, "NvEncodeAPIGetMaxSupportedVersion");
    std::uint32_t max_api_version = 0;
    check(get_max_version(&max_api_version), "NvEncodeAPIGetMaxSupportedVersion");
    constexpr std::uint32_t sdk_version = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
    if (max_api_version < sdk_version) {
        throw std::runtime_error("the driver supports NVENC API " + std::to_string(max_api_version >> 4) +
                                 "." + std::to_string(max_api_version & 15) +
                                 ", below the SDK used to build this probe");
    }

    check(symbol<tcuInit*>(cuda, "cuInit")(0), "cuInit");
    CUdevice device{};
    check(symbol<tcuDeviceGet*>(cuda, "cuDeviceGet")(&device, index), "cuDeviceGet");
    CUuuid uuid{};
    check(symbol<tcuDeviceGetUuid_v2*>(cuda, "cuDeviceGetUuid_v2")(&uuid, device), "cuDeviceGetUuid_v2");

    const auto destroy_context = symbol<tcuCtxDestroy_v2*>(cuda, "cuCtxDestroy_v2");
    CUcontext context = nullptr;
    check(symbol<tcuCtxCreate_v2*>(cuda, "cuCtxCreate_v2")(&context, 0, device), "cuCtxCreate_v2");
    if (!context) {
        throw std::runtime_error("CUDA did not return a context");
    }
    std::unique_ptr<CUctx_st, tcuCtxDestroy_v2*> owned_context(context, destroy_context);

    NV_ENCODE_API_FUNCTION_LIST api{};
    api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    const auto create_instance =
        symbol<decltype(&NvEncodeAPICreateInstance)>(nvenc, "NvEncodeAPICreateInstance");
    check(create_instance(&api), "NvEncodeAPICreateInstance");
    if (!api.nvEncOpenEncodeSessionEx || !api.nvEncDestroyEncoder ||
        !api.nvEncGetEncodeGUIDCount || !api.nvEncGetEncodeGUIDs ||
        !api.nvEncGetInputFormatCount || !api.nvEncGetInputFormats ||
        !api.nvEncGetEncodePresetCount || !api.nvEncGetEncodePresetGUIDs ||
        !api.nvEncGetEncodeCaps) {
        throw std::runtime_error("NVENC function table is incomplete");
    }

    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS params{};
    params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    params.apiVersion = NVENCAPI_VERSION;
    params.deviceType = NV_ENC_DEVICE_TYPE_CUDA;
    params.device = owned_context.get();
    void* encoder = nullptr;
    check(api.nvEncOpenEncodeSessionEx(&params, &encoder), "NvEncOpenEncodeSessionEx");
    if (!encoder) {
        throw std::runtime_error("NVENC did not return an encoder session");
    }
    std::unique_ptr<void, PNVENCDESTROYENCODER> owned_encoder(encoder, api.nvEncDestroyEncoder);

    auto encoders = query_list<GUID>(
        "NVENC encode GUIDs",
        [&](std::uint32_t* count) { return api.nvEncGetEncodeGUIDCount(encoder, count); },
        [&](GUID* items, std::uint32_t size, std::uint32_t* written) {
            return api.nvEncGetEncodeGUIDs(encoder, items, size, written);
        });
    std::sort(encoders.begin(), encoders.end(),
              [](const GUID& left, const GUID& right) { return guid_text(left) < guid_text(right); });

    std::ostringstream out;
    out << "{\"schemaVersion\":1,\"deviceIndex\":" << index
        << ",\"gpuUuid\":\"" << cuda_uuid(uuid) << "\",\"maxNvencApiVersion\":" << max_api_version
        << ",\"sdkApiVersion\":{\"major\":" << NVENCAPI_MAJOR_VERSION
        << ",\"minor\":" << NVENCAPI_MINOR_VERSION << "},\"encoders\":";
    write_list(out, encoders, [&](const GUID& codec) { write_encoder(out, api, encoder, codec); });
    out << '}';

    check(api.nvEncDestroyEncoder(owned_encoder.release()), "NvEncDestroyEncoder");
    check(destroy_context(owned_context.release()), "cuCtxDestroy_v2");
    return out.str();
}

}  // namespace

int main(int argc, char* argv[]) {
    int index = -1;
    if (argc == 2) {
        const std::string_view arg = argv[1];
        const auto parsed = std::from_chars(arg.data(), arg.data() + arg.size(), index);
        if (parsed.ec != std::errc{} || parsed.ptr != arg.data() + arg.size()) {
            index = -1;
        }
    }
    if (index < 0) {
        std::cerr << "Usage: sdk-probe <deviceIndex>\n";
        return 2;
    }
    try {
        std::cout << probe(index) << '\n';
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    return 0;
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include <vulkan/vulkan.h>
#include "vulkan_psnr_spv.hpp"
#include "vulkan_cambi_spv.hpp"
#include "vulkan_speed_spv.hpp"
#include "vulkan_speed_factor_spv.hpp"
#include "vulkan_adm_spv.hpp"
#include "vulkan_adm_row_spv.hpp"
#include "vulkan_motion_spv.hpp"
#include "cambi_parameters.hpp"
#include "speed_parameters.hpp"
#include "adm_parameters.hpp"
#include "motion_parameters.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <limits>
#include <mutex>
#include <sstream>
#include <stdexcept>

namespace bitovp::gpu {
namespace {
using Clock = std::chrono::steady_clock;
double milliseconds(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
void check(VkResult result, const char *operation) {
    if (result != VK_SUCCESS)
        throw std::runtime_error(std::string(operation) + " failed with VkResult " + std::to_string(result));
}
struct Buffer {
    VkBuffer buffer = VK_NULL_HANDLE;
    VkDeviceMemory memory = VK_NULL_HANDLE;
    void *mapped = nullptr;
    VkDeviceSize allocation_size = 0;
    VkDeviceSize capacity = 0;
    bool coherent = false;
};
struct ResetFlag {
    bool &flag;
    ~ResetFlag() { flag = false; }
};
struct Context {
    VkInstance instance = VK_NULL_HANDLE;
    VkPhysicalDevice physical = VK_NULL_HANDLE;
    VkDevice device = VK_NULL_HANDLE;
    VkQueue queue = VK_NULL_HANDLE;
    VkCommandPool command_pool = VK_NULL_HANDLE;
    VkCommandBuffer command = VK_NULL_HANDLE;
    VkFence fence = VK_NULL_HANDLE;
    VkDescriptorSetLayout descriptor_layout = VK_NULL_HANDLE;
    VkDescriptorPool descriptor_pool = VK_NULL_HANDLE;
    VkDescriptorSet descriptor = VK_NULL_HANDLE;
    VkPipelineLayout pipeline_layout = VK_NULL_HANDLE;
    VkPipeline pipeline = VK_NULL_HANDLE;
    VkPipeline cambi_pipeline = VK_NULL_HANDLE;
    VkPipeline speed_pipeline = VK_NULL_HANDLE;
    VkPipeline speed_factor_pipeline = VK_NULL_HANDLE;
    VkPipeline adm_pipeline = VK_NULL_HANDLE;
    VkPipeline adm_row_pipeline = VK_NULL_HANDLE;
    VkPipeline motion_pipeline = VK_NULL_HANDLE;
    VkQueryPool queries = VK_NULL_HANDLE;
    VkPhysicalDeviceProperties properties{};
    VkPhysicalDeviceMemoryProperties memory_properties{};
    std::array<Buffer, 3> buffers{};
    std::array<Buffer, 3> motion_history{};
    std::array<Buffer, 6> frame_planes{};
    std::uint32_t queue_family = 0;
    unsigned timestamp_bits = 0;
    bool float64 = false;
    bool int64 = false;
    bool profile_passes = false;
    DeviceInfo info;

    void release(Buffer &buffer) {
        if (buffer.mapped) vkUnmapMemory(device, buffer.memory);
        if (buffer.buffer) vkDestroyBuffer(device, buffer.buffer, nullptr);
        if (buffer.memory) vkFreeMemory(device, buffer.memory, nullptr);
        buffer = {};
    }
    ~Context() {
        if (device) {
            vkDeviceWaitIdle(device);
            for (auto &buffer : buffers) release(buffer);
            for (auto &buffer : motion_history) release(buffer);
            for (auto &buffer : frame_planes) release(buffer);
            if (queries) vkDestroyQueryPool(device, queries, nullptr);
            if (pipeline) vkDestroyPipeline(device, pipeline, nullptr);
            if (cambi_pipeline) vkDestroyPipeline(device, cambi_pipeline, nullptr);
            if (speed_pipeline) vkDestroyPipeline(device, speed_pipeline, nullptr);
            if (speed_factor_pipeline) vkDestroyPipeline(device, speed_factor_pipeline, nullptr);
            if (adm_pipeline) vkDestroyPipeline(device, adm_pipeline, nullptr);
            if (adm_row_pipeline) vkDestroyPipeline(device, adm_row_pipeline, nullptr);
            if (motion_pipeline) vkDestroyPipeline(device, motion_pipeline, nullptr);
            if (pipeline_layout) vkDestroyPipelineLayout(device, pipeline_layout, nullptr);
            if (descriptor_pool) vkDestroyDescriptorPool(device, descriptor_pool, nullptr);
            if (descriptor_layout) vkDestroyDescriptorSetLayout(device, descriptor_layout, nullptr);
            if (fence) vkDestroyFence(device, fence, nullptr);
            if (command_pool) vkDestroyCommandPool(device, command_pool, nullptr);
            vkDestroyDevice(device, nullptr);
        }
        if (instance) vkDestroyInstance(instance, nullptr);
    }
};

class VulkanBackend final : public FeatureBackend {
public:
    explicit VulkanBackend(const BackendOptions &options) : options_(options) {
        const char *profile = std::getenv("BITOVP_VULKAN_PROFILE_PASSES");
        context_.profile_passes = profile && std::strcmp(profile, "1") == 0;
        const std::uint16_t endian = 1;
        if (*reinterpret_cast<const std::uint8_t *>(&endian) != 1)
            throw std::runtime_error("Vulkan packed samples require a little-endian host");
        VkApplicationInfo app{};
        app.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
        app.pApplicationName = "bitovp-owned-vmaf";
        app.apiVersion = VK_API_VERSION_1_1;
        VkInstanceCreateInfo instance{};
        instance.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
        instance.pApplicationInfo = &app;
        check(vkCreateInstance(&instance, nullptr, &context_.instance), "vkCreateInstance");
        select_device();
        create_pipeline();
    }

    DeviceInfo device() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        return context_.info;
    }
    BackendTimings timings() const override {
        std::lock_guard<std::mutex> lock(mutex_);
        auto result = timings_;
        result.allocated_bytes = 0;
        for (const auto &buffer : context_.buffers) result.allocated_bytes += buffer.allocation_size;
        for (const auto &buffer : context_.motion_history) result.allocated_bytes += buffer.allocation_size;
        for (const auto &buffer : context_.frame_planes) result.allocated_bytes += buffer.allocation_size;
        return result;
    }
    PsnrSums psnr(const Picture &reference, const Picture &distorted) override {
        std::lock_guard<std::mutex> lock(mutex_);
        validate_pair(reference, distorted);
        PsnrSums result;
        for (unsigned plane = 0; plane < 3; ++plane) {
            const auto &r = reference.planes[plane];
            const auto &d = distorted.planes[plane];
            result.sample_count[plane] = std::uint64_t(r.width) * r.height;
            result.squared_error[plane] = plane_sse(r, d, reference.bit_depth);
        }
        return result;
    }
    void configure(const FeaturePlan &plan) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!plan.width || !plan.height || (plan.bit_depth != 8 && plan.bit_depth != 10))
            throw std::invalid_argument("invalid Vulkan feature-plan geometry or bit depth");
        std::vector<vulkan_detail::CambiParameters> cambi;
        std::vector<vulkan_detail::SpeedParameters> speed;
        std::vector<vulkan_detail::AdmParameters> adm;
        std::vector<vulkan_detail::MotionParameters> motion;
        std::vector<ExtractorSpec> psnr;
        for (const auto &spec : plan.extractors) {
            if (spec.name != "cambi" && spec.name != "speed_chroma" && spec.name != "adm" && spec.name != "motion" && spec.name != "psnr")
                throw std::invalid_argument("unsupported Vulkan feature provider: " + spec.name);
            if (spec.name != "motion" && spec.name != "psnr" && !context_.float64)
                throw std::runtime_error("Vulkan ADM/CAMBI/SPEED requires shaderFloat64 on the selected GPU");
            if (spec.name != "motion" && spec.name != "psnr" && context_.properties.limits.maxComputeWorkGroupSize[1] < 16)
                throw std::runtime_error("Vulkan image features require a 16 by 16 compute workgroup");
            if (spec.name == "cambi") cambi.emplace_back(spec, plan);
            else if (spec.name == "speed_chroma") speed.emplace_back(spec, plan);
            else if (spec.name == "adm") {
                if (!context_.int64)
                    throw std::runtime_error("Vulkan ADM requires shaderInt64 on the selected GPU");
                adm.emplace_back(spec, plan);
            } else if (spec.name == "psnr") {
                if (vulkan_detail::boolean(spec, "enable_apsnr"))
                    throw std::invalid_argument("Vulkan feature-series API does not expose aggregate APSNR");
                if (vulkan_detail::option(spec, "min_sse", 0) < 0)
                    throw std::invalid_argument("PSNR min_sse must be nonnegative");
                psnr.push_back(spec);
            } else {
                if (!context_.int64) throw std::runtime_error("Vulkan motion requires shaderInt64 on the selected GPU");
                if (plan.width < 3 || plan.height < 3)
                    throw std::invalid_argument("motion's reflected five-tap filter requires dimensions of at least three");
                motion.emplace_back(spec);
            }
        }
        if (!cambi.empty() && !context_.cambi_pipeline)
            context_.cambi_pipeline = additional_pipeline(bitovp_vulkan_cambi_spv, sizeof(bitovp_vulkan_cambi_spv));
        if (!speed.empty() && !context_.speed_pipeline)
            context_.speed_pipeline = additional_pipeline(bitovp_vulkan_speed_spv, sizeof(bitovp_vulkan_speed_spv));
        if (!speed.empty() && !context_.speed_factor_pipeline)
            context_.speed_factor_pipeline = additional_pipeline(bitovp_vulkan_speed_factor_spv, sizeof(bitovp_vulkan_speed_factor_spv));
        if (!adm.empty() && !context_.adm_pipeline)
            context_.adm_pipeline = additional_pipeline(bitovp_vulkan_adm_spv, sizeof(bitovp_vulkan_adm_spv));
        if (!adm.empty() && !context_.adm_row_pipeline)
            context_.adm_row_pipeline = additional_pipeline(bitovp_vulkan_adm_row_spv, sizeof(bitovp_vulkan_adm_row_spv));
        if (!motion.empty() && !context_.motion_pipeline)
            context_.motion_pipeline = additional_pipeline(bitovp_vulkan_motion_spv, sizeof(bitovp_vulkan_motion_spv));
        plan_ = plan;
        cambi_ = std::move(cambi);
        speed_ = std::move(speed);
        adm_ = std::move(adm);
        motion_ = std::move(motion);
        psnr_ = std::move(psnr);
        for (auto &buffer : context_.motion_history) context_.release(buffer);
        for (auto &buffer : context_.frame_planes) context_.release(buffer);
        history_strides_ = {};
        configured_ = true;
        finished_ = false;
        failed_ = false;
        next_index_ = 0;
    }
    std::vector<FeatureScore> extract(std::uint64_t index, const Picture &reference, const Picture &distorted) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!configured_ || finished_ || failed_ || index != next_index_ || index == UINT64_MAX)
            throw std::invalid_argument("Vulkan extraction requires a live plan and contiguous frame indices starting at zero");
        failed_ = true;
        validate_pair(reference, distorted);
        if (reference.bit_depth != plan_.bit_depth || reference.planes[0].width != plan_.width ||
            reference.planes[0].height != plan_.height)
            throw std::invalid_argument("Vulkan input does not match the configured feature plan");
        for (unsigned p = 0; p < 3; ++p) {
            frame_sources_[p * 2u] = &reference.planes[p];
            frame_sources_[p * 2u + 1u] = &distorted.planes[p];
        }
        frame_uploaded_ = {};
        frame_cache_active_ = true;
        ResetFlag reset_cache{frame_cache_active_};
        std::vector<FeatureScore> scores;
        if (!psnr_.empty()) {
            PsnrSums sums;
            for (unsigned p = 0; p < 3; ++p) {
                sums.sample_count[p] = std::uint64_t(reference.planes[p].width) * reference.planes[p].height;
                sums.squared_error[p] = plane_sse(reference.planes[p], distorted.planes[p], reference.bit_depth);
            }
            const auto start = Clock::now();
            const char *psnr_names[] = {"psnr_y", "psnr_cb", "psnr_cr"};
            const char *mse_names[] = {"mse_y", "mse_cb", "mse_cr"};
            for (const auto &spec : psnr_) {
                const bool chroma = vulkan_detail::boolean(spec, "enable_chroma", true);
                const unsigned peak = vulkan_detail::boolean(spec, "reduced_hbd_peak") ?
                    255u << (reference.bit_depth - 8u) : (1u << reference.bit_depth) - 1u;
                const double minimum_sse = vulkan_detail::option(spec, "min_sse", 0);
                const auto emit = [&](const char *base, double value) {
                    const auto name = spec.canonical_names.find(base);
                    if (name != spec.canonical_names.end() &&
                        std::find(spec.provided_features.begin(), spec.provided_features.end(), name->second) != spec.provided_features.end())
                        scores.push_back({index, name->second, value});
                };
                for (unsigned p = 0; p < (chroma ? 3u : 1u); ++p) {
                    const double mse = double(sums.squared_error[p]) / double(sums.sample_count[p]);
                    const double maximum = minimum_sse != 0 ?
                        std::ceil(10.0 * std::log10(double(peak) * peak / (minimum_sse / double(sums.sample_count[p])))) :
                        double(6 * reference.bit_depth + 12);
                    emit(psnr_names[p], std::min(10.0 * std::log10(double(peak) * peak / std::max(mse, 1e-16)), maximum));
                    if (vulkan_detail::boolean(spec, "enable_mse")) emit(mse_names[p], mse);
                }
            }
            timings_.cpu_postprocess_ms += milliseconds(start);
        }
        for (auto &adm : adm_) {
            const auto values = adm_score(adm, reference.planes[0], distorted.planes[0]);
            const char *bases[] = {"VMAF_integer_feature_adm3_score", "VMAF_integer_feature_adm2_score",
                                   "VMAF_integer_feature_aim_score"};
            for (unsigned i = 0; i < 3; ++i) {
                const auto name = adm.spec.canonical_names.find(bases[i]);
                if (name == adm.spec.canonical_names.end() ||
                    std::find(adm.spec.provided_features.begin(), adm.spec.provided_features.end(), name->second)
                        == adm.spec.provided_features.end()) continue;
                if (!std::isfinite(values[i])) throw std::runtime_error("Vulkan ADM produced a non-finite feature");
                scores.push_back({index, name->second, values[i]});
            }
        }
        for (auto &cambi : cambi_) {
            const double value = cambi_score(cambi, distorted.planes[0]);
            if (!std::isfinite(value)) throw std::runtime_error("Vulkan CAMBI produced a non-finite feature");
            const auto name = cambi.spec.canonical_names.find("Cambi_feature_cambi_score");
            if (name == cambi.spec.canonical_names.end())
                throw std::invalid_argument("CAMBI plan is missing its official canonical feature name");
            scores.push_back({index, name->second, value});
        }
        for (auto &speed : speed_) {
            for (unsigned p = 1; p < 3; ++p)
                if (reference.planes[p].width != speed.width || reference.planes[p].height != speed.height)
                    throw std::invalid_argument("Vulkan SPEED plan currently requires YUV420 chroma geometry");
            const auto channels = speed_channels(speed, reference, distorted);
            const auto &u = channels[0], &v = channels[1];
            auto start = Clock::now();
            const float uv = u.second && !v.second ? v.first : v.second && !u.second ? u.first :
                float((u.first + v.first) / 2.0);
            const std::pair<const char *, float> values[] = {
                {"Speed_chroma_feature_speed_chroma_u_score", u.first},
                {"Speed_chroma_feature_speed_chroma_v_score", v.first},
                {"Speed_chroma_feature_speed_chroma_uv_score", uv}};
            for (const auto &value : values) {
                if (!std::isfinite(value.second)) throw std::runtime_error("Vulkan SPEED produced a non-finite feature");
                const auto name = speed.spec.canonical_names.find(value.first);
                if (name == speed.spec.canonical_names.end()) continue;
                if (std::find(speed.spec.provided_features.begin(), speed.spec.provided_features.end(), name->second) == speed.spec.provided_features.end()) continue;
                scores.push_back({index, name->second, std::min(double(value.second), speed.maximum)});
            }
            timings_.cpu_postprocess_ms += milliseconds(start);
        }
        if (!motion_.empty()) {
            const auto &plane = reference.planes[0];
            bool needs_history = false;
            for (const auto &state : motion_) needs_history |= !state.force_zero;
            if (needs_history) {
                auto &current = context_.motion_history[index % context_.motion_history.size()];
                reserve(current, (VkDeviceSize(plane.stride) * plane.height + 7u) & ~VkDeviceSize(3u));
                auto start = Clock::now();
                const unsigned bytes = plan_.bit_depth == 8 ? 1 : 2;
                for (unsigned y = 0; y < plane.height; ++y)
                    std::memcpy(static_cast<std::uint8_t *>(current.mapped) + y * plane.stride,
                                static_cast<const std::uint8_t *>(plane.data) + y * plane.stride,
                                std::size_t(plane.width) * bytes);
                host_cache(current, true);
                timings_.uploaded_bytes += std::uint64_t(plane.width) * plane.height * bytes;
                timings_.upload_ms += milliseconds(start);
                history_strides_[index % history_strides_.size()] = unsigned(plane.stride);
            }
            std::array<std::uint64_t, 3> sums{};
            std::array<bool, 3> computed{};
            for (auto &state : motion_) {
                const unsigned lag = state.five_frame ? 2 : 1;
                if (index >= lag && !state.force_zero && !computed[lag]) {
                    const auto previous = (index - lag) % context_.motion_history.size();
                    const auto current = index % context_.motion_history.size();
                    sums[lag] = motion_sad(context_.motion_history[previous], context_.motion_history[current],
                                           history_strides_[previous], history_strides_[current]);
                    computed[lag] = true;
                }
                const auto start = Clock::now();
                state.append(index, sums[lag], std::uint64_t(plan_.width) * plan_.height, scores);
                timings_.cpu_postprocess_ms += milliseconds(start);
            }
        }
        ++next_index_;
        failed_ = false;
        return scores;
    }
    std::vector<FeatureScore> flush() override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!configured_ || failed_) throw std::invalid_argument("cannot flush an unconfigured or failed Vulkan plan");
        if (finished_) return {};
        std::vector<FeatureScore> output;
        const auto start = Clock::now();
        for (auto &state : motion_) state.flush(next_index_, output);
        timings_.cpu_postprocess_ms += milliseconds(start);
        finished_ = true;
        return output;
    }

private:
    void select_device() {
        std::uint32_t count = 0;
        check(vkEnumeratePhysicalDevices(context_.instance, &count, nullptr), "vkEnumeratePhysicalDevices");
        std::vector<VkPhysicalDevice> devices(count);
        check(vkEnumeratePhysicalDevices(context_.instance, &count, devices.data()), "vkEnumeratePhysicalDevices");
        int best_score = -1;
        for (std::size_t i = 0; i < devices.size(); ++i) {
            VkPhysicalDeviceProperties properties{};
            vkGetPhysicalDeviceProperties(devices[i], &properties);
            if (properties.deviceType != VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU &&
                properties.deviceType != VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) continue;
            if (options_.device_index >= 0 && std::size_t(options_.device_index) != i) continue;
            if (options_.vendor_id && properties.vendorID != options_.vendor_id) continue;
            const int score = options_.prefer_shared_memory &&
                properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU ? 2 : 1;
            if (score <= best_score) continue;
            context_.physical = devices[i];
            context_.properties = properties;
            context_.info.index = int(i);
            best_score = score;
        }
        if (!context_.physical)
            throw std::runtime_error("no hardware Vulkan GPU matches the requested device/vendor");
        if (context_.properties.apiVersion < VK_API_VERSION_1_1)
            throw std::runtime_error("the Vulkan backend requires Vulkan 1.1");
        auto &info = context_.info;
        info.backend = "vulkan";
        info.name = context_.properties.deviceName;
        info.vendor_id = context_.properties.vendorID;
        info.device_id = context_.properties.deviceID;
        info.integrated = context_.properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU;
        VkPhysicalDeviceIDProperties id{};
        id.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES;
        VkPhysicalDeviceProperties2 properties{};
        properties.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
        properties.pNext = &id;
        vkGetPhysicalDeviceProperties2(context_.physical, &properties);
        std::ostringstream uuid;
        for (unsigned char byte : id.deviceUUID)
            uuid << std::hex << std::setfill('0') << std::setw(2) << unsigned(byte);
        info.uuid = uuid.str();
        vkGetPhysicalDeviceMemoryProperties(context_.physical, &context_.memory_properties);

        std::uint32_t queue_count = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(context_.physical, &queue_count, nullptr);
        std::vector<VkQueueFamilyProperties> families(queue_count);
        vkGetPhysicalDeviceQueueFamilyProperties(context_.physical, &queue_count, families.data());
        bool found = false;
        for (std::uint32_t i = 0; i < queue_count; ++i) {
            if (!(families[i].queueFlags & VK_QUEUE_COMPUTE_BIT)) continue;
            context_.queue_family = i;
            context_.timestamp_bits = families[i].timestampValidBits;
            found = true;
            break;
        }
        if (!found) throw std::runtime_error("selected Vulkan GPU has no compute queue");
        if (context_.properties.limits.maxComputeWorkGroupInvocations < 256 ||
            context_.properties.limits.maxComputeWorkGroupSize[0] < 256 ||
            context_.properties.limits.maxComputeSharedMemorySize < 1024)
            throw std::runtime_error("selected Vulkan GPU cannot run the 256-sample SSE kernel");
        const float priority = 1;
        VkDeviceQueueCreateInfo queue{};
        queue.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
        queue.queueFamilyIndex = context_.queue_family;
        queue.queueCount = 1;
        queue.pQueuePriorities = &priority;
        VkDeviceCreateInfo device{};
        device.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
        VkPhysicalDeviceFeatures available{}, enabled{};
        vkGetPhysicalDeviceFeatures(context_.physical, &available);
        enabled.shaderFloat64 = available.shaderFloat64;
        enabled.shaderInt64 = available.shaderInt64;
        context_.float64 = available.shaderFloat64 != VK_FALSE;
        context_.int64 = available.shaderInt64 != VK_FALSE;
        device.pEnabledFeatures = &enabled;
        device.queueCreateInfoCount = 1;
        device.pQueueCreateInfos = &queue;
        check(vkCreateDevice(context_.physical, &device, nullptr, &context_.device), "vkCreateDevice");
        vkGetDeviceQueue(context_.device, context_.queue_family, 0, &context_.queue);
    }

    void create_pipeline() {
        std::array<VkDescriptorSetLayoutBinding, 3> bindings{};
        for (unsigned i = 0; i < bindings.size(); ++i) {
            bindings[i].binding = i;
            bindings[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            bindings[i].descriptorCount = 1;
            bindings[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
        }
        VkDescriptorSetLayoutCreateInfo layout{};
        layout.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
        layout.bindingCount = bindings.size();
        layout.pBindings = bindings.data();
        check(vkCreateDescriptorSetLayout(context_.device, &layout, nullptr, &context_.descriptor_layout), "vkCreateDescriptorSetLayout");
        VkPushConstantRange push{VK_SHADER_STAGE_COMPUTE_BIT, 0, 8 * sizeof(std::uint32_t)};
        VkPipelineLayoutCreateInfo pipeline_layout{};
        pipeline_layout.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
        pipeline_layout.setLayoutCount = 1;
        pipeline_layout.pSetLayouts = &context_.descriptor_layout;
        pipeline_layout.pushConstantRangeCount = 1;
        pipeline_layout.pPushConstantRanges = &push;
        check(vkCreatePipelineLayout(context_.device, &pipeline_layout, nullptr, &context_.pipeline_layout), "vkCreatePipelineLayout");
        VkShaderModuleCreateInfo shader{};
        shader.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
        shader.codeSize = sizeof(bitovp_vulkan_psnr_spv);
        shader.pCode = bitovp_vulkan_psnr_spv;
        VkShaderModule module = VK_NULL_HANDLE;
        check(vkCreateShaderModule(context_.device, &shader, nullptr, &module), "vkCreateShaderModule");
        VkComputePipelineCreateInfo pipeline{};
        pipeline.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
        pipeline.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
        pipeline.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
        pipeline.stage.module = module;
        pipeline.stage.pName = "main";
        pipeline.layout = context_.pipeline_layout;
        const VkResult pipeline_result = vkCreateComputePipelines(context_.device, VK_NULL_HANDLE, 1, &pipeline, nullptr, &context_.pipeline);
        vkDestroyShaderModule(context_.device, module, nullptr);
        check(pipeline_result, "vkCreateComputePipelines");
        VkDescriptorPoolSize size{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 3};
        VkDescriptorPoolCreateInfo pool{};
        pool.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
        pool.maxSets = 1;
        pool.poolSizeCount = 1;
        pool.pPoolSizes = &size;
        check(vkCreateDescriptorPool(context_.device, &pool, nullptr, &context_.descriptor_pool), "vkCreateDescriptorPool");
        VkDescriptorSetAllocateInfo allocate{};
        allocate.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
        allocate.descriptorPool = context_.descriptor_pool;
        allocate.descriptorSetCount = 1;
        allocate.pSetLayouts = &context_.descriptor_layout;
        check(vkAllocateDescriptorSets(context_.device, &allocate, &context_.descriptor), "vkAllocateDescriptorSets");
        VkCommandPoolCreateInfo commands{};
        commands.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
        commands.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
        commands.queueFamilyIndex = context_.queue_family;
        check(vkCreateCommandPool(context_.device, &commands, nullptr, &context_.command_pool), "vkCreateCommandPool");
        VkCommandBufferAllocateInfo command{};
        command.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
        command.commandPool = context_.command_pool;
        command.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        command.commandBufferCount = 1;
        check(vkAllocateCommandBuffers(context_.device, &command, &context_.command), "vkAllocateCommandBuffers");
        VkFenceCreateInfo fence{};
        fence.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
        check(vkCreateFence(context_.device, &fence, nullptr, &context_.fence), "vkCreateFence");
        if (context_.timestamp_bits) {
            VkQueryPoolCreateInfo query{};
            query.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO;
            query.queryType = VK_QUERY_TYPE_TIMESTAMP;
            query.queryCount = context_.profile_passes ? 512u : 2u;
            check(vkCreateQueryPool(context_.device, &query, nullptr, &context_.queries), "vkCreateQueryPool");
        }
    }

    void reserve(Buffer &buffer, VkDeviceSize bytes) {
        if (buffer.capacity >= bytes) return;
        if (bytes > context_.properties.limits.maxStorageBufferRange)
            throw std::runtime_error("Vulkan storage buffer exceeds maxStorageBufferRange");
        context_.release(buffer);
        VkBufferCreateInfo create{};
        create.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
        create.size = bytes;
        create.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
        create.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        check(vkCreateBuffer(context_.device, &create, nullptr, &buffer.buffer), "vkCreateBuffer");
        VkMemoryRequirements requirements{};
        vkGetBufferMemoryRequirements(context_.device, buffer.buffer, &requirements);
        int selected = -1, best = -1;
        for (unsigned i = 0; i < context_.memory_properties.memoryTypeCount; ++i) {
            const auto flags = context_.memory_properties.memoryTypes[i].propertyFlags;
            if (!(requirements.memoryTypeBits & (1u << i)) || !(flags & VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT)) continue;
            const int score = ((flags & VK_MEMORY_PROPERTY_HOST_COHERENT_BIT) ? 1 : 0) +
                ((flags & VK_MEMORY_PROPERTY_HOST_CACHED_BIT) ? 2 : 0) +
                ((options_.prefer_shared_memory && (flags & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)) ? 4 : 0);
            if (score > best) { best = score; selected = int(i); }
        }
        if (selected < 0) throw std::runtime_error("Vulkan storage buffers have no host-visible memory type");
        const auto &type = context_.memory_properties.memoryTypes[selected];
        buffer.coherent = (type.propertyFlags & VK_MEMORY_PROPERTY_HOST_COHERENT_BIT) != 0;
        VkMemoryAllocateInfo allocation{};
        allocation.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        allocation.allocationSize = requirements.size;
        allocation.memoryTypeIndex = unsigned(selected);
        check(vkAllocateMemory(context_.device, &allocation, nullptr, &buffer.memory), "vkAllocateMemory");
        buffer.allocation_size = requirements.size;
        check(vkBindBufferMemory(context_.device, buffer.buffer, buffer.memory, 0), "vkBindBufferMemory");
        check(vkMapMemory(context_.device, buffer.memory, 0, VK_WHOLE_SIZE, 0, &buffer.mapped), "vkMapMemory");
        buffer.capacity = bytes;
        context_.info.memory_budget = context_.memory_properties.memoryHeaps[type.heapIndex].size;
        std::uint64_t live = 0;
        for (const auto &item : context_.buffers) live += item.allocation_size;
        timings_.allocated_bytes = std::max(timings_.allocated_bytes, live);
    }

    void host_cache(Buffer &buffer, bool flush) {
        if (buffer.coherent) return;
        VkMappedMemoryRange range{};
        range.sType = VK_STRUCTURE_TYPE_MAPPED_MEMORY_RANGE;
        range.memory = buffer.memory;
        range.size = VK_WHOLE_SIZE;
        check(flush ? vkFlushMappedMemoryRanges(context_.device, 1, &range) :
                      vkInvalidateMappedMemoryRanges(context_.device, 1, &range),
              flush ? "vkFlushMappedMemoryRanges" : "vkInvalidateMappedMemoryRanges");
    }

    VkPipeline additional_pipeline(const std::uint32_t *code, std::size_t bytes) {
        VkShaderModuleCreateInfo shader{};
        shader.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
        shader.codeSize = bytes;
        shader.pCode = code;
        VkShaderModule module = VK_NULL_HANDLE;
        check(vkCreateShaderModule(context_.device, &shader, nullptr, &module), "vkCreateShaderModule(feature)");
        VkComputePipelineCreateInfo info{};
        info.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
        info.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
        info.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
        info.stage.module = module;
        info.stage.pName = "main";
        info.layout = context_.pipeline_layout;
        VkPipeline pipeline = VK_NULL_HANDLE;
        const auto result = vkCreateComputePipelines(context_.device, VK_NULL_HANDLE, 1, &info, nullptr, &pipeline);
        vkDestroyShaderModule(context_.device, module, nullptr);
        check(result, "vkCreateComputePipelines(feature)");
        return pipeline;
    }

    struct Dispatch {
        std::array<std::uint32_t, 8> parameters;
        unsigned x, y;
        VkPipeline pipeline = VK_NULL_HANDLE;
    };
    void execute_program(VkPipeline pipeline, const std::vector<Dispatch> &dispatches,
                         const std::array<Buffer *, 3> *resources = nullptr,
                         const char *extractor = nullptr) {
        const unsigned query_count = context_.profile_passes ? 2u + 2u * dispatches.size() : 2u;
        if (query_count > 512u)
            throw std::invalid_argument("Vulkan diagnostic pass profile exceeds timestamp query capacity");
        std::array<VkDescriptorBufferInfo, 3> buffer_info{};
        std::array<VkWriteDescriptorSet, 3> writes{};
        for (unsigned i = 0; i < 3; ++i) {
            const Buffer &buffer = resources ? *(*resources)[i] : context_.buffers[i];
            buffer_info[i] = {buffer.buffer, 0, buffer.capacity};
            writes[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
            writes[i].dstSet = context_.descriptor;
            writes[i].dstBinding = i;
            writes[i].descriptorCount = 1;
            writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            writes[i].pBufferInfo = &buffer_info[i];
        }
        vkUpdateDescriptorSets(context_.device, writes.size(), writes.data(), 0, nullptr);
        check(vkResetCommandBuffer(context_.command, 0), "vkResetCommandBuffer(feature)");
        VkCommandBufferBeginInfo begin{};
        begin.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
        begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        check(vkBeginCommandBuffer(context_.command, &begin), "vkBeginCommandBuffer(feature)");
        if (context_.queries) {
            vkCmdResetQueryPool(context_.command, context_.queries, 0, query_count);
            vkCmdWriteTimestamp(context_.command, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, context_.queries, 0);
        }
        vkCmdBindPipeline(context_.command, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
        VkPipeline current_pipeline = pipeline;
        vkCmdBindDescriptorSets(context_.command, VK_PIPELINE_BIND_POINT_COMPUTE, context_.pipeline_layout, 0, 1, &context_.descriptor, 0, nullptr);
        VkMemoryBarrier barrier{};
        barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;
        barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
        barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT;
        for (unsigned pass = 0; pass < dispatches.size(); ++pass) {
            const auto &dispatch = dispatches[pass];
            if (dispatch.x > context_.properties.limits.maxComputeWorkGroupCount[0] ||
                dispatch.y > context_.properties.limits.maxComputeWorkGroupCount[1])
                throw std::invalid_argument("Vulkan feature dispatch exceeds device limits");
            const VkPipeline selected_pipeline = dispatch.pipeline ? dispatch.pipeline : pipeline;
            if (selected_pipeline != current_pipeline) {
                vkCmdBindPipeline(context_.command, VK_PIPELINE_BIND_POINT_COMPUTE, selected_pipeline);
                current_pipeline = selected_pipeline;
            }
            vkCmdPushConstants(context_.command, context_.pipeline_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0,
                               sizeof(dispatch.parameters), dispatch.parameters.data());
            if (context_.queries && context_.profile_passes)
                vkCmdWriteTimestamp(context_.command, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
                    context_.queries, 2u + 2u * pass);
            vkCmdDispatch(context_.command, dispatch.x, dispatch.y, 1);
            vkCmdPipelineBarrier(context_.command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &barrier, 0, nullptr, 0, nullptr);
            if (context_.queries && context_.profile_passes)
                vkCmdWriteTimestamp(context_.command, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,
                    context_.queries, 3u + 2u * pass);
        }
        barrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
        vkCmdPipelineBarrier(context_.command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
            VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &barrier, 0, nullptr, 0, nullptr);
        if (context_.queries) vkCmdWriteTimestamp(context_.command, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, context_.queries, 1);
        check(vkEndCommandBuffer(context_.command), "vkEndCommandBuffer(feature)");
        check(vkResetFences(context_.device, 1, &context_.fence), "vkResetFences(feature)");
        VkSubmitInfo submit{};
        submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
        submit.commandBufferCount = 1;
        submit.pCommandBuffers = &context_.command;
        check(vkQueueSubmit(context_.queue, 1, &submit, context_.fence), "vkQueueSubmit(feature)");
        check(vkWaitForFences(context_.device, 1, &context_.fence, VK_TRUE, UINT64_MAX), "vkWaitForFences(feature)");
        if (context_.queries) {
            std::vector<std::uint64_t> ticks(query_count);
            check(vkGetQueryPoolResults(context_.device, context_.queries, 0, query_count, ticks.size() * sizeof(std::uint64_t), ticks.data(), sizeof(std::uint64_t), VK_QUERY_RESULT_64_BIT), "vkGetQueryPoolResults(feature)");
            const auto mask = context_.timestamp_bits == 64 ? UINT64_MAX : (std::uint64_t(1) << context_.timestamp_bits) - 1u;
            const double elapsed = double((ticks[1] - ticks[0]) & mask) * context_.properties.limits.timestampPeriod / 1e6;
            timings_.kernel_ms += elapsed;
            if (extractor) timings_.extractor_kernel_ms[extractor] += elapsed;
            if (extractor && context_.profile_passes)
                for (unsigned pass = 0; pass < dispatches.size(); ++pass) {
                    const double duration = double((ticks[3u + 2u * pass] - ticks[2u + 2u * pass]) & mask) *
                        context_.properties.limits.timestampPeriod / 1e6;
                    timings_.extractor_kernel_ms[std::string(extractor) + "/mode" +
                        std::to_string(dispatches[pass].parameters[0])] += duration;
                }
        }
    }

    Buffer &source_buffer(const Plane &source, unsigned depth, unsigned fallback) {
        Buffer *selected = &context_.buffers[fallback];
        bool *uploaded = nullptr;
        if (frame_cache_active_)
            for (unsigned i = 0; i < frame_sources_.size(); ++i)
                if (frame_sources_[i] == &source) {
                    selected = &context_.frame_planes[i];
                    uploaded = &frame_uploaded_[i];
                    if (*uploaded) return *selected;
                    break;
                }
        auto &buffer = *selected;
        reserve(buffer, (VkDeviceSize(source.stride) * source.height + 7u) & ~VkDeviceSize(3u));
        auto start = Clock::now();
        const unsigned bytes = depth == 8 ? 1u : 2u;
        // Only active samples are copied. Packed word loads mask unused row
        // padding and the allocation includes a guard word after the last row.
        for (unsigned y = 0; y < source.height; ++y)
            std::memcpy(static_cast<std::uint8_t *>(buffer.mapped) + y * source.stride,
                        static_cast<const std::uint8_t *>(source.data) + y * source.stride,
                        std::size_t(source.width) * bytes);
        host_cache(buffer, true);
        timings_.uploaded_bytes += std::uint64_t(source.width) * source.height * bytes;
        timings_.upload_ms += milliseconds(start);
        if (uploaded) *uploaded = true;
        return buffer;
    }

    std::array<double, 3> adm_score(vulkan_detail::AdmParameters &adm,
                                   const Plane &reference, const Plane &distorted) {
        auto &r = source_buffer(reference, plan_.bit_depth, 0);
        auto &d = source_buffer(distorted, plan_.bit_depth, 1);
        reserve(context_.buffers[2], adm.word_count * sizeof(std::uint32_t));
        auto start = Clock::now();
        adm.words[3] = static_cast<std::uint32_t>(reference.stride);
        adm.words[4] = static_cast<std::uint32_t>(distorted.stride);
        auto &workspace = context_.buffers[2];
        std::memcpy(workspace.mapped, adm.words.data(), adm.words.size() * sizeof(std::uint32_t));
        host_cache(workspace, true);
        timings_.uploaded_bytes += adm.words.size() * sizeof(std::uint32_t);
        timings_.upload_ms += milliseconds(start);
        std::vector<Dispatch> commands;
        for (const auto &pass : adm.passes)
            commands.push_back({pass.push, pass.groups_x, pass.groups_y,
                pass.push[0] == 4u ? context_.adm_row_pipeline : VK_NULL_HANDLE});
        const double previous_kernel_ms = timings_.kernel_ms;
        const std::array<Buffer *, 3> resources = {&r, &d, &workspace};
        execute_program(context_.adm_pipeline, commands, &resources);
        timings_.extractor_kernel_ms["adm"] += timings_.kernel_ms - previous_kernel_ms;
        start = Clock::now();
        host_cache(workspace, false);
        std::array<double, 3> result{};
        const auto *words = static_cast<const std::uint32_t *>(workspace.mapped);
        std::memcpy(result.data(), words + adm.result_offset, sizeof(result));
        timings_.downloaded_bytes += sizeof(result);
        timings_.download_ms += milliseconds(start);
        return result;
    }

    double cambi_score(vulkan_detail::CambiParameters &cambi, const Plane &input) {
        reserve(context_.buffers[0], 4);
        auto &data = source_buffer(input, plan_.bit_depth, 1);
        reserve(context_.buffers[2], cambi.word_count * sizeof(std::uint32_t));
        auto start = Clock::now();
        cambi.words[4] = std::uint32_t(input.stride);
        auto &workspace = context_.buffers[2];
        std::memcpy(workspace.mapped, cambi.words.data(), cambi.words.size() * sizeof(std::uint32_t));
        host_cache(workspace, true);
        timings_.uploaded_bytes += cambi.words.size() * sizeof(std::uint32_t);
        timings_.upload_ms += milliseconds(start);
        unsigned width = cambi.width, height = cambi.height;
        auto image = cambi.image_a, other_image = cambi.image_b;
        auto mask = cambi.mask_a, other_mask = cambi.mask_b;
        std::vector<Dispatch> commands;
        const auto dispatch = [&](unsigned mode, unsigned extra = 0, unsigned destination = 0) {
            const auto groups = (std::uint64_t(width) * height + 255u) / 256u;
            const bool flat = mode == 7u || mode == 9u;
            const bool pooled = mode >= 6u && mode <= 10u;
            const unsigned groups_x = flat ? unsigned(std::min<std::uint64_t>(groups,
                context_.properties.limits.maxComputeWorkGroupCount[0])) :
                pooled ? 1u : (width + 15u) / 16u;
            const unsigned groups_y = flat ? unsigned((groups + groups_x - 1u) / groups_x) :
                pooled ? 1u : (height + 15u) / 16u;
            commands.push_back({{mode, width, height, image, destination ? destination : other_image,
                mask, other_mask, extra}, groups_x, groups_y});
        };
        dispatch(0, 0, image);
        if (cambi.words[6] < 10u) { dispatch(1); std::swap(image, other_image); }
        dispatch(11);
        std::swap(mask, other_mask);
        dispatch(2);
        std::swap(mask, other_mask);
        for (unsigned scale = 0; scale < 5; ++scale) {
            if (scale || cambi.high_resolution) {
                const auto old_width = width;
                width = (width + 1u) >> 1u;
                height = (height + 1u) >> 1u;
                dispatch(3, old_width);
                std::swap(image, other_image);
                std::swap(mask, other_mask);
            }
            dispatch(4); std::swap(image, other_image);
            dispatch(5);
            const auto count = std::uint64_t(width) * height;
            const auto topk = unsigned(std::clamp(cambi.topk * double(count), 1.0, double(count)));
            dispatch(6, topk);
            if (topk != count)
                for (int shift = 28; shift >= 0; shift -= 4) {
                    dispatch(7, unsigned(shift));
                    dispatch(8, unsigned(shift));
                }
            dispatch(9);
            dispatch(10, topk, cambi.scores + scale * 2u);
        }
        const std::array<Buffer *, 3> resources = {&context_.buffers[0], &data, &workspace};
        execute_program(context_.cambi_pipeline, commands, &resources, "cambi");
        start = Clock::now();
        host_cache(workspace, false);
        const auto *words = static_cast<const std::uint32_t *>(workspace.mapped);
        std::array<double, 5> values{};
        for (unsigned scale = 0; scale < 5; ++scale) {
            std::memcpy(&values[scale], words + cambi.scores + scale * 2u, sizeof(double));
        }
        timings_.downloaded_bytes += 5 * sizeof(double);
        timings_.download_ms += milliseconds(start);
        start = Clock::now();
        const unsigned weights[5] = {16, 8, 4, 2, 1};
        double score = 0;
        for (unsigned scale = 0; scale < 5; ++scale) score += values[scale] * weights[scale];
        const double result = std::min(score / double(cambi.window * cambi.window), cambi.maximum);
        timings_.cpu_postprocess_ms += milliseconds(start);
        return result;
    }

    std::array<std::pair<float, bool>, 2> speed_channels(vulkan_detail::SpeedParameters &speed,
                                                        const Picture &reference, const Picture &distorted) {
        reserve(context_.buffers[2], speed.word_count * sizeof(std::uint32_t));
        auto start = Clock::now();
        auto &workspace = context_.buffers[2];
        std::memcpy(workspace.mapped, speed.words.data(), speed.words.size() * sizeof(std::uint32_t));
        host_cache(workspace, true);
        timings_.uploaded_bytes += speed.words.size() * sizeof(std::uint32_t);
        timings_.upload_ms += milliseconds(start);
        // Retain four small covariance/RHS workspaces, while reusing the large
        // image scratch. Each channel completes before its input descriptors
        // change. The second submission factors all four independent matrices.
        for (unsigned channel = 0; channel < 2; ++channel) {
            const Plane *inputs[2] = {&reference.planes[channel + 1u], &distorted.planes[channel + 1u]};
            auto &r = source_buffer(*inputs[0], plan_.bit_depth, 0);
            auto &d = source_buffer(*inputs[1], plan_.bit_depth, 1);
            std::vector<Dispatch> commands;
            const auto dispatch = [&](unsigned mode, unsigned width, unsigned height,
                                      unsigned source, unsigned destination, unsigned extra0 = 0,
                                      unsigned extra1 = 0, unsigned slot = 0) {
                const unsigned groups_x = mode == 7u ? 4u : mode == 8u ? 3u :
                    mode == 9u || mode == 10u ? (speed.blocks + 255u) / 256u :
                    mode >= 6u ? 1u : (width + 15u) / 16u;
                const unsigned groups_y = mode == 9u ? 4u : mode >= 6u ? 1u : (height + 15u) / 16u;
                commands.push_back({{mode, width, height, source, destination, extra0, extra1, slot},
                    groups_x, groups_y, mode == 7u ? context_.speed_factor_pipeline : VK_NULL_HANDLE});
            };
            for (unsigned i = 0; i < 2; ++i) {
                const unsigned slot = channel * 2u + i;
                dispatch(0, speed.width, speed.height, 0, speed.frame_a, unsigned(inputs[i]->stride), i);
                unsigned input = speed.frame_a;
                if (speed.resize) {
                    dispatch(1, speed.scaled_width, speed.scaled_height, speed.frame_a, speed.frame_b);
                    input = speed.frame_b;
                }
                dispatch(2, speed.scaled_width, speed.operating_height, input, speed.temporary);
                dispatch(3, speed.operating_width, speed.operating_height, speed.temporary, speed.downscaled);
                dispatch(4, speed.operating_width, speed.operating_height, speed.downscaled, speed.temporary);
                dispatch(5, speed.operating_width, speed.operating_height, speed.temporary, speed.downscaled, speed.downscaled);
                dispatch(6, speed.operating_width, speed.operating_height, speed.downscaled, 0);
                dispatch(8, speed.operating_width, speed.operating_height, speed.downscaled, 0, 0, 0, slot);
                dispatch(10, speed.operating_width, speed.operating_height, speed.downscaled, 0, 0, 0, slot);
            }
            if (channel == 1u) {
                dispatch(7, speed.operating_width, speed.operating_height, 0, 0);
                dispatch(9, speed.operating_width, speed.operating_height, 0, 0);
            }
            const std::array<Buffer *, 3> resources = {&r, &d, &workspace};
            execute_program(context_.speed_pipeline, commands, &resources, "speed_chroma");
        }
        start = Clock::now();
        host_cache(workspace, false);
        const unsigned count = 26u + speed.blocks;
        std::array<std::vector<float>, 4> values;
        const auto *words = static_cast<const std::uint32_t *>(workspace.mapped);
        for (unsigned i = 0; i < values.size(); ++i) {
            values[i].resize(count);
            std::memcpy(values[i].data(), words + speed.matrices[i].result, count * sizeof(float));
        }
        timings_.downloaded_bytes += values.size() * count * sizeof(float);
        timings_.download_ms += milliseconds(start);
        start = Clock::now();
        const std::array<std::pair<float, bool>, 2> result = {
            speed.channel_score(values[0].data(), values[1].data()),
            speed.channel_score(values[2].data(), values[3].data())};
        timings_.cpu_postprocess_ms += milliseconds(start);
        return result;
    }

    std::uint64_t motion_sad(Buffer &previous, Buffer &current,
                              unsigned previous_stride, unsigned current_stride) {
        const auto pixels = std::uint64_t(plan_.width) * plan_.height;
        const auto groups = unsigned((pixels + 255u) / 256u);
        const auto groups_x = std::min(groups, context_.properties.limits.maxComputeWorkGroupCount[0]);
        const auto groups_y = (groups + groups_x - 1u) / groups_x;
        reserve(context_.buffers[2], (pixels + groups + 1u) * sizeof(std::uint32_t));
        auto &workspace = context_.buffers[2];
        auto start = Clock::now();
        static_cast<std::uint32_t *>(workspace.mapped)[pixels + groups] = 0;
        host_cache(workspace, true);
        timings_.uploaded_bytes += sizeof(std::uint32_t);
        timings_.upload_ms += milliseconds(start);
        std::vector<Dispatch> commands;
        for (unsigned mode = 0; mode < 2; ++mode)
            commands.push_back({{mode, plan_.width, plan_.height, previous_stride, current_stride,
                plan_.bit_depth, groups_x, groups}, groups_x, groups_y});
        const std::array<Buffer *, 3> resources = {&previous, &current, &workspace};
        execute_program(context_.motion_pipeline, commands, &resources, "motion");
        start = Clock::now();
        host_cache(workspace, false);
        const auto *partial = static_cast<const std::uint32_t *>(workspace.mapped) + pixels;
        if (partial[groups]) throw std::invalid_argument("Vulkan motion sample exceeds the declared bit depth");
        timings_.downloaded_bytes += (std::uint64_t(groups) + 1u) * sizeof(std::uint32_t);
        timings_.download_ms += milliseconds(start);
        start = Clock::now();
        std::uint64_t result = 0;
        for (unsigned i = 0; i < groups; ++i) result += partial[i];
        timings_.cpu_postprocess_ms += milliseconds(start);
        return result;
    }

    static void validate_pair(const Picture &reference, const Picture &distorted) {
        if (reference.memory != PictureMemory::Host || distorted.memory != PictureMemory::Host)
            throw std::invalid_argument("Vulkan host-input backend cannot read CUDA device pictures");
        if ((reference.bit_depth != 8 && reference.bit_depth != 10) || reference.bit_depth != distorted.bit_depth)
            throw std::invalid_argument("Vulkan PSNR currently requires matching 8-bit or 10-bit pictures");
        const unsigned bytes = reference.bit_depth == 8 ? 1 : 2;
        for (unsigned p = 0; p < 3; ++p) {
            const auto &r = reference.planes[p];
            const auto &d = distorted.planes[p];
            if (!r.data || !d.data || !r.width || !r.height || r.width != d.width || r.height != d.height)
                throw std::invalid_argument("Vulkan pictures require matching nonempty Y/U/V planes");
            if (std::uint64_t(r.width) * r.height > std::numeric_limits<std::uint32_t>::max() ||
                r.stride < std::uint64_t(r.width) * bytes || d.stride < std::uint64_t(d.width) * bytes ||
                r.stride > std::numeric_limits<std::uint32_t>::max() / r.height ||
                d.stride > std::numeric_limits<std::uint32_t>::max() / d.height)
                throw std::invalid_argument("Vulkan plane dimensions or stride exceed the packed-buffer contract");
        }
    }

    std::uint64_t plane_sse(const Plane &reference, const Plane &distorted, unsigned depth) {
        const auto count = std::uint64_t(reference.width) * reference.height;
        const auto groups = std::uint32_t((count + 255u) / 256u);
        const auto groups_x = std::min(groups, context_.properties.limits.maxComputeWorkGroupCount[0]);
        const auto groups_y = (groups + groups_x - 1u) / groups_x;
        if (groups_y > context_.properties.limits.maxComputeWorkGroupCount[1])
            throw std::runtime_error("Vulkan SSE dispatch exceeds workgroup count limits");
        const unsigned bytes = depth == 8 ? 1 : 2;
        auto &r = source_buffer(reference, depth, 0);
        auto &d = source_buffer(distorted, depth, 1);
        reserve(context_.buffers[2], (VkDeviceSize(groups) + 1u) * sizeof(std::uint32_t));
        auto start = Clock::now();
        static_cast<std::uint32_t *>(context_.buffers[2].mapped)[groups] = 0;
        host_cache(context_.buffers[2], true);
        timings_.uploaded_bytes += sizeof(std::uint32_t);
        timings_.upload_ms += milliseconds(start);
        std::array<VkDescriptorBufferInfo, 3> buffer_info{};
        std::array<VkWriteDescriptorSet, 3> writes{};
        const Buffer *resources[] = {&r, &d, &context_.buffers[2]};
        for (unsigned i = 0; i < 3; ++i) {
            buffer_info[i] = {resources[i]->buffer, 0, resources[i]->capacity};
            writes[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
            writes[i].dstSet = context_.descriptor;
            writes[i].dstBinding = i;
            writes[i].descriptorCount = 1;
            writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            writes[i].pBufferInfo = &buffer_info[i];
        }
        vkUpdateDescriptorSets(context_.device, writes.size(), writes.data(), 0, nullptr);
        check(vkResetCommandBuffer(context_.command, 0), "vkResetCommandBuffer");
        VkCommandBufferBeginInfo begin{};
        begin.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
        begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        check(vkBeginCommandBuffer(context_.command, &begin), "vkBeginCommandBuffer");
        if (context_.queries) {
            vkCmdResetQueryPool(context_.command, context_.queries, 0, 2);
            vkCmdWriteTimestamp(context_.command, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, context_.queries, 0);
        }
        vkCmdBindPipeline(context_.command, VK_PIPELINE_BIND_POINT_COMPUTE, context_.pipeline);
        vkCmdBindDescriptorSets(context_.command, VK_PIPELINE_BIND_POINT_COMPUTE, context_.pipeline_layout, 0, 1, &context_.descriptor, 0, nullptr);
        const std::array<std::uint32_t, 8> parameters = {reference.width, reference.height,
            std::uint32_t(reference.stride), std::uint32_t(distorted.stride), bytes, (1u << depth) - 1u, groups, groups_x};
        vkCmdPushConstants(context_.command, context_.pipeline_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(parameters), parameters.data());
        vkCmdDispatch(context_.command, groups_x, groups_y, 1);
        VkMemoryBarrier barrier{};
        barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;
        barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
        barrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
        vkCmdPipelineBarrier(context_.command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &barrier, 0, nullptr, 0, nullptr);
        if (context_.queries) vkCmdWriteTimestamp(context_.command, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, context_.queries, 1);
        check(vkEndCommandBuffer(context_.command), "vkEndCommandBuffer");
        check(vkResetFences(context_.device, 1, &context_.fence), "vkResetFences");
        VkSubmitInfo submit{};
        submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
        submit.commandBufferCount = 1;
        submit.pCommandBuffers = &context_.command;
        check(vkQueueSubmit(context_.queue, 1, &submit, context_.fence), "vkQueueSubmit");
        check(vkWaitForFences(context_.device, 1, &context_.fence, VK_TRUE, UINT64_MAX), "vkWaitForFences");
        if (context_.queries) {
            std::array<std::uint64_t, 2> ticks{};
            check(vkGetQueryPoolResults(context_.device, context_.queries, 0, 2, sizeof(ticks), ticks.data(), sizeof(std::uint64_t), VK_QUERY_RESULT_64_BIT), "vkGetQueryPoolResults");
            const std::uint64_t mask = context_.timestamp_bits == 64 ? UINT64_MAX : (std::uint64_t(1) << context_.timestamp_bits) - 1u;
            const double elapsed = double((ticks[1] - ticks[0]) & mask) * context_.properties.limits.timestampPeriod / 1e6;
            timings_.kernel_ms += elapsed;
            timings_.extractor_kernel_ms["psnr"] += elapsed;
        }
        start = Clock::now();
        host_cache(context_.buffers[2], false);
        const auto *partial = static_cast<const std::uint32_t *>(context_.buffers[2].mapped);
        if (partial[groups]) throw std::invalid_argument("Vulkan input sample exceeds its declared bit depth");
        timings_.downloaded_bytes += (std::uint64_t(groups) + 1u) * sizeof(std::uint32_t);
        timings_.download_ms += milliseconds(start);
        start = Clock::now();
        std::uint64_t sum = 0;
        for (std::uint32_t i = 0; i < groups; ++i) sum += partial[i];
        timings_.cpu_postprocess_ms += milliseconds(start);
        return sum;
    }

    BackendOptions options_;
    Context context_;
    FeaturePlan plan_;
    std::vector<vulkan_detail::CambiParameters> cambi_;
    std::vector<vulkan_detail::SpeedParameters> speed_;
    std::vector<vulkan_detail::AdmParameters> adm_;
    std::vector<vulkan_detail::MotionParameters> motion_;
    std::vector<ExtractorSpec> psnr_;
    std::array<const Plane *, 6> frame_sources_{};
    std::array<bool, 6> frame_uploaded_{};
    bool frame_cache_active_ = false;
    std::array<unsigned, 3> history_strides_{};
    std::uint64_t next_index_ = 0;
    bool configured_ = false, finished_ = false, failed_ = false;
    BackendTimings timings_;
    mutable std::mutex mutex_;
};
}

std::unique_ptr<FeatureBackend> create_vulkan_backend(const BackendOptions &options) {
    return std::make_unique<VulkanBackend>(options);
}
} // namespace bitovp::gpu

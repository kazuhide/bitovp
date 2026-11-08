// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "adm_reduce_cases.hpp"
#include "vulkan_adm_reduce_test_spv.hpp"
#include <vulkan/vulkan.h>
#include <cstring>
#include <iostream>

namespace {
void check(VkResult result, const char *operation) {
    if (result != VK_SUCCESS)
        throw std::runtime_error(std::string(operation) + ": " + std::to_string(result));
}
class Harness {
    VkInstance instance = VK_NULL_HANDLE;
    VkPhysicalDevice physical = VK_NULL_HANDLE;
    VkDevice device = VK_NULL_HANDLE;
    VkQueue queue = VK_NULL_HANDLE;
    VkDescriptorSetLayout set_layout = VK_NULL_HANDLE;
    VkDescriptorPool descriptors = VK_NULL_HANDLE;
    VkDescriptorSet descriptor = VK_NULL_HANDLE;
    VkPipelineLayout layout = VK_NULL_HANDLE;
    VkPipeline pipeline = VK_NULL_HANDLE;
    VkCommandPool commands = VK_NULL_HANDLE;
    VkCommandBuffer command = VK_NULL_HANDLE;
    VkBuffer buffer = VK_NULL_HANDLE;
    VkDeviceMemory memory = VK_NULL_HANDLE;
    void *mapped = nullptr;
    std::size_t capacity = 0;

    void cleanup() {
        if (device) {
            vkDeviceWaitIdle(device);
            if (mapped) vkUnmapMemory(device, memory);
            if (buffer) vkDestroyBuffer(device, buffer, nullptr);
            if (memory) vkFreeMemory(device, memory, nullptr);
            if (commands) vkDestroyCommandPool(device, commands, nullptr);
            if (pipeline) vkDestroyPipeline(device, pipeline, nullptr);
            if (layout) vkDestroyPipelineLayout(device, layout, nullptr);
            if (descriptors) vkDestroyDescriptorPool(device, descriptors, nullptr);
            if (set_layout) vkDestroyDescriptorSetLayout(device, set_layout, nullptr);
            vkDestroyDevice(device, nullptr);
        }
        if (instance) vkDestroyInstance(instance, nullptr);
    }
    void reserve(std::size_t size) {
        if (capacity >= size) return;
        if (mapped) vkUnmapMemory(device, memory);
        if (buffer) vkDestroyBuffer(device, buffer, nullptr);
        if (memory) vkFreeMemory(device, memory, nullptr);
        mapped = nullptr; buffer = VK_NULL_HANDLE; memory = VK_NULL_HANDLE; capacity = 0;
        VkBufferCreateInfo create{};
        create.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
        create.size = size; create.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
        check(vkCreateBuffer(device, &create, nullptr, &buffer), "create test workspace");
        VkMemoryRequirements requirements{};
        vkGetBufferMemoryRequirements(device, buffer, &requirements);
        VkPhysicalDeviceMemoryProperties properties{};
        vkGetPhysicalDeviceMemoryProperties(physical, &properties);
        unsigned type = properties.memoryTypeCount;
        const auto wanted = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        for (unsigned i = 0; i < properties.memoryTypeCount; ++i)
            if ((requirements.memoryTypeBits & (1u << i)) &&
                (properties.memoryTypes[i].propertyFlags & wanted) == wanted) { type = i; break; }
        if (type == properties.memoryTypeCount) throw std::runtime_error("No coherent test memory type");
        VkMemoryAllocateInfo allocation{};
        allocation.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        allocation.allocationSize = requirements.size; allocation.memoryTypeIndex = type;
        check(vkAllocateMemory(device, &allocation, nullptr, &memory), "allocate test workspace");
        check(vkBindBufferMemory(device, buffer, memory, 0), "bind test workspace");
        check(vkMapMemory(device, memory, 0, VK_WHOLE_SIZE, 0, &mapped), "map test workspace");
        capacity = size;
    }
public:
    Harness(int requested, unsigned vendor) {
        try {
            VkApplicationInfo app{}; app.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
            app.apiVersion = VK_API_VERSION_1_1;
            VkInstanceCreateInfo create{}; create.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
            create.pApplicationInfo = &app;
            check(vkCreateInstance(&create, nullptr, &instance), "create test instance");
            unsigned count = 0;
            check(vkEnumeratePhysicalDevices(instance, &count, nullptr), "count test devices");
            std::vector<VkPhysicalDevice> devices(count);
            check(vkEnumeratePhysicalDevices(instance, &count, devices.data()), "list test devices");
            for (unsigned i = 0; i < count; ++i) {
                VkPhysicalDeviceProperties properties{};
                vkGetPhysicalDeviceProperties(devices[i], &properties);
                if ((requested < 0 || unsigned(requested) == i) && properties.vendorID == vendor &&
                    (properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU ||
                     properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU)) { physical = devices[i]; break; }
            }
            if (!physical) throw std::runtime_error("No requested hardware Vulkan device");
            VkPhysicalDeviceFeatures available{};
            vkGetPhysicalDeviceFeatures(physical, &available);
            if (!available.shaderInt64 || !available.shaderFloat64)
                throw std::runtime_error("ADM test requires shaderInt64 and shaderFloat64");
            VkPhysicalDeviceFeatures features{}; features.shaderInt64 = features.shaderFloat64 = VK_TRUE;
            unsigned families = 0;
            vkGetPhysicalDeviceQueueFamilyProperties(physical, &families, nullptr);
            std::vector<VkQueueFamilyProperties> queues(families);
            vkGetPhysicalDeviceQueueFamilyProperties(physical, &families, queues.data());
            unsigned family = families;
            for (unsigned i = 0; i < families; ++i)
                if (queues[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { family = i; break; }
            if (family == families) throw std::runtime_error("No Vulkan compute queue");
            const float priority = 1;
            VkDeviceQueueCreateInfo queue_info{}; queue_info.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
            queue_info.queueFamilyIndex = family; queue_info.queueCount = 1; queue_info.pQueuePriorities = &priority;
            VkDeviceCreateInfo device_info{}; device_info.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
            device_info.queueCreateInfoCount = 1; device_info.pQueueCreateInfos = &queue_info;
            device_info.pEnabledFeatures = &features;
            check(vkCreateDevice(physical, &device_info, nullptr, &device), "create test device");
            vkGetDeviceQueue(device, family, 0, &queue);
            std::array<VkDescriptorSetLayoutBinding, 3> bindings{};
            for (unsigned i = 0; i < bindings.size(); ++i) {
                bindings[i].binding = i; bindings[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
                bindings[i].descriptorCount = 1; bindings[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
            }
            VkDescriptorSetLayoutCreateInfo set_info{}; set_info.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
            set_info.bindingCount = bindings.size(); set_info.pBindings = bindings.data();
            check(vkCreateDescriptorSetLayout(device, &set_info, nullptr, &set_layout), "create test bindings");
            VkPushConstantRange push{VK_SHADER_STAGE_COMPUTE_BIT, 0, 8 * sizeof(std::uint32_t)};
            VkPipelineLayoutCreateInfo layout_info{}; layout_info.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
            layout_info.setLayoutCount = 1; layout_info.pSetLayouts = &set_layout;
            layout_info.pushConstantRangeCount = 1; layout_info.pPushConstantRanges = &push;
            check(vkCreatePipelineLayout(device, &layout_info, nullptr, &layout), "create test layout");
            VkShaderModuleCreateInfo shader_info{}; shader_info.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
            shader_info.codeSize = sizeof(bitovp_vulkan_adm_reduce_test_spv); shader_info.pCode = bitovp_vulkan_adm_reduce_test_spv;
            VkShaderModule shader = VK_NULL_HANDLE;
            check(vkCreateShaderModule(device, &shader_info, nullptr, &shader), "create actual ADM shader");
            VkComputePipelineCreateInfo pipeline_info{}; pipeline_info.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
            pipeline_info.layout = layout; pipeline_info.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
            pipeline_info.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT; pipeline_info.stage.module = shader;
            pipeline_info.stage.pName = "main";
            const auto result = vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &pipeline_info, nullptr, &pipeline);
            vkDestroyShaderModule(device, shader, nullptr); check(result, "create actual ADM pipeline");
            VkDescriptorPoolSize pool_size{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 3};
            VkDescriptorPoolCreateInfo pool_info{}; pool_info.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
            pool_info.maxSets = 1; pool_info.poolSizeCount = 1; pool_info.pPoolSizes = &pool_size;
            check(vkCreateDescriptorPool(device, &pool_info, nullptr, &descriptors), "create test descriptors");
            VkDescriptorSetAllocateInfo set_allocate{}; set_allocate.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
            set_allocate.descriptorPool = descriptors; set_allocate.descriptorSetCount = 1; set_allocate.pSetLayouts = &set_layout;
            check(vkAllocateDescriptorSets(device, &set_allocate, &descriptor), "allocate test descriptors");
            VkCommandPoolCreateInfo command_info{}; command_info.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
            command_info.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT; command_info.queueFamilyIndex = family;
            check(vkCreateCommandPool(device, &command_info, nullptr, &commands), "create test command pool");
            VkCommandBufferAllocateInfo command_allocate{}; command_allocate.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
            command_allocate.commandPool = commands; command_allocate.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
            command_allocate.commandBufferCount = 1;
            check(vkAllocateCommandBuffers(device, &command_allocate, &command), "allocate test command buffer");
        } catch (...) { cleanup(); throw; }
    }
    ~Harness() { cleanup(); }
    Harness(const Harness &) = delete;
    Harness &operator=(const Harness &) = delete;

    void run(const bitovp::gpu::adm_reduce_test::Fixture &fixture) {
        const auto bytes = fixture.words.size() * sizeof(std::uint32_t);
        reserve(bytes);
        std::memcpy(mapped, fixture.words.data(), bytes);
        std::array<VkDescriptorBufferInfo, 3> buffers{};
        std::array<VkWriteDescriptorSet, 3> writes{};
        for (unsigned i = 0; i < buffers.size(); ++i) {
            buffers[i] = {buffer, 0, bytes};
            writes[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET; writes[i].dstSet = descriptor;
            writes[i].dstBinding = i; writes[i].descriptorCount = 1;
            writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; writes[i].pBufferInfo = &buffers[i];
        }
        vkUpdateDescriptorSets(device, writes.size(), writes.data(), 0, nullptr);
        check(vkResetCommandBuffer(command, 0), "reset test command");
        VkCommandBufferBeginInfo begin{}; begin.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
        check(vkBeginCommandBuffer(command, &begin), "begin test command");
        vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
        vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &descriptor, 0, nullptr);
        vkCmdPushConstants(command, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0,
                           sizeof(fixture.parameters), fixture.parameters.data());
        vkCmdDispatch(command, 1, 1, 1);
        VkMemoryBarrier barrier{}; barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;
        barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT; barrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
        vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_HOST_BIT,
                             0, 1, &barrier, 0, nullptr, 0, nullptr);
        check(vkEndCommandBuffer(command), "end test command");
        VkSubmitInfo submit{}; submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
        submit.commandBufferCount = 1; submit.pCommandBuffers = &command;
        check(vkQueueSubmit(queue, 1, &submit, VK_NULL_HANDLE), "submit ADM row stage");
        check(vkQueueWaitIdle(queue), "wait for ADM row stage");
        std::vector<std::uint32_t> actual(fixture.words.size());
        std::memcpy(actual.data(), mapped, bytes);
        fixture.verify(actual);
    }
};
}

int main(int argc, char **argv) {
    try {
        if (argc > 3) throw std::invalid_argument("Usage: vulkan_adm_reduce_test [device-index] [vendor-id]");
        Harness harness(argc > 1 ? std::stoi(argv[1]) : -1,
                        argc > 2 ? std::stoul(argv[2], nullptr, 0) : 0x1002);
        const auto count = bitovp::gpu::adm_reduce_test::cases([&](const auto &fixture) {
            harness.run(fixture);
        });
        std::cout << "PASS Vulkan exact integer ADM scale reduction: " << count << " empty/tail/overflow/ownership cases\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL vulkan_adm_reduce: " << error.what() << '\n';
        return 1;
    }
}

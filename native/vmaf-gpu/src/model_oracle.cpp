// SPDX-License-Identifier: MIT
#include "model_oracle.hpp"
#include "oracle/official_adapter.h"

#include <libvmaf/libvmaf.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <exception>
#include <iomanip>
#include <limits>
#include <locale>
#include <set>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace bitovp::gpu {
namespace {
void check(int error, const std::string &operation) {
    if (error) throw std::runtime_error(operation + " failed (libvmaf " +
                                      std::to_string(error) + ")");
}
void validate_text(const std::string &value, const char *field) {
    if (value.empty() || value.find('\0') != std::string::npos)
        throw std::invalid_argument(std::string(field) + " is empty or contains NUL");
}

struct PlanBuilder {
    FeaturePlan plan;
    ExtractorSpec current;
    std::exception_ptr failure;

    template <class F> int guard(F action) noexcept {
        try { action(); return 0; }
        catch (...) { failure = std::current_exception(); return -1; }
    }
    static int begin(void *cookie, const char *extractor) noexcept {
        auto &self = *static_cast<PlanBuilder *>(cookie);
        return self.guard([&] { self.current = {}; self.current.name = extractor; });
    }
    static int option(void *cookie, const char *key,
                      const BitovpOracleOption *value) noexcept {
        auto &self = *static_cast<PlanBuilder *>(cookie);
        return self.guard([&] {
            std::string text;
            switch (value->type) {
            case BITOVP_ORACLE_BOOL: text = value->integer_value ? "true" : "false"; break;
            case BITOVP_ORACLE_INT: text = std::to_string(value->integer_value); break;
            case BITOVP_ORACLE_DOUBLE: text = oracle_double_to_string(value->double_value); break;
            case BITOVP_ORACLE_STRING:
                // A null optional path (for example CAMBI heatmaps_path) is
                // represented as an empty string in the string-only plan.
                text = value->string_value ? value->string_value : "";
                break;
            }
            self.current.options.emplace(key, std::move(text));
        });
    }
    static int feature(void *cookie, const char *base, const char *canonical,
                       int required) noexcept {
        auto &self = *static_cast<PlanBuilder *>(cookie);
        return self.guard([&] {
            self.current.canonical_names.emplace(base, canonical);
            if (required) self.current.provided_features.emplace_back(canonical);
        });
    }
    static int end(void *cookie) noexcept {
        auto &self = *static_cast<PlanBuilder *>(cookie);
        return self.guard([&] {
            auto match = std::find_if(self.plan.extractors.begin(), self.plan.extractors.end(),
                [&](const ExtractorSpec &other) {
                    return other.name == self.current.name && other.options == self.current.options &&
                           other.canonical_names == self.current.canonical_names;
                });
            if (match == self.plan.extractors.end()) {
                self.plan.extractors.push_back(std::move(self.current));
            } else {
                for (const auto &name : self.current.provided_features)
                    if (std::find(match->provided_features.begin(), match->provided_features.end(), name) ==
                        match->provided_features.end()) match->provided_features.push_back(name);
            }
        });
    }
    void checked(int error) {
        if (failure) std::rethrow_exception(failure);
        check(error, "describe official model features");
    }
    inline static const BitovpOracleDescriptionCallbacks callbacks{begin, option, feature, end};
};

struct OwnedPicture {
    VmafPicture value{};
    explicit OwnedPicture(const Picture &source) {
        const auto &luma = source.planes[0];
        check(vmaf_picture_alloc(&value, VMAF_PIX_FMT_YUV420P, source.bit_depth,
                                 luma.width, luma.height), "allocate official CPU picture");
        const unsigned bytes = source.bit_depth > 8 ? 2 : 1;
        for (unsigned plane = 0; plane < 3; ++plane) {
            for (unsigned y = 0; y < value.h[plane]; ++y)
                std::memcpy(static_cast<unsigned char *>(value.data[plane]) +
                                y * value.stride[plane],
                            static_cast<const unsigned char *>(source.planes[plane].data) +
                                y * source.planes[plane].stride,
                            value.w[plane] * bytes);
        }
    }
    ~OwnedPicture() { if (value.ref) vmaf_picture_unref(&value); }
    OwnedPicture(const OwnedPicture &) = delete;
    OwnedPicture &operator=(const OwnedPicture &) = delete;
};
} // namespace

struct ModelOracle::Impl {
    ModelOracleConfig config;
    OracleMode mode;
    std::vector<std::pair<std::string, VmafModel *>> models;
    VmafContext *context = nullptr;
    FeaturePlan plan;
    std::set<std::string> required_names, allowed_names;
    std::map<std::pair<std::uint64_t, std::string>, double> imported;
    std::uint64_t submitted = 0;
    bool terminal = false;

    Impl(ModelOracleConfig configuration, OracleMode requested_mode)
        : config(configuration), mode(requested_mode) {}
    ~Impl() {
        // The collector borrows model pointers. Close it, including worker
        // threads and temporal state, before releasing any official model.
        if (context) vmaf_close(context);
        for (const auto &[id, model] : models) vmaf_model_destroy(model);
    }
    void active() const {
        if (terminal) throw std::logic_error("model oracle is already finished or failed");
    }
    void validate_picture(const Picture &picture) const {
        if (picture.memory != PictureMemory::Host || picture.cuda_ready_event)
            throw std::invalid_argument("official CPU extraction requires ready host pictures");
        if (picture.bit_depth != config.bit_depth)
            throw std::invalid_argument("picture bit depth differs from the feature plan");
        const std::size_t bytes = config.bit_depth > 8 ? 2 : 1;
        for (unsigned plane = 0; plane < 3; ++plane) {
            const auto &input = picture.planes[plane];
            const unsigned width = config.width >> (plane != 0);
            const unsigned height = config.height >> (plane != 0);
            if (!input.data || input.width != width || input.height != height ||
                input.stride < width * bytes ||
                input.stride > static_cast<std::size_t>(std::numeric_limits<std::ptrdiff_t>::max()) /
                                   height)
                throw std::invalid_argument("picture must contain three valid planar YUV420 strides");
            if (bytes == 2) {
                for (unsigned y = 0; y < height; ++y) {
                    const auto *row = static_cast<const unsigned char *>(input.data) + y * input.stride;
                    for (unsigned x = 0; x < width; ++x) {
                        std::uint16_t sample;
                        std::memcpy(&sample, row + x * 2, 2);
                        if (sample >= (1U << config.bit_depth))
                            throw std::invalid_argument("picture sample exceeds its declared bit depth");
                    }
                }
            }
        }
    }
};

ModelOracle::ModelOracle(std::vector<ModelInput> inputs, ModelOracleConfig config,
                         OracleMode mode, std::vector<FeatureInput> features)
    : impl_(std::make_unique<Impl>(config, mode)) {
    if (mode != OracleMode::Cpu && mode != OracleMode::ImportedFeatures)
        throw std::invalid_argument("unknown model oracle mode");
    if (!config.width || !config.height || (config.width & 1) || (config.height & 1) ||
        config.width > static_cast<unsigned>(std::numeric_limits<int>::max() - 64) ||
        config.height > static_cast<unsigned>(std::numeric_limits<int>::max()) ||
        (config.bit_depth != 8 && config.bit_depth != 10))
        throw std::invalid_argument("oracle needs an even-sized 8/10-bit YUV420 feature plan");
    const std::size_t aligned = (static_cast<std::size_t>(config.width) + 63) & ~std::size_t(63);
    if (aligned > std::numeric_limits<std::size_t>::max() / config.height / 4)
        throw std::invalid_argument("picture allocation size overflows");
    if (inputs.empty() && features.empty())
        throw std::invalid_argument("at least one official model or explicit feature is required");
    std::set<std::string> ids;
    PlanBuilder builder;
    builder.plan.width = config.width;
    builder.plan.height = config.height;
    builder.plan.bit_depth = config.bit_depth;
    for (const auto &input : inputs) {
        validate_text(input.id, "model ID");
        validate_text(input.path, "model path");
        if (!ids.insert(input.id).second) throw std::invalid_argument("duplicate model ID: " + input.id);
        VmafModelConfig model_config{};
        model_config.name = input.id.c_str();
        VmafModel *model = nullptr;
        const int load_error = vmaf_model_load_from_path(&model, &model_config, input.path.c_str());
        if (load_error) {
            // The pinned loader frees a partially built model on failure.
            check(load_error, "load official model " + input.id);
        }
        impl_->models.emplace_back(input.id, model);
        if (bitovp_oracle_model_requires_conversion(model))
            throw std::invalid_argument("model requests implicit picture conversion; supply a qualified "
                                        "preprocessed-input contract first: " + input.id);
        for (const auto &[extractor, options] : input.feature_overrides) {
            validate_text(extractor, "extractor override");
            std::vector<BitovpOracleKeyValue> dictionary;
            for (const auto &[key, value] : options) {
                validate_text(key, "option name");
                if (value.find('\0') != std::string::npos)
                    throw std::invalid_argument("option value contains NUL");
                dictionary.push_back({key.c_str(), value.c_str()});
            }
            check(bitovp_oracle_override_model(model, extractor.c_str(), dictionary.data(),
                                               dictionary.size()), "override official extractor " + extractor);
        }
        builder.checked(bitovp_oracle_describe_model(model, &PlanBuilder::callbacks, &builder));
    }
    for (const auto &feature : features) {
        validate_text(feature.name, "feature name");
        std::vector<BitovpOracleKeyValue> dictionary;
        for (const auto &[key, value] : feature.options) {
            validate_text(key, "option name");
            if (value.find('\0') != std::string::npos)
                throw std::invalid_argument("option value contains NUL");
            dictionary.push_back({key.c_str(), value.c_str()});
        }
        builder.checked(bitovp_oracle_describe_feature(feature.name.c_str(), dictionary.data(),
            dictionary.size(), &PlanBuilder::callbacks, &builder));
    }
    if (config.include_psnr)
        builder.checked(bitovp_oracle_describe_psnr(&PlanBuilder::callbacks, &builder));
    impl_->plan = std::move(builder.plan);
    for (auto &extractor : impl_->plan.extractors) {
        if (extractor.name == "speed_chroma") {
            std::istringstream input(extractor.options.at("speed_prescale"));
            input.imbue(std::locale::classic());
            double prescale = 0;
            input >> prescale;
            // Pinned speed.c: rounded chroma prescale, four decimations,
            // then 5x5 blocks. Its init currently discards the small-image
            // error, so reject before calling into the official extractor.
            const double scaled_width = config.width / 2 * prescale + 0.5;
            const double scaled_height = config.height / 2 * prescale + 0.5;
            if (!input || scaled_width < 80 || scaled_height < 80 ||
                scaled_width > std::numeric_limits<int>::max() ||
                scaled_height > std::numeric_limits<int>::max())
                throw std::invalid_argument("input is too small or too large for official SpEED chroma blocks");
        }
        std::sort(extractor.provided_features.begin(), extractor.provided_features.end());
        for (const auto &name : extractor.provided_features) impl_->required_names.insert(name);
        for (const auto &[base, canonical] : extractor.canonical_names) impl_->allowed_names.insert(canonical);
    }
    if (impl_->required_names.empty()) throw std::runtime_error("official model has no required features");
    for (const auto &id : ids)
        if (impl_->allowed_names.count(id))
            throw std::invalid_argument("model ID collides with a collector feature name: " + id);

    VmafConfiguration configuration{};
    configuration.log_level = VMAF_LOG_LEVEL_ERROR;
    configuration.n_threads = mode == OracleMode::Cpu ? config.cpu_threads : 0;
    configuration.n_subsample = 1;
    configuration.gpumask = 1; // The oracle must never select official CUDA extractors.
    VmafContext *context = nullptr;
    const int init_error = vmaf_init(&context, configuration);
    // vmaf_init frees its allocation on error without clearing the out-pointer.
    check(init_error, "initialize official CPU collector");
    impl_->context = context;
    if (mode == OracleMode::Cpu) {
        for (const auto &[id, model] : impl_->models)
            check(vmaf_use_features_from_model(context, model), "register official CPU model " + id);
        if (config.include_psnr)
            check(vmaf_use_feature(context, "psnr", nullptr), "register official CPU PSNR");
        for (const auto &feature : features) {
            VmafFeatureDictionary *dictionary = nullptr;
            try {
                for (const auto &[key, value] : feature.options)
                    check(vmaf_feature_dictionary_set(&dictionary, key.c_str(), value.c_str()),
                          "set official feature option " + key);
            } catch (...) {
                vmaf_feature_dictionary_free(&dictionary);
                throw;
            }
            // The extractor and option values were validated by the pinned
            // adapter before the public API takes ownership of its dictionary.
            check(vmaf_use_feature(context, feature.name.c_str(), dictionary),
                  "register official CPU feature " + feature.name);
        }
    }
}

ModelOracle::~ModelOracle() = default;
ModelOracle::ModelOracle(ModelOracle &&) noexcept = default;
ModelOracle &ModelOracle::operator=(ModelOracle &&) noexcept = default;

const FeaturePlan &ModelOracle::feature_plan() const {
    if (!impl_) throw std::logic_error("model oracle was moved");
    return impl_->plan;
}

void ModelOracle::submit(std::uint64_t index, const Picture &reference,
                         const Picture &distorted) {
    if (!impl_) throw std::logic_error("model oracle was moved");
    impl_->active();
    if (impl_->mode != OracleMode::Cpu) throw std::logic_error("import oracle cannot read pictures");
    if (index != impl_->submitted || index >= std::numeric_limits<unsigned>::max())
        throw std::invalid_argument("CPU frame indices must be contiguous and start at zero");
    impl_->validate_picture(reference);
    impl_->validate_picture(distorted);
    OwnedPicture ref(reference), dist(distorted);
    const int error = vmaf_read_pictures(impl_->context, &ref.value, &dist.value,
                                         static_cast<unsigned>(index));
    if (error) impl_->terminal = true;
    check(error, "extract official CPU frame " + std::to_string(index));
    ++impl_->submitted;
}

void ModelOracle::import_scores(const std::vector<FeatureScore> &scores) {
    if (!impl_) throw std::logic_error("model oracle was moved");
    impl_->active();
    if (impl_->mode != OracleMode::ImportedFeatures)
        throw std::logic_error("CPU oracle cannot import feature scores");
    std::set<std::pair<std::uint64_t, std::string>> batch;
    for (const auto &score : scores) {
        const auto key = std::make_pair(score.index, score.name);
        if (score.index >= std::numeric_limits<unsigned>::max() ||
            !impl_->allowed_names.count(score.name) || !std::isfinite(score.value) ||
            impl_->imported.count(key) || !batch.insert(key).second)
            throw std::invalid_argument("invalid, unknown or duplicate imported feature: " + score.name);
    }
    for (const auto &score : scores) {
        const int error = vmaf_import_feature_score(impl_->context, score.name.c_str(), score.value,
                                                    static_cast<unsigned>(score.index));
        if (error) impl_->terminal = true;
        check(error, "import official collector feature " + score.name);
        impl_->imported.emplace(std::make_pair(score.index, score.name), score.value);
    }
}

OracleResult ModelOracle::finish(std::uint64_t expected_frame_count) {
    if (!impl_) throw std::logic_error("model oracle was moved");
    impl_->active();
    impl_->terminal = true;
    if (!expected_frame_count || expected_frame_count > std::numeric_limits<unsigned>::max())
        throw std::invalid_argument("frame count must fit the official nonempty index interval");
    if (impl_->mode == OracleMode::Cpu) {
        if (impl_->submitted != expected_frame_count)
            throw std::invalid_argument("submitted CPU frame count differs from the expected count");
        check(vmaf_read_pictures(impl_->context, nullptr, nullptr, 0), "flush official temporal features");
    } else {
        for (const auto &[key, value] : impl_->imported)
            if (key.first >= expected_frame_count)
                throw std::invalid_argument("imported feature lies outside the final frame interval");
    }
    OracleResult result;
    result.frame_count = expected_frame_count;
    for (std::uint64_t index = 0; index < expected_frame_count; ++index) {
        for (const auto &name : impl_->required_names) {
            double value = 0;
            check(vmaf_feature_score_at_index(impl_->context, name.c_str(), &value,
                                               static_cast<unsigned>(index)),
                  "required feature " + name + " at frame " + std::to_string(index));
            if (!std::isfinite(value))
                throw std::runtime_error("non-finite required feature: " + name);
            result.features.push_back({index, name, value});
        }
    }
    for (const auto &[id, model] : impl_->models) {
        auto &values = result.model_scores[id];
        values.reserve(static_cast<std::size_t>(expected_frame_count));
        for (unsigned index = 0; index < expected_frame_count; ++index) {
            double value = 0;
            check(vmaf_score_at_index(impl_->context, model, &value, index), "predict official model " + id);
            if (!std::isfinite(value)) throw std::runtime_error("non-finite model prediction: " + id);
            values.push_back(value);
        }
        auto &pool = result.pooled[id];
        const std::pair<VmafPoolingMethod, double *> methods[]{
            {VMAF_POOL_METHOD_MIN, &pool.minimum}, {VMAF_POOL_METHOD_MAX, &pool.maximum},
            {VMAF_POOL_METHOD_MEAN, &pool.mean}, {VMAF_POOL_METHOD_HARMONIC_MEAN, &pool.harmonic_mean}};
        for (const auto &[method, value] : methods) {
            check(vmaf_score_pooled(impl_->context, model, method, value, 0,
                                     static_cast<unsigned>(expected_frame_count - 1)), "pool official model " + id);
            if (!std::isfinite(*value)) throw std::runtime_error("non-finite pooled score: " + id);
        }
    }
    return result;
}

std::string oracle_double_to_string(double value) {
    if (!std::isfinite(value)) throw std::invalid_argument("cannot serialize a non-finite oracle value");
    std::ostringstream output;
    output.imbue(std::locale::classic());
    output << std::setprecision(std::numeric_limits<double>::max_digits10) << value;
    return output.str();
}
} // namespace bitovp::gpu

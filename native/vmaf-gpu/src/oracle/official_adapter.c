// SPDX-License-Identifier: MIT
#include "official_adapter.h"

#include "dict.h"
#include "feature/feature_extractor.h"
#include "feature/feature_name.h"
#include "model.h"

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static const VmafOption *find_option(const VmafFeatureExtractor *extractor,
                                    const char *key)
{
    if (!extractor->options) return NULL;
    for (const VmafOption *option = extractor->options; option->name; ++option)
        if (!strcmp(option->name, key)) return option;
    return NULL;
}

static int validate_value(const VmafOption *option, const char *value)
{
    if (!option || !value) return -EINVAL;
    char *end = NULL;
    switch (option->type) {
    case VMAF_OPT_TYPE_BOOL:
        return strcmp(value, "true") && strcmp(value, "false") ? -EINVAL : 0;
    case VMAF_OPT_TYPE_INT: {
        errno = 0;
        long result = strtol(value, &end, 10);
        return errno || end == value || *end || result < INT_MIN || result > INT_MAX ||
               result < option->min || result > option->max ? -EINVAL : 0;
    }
    case VMAF_OPT_TYPE_DOUBLE: {
        errno = 0;
        double result = strtod(value, &end);
        return errno || end == value || *end || !isfinite(result) ||
               result < option->min || result > option->max ? -EINVAL : 0;
    }
    case VMAF_OPT_TYPE_STRING:
        return 0;
    }
    return -EINVAL;
}

static int describe(VmafFeatureExtractor *extractor, VmafDictionary *dictionary,
                    const char *required,
                    const struct BitovpOracleDescriptionCallbacks *callbacks,
                    void *cookie)
{
    if (!extractor || !extractor->provided_features) return -EINVAL;
    if (dictionary) {
        for (unsigned i = 0; i < dictionary->cnt; ++i) {
            const VmafDictionaryEntry *entry = &dictionary->entry[i];
            int err = validate_value(find_option(extractor, entry->key), entry->val);
            if (err) return err;
        }
    }
    VmafDictionary *copy = NULL;
    // A NULL dictionary means all official defaults, not a dictionary error.
    int err = dictionary ? vmaf_dictionary_copy(&dictionary, &copy) : 0;
    if (err) return err;
    VmafFeatureExtractorContext *context = NULL;
    err = vmaf_feature_extractor_context_create(&context, extractor, copy);
    if (err) {
        /* At this pinned revision allocation failure frees context without
         * clearing its out-pointer; option errors retain an owned context. */
        if (err == -ENOMEM) vmaf_dictionary_free(&copy);
        else if (context) vmaf_feature_extractor_context_destroy(context);
        return err;
    }

    err = callbacks->begin(cookie, context->fex->name);
    if (err) goto done;
    if (context->fex->options) {
        for (const VmafOption *option = context->fex->options; option->name; ++option) {
            const void *data = (const uint8_t *)context->fex->priv + option->offset;
            struct BitovpOracleOption value = {0};
            switch (option->type) {
            case VMAF_OPT_TYPE_BOOL:
                value.type = BITOVP_ORACLE_BOOL;
                value.integer_value = *(const bool *)data;
                break;
            case VMAF_OPT_TYPE_INT:
                value.type = BITOVP_ORACLE_INT;
                value.integer_value = *(const int *)data;
                break;
            case VMAF_OPT_TYPE_DOUBLE:
                value.type = BITOVP_ORACLE_DOUBLE;
                value.double_value = *(const double *)data;
                break;
            case VMAF_OPT_TYPE_STRING:
                value.type = BITOVP_ORACLE_STRING;
                value.string_value = *(const char *const *)data;
                break;
            }
            err = callbacks->option(cookie, option->name, &value);
            if (err) goto done;
        }
    }
    int found_required = !required;
    for (const char **feature = context->fex->provided_features; *feature; ++feature) {
        char *canonical = vmaf_feature_name_from_options(*feature,
            context->fex->options, context->fex->priv);
        if (!canonical) { err = -ENOMEM; goto done; }
        const int is_required = !required || !strcmp(required, *feature);
        found_required |= is_required;
        err = callbacks->feature(cookie, *feature, canonical, is_required);
        free(canonical);
        if (err) goto done;
    }
    if (!found_required) { err = -EINVAL; goto done; }
    err = callbacks->end(cookie);
done:
    vmaf_feature_extractor_context_destroy(context);
    return err;
}

int bitovp_oracle_model_requires_conversion(const VmafModel *model)
{
    return model ? model->conversion_target.enabled : -EINVAL;
}

int bitovp_oracle_describe_model(VmafModel *model,
    const struct BitovpOracleDescriptionCallbacks *callbacks, void *cookie)
{
    if (!model || !callbacks || !callbacks->begin || !callbacks->option ||
        !callbacks->feature || !callbacks->end) return -EINVAL;
    for (unsigned i = 0; i < model->n_features; ++i) {
        VmafFeatureExtractor *extractor = vmaf_get_feature_extractor_by_feature_name(
            model->feature[i].name, 0);
        int err = describe(extractor, model->feature[i].opts_dict,
                           model->feature[i].name, callbacks, cookie);
        if (err) return err;
    }
    return 0;
}

int bitovp_oracle_describe_psnr(
    const struct BitovpOracleDescriptionCallbacks *callbacks, void *cookie)
{
    return describe(vmaf_get_feature_extractor_by_name("psnr"), NULL, NULL,
                     callbacks, cookie);
}

int bitovp_oracle_describe_feature(const char *extractor_name,
    const struct BitovpOracleKeyValue *options, size_t option_count,
    const struct BitovpOracleDescriptionCallbacks *callbacks, void *cookie)
{
    if (!extractor_name || (!options && option_count) || !callbacks ||
        !callbacks->begin || !callbacks->option || !callbacks->feature || !callbacks->end)
        return -EINVAL;
    VmafFeatureExtractor *extractor = vmaf_get_feature_extractor_by_name(extractor_name);
    if (!extractor) return -EINVAL;
    VmafDictionary *dictionary = NULL;
    int err = 0;
    for (size_t i = 0; i < option_count; ++i) {
        err = validate_value(find_option(extractor, options[i].key), options[i].value);
        if (err) goto done;
        err = vmaf_dictionary_set(&dictionary, options[i].key, options[i].value, 0);
        if (err) goto done;
    }
    err = describe(extractor, dictionary, NULL, callbacks, cookie);
done:
    vmaf_dictionary_free(&dictionary);
    return err;
}

int bitovp_oracle_override_model(VmafModel *model, const char *extractor_name,
    const struct BitovpOracleKeyValue *options, size_t option_count)
{
    if (!model || !extractor_name || (!options && option_count)) return -EINVAL;
    VmafFeatureExtractor *extractor = NULL;
    for (unsigned i = 0; i < model->n_features; ++i) {
        VmafFeatureExtractor *candidate = vmaf_get_feature_extractor_by_feature_name(
            model->feature[i].name, 0);
        if (candidate && !strcmp(candidate->name, extractor_name)) {
            extractor = candidate;
            break;
        }
    }
    if (!extractor) return -EINVAL;
    VmafFeatureDictionary *dictionary = NULL;
    int err = 0;
    for (size_t i = 0; i < option_count; ++i) {
        err = validate_value(find_option(extractor, options[i].key), options[i].value);
        if (err) goto fail;
        err = vmaf_feature_dictionary_set(&dictionary, options[i].key, options[i].value);
        if (err) goto fail;
    }
    if (!dictionary) return 0;
    err = vmaf_model_feature_overload(model, extractor_name, dictionary);
    /* The pinned overload consumes dictionary on its normal path, but its
     * allocation-failure return precedes that cleanup. */
    if (err == -ENOMEM) vmaf_feature_dictionary_free(&dictionary);
    return err;
fail:
    vmaf_feature_dictionary_free(&dictionary);
    return err;
}

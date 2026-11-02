// SPDX-License-Identifier: MIT
#ifndef BITOVP_OFFICIAL_VMAF_ADAPTER_H
#define BITOVP_OFFICIAL_VMAF_ADAPTER_H

#include <libvmaf/model.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The only translation unit depending on libvmaf's private layout is the
 * accompanying C file, built against revision 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef.
 * Descriptors borrow their values only for the duration of each callback. */
enum BitovpOracleOptionType {
    BITOVP_ORACLE_BOOL, BITOVP_ORACLE_INT,
    BITOVP_ORACLE_DOUBLE, BITOVP_ORACLE_STRING
};
struct BitovpOracleOption {
    enum BitovpOracleOptionType type;
    int integer_value;
    double double_value;
    const char *string_value;
};
struct BitovpOracleDescriptionCallbacks {
    int (*begin)(void *cookie, const char *extractor);
    int (*option)(void *cookie, const char *key,
                  const struct BitovpOracleOption *value);
    int (*feature)(void *cookie, const char *base, const char *canonical,
                   int required);
    int (*end)(void *cookie);
};
struct BitovpOracleKeyValue { const char *key, *value; };

int bitovp_oracle_model_requires_conversion(const VmafModel *model);
int bitovp_oracle_describe_model(VmafModel *model,
    const struct BitovpOracleDescriptionCallbacks *callbacks, void *cookie);
int bitovp_oracle_describe_psnr(
    const struct BitovpOracleDescriptionCallbacks *callbacks, void *cookie);
/* Rejects unknown extractor/option keys rather than the official overload's
 * otherwise silent no-op. Values still pass through the official option parser. */
int bitovp_oracle_override_model(VmafModel *model, const char *extractor,
    const struct BitovpOracleKeyValue *options, size_t option_count);

#ifdef __cplusplus
}
#endif
#endif

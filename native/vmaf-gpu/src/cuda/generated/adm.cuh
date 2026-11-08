// Device adaptation of Netflix/vmaf 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef.
// Scalar pixel math runs on the GPU; no host extractor is invoked.
// See source-manifest.json for immutable original sources and hashes.
#pragma once
namespace bitovp::gpu::scalar_cuda::adm {
#ifndef FEATURE_ADM_H_
#define FEATURE_ADM_H_

#ifdef HAVE_BUILTIN_CLZ_COMPAT
#endif

#define div_lookup (active_arena()->division_lookup)
static const int32_t div_Q_factor = 1073741824; // 2^30

__device__ static inline void div_lookup_generator() {
    for (int i = 1; i <= 32768; ++i) {
        int32_t recip = (int32_t)(div_Q_factor / i);
        div_lookup[32768 + i] = recip;
        div_lookup[32768 - i] = 0 - recip;
    }
}

typedef struct adm_dwt_band_t {
    int16_t *band_a; /* Low-pass V + low-pass H. */
    int16_t *band_v; /* Low-pass V + high-pass H. */
    int16_t *band_h; /* High-pass V + low-pass H. */
    int16_t *band_d; /* High-pass V + high-pass H. */
} adm_dwt_band_t;

typedef struct i4_adm_dwt_band_t {
    int32_t *band_a; /* Low-pass V + low-pass H. */
    int32_t *band_v; /* Low-pass V + high-pass H. */
    int32_t *band_h; /* High-pass V + low-pass H. */
    int32_t *band_d; /* High-pass V + high-pass H. */
} i4_adm_dwt_band_t;

typedef struct AdmBuffer {
    size_t ind_size_x, ind_size_y; // strides size for intermidate buffers
    Pointer data_buf;   // buffer for adm intermidiate data calculations
    Pointer tmp_ref;    // buffer for adm intermidiate data calculations
    Pointer buf_x_orig; // buffer for storing imgcoeff values along x.
    Pointer buf_y_orig; // buffer for storing imgcoeff values along y.
    int *ind_y[4], *ind_x[4];

    adm_dwt_band_t ref_dwt2;
    adm_dwt_band_t dis_dwt2;
    adm_dwt_band_t decouple_r;
    adm_dwt_band_t decouple_a;
    adm_dwt_band_t csf_a;
    adm_dwt_band_t csf_f;

    i4_adm_dwt_band_t i4_ref_dwt2;
    i4_adm_dwt_band_t i4_dis_dwt2;
    i4_adm_dwt_band_t i4_decouple_r;
    i4_adm_dwt_band_t i4_decouple_a;
    i4_adm_dwt_band_t i4_csf_a;
    i4_adm_dwt_band_t i4_csf_f;
} AdmBuffer;

#ifndef NUM_BUFS_ADM
#define NUM_BUFS_ADM 30
#endif

__device__ int adm_buffer_alloc(AdmBuffer *buf, int w, int h);
__device__ void adm_buffer_free(AdmBuffer *buf);
__device__ void dwt2_src_indices_filt(int **src_ind_y, int **src_ind_x, int w, int h);

__device__ void adm_dwt2_8(const uint8_t *src, const adm_dwt_band_t *dst,
                 AdmBuffer *buf, int w, int h, int src_stride, int dst_stride);

__device__ void adm_dwt2_16(const uint16_t *src, const adm_dwt_band_t *dst,
                  AdmBuffer *buf, int w, int h, int src_stride,
                  int dst_stride, int inp_size_bits);

__device__ void adm_decouple(AdmBuffer *buf, int w, int h, int stride,
                   double adm_enhn_gain_limit, int32_t *adm_div_lookup);

__device__ void adm_csf(AdmBuffer *buf, int w, int h, int stride,
             double adm_norm_view_dist, int adm_ref_display_height,
             int adm_csf_mode, double adm_csf_scale,
             double adm_csf_diag_scale, bool measure_aim);

__device__ float adm_cm(AdmBuffer *buf, int w, int h, int src_stride, int csf_a_stride,
             double adm_norm_view_dist, int adm_ref_display_height,
             int adm_csf_mode, double adm_csf_scale,
             double adm_csf_diag_scale, double adm_noise_weight,
             bool measure_aim);

__device__ void adm_decouple_s123(AdmBuffer *buf, int w, int h, int stride,
                        double adm_enhn_gain_limit, int32_t *adm_div_lookup);

__device__ void adm_dwt2_s123_combined(const int32_t *i4_ref_scale,
                             const int32_t *i4_curr_dis, AdmBuffer *buf,
                             int w, int h, int ref_stride, int dis_stride,
                             int dst_stride, int scale);

__device__ void i4_adm_csf(AdmBuffer *buf, int scale, int w, int h, int stride,
                 double adm_norm_view_dist, int adm_ref_display_height,
                 int adm_csf_mode, double adm_csf_scale,
                 double adm_csf_diag_scale, bool measure_aim);

__device__ float i4_adm_cm(AdmBuffer *buf, int w, int h, int src_stride,
                 int csf_a_stride, int scale, double adm_norm_view_dist,
                 int adm_ref_display_height, int adm_csf_mode,
                 double adm_csf_scale, double adm_csf_diag_scale,
                 double adm_noise_weight, bool measure_aim);

__device__ float adm_csf_den_scale(const adm_dwt_band_t *src, int w, int h,
                         int src_stride, double adm_norm_view_dist,
                         int adm_ref_display_height, int adm_csf_mode,
                         double adm_csf_scale, double adm_csf_diag_scale,
                         double adm_noise_weight);

__device__ float adm_csf_den_s123(const i4_adm_dwt_band_t *src, int scale, int w, int h,
                        int src_stride, double adm_norm_view_dist,
                        int adm_ref_display_height, int adm_csf_mode,
                        double adm_csf_scale, double adm_csf_diag_scale,
                        double adm_noise_weight);

/* Enhancement gain imposed on adm, must be >= 1.0, where 1.0 means the gain is completely disabled */
#ifndef DEFAULT_ADM_ENHN_GAIN_LIMIT
#define DEFAULT_ADM_ENHN_GAIN_LIMIT (100.0)
#endif // !DEFAULT_ADM_ENHN_GAIN_LIMIT

#ifndef DEFAULT_ADM_NORM_VIEW_DIST
#define DEFAULT_ADM_NORM_VIEW_DIST (3.0)
#endif // !DEFAULT_ADM_NORM_VIEW_DIST

#ifndef DEFAULT_ADM_REF_DISPLAY_HEIGHT
#define DEFAULT_ADM_REF_DISPLAY_HEIGHT (1080)
#endif // !DEFAULT_ADM_REF_DISPLAY_HEIGHT

#ifndef ADM_BORDER_FACTOR
#define ADM_BORDER_FACTOR (0.1)
#endif // !ADM_BORDER_FACTOR

/* noise multiplicative weight */
#ifndef DEFAULT_ADM_NOISE_WEIGHT
#define DEFAULT_ADM_NOISE_WEIGHT (0.03125)
#endif // !DEFAULT_ADM_NOISE_WEIGHT

/* CSF scale factor */
#ifndef DEFAULT_ADM_CSF_SCALE
#define DEFAULT_ADM_CSF_SCALE (1.0)
#endif // !DEFAULT_ADM_CSF_SCALE

/* CSF diagonal scale factor */
#ifndef DEFAULT_ADM_CSF_DIAG_SCALE
#define DEFAULT_ADM_CSF_DIAG_SCALE (1.0)
#endif // !DEFAULT_ADM_CSF_DIAG_SCALE

/* Default minimum value allowed for the feature */
#ifndef DEFAULT_ADM_MIN_VAL
#define DEFAULT_ADM_MIN_VAL (0.0)
#endif // !DEFAULT_ADM_MIN_VAL

/* Contrast sensitivity function */
enum ADM_CSF_MODE {
    ADM_CSF_MODE_WATSON97 = 0,
    ADM_CSF_MODE_BARTEN = 1,
    ADM_CSF_MODE_BARTEN_WATSON_BLEND = 2,
    ADM_CSF_MODE_BARTEN_WATSON_BLEND_MAE = 3,
};

/* Default contrast sensitivity function */
#ifndef DEFAULT_ADM_CSF_MODE
#define DEFAULT_ADM_CSF_MODE (ADM_CSF_MODE_WATSON97)
#endif // !DEFAULT_ADM_CSF_MODE

/* Default luminance level (in cd/m2) for contrast sensitivity function calculation */
#ifndef DEFAULT_ADM_CSF_LUM
#define DEFAULT_ADM_CSF_LUM (100.0)
#endif // !DEFAULT_ADM_CSF_LUM

#define DIVS(n, d) ((n) / (d))

static __device__ const int16_t dwt2_db2_coeffs_lo[10] = {15826, 27411, 7345, -4240};
static __device__ const int16_t dwt2_db2_coeffs_hi[10] = {-4240, -7345, 27411, -15826};

static const int32_t dwt2_db2_coeffs_lo_sum = 46342;
static const int32_t dwt2_db2_coeffs_hi_sum = 0;

#ifndef ONE_BY_15
#define ONE_BY_15 8738
#endif

#ifndef I4_ONE_BY_15
#define I4_ONE_BY_15 286331153
#endif

/* ================= */
/* Noise floor model */
/* ================= */

/*
 * The following dwt visibility threshold parameters are taken from
 * "Visibility of Wavelet Quantization Noise"
 * by A. B. Watson, G. Y. Yang, J. A. Solomon and J. Villasenor
 * IEEE Trans. on Image Processing, Vol. 6, No 8, Aug. 1997
 * Page 1170, formula (7) and corresponding Table IV
 * Table IV has 2 entries for Cb and Cr thresholds
 * Chose those corresponding to subject "sfl" since they are lower
 * These thresholds were obtained and modeled for the 7-9 biorthogonal wavelet
 * basis
 */

/*
 * The following dwt visibility threshold parameters are taken from
 * "Visibility of Wavelet Quantization Noise"
 * by A. B. Watson, G. Y. Yang, J. A. Solomon and J. Villasenor
 * IEEE Trans. on Image Processing, Vol. 6, No 8, Aug. 1997
 * Page 1170, formula (7) and corresponding Table IV
 * Table IV has 2 entries for Cb and Cr thresholds
 * Chose those corresponding to subject "sfl" since they are lower
 * These thresholds were obtained and modeled for the 7-9 biorthogonal wavelet
 * basis
 */
struct dwt_model_params {
    float a;
    float k;
    float f0;
    float g[4];
};

// 0 -> Y, 1 -> Cb, 2 -> Cr
static __device__ const struct dwt_model_params dwt_7_9_YCbCr_threshold[3] = {
    {0.495f, 0.466f, 0.401f, {1.501f, 1.0f, 0.534f, 1.0f}},
    {1.633f, 0.353f, 0.209f, {1.520f, 1.0f, 0.502f, 1.0f}},
    {0.944f, 0.521f, 0.404f, {1.868f, 1.0f, 0.516f, 1.0f}}
};

/*
 * The following dwt basis function amplitudes, A(lambda,theta), are taken from
 * "Visibility of Wavelet Quantization Noise"
 * by A. B. Watson, G. Y. Yang, J. A. Solomon and J. Villasenor
 * IEEE Trans. on Image Processing, Vol. 6, No 8, Aug. 1997
 * Page 1172, Table V
 * The table has been transposed, i.e. it can be used directly to obtain
 * A[lambda][theta]
 * These amplitudes were calculated for the 7-9 biorthogonal wavelet basis
 */
static __device__ const float dwt_7_9_basis_function_amplitudes[6][4] = {
    {0.62171, 0.67234, 0.72709, 0.67234},
    {0.34537, 0.41317, 0.49428, 0.41317},
    {0.18004, 0.22727, 0.28688, 0.22727},
    {0.091401, 0.11792, 0.15214, 0.11792},
    {0.045943, 0.059758, 0.077727, 0.059758},
    {0.023013, 0.030018, 0.039156, 0.030018}};

#endif /* _FEATURE_ADM_H_ */

/**
 *
 *  Copyright 2016-2023 Netflix, Inc.
 *
 *     Licensed under the BSD+Patent License (the "License");
 *     you may not use this file except in compliance with the License.
 *     You may obtain a copy of the License at
 *
 *         https://opensource.org/licenses/BSDplusPatent
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 *
 */

#pragma once

#ifndef BARTEN_CSF_TOOLS_H_
#define BARTEN_CSF_TOOLS_H_

__device__ static float linear_interpolate(float left_position, float left_value,
                                float right_position, float right_value,
                                float sample_position) {
    return left_value + ((right_value - left_value) / (right_position - left_position)) * (sample_position - left_position);
}

/*
 * There were 6 luminance levels (in cd/m2) that were measured in the CSF experiments of HDR-VDP2
 * Note: HDR-VDP2 paper has 5 levels, but version 2.2.1 was updated with data for 6 levels:
 * 0.002, 0.02, 0.2, 2, 20, 150
 */
static __device__ const float barten_csf_param_anchors[6] = { 0.002, 0.02, 0.2, 2, 20, 150 };

static __device__ const float barten_csf_params[6][5] = {
    { 0.0160737, 0.991265, 3.74038, 0.50722, 4.46044  },
    { 0.383873, 0.800889, 3.54104, 0.682505, 4.94958  },
    { 0.929301, 0.476505, 4.37453, 0.750315, 5.28678  },
    { 1.29776, 0.405782, 4.40602, 0.935314, 5.61425  },
    { 1.49222, 0.334278, 3.79542, 1.07327, 6.4635 },
    { 1.46213, 0.394533, 2.7755, 1.16577, 7.45665 }
};

static __device__ const float barten_csf_sa[4] = { 30.162, 4.0627, 1.6596, 0.2712 };
static __device__ const float barten_mtf_params_a[4] = { 0.424838596301290, 0.572435103936480, 0.000167576239164937, 0.00255872352306433 };
static __device__ const float barten_mtf_params_b[4] = { 0.028, 0.37, 37, 360 };

/* Luminance-dependent component of Barten's CSF */
__device__ static float barten_rod_cone_sens(float luminance_level)
{
    float cvi_sens_drop = barten_csf_sa[1];  // p6 in the paper
    float cvi_trans_slope = barten_csf_sa[2];  // p7 in the paper
    float cvi_low_slope = barten_csf_sa[3];  // p8 in the paper
    return barten_csf_sa[0] * pow(pow(cvi_sens_drop / luminance_level, cvi_trans_slope) + 1, - cvi_low_slope);
}

/*  MTF portion of Barten's CSF */
__device__ static float barten_mtf(float spatial_frequency)
{
    float mtf = 0.0;
    for (int i = 0; i <= 3; i++)
        mtf = mtf + barten_mtf_params_a[i] * exp(- barten_mtf_params_b[i] * spatial_frequency);
    return mtf;
}

#define CLAMP(x, low, high) (((x) > (high)) ? (high) : (((x) < (low)) ? (low) : (x)))

/*
 * Simplified version of Barten's CSF used in HDR-VDP2 (ported from Matlab version HDR-VDP 2.2.1)
 * HDR-VDP-2: A calibrated visual metric for visibility and quality predictions in all luminance conditions
 * ACM Transactions on Graphics, Volume 30, Issue 4, July 2011, Article No.: 40, pp 1–14
 * Rafal Mantiuk, Kil Joong Kim, Allan G. Rempel, Wolfgang Heidrich
 */
__device__ static FORCE_INLINE inline float barten_csf(int lambda, double adm_norm_view_dist,
                                            int adm_ref_display_height, double adm_csf_lum_level, double adm_csf_scale)
{
    /* This is the display visual resolution (DVR), in pixels/degree of visual angle. It should be ~56.55. */
    float r = adm_norm_view_dist * adm_ref_display_height * M_PI / 180.0;
    /* This is the nominal spatial frequency for each DWT level; first level (level = 0) is half of the DVR. */
    float spatial_frequency = r / pow(2, lambda + 1);

    double clamped_lum = CLAMP(adm_csf_lum_level, barten_csf_param_anchors[0], barten_csf_param_anchors[5]);

    int left_lum_index = 0, right_lum_index = 0;
    int i = 0;
    while (i < 5) {
        if (clamped_lum >= barten_csf_param_anchors[i] && clamped_lum <= barten_csf_param_anchors[i + 1]) {
            left_lum_index = i;
            right_lum_index = i + 1;
            break;
        }
        i++;
    }

    float left_lum = barten_csf_param_anchors[left_lum_index];
    float right_lum = barten_csf_param_anchors[right_lum_index];

    float left_position = log10(left_lum);
    float right_position = log10(right_lum);
    float sample_position = log10(clamped_lum);

    float p_0 = linear_interpolate(left_position, barten_csf_params[left_lum_index][1], right_position,
                                   barten_csf_params[right_lum_index][1], sample_position);
    float p_1 = linear_interpolate(left_position, barten_csf_params[left_lum_index][2], right_position,
                                   barten_csf_params[right_lum_index][2], sample_position);
    float p_2 = linear_interpolate(left_position, barten_csf_params[left_lum_index][3], right_position,
                                   barten_csf_params[right_lum_index][3], sample_position);
    float p_3 = linear_interpolate(left_position, barten_csf_params[left_lum_index][4], right_position,
                                   barten_csf_params[right_lum_index][4], sample_position);

    // these values can be derived by the matlab code:
    // metric_par = hdrvdp_parse_options({})
    // hdrvdp_ncsf(rho, lum, metric_par); (any rho works)
    float a = 1.0f + pow(p_0 * spatial_frequency, p_1);
    float b = 1.0f / pow(1 - exp(- pow(spatial_frequency / 7, 2)), p_2);

    /* neural contrast sensitivity function */
    float csf = p_3 / pow(a * b, 0.5);

    /* return entire CSF */
    return csf * barten_mtf(spatial_frequency) * barten_rod_cone_sens(adm_csf_lum_level) * adm_csf_scale;
}

static __device__ const float BLENDED_CSF_1080_3H[2][4] = {
    {0.01183, 0.025026, 0.04295, 0.058621},
    {0.004302, 0.011778, 0.023918, 0.035901}
};

static __device__ const float BLENDED_CSF_1080_5H[2][4] = {
    {0.004212, 0.014809, 0.029642, 0.047464},
    {0.000984, 0.005852, 0.0146, 0.027574}
};

static __device__ const float BLENDED_CSF_2160_3H[2][4] = {
    {0.00226, 0.01183, 0.025026, 0.04295},
    {0.000479, 0.004302, 0.011778, 0.023918}
};

static __device__ const float BLENDED_CSF_2160_5H[2][4] = {
    {0.000092, 0.004212, 0.014809, 0.029642},
    {0.000050, 0.000984, 0.005852, 0.0146}
};

static __device__ const float BLENDED_CSF_720_3H[2][4] = {
    {0.018715, 0.035637, 0.052798, 0.061509},
    {0.007999, 0.018396, 0.031851, 0.037718}
};

static __device__ const float BLENDED_CSF_720_5H[2][4] = {
    {0.010144, 0.022561, 0.040309, 0.05672},
    {0.003463, 0.010282, 0.021839, 0.034641}
};

static __device__ const float BLENDED_CSF_480_3H[2][4] = {
    {0.027961, 0.045875, 0.060275, 0.056234},
    {0.013572, 0.026277, 0.036959, 0.034511}
};

static __device__ const float BLENDED_CSF_480_5H[2][4] = {
    {0.016781, 0.032822, 0.05032, 0.061594},
    {0.00691, 0.016545, 0.029917, 0.037777}
};

/* 
 * BLENDED_CSF coefficient arrays for v1.0.17+ models (with CSF bug fix)
 * These coefficients incorporate the L1 optimization scaling parameter fix
 */
static __device__ const float BLENDED_CSF_1080_3H_MAE[2][4] = {
    {0.011249, 0.022606, 0.035930, 0.045673},
    {0.004097, 0.010921, 0.021430, 0.031313}
};

static __device__ const float BLENDED_CSF_1080_5H_MAE[2][4] = {
    {0.004052, 0.013939, 0.026298, 0.038833},
    {0.000927, 0.005544, 0.013415, 0.024515}
};

static __device__ const float BLENDED_CSF_2160_3H_MAE[2][4] = {
    {0.002166, 0.011249, 0.022606, 0.035930},
    {0.000447, 0.004097, 0.010921, 0.021430}
};

static __device__ const float BLENDED_CSF_2160_5H_MAE[2][4] = {
    {0.000077, 0.004052, 0.013939, 0.026298},
    {0.000045, 0.000927, 0.005544, 0.013415}
};

static __device__ const float BLENDED_CSF_720_3H_MAE[2][4] = {
    {0.017329, 0.030870, 0.042134, 0.047410},
    {0.007509, 0.016707, 0.028072, 0.032722}
};

static __device__ const float BLENDED_CSF_720_5H_MAE[2][4] = {
    {0.009689, 0.020577, 0.034162, 0.044523},
    {0.003302, 0.009579, 0.019661, 0.030318}
};

static __device__ const float BLENDED_CSF_480_3H_MAE[2][4] = {
    {0.024969, 0.037825, 0.046676, 0.043974},
    {0.012511, 0.023424, 0.032139, 0.030166}
};

static __device__ const float BLENDED_CSF_480_5H_MAE[2][4] = {
    {0.015665, 0.028766, 0.040612, 0.047483},
    {0.006514, 0.015107, 0.026476, 0.032776}
};

/*
 * CSF function with CSF bug fix
 * Uses the corrected L1 optimization 
 */
__device__ static FORCE_INLINE inline float barten_watson_blend_csf_mae(int scale, int theta, double adm_norm_view_dist,
                                                                  int adm_ref_display_height) {
    if (adm_ref_display_height == 1080 && adm_norm_view_dist == 3.0) {
        return BLENDED_CSF_1080_3H_MAE[theta][scale];
    } else if (adm_ref_display_height == 1080 && adm_norm_view_dist == 5.0) {
        return BLENDED_CSF_1080_5H_MAE[theta][scale];
    } else if (adm_ref_display_height == 2160 && adm_norm_view_dist == 1.5) {
        // 2160@1.5H has the same PPD as 1080@3H (1.5*2160 == 3.0*1080 == 56.55 ppd)
        return BLENDED_CSF_1080_3H_MAE[theta][scale];
    } else if (adm_ref_display_height == 2160 && adm_norm_view_dist == 3.0) {
        return BLENDED_CSF_2160_3H_MAE[theta][scale];
    } else if (adm_ref_display_height == 2160 && adm_norm_view_dist == 5.0) {
        return BLENDED_CSF_2160_5H_MAE[theta][scale];
    } else if (adm_ref_display_height == 720 && adm_norm_view_dist == 3.0) {
        return BLENDED_CSF_720_3H_MAE[theta][scale];
    } else if (adm_ref_display_height == 720 && adm_norm_view_dist == 5.0) {
        return BLENDED_CSF_720_5H_MAE[theta][scale];
    } else if (adm_ref_display_height == 480 && adm_norm_view_dist == 3.0) {
        return BLENDED_CSF_480_3H_MAE[theta][scale];
    } else if (adm_ref_display_height == 480 && adm_norm_view_dist == 5.0) {
        return BLENDED_CSF_480_5H_MAE[theta][scale];
    } else {
        return -EINVAL;
    }
}

/*
 * Legacy Blended CSF function (backward compatibility)
 * Always uses legacy coefficients for existing models
 */
__device__ static FORCE_INLINE inline float barten_watson_blend_csf(int scale, int theta, double adm_norm_view_dist,
                                                         int adm_ref_display_height) {
    if (adm_ref_display_height == 1080 && adm_norm_view_dist == 3.0) {
        return BLENDED_CSF_1080_3H[theta][scale];
    } else if (adm_ref_display_height == 1080 && adm_norm_view_dist == 5.0) {
        return BLENDED_CSF_1080_5H[theta][scale];
    } else if (adm_ref_display_height == 2160 && adm_norm_view_dist == 1.5) {
        // 2160@1.5H has the same PPD as 1080@3H (1.5*2160 == 3.0*1080 == 56.55 ppd)
        return BLENDED_CSF_1080_3H[theta][scale];
    } else if (adm_ref_display_height == 2160 && adm_norm_view_dist == 3.0) {
        return BLENDED_CSF_2160_3H[theta][scale];
    } else if (adm_ref_display_height == 2160 && adm_norm_view_dist == 5.0) {
        return BLENDED_CSF_2160_5H[theta][scale];
    } else if (adm_ref_display_height == 720 && adm_norm_view_dist == 3.0) {
        return BLENDED_CSF_720_3H[theta][scale];
    } else if (adm_ref_display_height == 720 && adm_norm_view_dist == 5.0) {
        return BLENDED_CSF_720_5H[theta][scale];
    } else if (adm_ref_display_height == 480 && adm_norm_view_dist == 3.0) {
        return BLENDED_CSF_480_3H[theta][scale];
    } else if (adm_ref_display_height == 480 && adm_norm_view_dist == 5.0) {
        return BLENDED_CSF_480_5H[theta][scale];
    } else {
        return -EINVAL;
    }
}

#endif /* BARTEN_CSF_TOOLS_H_ */

/**
 *
 *  Copyright 2016-2020 Netflix, Inc.
 *
 *     Licensed under the BSD+Patent License (the "License");
 *     you may not use this file except in compliance with the License.
 *     You may obtain a copy of the License at
 *
 *         https://opensource.org/licenses/BSDplusPatent
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 *
 */

#if ARCH_X86
#if HAVE_AVX512
#endif
#elif ARCH_AARCH64
#endif
#undef MAX

#define MAX(x, y) (((x) > (y)) ? (x) : (y))

typedef struct AdmState {
    AdmBuffer buf;
    bool debug;
    bool adm_skip_aim;
    bool adm_skip_scale0;
    double adm_csf_diag_scale;
    double adm_csf_scale;
    double adm_dlm_weight;
    double adm_enhn_gain_limit;
    double adm_norm_view_dist;
    double adm_norm_view_dist_extra;
    double adm_noise_weight;
    double adm_min_val;
    int adm_ref_display_height;
    int adm_csf_mode;
    void (*dwt2_8)(const uint8_t *src, const adm_dwt_band_t *dst,
                   AdmBuffer *buf, int w, int h, int src_stride,
                   int dst_stride);
    void (*dwt2_16)(const uint16_t *src, const adm_dwt_band_t *dst,
                    AdmBuffer *buf, int w, int h, int src_stride,
                    int dst_stride, int inp_size_bits);
    void (*adm_decouple)(AdmBuffer *buf, int w, int h, int stride,
                         double adm_enhn_gain_limit,
                         int32_t *adm_div_lookup);
    void (*adm_decouple_s123)(AdmBuffer *buf, int w, int h, int stride,
                              double adm_enhn_gain_limit,
                              int32_t *adm_div_lookup);
    float (*adm_csf_den_scale)(const adm_dwt_band_t *src, int w, int h,
                               int src_stride, double adm_norm_view_dist,
                               int adm_ref_display_height,
                               int adm_csf_mode, double adm_csf_scale,
                               double adm_csf_diag_scale,
                               double adm_noise_weight);
    void (*adm_csf)(AdmBuffer *buf, int w, int h, int stride,
                    double adm_norm_view_dist, int adm_ref_display_height,
                    int adm_csf_mode, double adm_csf_scale,
                    double adm_csf_diag_scale, bool measure_aim);
    float (*adm_cm)(AdmBuffer *buf, int w, int h, int src_stride, int csf_a_stride,
                    double adm_norm_view_dist, int adm_ref_display_height,
                    int adm_csf_mode, double adm_csf_scale,
                    double adm_csf_diag_scale, double adm_noise_weight,
                    bool measure_aim);
    void (*adm_dwt2_s123_combined)(const int32_t *i4_ref_scale, const int32_t *i4_curr_dis,
                                   AdmBuffer *buf, int w, int h, int ref_stride,
                                   int dis_stride, int dst_stride, int scale);
    float (*adm_csf_den_s123)(const i4_adm_dwt_band_t *src, int scale, int w, int h,
                              int src_stride, double adm_norm_view_dist,
                              int adm_ref_display_height,
                              int adm_csf_mode, double adm_csf_scale,
                              double adm_csf_diag_scale,
                              double adm_noise_weight);
    void (*i4_adm_csf)(AdmBuffer *buf, int scale, int w, int h, int stride,
                       double adm_norm_view_dist, int adm_ref_display_height,
                       int adm_csf_mode, double adm_csf_scale,
                       double adm_csf_diag_scale, bool measure_aim);
    float (*i4_adm_cm)(AdmBuffer *buf, int w, int h, int src_stride,
                       int csf_a_stride, int scale, double adm_norm_view_dist,
                       int adm_ref_display_height,
                       int adm_csf_mode, double adm_csf_scale,
                       double adm_csf_diag_scale, double adm_noise_weight,
                       bool measure_aim);
    VmafDictionary *feature_name_dict;
    // secondary feature-name dictionary, rendered as if adm_norm_view_dist ==
    // adm_norm_view_dist_extra; used to register the secondary viewing-distance
    // scores under the exact names a second model (at that viewing distance)
    // looks up. Only allocated when adm_norm_view_dist_extra > 0.
    VmafDictionary *feature_name_dict_extra;
} AdmState;



/*
 * lambda = 0 (finest scale), 1, 2, 3 (coarsest scale);
 * theta = 0 (ll), 1 (lh - vertical), 2 (hh - diagonal), 3(hl - horizontal).
 */
__device__ static inline float
dwt_quant_step(const struct dwt_model_params *params, int lambda, int theta,
        double adm_norm_view_dist, int adm_ref_display_height)
{
    // Formula (1), page 1165 - display visual resolution (DVR), in pixels/degree
    // of visual angle. This should be 56.55
    float r = adm_norm_view_dist * adm_ref_display_height * M_PI / 180.0;

    // Formula (9), page 1171
    float temp = log10(pow(2.0, lambda + 1)*params->f0*params->g[theta] / r);
    float Q = 2.0*params->a*pow(10.0, params->k*temp*temp) /
        dwt_7_9_basis_function_amplitudes[lambda][theta];

    return Q;
}

// i = 0, j = 0: indices y: 1,0,1, x: 1,0,1  for Fixed-point
#define ADM_CM_THRESH_S_0_0(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t sum = 0; \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		sum += flt_ptr[src_stride + 1]; \
		sum += flt_ptr[src_stride]; \
		sum += flt_ptr[src_stride + 1]; \
		sum += flt_ptr[1]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[0]))+ 2048)>>12);\
		sum += flt_ptr[1]; \
		sum += flt_ptr[src_stride + 1]; \
		sum += flt_ptr[src_stride]; \
		sum += flt_ptr[src_stride + 1]; \
		*accum += sum; \
	} \
}

// i = 0, j = w-1: indices y: 1,0,1, x: w-2, w-1, w-1
#define ADM_CM_THRESH_S_0_W_M_1(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		sum += flt_ptr[src_stride + w - 2]; \
		sum += flt_ptr[src_stride + w - 1]; \
		sum += flt_ptr[src_stride + w - 1]; \
		sum += flt_ptr[w - 2]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[w - 1]))+ 2048)>>12);\
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[src_stride + w - 2]; \
		sum += flt_ptr[src_stride + w - 1]; \
		sum += flt_ptr[src_stride + w - 1]; \
		*accum += sum; \
	} \
}

// i = 0, j = 1, ..., w-2: indices y: 1,0,1, x: j-1,j,j+1
#define ADM_CM_THRESH_S_0_J(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t sum = 0; \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		sum += flt_ptr[src_stride + j - 1]; \
		sum += flt_ptr[src_stride + j]; \
		sum += flt_ptr[src_stride + j + 1]; \
		sum += flt_ptr[j - 1]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[j]))+ 2048)>>12);\
		sum += flt_ptr[j + 1]; \
		sum += flt_ptr[src_stride + j - 1]; \
		sum += flt_ptr[src_stride + j]; \
		sum += flt_ptr[src_stride + j + 1];  \
		*accum += sum; \
	} \
}

// i = h-1, j = 0: indices y: h-2,h-1,h-1, x: 1,0,1
#define ADM_CM_THRESH_S_H_M_1_0(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t sum = 0; \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		src_ptr += (src_stride * (h - 2)); \
		flt_ptr += (src_stride * (h - 2)); \
		sum += flt_ptr[1]; \
		sum += flt_ptr[0]; \
		sum += flt_ptr[1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[1]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[0]))+ 2048)>>12);\
		sum += flt_ptr[1]; \
		sum += flt_ptr[1]; \
		sum += flt_ptr[0]; \
		sum += flt_ptr[1]; \
		*accum += sum; \
	} \
}

// i = h-1, j = w-1: indices y: h-2,h-1,h-1, x: w-2, w-1, w-1
#define ADM_CM_THRESH_S_H_M_1_W_M_1(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		src_ptr += (src_stride * (h - 2)); \
		flt_ptr += (src_stride * (h - 2)); \
		sum += flt_ptr[w - 2]; \
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[w - 2]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[w - 1]))+ 2048)>>12);\
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 2]; \
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 1]; \
		*accum += sum; \
	} \
}

// i = h-1, j = 1, ..., w-2: indices y: h-2,h-1,h-1, x: j-1,j,j+1
#define ADM_CM_THRESH_S_H_M_1_J(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		src_ptr += (src_stride * (h - 2)); \
		flt_ptr += (src_stride * (h - 2)); \
		sum += flt_ptr[j - 1];\
		sum += flt_ptr[j]; \
		sum += flt_ptr[j + 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[j - 1]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[j]))+ 2048)>>12);\
		sum += flt_ptr[j + 1]; \
		sum += flt_ptr[j - 1]; \
		sum += flt_ptr[j]; \
		sum += flt_ptr[j + 1]; \
		*accum += sum; \
	} \
}

// i = 1,..,h-2, j = 1,..,w-2: indices y: i-1,i,i+1, x: j-1,j,j+1
#define ADM_CM_THRESH_S_I_J(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t sum = 0; \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		src_ptr += (src_stride * (i - 1)); \
		flt_ptr += (src_stride * (i - 1)); \
		sum += flt_ptr[j - 1]; \
		sum += flt_ptr[j]; \
		sum += flt_ptr[j + 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[j - 1]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[j]))+ 2048)>>12);\
		sum += flt_ptr[j + 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[j - 1]; \
		sum += flt_ptr[j]; \
		sum += flt_ptr[j + 1]; \
		*accum += sum; \
	} \
}

// i = 1,..,h-2, j = 0: indices y: i-1,i,i+1, x: 1,0,1
#define ADM_CM_THRESH_S_I_0(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		src_ptr += (src_stride * (i - 1)); \
		flt_ptr += (src_stride * (i - 1)); \
		sum += flt_ptr[1]; \
		sum += flt_ptr[0]; \
		sum += flt_ptr[1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[1]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[0]))+ 2048)>>12);\
		sum += flt_ptr[1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[1]; \
		sum += flt_ptr[0]; \
		sum += flt_ptr[1]; \
		*accum += sum; \
	} \
}

// i = 1,..,h-2, j = w-1: indices y: i-1,i,i+1, x: w-2,w-1,w-1
#define ADM_CM_THRESH_S_I_W_M_1(angles,flt_angles,src_stride,accum,w,h,i,j) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int16_t *src_ptr = angles[theta]; \
		int16_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		src_ptr += (src_stride * (i-1)); \
		flt_ptr += (src_stride * (i - 1)); \
		sum += flt_ptr[w - 2]; \
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[w - 2]; \
		sum += (int16_t)(((ONE_BY_15 * abs((int32_t) src_ptr[w - 1]))+ 2048)>>12);\
		sum += flt_ptr[w - 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[w - 2]; \
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 1]; \
		*accum += sum; \
	} \
}

// i = 0, j = 0: indices y: 1,0,1, x: 1,0,1  for Fixed-point
#define I4_ADM_CM_THRESH_S_0_0(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t sum = 0; \
		int32_t *src_ptr = angles[theta]; \
		int32_t *flt_ptr = flt_angles[theta]; \
		sum += flt_ptr[src_stride + 1]; \
		sum += flt_ptr[src_stride]; \
		sum += flt_ptr[src_stride + 1]; \
		sum += flt_ptr[1]; \
		sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs( src_ptr[0]))+ add_bef_shift)>>shift);\
		sum += flt_ptr[1]; \
		sum += flt_ptr[src_stride + 1]; \
		sum += flt_ptr[src_stride]; \
		sum += flt_ptr[src_stride + 1]; \
		*accum += sum; \
	} \
}

// i = 0, j = w-1: indices y: 1,0,1, x: w-2, w-1, w-1
#define I4_ADM_CM_THRESH_S_0_W_M_1(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t *src_ptr = angles[theta]; \
		int32_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		sum += flt_ptr[src_stride + w - 2]; \
		sum += flt_ptr[src_stride + w - 1]; \
		sum += flt_ptr[src_stride + w - 1]; \
		sum += flt_ptr[w - 2]; \
		sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs((int32_t) src_ptr[w - 1]))+ add_bef_shift)>>shift);\
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[src_stride + w - 2]; \
		sum += flt_ptr[src_stride + w - 1]; \
		sum += flt_ptr[src_stride + w - 1]; \
		*accum += sum; \
	} \
}

// i = 0, j = 1, ..., w-2: indices y: 1,0,1, x: j-1,j,j+1
#define I4_ADM_CM_THRESH_S_0_J(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t sum = 0; \
		int32_t *src_ptr = angles[theta]; \
		int32_t *flt_ptr = flt_angles[theta]; \
		sum += flt_ptr[src_stride + j - 1]; \
		sum += flt_ptr[src_stride + j]; \
		sum += flt_ptr[src_stride + j + 1]; \
		sum += flt_ptr[j - 1]; \
		sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs((int32_t) src_ptr[j]))+ add_bef_shift)>>shift);\
		sum += flt_ptr[j + 1]; \
		sum += flt_ptr[src_stride + j - 1]; \
		sum += flt_ptr[src_stride + j]; \
		sum += flt_ptr[src_stride + j + 1];  \
		*accum += sum; \
	} \
}

// i = h-1, j = 0: indices y: h-2,h-1,h-1, x: 1,0,1
#define I4_ADM_CM_THRESH_S_H_M_1_0(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
	    int32_t sum = 0; \
	    int32_t *src_ptr = angles[theta]; \
	    int32_t *flt_ptr = flt_angles[theta]; \
	    src_ptr += (src_stride * (h - 2)); \
	    flt_ptr += (src_stride * (h - 2)); \
	    sum += flt_ptr[1]; \
	    sum += flt_ptr[0]; \
	    sum += flt_ptr[1]; \
	    src_ptr += src_stride; \
	    flt_ptr += src_stride; \
	    sum += flt_ptr[1]; \
	    sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs((int32_t) src_ptr[0]))+ add_bef_shift)>>shift);\
	    sum += flt_ptr[1]; \
	    sum += flt_ptr[1]; \
	    sum += flt_ptr[0]; \
	    sum += flt_ptr[1]; \
	    *accum += sum; \
	} \
}

// i = h-1, j = w-1: indices y: h-2,h-1,h-1, x: w-2, w-1, w-1
#define I4_ADM_CM_THRESH_S_H_M_1_W_M_1(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t *src_ptr = angles[theta]; \
		int32_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		src_ptr += (src_stride * (h - 2)); \
		flt_ptr += (src_stride * (h - 2)); \
		sum += flt_ptr[w - 2]; \
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[w - 2]; \
		sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs((int32_t) src_ptr[w - 1]))+ add_bef_shift)>>shift);\
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 2]; \
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 1]; \
		*accum += sum; \
	} \
}

// i = h-1, j = 1, ..., w-2: indices y: h-2,h-1,h-1, x: j-1,j,j+1
#define I4_ADM_CM_THRESH_S_H_M_1_J(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t *src_ptr = angles[theta]; \
		int32_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		src_ptr += (src_stride * (h - 2)); \
		flt_ptr += (src_stride * (h - 2)); \
		sum += flt_ptr[j - 1];\
		sum += flt_ptr[j]; \
		sum += flt_ptr[j + 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[j - 1]; \
		sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs((int32_t) src_ptr[j]))+ add_bef_shift)>>shift);\
		sum += flt_ptr[j + 1]; \
		sum += flt_ptr[j - 1]; \
		sum += flt_ptr[j]; \
		sum += flt_ptr[j + 1]; \
		*accum += sum; \
	} \
}

// i = 1,..,h-2, j = 1,..,w-2: indices y: i-1,i,i+1, x: j-1,j,j+1
#define I4_ADM_CM_THRESH_S_I_J(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t sum = 0; \
		int32_t *src_ptr = angles[theta]; \
		int32_t *flt_ptr = flt_angles[theta]; \
		src_ptr += (src_stride * (i - 1)); \
		flt_ptr += (src_stride * (i - 1)); \
		sum += flt_ptr[j - 1]; \
		sum += flt_ptr[j]; \
		sum += flt_ptr[j + 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[j - 1]; \
		sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs((int32_t) src_ptr[j]))+ add_bef_shift)>>shift);\
		sum += flt_ptr[j + 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[j - 1]; \
		sum += flt_ptr[j]; \
		sum += flt_ptr[j + 1]; \
		*accum += sum; \
	} \
}

// i = 1,..,h-2, j = 0: indices y: i-1,i,i+1, x: 1,0,1
#define I4_ADM_CM_THRESH_S_I_0(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t *src_ptr = angles[theta]; \
		int32_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		src_ptr += (src_stride * (i - 1)); \
		flt_ptr += (src_stride * (i - 1)); \
		sum += flt_ptr[1]; \
		sum += flt_ptr[0]; \
		sum += flt_ptr[1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[1]; \
		sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs((int32_t) src_ptr[0]))+ add_bef_shift)>>shift);\
		sum += flt_ptr[1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[1]; \
		sum += flt_ptr[0]; \
		sum += flt_ptr[1]; \
		*accum += sum; \
	} \
}

// i = 1,..,h-2, j = w-1: indices y: i-1,i,i+1, x: w-2,w-1,w-1
#define I4_ADM_CM_THRESH_S_I_W_M_1(angles,flt_angles,src_stride,accum,w,h,i,j,add_bef_shift,shift) \
{ \
	*accum = 0; \
	for (int theta = 0; theta < 3; ++theta) { \
		int32_t *src_ptr = angles[theta]; \
		int32_t *flt_ptr = flt_angles[theta]; \
		int32_t sum = 0; \
		src_ptr += (src_stride * (i-1)); \
		flt_ptr += (src_stride * (i - 1)); \
		sum += flt_ptr[w - 2]; \
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[w - 2]; \
		sum += (int32_t)((((int64_t)I4_ONE_BY_15 * abs((int32_t) src_ptr[w - 1]))+ add_bef_shift)>>shift);\
		sum += flt_ptr[w - 1]; \
		src_ptr += src_stride; \
		flt_ptr += src_stride; \
		sum += flt_ptr[w - 2]; \
		sum += flt_ptr[w - 1]; \
		sum += flt_ptr[w - 1]; \
		*accum += sum; \
	} \
}

#define ADM_CM_ACCUM_ROUND(x, thr, shift_xsub, x_sq, add_shift_xsq, shift_xsq, val, \
                           add_shift_xcub, shift_xcub, accum_inner) \
{ \
    x = abs(x) - ((int32_t)(thr) << shift_xsub); \
    x = x < 0 ? 0 : x; \
    x_sq = (int32_t)((((int64_t)x * x) + add_shift_xsq) >> shift_xsq); \
    val = (((int64_t)x_sq * x) + add_shift_xcub) >> shift_xcub; \
    accum_inner += val; \
}

#define I4_ADM_CM_ACCUM_ROUND(x, thr, shift_sub, x_sq, add_shift_sq, shift_sq, val, \
                              add_shift_cub, shift_cub, accum_inner)    \
{ \
    x = abs(x) - (thr >> shift_sub); \
    x = x < 0 ? 0 : x; \
    x_sq = (int32_t)((((int64_t)x * x) + add_shift_sq) >> shift_sq); \
    val = (((int64_t)x_sq * x) + add_shift_cub) >> shift_cub; \
    accum_inner += val; \
}

__device__ void dwt2_src_indices_filt(int **src_ind_y, int **src_ind_x, int w, int h)
{
    int ind0, ind1, ind2, ind3;
    const unsigned h_half = (h + 1) / 2;
    const unsigned w_half = (w + 1) / 2;
    unsigned i, j;
    /* Vertical pass */
    {   /* i : 0 */
        src_ind_y[0][0] = 1;
        src_ind_y[1][0] = 0;
        src_ind_y[2][0] = 1;
        src_ind_y[3][0] = 2;
    }
    for (i = 1; i < h_half - 2; ++i) { /* i : 1 to  h_half - 3*/
        ind1 = 2 * i;
        ind0 = ind1 - 1;
        ind2 = ind1 + 1;
        ind3 = ind1 + 2;
        src_ind_y[0][i] = ind0;
        src_ind_y[1][i] = ind1;
        src_ind_y[2][i] = ind2;
        src_ind_y[3][i] = ind3;
    }
    for (i = h_half - 2; i < h_half; ++i) { /* i : h_half - 3 to  h_half */
        ind1 = 2 * i;
        ind0 = ind1 - 1;
        ind2 = ind1 + 1;
        ind3 = ind1 + 2;
        if (ind0 >= h) {
            ind0 = (2 * h - ind0 - 1);
        }
        if (ind1 >= h) {
            ind1 = (2 * h - ind1 - 1);
        }
        if (ind2 >= h) {
            ind2 = (2 * h - ind2 - 1);
        }
        if (ind3 >= h) {
            ind3 = (2 * h - ind3 - 1);
        }
        src_ind_y[0][i] = ind0;
        src_ind_y[1][i] = ind1;
        src_ind_y[2][i] = ind2;
        src_ind_y[3][i] = ind3;
    }

    /* Horizontal pass */
    {   /* j : 0 */
        src_ind_x[0][0] = 1;
        src_ind_x[1][0] = 0;
        src_ind_x[2][0] = 1;
        src_ind_x[3][0] = 2;
    }
    for (j = 1; j < w_half - 2; ++j) { /* j : 1 to  w_half - 3 */
        ind1 = 2 * j;
        ind0 = ind1 - 1;
        ind2 = ind1 + 1;
        ind3 = ind1 + 2;
        src_ind_x[0][j] = ind0;
        src_ind_x[1][j] = ind1;
        src_ind_x[2][j] = ind2;
        src_ind_x[3][j] = ind3;
    }
    for (j = w_half - 2; j < w_half; ++j) { /* j : w_half - 3 to  w_half */
        ind1 = 2 * j;
        ind0 = ind1 - 1;
        ind2 = ind1 + 1;
        ind3 = ind1 + 2;
        if (ind0 >= w) {
            ind0 = (2 * w - ind0 - 1);
        }
        if (ind1 >= w) {
            ind1 = (2 * w - ind1 - 1);
        }
        if (ind2 >= w) {
            ind2 = (2 * w - ind2 - 1);
        }
        if (ind3 >= w) {
            ind3 = (2 * w - ind3 - 1);
        }
        src_ind_x[0][j] = ind0;
        src_ind_x[1][j] = ind1;
        src_ind_x[2][j] = ind2;
        src_ind_x[3][j] = ind3;
    }
}

#define MIN(x, y) (((x) < (y)) ? (x) : (y))
#undef MAX
#define MAX(x, y) (((x) > (y)) ? (x) : (y))

__device__ void adm_decouple(AdmBuffer *buf, int w, int h, int stride,
                         double adm_enhn_gain_limit,
                         int32_t *adm_div_lookup)
{
    const float cos_1deg_sq = cos(1.0 * M_PI / 180.0) * cos(1.0 * M_PI / 180.0);

    const adm_dwt_band_t *ref = &buf->ref_dwt2;
    const adm_dwt_band_t *dis = &buf->dis_dwt2;
    const adm_dwt_band_t *r = &buf->decouple_r;
    const adm_dwt_band_t *a = &buf->decouple_a;

    int left = w * ADM_BORDER_FACTOR - 0.5 - 1; // -1 for filter tap
    int top = h * ADM_BORDER_FACTOR - 0.5 - 1;
    int right = w - left + 2; // +2 for filter tap
    int bottom = h - top + 2;

    if (left < 0) {
        left = 0;
    }
    if (right > w) {
        right = w;
    }
    if (top < 0) {
        top = 0;
    }
    if (bottom > h) {
        bottom = h;
    }

    int64_t ot_dp, o_mag_sq, t_mag_sq;

    for (int i = top; i < bottom; ++i) {
        for (int j = left; j < right; ++j) {
            int16_t oh = ref->band_h[i * stride + j];
            int16_t ov = ref->band_v[i * stride + j];
            int16_t od = ref->band_d[i * stride + j];
            int16_t th = dis->band_h[i * stride + j];
            int16_t tv = dis->band_v[i * stride + j];
            int16_t td = dis->band_d[i * stride + j];
            int16_t rst_h, rst_v, rst_d;

            /* Determine if angle between (oh,ov) and (th,tv) is less than 1 degree.
             * Given that u is the angle (oh,ov) and v is the angle (th,tv), this can
             * be done by testing the inequvality.
             *
             * { (u.v.) >= 0 } AND { (u.v)^2 >= cos(1deg)^2 * ||u||^2 * ||v||^2 }
             *
             * Proof:
             *
             * cos(theta) = (u.v) / (||u|| * ||v||)
             *
             * IF u.v >= 0 THEN
             *   cos(theta)^2 = (u.v)^2 / (||u||^2 * ||v||^2)
             *   (u.v)^2 = cos(theta)^2 * ||u||^2 * ||v||^2
             *
             *   IF |theta| < 1deg THEN
             *     (u.v)^2 >= cos(1deg)^2 * ||u||^2 * ||v||^2
             *   END
             * ELSE
             *   |theta| > 90deg
             * END
             */
            ot_dp = (int64_t)oh * th + (int64_t)ov * tv;
            o_mag_sq = (int64_t)oh * oh + (int64_t)ov * ov;
            t_mag_sq = (int64_t)th * th + (int64_t)tv * tv;

            /**
             * angle_flag is calculated in floating-point by converting fixed-point variables back to
             * floating-point
             */
            int angle_flag = (((float)ot_dp / 4096.0) >= 0.0f) &&
                (((float)ot_dp / 4096.0) * ((float)ot_dp / 4096.0) >=
                    cos_1deg_sq * ((float)o_mag_sq / 4096.0) * ((float)t_mag_sq / 4096.0));

            /**
             * Division th/oh is carried using lookup table and converted to multiplication
             */

            int32_t tmp_kh = (oh == 0) ?
                32768 : (((int64_t)adm_div_lookup[oh + 32768] * th) + 16384) >> 15;
            int32_t tmp_kv = (ov == 0) ?
                32768 : (((int64_t)adm_div_lookup[ov + 32768] * tv) + 16384) >> 15;
            int32_t tmp_kd = (od == 0) ?
                32768 : (((int64_t)adm_div_lookup[od + 32768] * td) + 16384) >> 15;

            int32_t kh = tmp_kh < 0 ? 0 : (tmp_kh > 32768 ? 32768 : tmp_kh);
            int32_t kv = tmp_kv < 0 ? 0 : (tmp_kv > 32768 ? 32768 : tmp_kv);
            int32_t kd = tmp_kd < 0 ? 0 : (tmp_kd > 32768 ? 32768 : tmp_kd);

            /**
             * kh,kv,kd are in Q15 type and oh,ov,od are in Q16 type hence shifted by
             * 15 to make result Q16
             */
            rst_h = ((kh * oh) + 16384) >> 15;
            rst_v = ((kv * ov) + 16384) >> 15;
            rst_d = ((kd * od) + 16384) >> 15;

            const float rst_h_f = ((float)kh / 32768) * ((float)oh / 64);
            const float rst_v_f = ((float)kv / 32768) * ((float)ov / 64);
            const float rst_d_f = ((float)kd / 32768) * ((float)od / 64);

            if (angle_flag && (rst_h_f > 0.)) rst_h = MIN((rst_h * adm_enhn_gain_limit), th);
            if (angle_flag && (rst_h_f < 0.)) rst_h = MAX((rst_h * adm_enhn_gain_limit), th);

            if (angle_flag && (rst_v_f > 0.)) rst_v = MIN(rst_v * adm_enhn_gain_limit, tv);
            if (angle_flag && (rst_v_f < 0.)) rst_v = MAX(rst_v * adm_enhn_gain_limit, tv);

            if (angle_flag && (rst_d_f > 0.)) rst_d = MIN(rst_d * adm_enhn_gain_limit, td);
            if (angle_flag && (rst_d_f < 0.)) rst_d = MAX(rst_d * adm_enhn_gain_limit, td);

            r->band_h[i * stride + j] = rst_h;
            r->band_v[i * stride + j] = rst_v;
            r->band_d[i * stride + j] = rst_d;

            a->band_h[i * stride + j] = th - rst_h;
            a->band_v[i * stride + j] = tv - rst_v;
            a->band_d[i * stride + j] = td - rst_d;
        }
    }
}

__device__ static inline uint16_t get_best15_from32(uint32_t temp, int *x)
{
    int k = __clz(temp);    //built in for intel
    k = 17 - k;
    temp = (temp + (1 << (k - 1))) >> k;
    *x = k;
    return temp;
}

__device__ void adm_decouple_s123(AdmBuffer *buf, int w, int h, int stride,
                              double adm_enhn_gain_limit,
                              int32_t *adm_div_lookup)
{
    const float cos_1deg_sq = cos(1.0 * M_PI / 180.0) * cos(1.0 * M_PI / 180.0);

    const i4_adm_dwt_band_t *ref = &buf->i4_ref_dwt2;
    const i4_adm_dwt_band_t *dis = &buf->i4_dis_dwt2;
    const i4_adm_dwt_band_t *r = &buf->i4_decouple_r;
    const i4_adm_dwt_band_t *a = &buf->i4_decouple_a;
    /* The computation of the score is not required for the regions
    which lie outside the frame borders */
    int left = w * ADM_BORDER_FACTOR - 0.5 - 1; // -1 for filter tap
    int top = h * ADM_BORDER_FACTOR - 0.5 - 1;
    int right = w - left + 2; // +2 for filter tap
    int bottom = h - top + 2;

    if (left < 0) {
        left = 0;
    }
    if (right > w) {
        right = w;
    }
    if (top < 0) {
        top = 0;
    }
    if (bottom > h) {
        bottom = h;
    }

    int64_t ot_dp, o_mag_sq, t_mag_sq;

    for (int i = top; i < bottom; ++i)
    {
        for (int j = left; j < right; ++j)
        {
            int32_t oh = ref->band_h[i * stride + j];
            int32_t ov = ref->band_v[i * stride + j];
            int32_t od = ref->band_d[i * stride + j];
            int32_t th = dis->band_h[i * stride + j];
            int32_t tv = dis->band_v[i * stride + j];
            int32_t td = dis->band_d[i * stride + j];
            int32_t rst_h, rst_v, rst_d;

            /* Determine if angle between (oh,ov) and (th,tv) is less than 1 degree.
             * Given that u is the angle (oh,ov) and v is the angle (th,tv), this can
             * be done by testing the inequvality.
             *
             * { (u.v.) >= 0 } AND { (u.v)^2 >= cos(1deg)^2 * ||u||^2 * ||v||^2 }
             *
             * Proof:
             *
             * cos(theta) = (u.v) / (||u|| * ||v||)
             *
             * IF u.v >= 0 THEN
             *   cos(theta)^2 = (u.v)^2 / (||u||^2 * ||v||^2)
             *   (u.v)^2 = cos(theta)^2 * ||u||^2 * ||v||^2
             *
             *   IF |theta| < 1deg THEN
             *     (u.v)^2 >= cos(1deg)^2 * ||u||^2 * ||v||^2
             *   END
             * ELSE
             *   |theta| > 90deg
             * END
             */
            ot_dp = (int64_t)oh * th + (int64_t)ov * tv;
            o_mag_sq = (int64_t)oh * oh + (int64_t)ov * ov;
            t_mag_sq = (int64_t)th * th + (int64_t)tv * tv;

            int angle_flag = (((float)ot_dp / 4096.0) >= 0.0f) &&
                (((float)ot_dp / 4096.0) * ((float)ot_dp / 4096.0) >=
                    cos_1deg_sq * ((float)o_mag_sq / 4096.0) * ((float)t_mag_sq / 4096.0));

            /**
             * Division th/oh is carried using lookup table and converted to multiplication
             * int64 / int32 is converted to multiplication using following method
             * num /den :
             * DenAbs = Abs(den)
             * MSBDen = MSB(DenAbs)     (gives position of first 1 bit form msb side)
             * If (DenAbs < (1 << 15))
             *      Round = (1<<14)
             *      Score = (num *  div_lookup[den] + Round ) >> 15
             * else
             *      RoundD  = (1<< (16 - MSBDen))
             *      Round   = (1<< (14 + (17 - MSBDen))
             *      Score   = (num * div_lookup[(DenAbs + RoundD )>>(17 - MSBDen)]*sign(Denominator) + Round)
             *                  >> ((15 + (17 - MSBDen))
             */

            int32_t kh_shift = 0;
            int32_t kv_shift = 0;
            int32_t kd_shift = 0;

            uint32_t abs_oh = abs(oh);
            uint32_t abs_ov = abs(ov);
            uint32_t abs_od = abs(od);

            int8_t kh_sign = (oh < 0 ? -1 : 1);
            int8_t kv_sign = (ov < 0 ? -1 : 1);
            int8_t kd_sign = (od < 0 ? -1 : 1);

            uint16_t kh_msb = (abs_oh < (32768) ? abs_oh : get_best15_from32(abs_oh, &kh_shift));
            uint16_t kv_msb = (abs_ov < (32768) ? abs_ov : get_best15_from32(abs_ov, &kv_shift));
            uint16_t kd_msb = (abs_od < (32768) ? abs_od : get_best15_from32(abs_od, &kd_shift));

            int64_t tmp_kh = (oh == 0) ? 32768 : (((int64_t)adm_div_lookup[kh_msb + 32768] * th)*(kh_sign) +
                (1 << (14 + kh_shift))) >> (15 + kh_shift);
            int64_t tmp_kv = (ov == 0) ? 32768 : (((int64_t)adm_div_lookup[kv_msb + 32768] * tv)*(kv_sign) +
                (1 << (14 + kv_shift))) >> (15 + kv_shift);
            int64_t tmp_kd = (od == 0) ? 32768 : (((int64_t)adm_div_lookup[kd_msb + 32768] * td)*(kd_sign) +
                (1 << (14 + kd_shift))) >> (15 + kd_shift);

            int64_t kh = tmp_kh < 0 ? 0 : (tmp_kh > 32768 ? 32768 : tmp_kh);
            int64_t kv = tmp_kv < 0 ? 0 : (tmp_kv > 32768 ? 32768 : tmp_kv);
            int64_t kd = tmp_kd < 0 ? 0 : (tmp_kd > 32768 ? 32768 : tmp_kd);

            rst_h = ((kh * oh) + 16384) >> 15;
            rst_v = ((kv * ov) + 16384) >> 15;
            rst_d = ((kd * od) + 16384) >> 15;

            const float rst_h_f = ((float)kh / 32768) * ((float)oh / 64);
            const float rst_v_f = ((float)kv / 32768) * ((float)ov / 64);
            const float rst_d_f = ((float)kd / 32768) * ((float)od / 64);

            if (angle_flag && (rst_h_f > 0.)) rst_h = MIN((rst_h * adm_enhn_gain_limit), th);
            if (angle_flag && (rst_h_f < 0.)) rst_h = MAX((rst_h * adm_enhn_gain_limit), th);

            if (angle_flag && (rst_v_f > 0.)) rst_v = MIN(rst_v * adm_enhn_gain_limit, tv);
            if (angle_flag && (rst_v_f < 0.)) rst_v = MAX(rst_v * adm_enhn_gain_limit, tv);

            if (angle_flag && (rst_d_f > 0.)) rst_d = MIN(rst_d * adm_enhn_gain_limit, td);
            if (angle_flag && (rst_d_f < 0.)) rst_d = MAX(rst_d * adm_enhn_gain_limit, td);

            r->band_h[i * stride + j] = rst_h;
            r->band_v[i * stride + j] = rst_v;
            r->band_d[i * stride + j] = rst_d;

            a->band_h[i * stride + j] = th - rst_h;
            a->band_v[i * stride + j] = tv - rst_v;
            a->band_d[i * stride + j] = td - rst_d;
        }
    }
}

__device__ void adm_csf(AdmBuffer *buf, int w, int h, int stride,
                    double adm_norm_view_dist, int adm_ref_display_height, int adm_csf_mode, double adm_csf_scale,
                    double adm_csf_diag_scale, bool measure_aim)
{
    adm_dwt_band_t *src;
    adm_dwt_band_t *dst;
    adm_dwt_band_t *flt;

    if (measure_aim) {
        src = &buf->decouple_r;
        dst = &buf->csf_f;
        flt = &buf->csf_a;
    } else {
        src = &buf->decouple_a;
        dst = &buf->csf_a;
        flt = &buf->csf_f;
    }

    const int16_t *src_angles[3] = { src->band_h, src->band_v, src->band_d };
    int16_t *dst_angles[3] = { dst->band_h, dst->band_v, dst->band_d };
    int16_t *flt_angles[3] = { flt->band_h, flt->band_v, flt->band_d };

    // for ADM: scales goes from 0 to 3 but in noise floor paper, it goes from
    // 1 to 4 (from finest scale to coarsest scale).
    // 0 is scale zero passed to dwt_quant_step
    float factor1, factor2;
	if (adm_csf_mode == ADM_CSF_MODE_BARTEN) {
	    factor1 = barten_csf(0, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM, adm_csf_scale);
	    factor2 = barten_csf(0, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM, adm_csf_diag_scale);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND) {
	    factor1 = barten_watson_blend_csf(0, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf(0, 1, adm_norm_view_dist, adm_ref_display_height);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND_MAE) {
	    factor1 = barten_watson_blend_csf_mae(0, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf_mae(0, 1, adm_norm_view_dist, adm_ref_display_height);
	} else {
	    factor1 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], 0, 1, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], 0, 2, adm_norm_view_dist, adm_ref_display_height);
	}
	const float rfactor1[3] = { factor1, factor1, factor2 };

    /**
     * rfactor is converted to fixed-point for scale0 and stored in i_rfactor
     * multiplied by 2^21 for rfactor[0,1] and by 2^23 for rfactor[2].
     * For adm_norm_view_dist 3.0 and adm_ref_display_height 1080,
     * i_rfactor is around { 36453,36453,49417 } for ADM_CSF_MODE_WATSON97
     */
    uint16_t i_rfactor[3];
    if (fabs(adm_norm_view_dist * adm_ref_display_height - DEFAULT_ADM_NORM_VIEW_DIST * DEFAULT_ADM_REF_DISPLAY_HEIGHT) < 1.0e-8 &&
            adm_csf_mode == ADM_CSF_MODE_WATSON97) {
        i_rfactor[0] = 36453;
        i_rfactor[1] = 36453;
        i_rfactor[2] = 49417;
    }
    else {
        const double pow2_21 = pow(2, 21);
        const double pow2_23 = pow(2, 23);
        i_rfactor[0] = (uint16_t) (rfactor1[0] * pow2_21);
        i_rfactor[1] = (uint16_t) (rfactor1[1] * pow2_21);
        i_rfactor[2] = (uint16_t) (rfactor1[2] * pow2_23);
    }

    /**
     * Shifts pending from previous stage is 6
     * hence variables multiplied by i_rfactor[0,1] has to be shifted by 21+6=27 to convert
     * into floating-point. But shifted by 15 to make it Q16
     * and variables multiplied by i_factor[2] has to be shifted by 23+6=29 to convert into
     * floating-point. But shifted by 17 to make it Q16
     * Hence remaining shifts after shifting by i_shifts is 12 to make it equivalent to
     * floating-point
     */
    uint8_t i_shifts[3] = { 15,15,17 };
    uint16_t i_shiftsadd[3] = { 16384, 16384, 65535 };
    uint16_t FIX_ONE_BY_30 = 4369; //(1/30)*2^17
    /* The computation of the csf values is not required for the regions which
     *lie outside the frame borders
     */
    int left = w * ADM_BORDER_FACTOR - 0.5 - 1; // -1 for filter tap
    int top = h * ADM_BORDER_FACTOR - 0.5 - 1;
    int right = w - left + 2; // +2 for filter tap
    int bottom = h - top + 2;

    if (left < 0) {
        left = 0;
    }
    if (right > w) {
        right = w;
    }
    if (top < 0) {
        top = 0;
    }
    if (bottom > h) {
        bottom = h;
    }

    for (int theta = 0; theta < 3; ++theta) {
        const int16_t *src_ptr = src_angles[theta];
        int16_t *dst_ptr = dst_angles[theta];
        int16_t *flt_ptr = flt_angles[theta];

        for (int i = top; i < bottom; ++i) {
            int src_offset = i * stride;
            int dst_offset = i * stride;

            for (int j = left; j < right; ++j) {
                int32_t dst_val = i_rfactor[theta] * (int32_t)src_ptr[src_offset + j];
                int16_t i16_dst_val = ((int16_t)((dst_val + i_shiftsadd[theta]) >> i_shifts[theta]));
                dst_ptr[dst_offset + j] = i16_dst_val;
                flt_ptr[dst_offset + j] = ((int16_t)(((FIX_ONE_BY_30 * abs((int32_t)i16_dst_val))
                    + 2048) >> 12));
            }
        }
    }
}

__device__ void i4_adm_csf(AdmBuffer *buf, int scale, int w, int h, int stride,
                       double adm_norm_view_dist, int adm_ref_display_height, int adm_csf_mode, double adm_csf_scale,
                       double adm_csf_diag_scale, bool measure_aim)
{
    i4_adm_dwt_band_t *src;
    i4_adm_dwt_band_t *dst;
    i4_adm_dwt_band_t *flt;

    if (measure_aim) {
        src = &buf->i4_decouple_r;
        dst = &buf->i4_csf_f;
        flt = &buf->i4_csf_a;
    } else {
        src = &buf->i4_decouple_a;
        dst = &buf->i4_csf_a;
        flt = &buf->i4_csf_f;
    }

    const int32_t *src_angles[3] = { src->band_h, src->band_v, src->band_d };
    int32_t *dst_angles[3] = { dst->band_h, dst->band_v, dst->band_d };
    int32_t *flt_angles[3] = { flt->band_h, flt->band_v, flt->band_d };

    // for ADM: scales goes from 0 to 3 but in noise floor paper, it goes from
    // 1 to 4 (from finest scale to coarsest scale).
    float factor1, factor2;
	if (adm_csf_mode == ADM_CSF_MODE_BARTEN) {
	    factor1 = barten_csf(scale, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM,
	        adm_csf_scale);
	    factor2 = barten_csf(scale, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM,
	        adm_csf_diag_scale);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND) {
	    factor1 = barten_watson_blend_csf(scale, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf(scale, 1, adm_norm_view_dist, adm_ref_display_height);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND_MAE) {
	    factor1 = barten_watson_blend_csf_mae(scale, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf_mae(scale, 1, adm_norm_view_dist, adm_ref_display_height);
	} else {
	    factor1 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], scale, 1, adm_norm_view_dist,
	        adm_ref_display_height);
	    factor2 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], scale, 2, adm_norm_view_dist,
	        adm_ref_display_height);
	}
	const float rfactor1[3] = { factor1, factor1, factor2 };

    //i_rfactor in fixed-point
    const double pow2_32 = pow(2, 32);
    const uint32_t i_rfactor[3] = { (uint32_t)(rfactor1[0] * pow2_32),
                                    (uint32_t)(rfactor1[1] * pow2_32),
                                    (uint32_t)(rfactor1[2] * pow2_32) };

    const uint32_t FIX_ONE_BY_30 = 143165577;
    const uint32_t shift_dst[3] = { 28, 28, 28 };
    const uint32_t shift_flt[3] = { 32, 32, 32 };
    int32_t add_bef_shift_dst[3], add_bef_shift_flt[3];

    for (unsigned idx = 0; idx < 3; ++idx) {
        add_bef_shift_dst[idx] = (1u << (shift_dst[idx] - 1));
        add_bef_shift_flt[idx] = (1u << (shift_flt[idx] - 1));
    }

    /* The computation of the csf values is not required for the regions
     * which lie outside the frame borders
     */
    int left = w * ADM_BORDER_FACTOR - 0.5 - 1; // -1 for filter tap
    int top = h * ADM_BORDER_FACTOR - 0.5 - 1;
    int right = w - left + 2; // +2 for filter tap
    int bottom = h - top + 2;

    if (left < 0) {
        left = 0;
    }
    if (right > w) {
        right = w;
    }
    if (top < 0) {
        top = 0;
    }
    if (bottom > h) {
        bottom = h;
    }

    for (int theta = 0; theta < 3; ++theta)
    {
        const int32_t *src_ptr = src_angles[theta];
        int32_t *dst_ptr = dst_angles[theta];
        int32_t *flt_ptr = flt_angles[theta];

        for (int i = top; i < bottom; ++i)
        {
            int src_offset = i * stride;
            int dst_offset = i * stride;

            for (int j = left; j < right; ++j)
            {
                int32_t dst_val = (int32_t)(((i_rfactor[theta] * (int64_t)src_ptr[src_offset + j]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                dst_ptr[dst_offset + j] = dst_val;
                flt_ptr[dst_offset + j] = (int32_t)((((int64_t)FIX_ONE_BY_30 * abs(dst_val)) +
                    add_bef_shift_flt[scale - 1]) >> shift_flt[scale - 1]);
            }
        }
    }
}

__device__ float adm_csf_den_scale(const adm_dwt_band_t *src, int w, int h,
                               int src_stride,
                               double adm_norm_view_dist, int adm_ref_display_height, int adm_csf_mode,
                               double adm_csf_scale, double adm_csf_diag_scale, double adm_noise_weight)
{
    // for ADM: scales goes from 0 to 3 but in noise floor paper, it goes from
    // 1 to 4 (from finest scale to coarsest scale).
    float factor1, factor2;
	if (adm_csf_mode == ADM_CSF_MODE_BARTEN) {
	    factor1 = barten_csf(0, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM, adm_csf_scale);
	    factor2 = barten_csf(0, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM, adm_csf_diag_scale);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND) {
	    factor1 = barten_watson_blend_csf(0, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf(0, 1, adm_norm_view_dist, adm_ref_display_height);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND_MAE) {
	    factor1 = barten_watson_blend_csf_mae(0, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf_mae(0, 1, adm_norm_view_dist, adm_ref_display_height);
	} else {
	    factor1 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], 0, 1, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], 0, 2, adm_norm_view_dist, adm_ref_display_height);
	}
	const float rfactor[3] = { factor1, factor1, factor2 };

    uint64_t accum_h = 0, accum_v = 0, accum_d = 0;

    /* The computation of the denominator scales is not required for the regions
     * which lie outside the frame borders
     */
    const int left = w * ADM_BORDER_FACTOR - 0.5;
    const int top = h * ADM_BORDER_FACTOR - 0.5;
    const int right = w - left;
    const int bottom = h - top;

    int32_t shift_accum = (int32_t)ceil(log2((bottom - top)*(right - left)) - 20);
    shift_accum = shift_accum > 0 ? shift_accum : 0;
    int32_t add_shift_accum =
        shift_accum > 0 ? (1 << (shift_accum - 1)) : 0;

    /**
     * The rfactor is multiplied at the end after cubing
     * Because d+ = (a[i]^3)*(r^3)
     * is equivalent to d+=a[i]^3 and d=d*(r^3)
     */
    int16_t *src_h = src->band_h + top * src_stride;
    int16_t *src_v = src->band_v + top * src_stride;
    int16_t *src_d = src->band_d + top * src_stride;
    for (int i = top; i < bottom; ++i) {
        uint64_t accum_inner_h = 0;
        uint64_t accum_inner_v = 0;
        uint64_t accum_inner_d = 0;
        for (int j = left; j < right; ++j) {
            uint16_t h = (uint16_t)abs(src_h[j]);
            uint16_t v = (uint16_t)abs(src_v[j]);
            uint16_t d = (uint16_t)abs(src_d[j]);

            uint64_t val = ((uint64_t)h * h) * h;
            accum_inner_h += val;
            val = ((uint64_t)v * v) * v;
            accum_inner_v += val;
            val = ((uint64_t)d * d) * d;
            accum_inner_d += val;
        }
        /**
         * max_value of h^3, v^3, d^3 is 1.205624776 * —10^13
         * accum_h can hold till 1.844674407 * —10^19
         * accum_h's maximum is reached when it is 2^20 * max(h^3)
         * Therefore the accum_h,v,d is shifted based on width and height subtracted by 20
         */
        accum_h += (accum_inner_h + add_shift_accum) >> shift_accum;
        accum_v += (accum_inner_v + add_shift_accum) >> shift_accum;
        accum_d += (accum_inner_d + add_shift_accum) >> shift_accum;
        src_h += src_stride;
        src_v += src_stride;
        src_d += src_stride;
    }
    /**
     * rfactor is multiplied after cubing
     * accum_h,v,d is converted to floating-point for score calculation
     * 6bits are yet to be shifted from previous stage that is after dwt hence
     * after cubing 18bits are to shifted
     * Hence final shift is 18-shift_accum
     */
    double shift_csf = pow(2, (18 - shift_accum));
    double csf_h = (double)(accum_h / shift_csf) * pow(rfactor[0], 3);
    double csf_v = (double)(accum_v / shift_csf) * pow(rfactor[1], 3);
    double csf_d = (double)(accum_d / shift_csf) * pow(rfactor[2], 3);

    // TODO: if we integrate adm_p_norm, adm_p_norm=3.0f here
    // This would mean:
    // float powf_add = powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / adm_p_norm);
    // float den_scale_h = powf(csf_h, 1.0f / adm_p_norm) + powf_add;
    // float den_scale_v = powf(csf_v, 1.0f / adm_p_norm) + powf_add;
    // float den_scale_d = powf(csf_d, 1.0f / adm_p_norm) + powf_add;
    float powf_add = powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / 3.0f);
    float den_scale_h = powf(csf_h, 1.0f / 3.0f) + powf_add;
    float den_scale_v = powf(csf_v, 1.0f / 3.0f) + powf_add;
    float den_scale_d = powf(csf_d, 1.0f / 3.0f) + powf_add;

    return (den_scale_h + den_scale_v + den_scale_d);

}

__device__ float adm_csf_den_s123(const i4_adm_dwt_band_t *src, int scale, int w, int h,
                              int src_stride,
                              double adm_norm_view_dist, int adm_ref_display_height, int adm_csf_mode,
                              double adm_csf_scale, double adm_csf_diag_scale, double adm_noise_weight)
{
    // for ADM: scales goes from 0 to 3 but in noise floor paper, it goes from
    // 1 to 4 (from finest scale to coarsest scale).
    float factor1, factor2;
	if (adm_csf_mode == ADM_CSF_MODE_BARTEN) {
	    factor1 = barten_csf(scale, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM,
	        adm_csf_scale);
	    factor2 = barten_csf(scale, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM,
	        adm_csf_diag_scale);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND) {
	    factor1 = barten_watson_blend_csf(scale, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf(scale, 1, adm_norm_view_dist, adm_ref_display_height);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND_MAE) {
	    factor1 = barten_watson_blend_csf_mae(scale, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf_mae(scale, 1, adm_norm_view_dist, adm_ref_display_height);
	} else {
	    factor1 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], scale, 1, adm_norm_view_dist,
	        adm_ref_display_height);
	    factor2 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], scale, 2, adm_norm_view_dist,
	        adm_ref_display_height);
	}
	const float rfactor[3] = { factor1, factor1, factor2 };

    uint64_t accum_h = 0, accum_v = 0, accum_d = 0;
    const uint32_t shift_sq[3] = { 31, 30, 31 };
    const uint32_t accum_convert_float[3] = { 32, 27, 23 };
    const uint32_t add_shift_sq[3] =
        { 1u << shift_sq[0], 1u << shift_sq[1], 1u << shift_sq[2] };

    /* The computation of the denominator scales is not required for the regions
     * which lie outside the frame borders
     */
    const int left = w * ADM_BORDER_FACTOR - 0.5;
    const int top = h * ADM_BORDER_FACTOR - 0.5;
    const int right = w - left;
    const int bottom = h - top;

    uint32_t shift_cub = (uint32_t)ceil(log2(right - left));
    uint32_t add_shift_cub = (uint32_t)pow(2, (shift_cub - 1));
    uint32_t shift_accum = (uint32_t)ceil(log2(bottom - top));
    uint32_t add_shift_accum = (uint32_t)pow(2, (shift_accum - 1));

    int32_t *src_h = src->band_h + top * src_stride;
    int32_t *src_v = src->band_v + top * src_stride;
    int32_t *src_d = src->band_d + top * src_stride;
    for (int i = top; i < bottom; ++i)
    {
        uint64_t accum_inner_h = 0;
        uint64_t accum_inner_v = 0;
        uint64_t accum_inner_d = 0;
        for (int j = left; j < right; ++j)
        {
            uint32_t h = (uint32_t)abs(src_h[j]);
            uint32_t v = (uint32_t)abs(src_v[j]);
            uint32_t d = (uint32_t)abs(src_d[j]);

            uint64_t val = ((((((uint64_t)h * h) + add_shift_sq[scale - 1]) >>
                shift_sq[scale - 1]) * h) + add_shift_cub) >> shift_cub;

            accum_inner_h += val;

            val = ((((((uint64_t)v * v) + add_shift_sq[scale - 1]) >>
                shift_sq[scale - 1]) * v) + add_shift_cub) >> shift_cub;
            accum_inner_v += val;

            val = ((((((uint64_t)d * d) + add_shift_sq[scale - 1]) >>
                shift_sq[scale - 1]) * d) + add_shift_cub) >> shift_cub;
            accum_inner_d += val;
        }

        accum_h += (accum_inner_h + add_shift_accum) >> shift_accum;
        accum_v += (accum_inner_v + add_shift_accum) >> shift_accum;
        accum_d += (accum_inner_d + add_shift_accum) >> shift_accum;

        src_h += src_stride;
        src_v += src_stride;
        src_d += src_stride;
    }
    /**
     * All the results are converted to floating-point to calculate the scores
     * For all scales the final shift is 3*shifts from dwt - total shifts done here
     */
    double shift_csf = pow(2, (accum_convert_float[scale - 1] - shift_accum - shift_cub));
    double csf_h = (double)(accum_h / shift_csf) * pow(rfactor[0], 3);
    double csf_v = (double)(accum_v / shift_csf) * pow(rfactor[1], 3);
    double csf_d = (double)(accum_d / shift_csf) * pow(rfactor[2], 3);

    // TODO: if we integrate adm_p_norm, adm_p_norm=3.0f here
    // This would mean:
    // float powf_add = powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / adm_p_norm);
    // float den_scale_h = powf(csf_h, 1.0f / adm_p_norm) + powf_add;
    // float den_scale_v = powf(csf_v, 1.0f / adm_p_norm) + powf_add;
    // float den_scale_d = powf(csf_d, 1.0f / adm_p_norm) + powf_add;
    float powf_add = powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / 3.0f);
    float den_scale_h = powf(csf_h, 1.0f / 3.0f) + powf_add;
    float den_scale_v = powf(csf_v, 1.0f / 3.0f) + powf_add;
    float den_scale_d = powf(csf_d, 1.0f / 3.0f) + powf_add;

    return (den_scale_h + den_scale_v + den_scale_d);
}

__device__ float adm_cm(AdmBuffer *buf, int w, int h, int src_stride, int csf_a_stride,
                    double adm_norm_view_dist, int adm_ref_display_height, int adm_csf_mode,
                    double adm_csf_scale, double adm_csf_diag_scale, double adm_noise_weight, bool measure_aim)
{
    adm_dwt_band_t *src;
    adm_dwt_band_t *csf_f;
    adm_dwt_band_t *csf_a;

    if (measure_aim) {
        src = &buf->decouple_a;
        csf_f = &buf->csf_a;
        csf_a = &buf->csf_f;
    } else {
        src = &buf->decouple_r;
        csf_f = &buf->csf_f;
        csf_a = &buf->csf_a;
    }

    // for ADM: scales goes from 0 to 3 but in noise floor paper, it goes from
    // 1 to 4 (from finest scale to coarsest scale).
    // 0 is scale zero passed to dwt_quant_step
    float factor1, factor2;
	if (adm_csf_mode == ADM_CSF_MODE_BARTEN) {
	    factor1 = barten_csf(0, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM, adm_csf_scale);
	    factor2 = barten_csf(0, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM, adm_csf_diag_scale);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND) {
	    factor1 = barten_watson_blend_csf(0, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf(0, 1, adm_norm_view_dist, adm_ref_display_height);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND_MAE) {
	    factor1 = barten_watson_blend_csf_mae(0, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf_mae(0, 1, adm_norm_view_dist, adm_ref_display_height);
	} else {
	    factor1 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], 0, 1, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], 0, 2, adm_norm_view_dist, adm_ref_display_height);
	}
	const float rfactor1[3] = { factor1, factor1, factor2 };

    /**
     * rfactor is converted to fixed-point for scale0 and stored in i_rfactor
     * multiplied by 2^21 for rfactor[0,1] and by 2^23 for rfactor[2].
     * For adm_norm_view_dist 3.0 and adm_ref_display_height 1080,
     * i_rfactor is around { 36453,36453,49417 } for ADM_CSF_MODE_WATSON97
     */
    uint16_t i_rfactor[3];
    if (fabs(adm_norm_view_dist * adm_ref_display_height - DEFAULT_ADM_NORM_VIEW_DIST * DEFAULT_ADM_REF_DISPLAY_HEIGHT) < 1.0e-8 &&
        adm_csf_mode == ADM_CSF_MODE_WATSON97) {
        i_rfactor[0] = 36453;
        i_rfactor[1] = 36453;
        i_rfactor[2] = 49417;
    }
    else {
        const double pow2_21 = pow(2, 21);
        const double pow2_23 = pow(2, 23);
        i_rfactor[0] = (uint16_t) (rfactor1[0] * pow2_21);
        i_rfactor[1] = (uint16_t) (rfactor1[1] * pow2_21);
        i_rfactor[2] = (uint16_t) (rfactor1[2] * pow2_23);
    }

    const int32_t shift_xhsq = 29;
    const int32_t shift_xvsq = 29;
    const int32_t shift_xdsq = 30;
    const int32_t add_shift_xhsq = 268435456;
    const int32_t add_shift_xvsq = 268435456;
    const int32_t add_shift_xdsq = 536870912;

    const uint32_t shift_xhcub = (uint32_t)ceil(log2(w) - 4);
    const uint32_t add_shift_xhcub = (uint32_t)pow(2, (shift_xhcub - 1));

    const uint32_t shift_xvcub = (uint32_t)ceil(log2(w) - 4);
    const uint32_t add_shift_xvcub = (uint32_t)pow(2, (shift_xvcub - 1));

    const uint32_t shift_xdcub = (uint32_t)ceil(log2(w) - 3);
    const uint32_t add_shift_xdcub = (uint32_t)pow(2, (shift_xdcub - 1));

    const uint32_t shift_inner_accum = (uint32_t)ceil(log2(h));
    const uint32_t add_shift_inner_accum = (uint32_t)pow(2, (shift_inner_accum - 1));

    const int32_t shift_xhsub = 10;
    const int32_t shift_xvsub = 10;
    const int32_t shift_xdsub = 12;

    int16_t *angles[3] = { csf_a->band_h, csf_a->band_v, csf_a->band_d };
    int16_t *flt_angles[3] = { csf_f->band_h, csf_f->band_v, csf_f->band_d };

    /* The computation of the scales is not required for the regions which lie
     * outside the frame borders
     */
    int left = w * ADM_BORDER_FACTOR - 0.5;
    int top = h * ADM_BORDER_FACTOR - 0.5;
    int right = w - left;
    int bottom = h - top;

    const int start_col = (left > 1) ? left : 1;
    const int end_col = (right < (w - 1)) ? right : (w - 1);
    const int start_row = (top > 1) ? top : 1;
    const int end_row = (bottom < (h - 1)) ? bottom : (h - 1);

    int i, j;
    int64_t val;
    int32_t xh, xv, xd, thr;
    int32_t xh_sq, xv_sq, xd_sq;
    int64_t accum_h = 0, accum_v = 0, accum_d = 0;
    int64_t accum_inner_h = 0, accum_inner_v = 0, accum_inner_d = 0;

    /* i=0,j=0 */
    if ((top <= 0) && (left <= 0))
    {
        xh = (int32_t)src->band_h[0] * i_rfactor[0];
        xv = (int32_t)src->band_v[0] * i_rfactor[1];
        xd = (int32_t)src->band_d[0] * i_rfactor[2];
        ADM_CM_THRESH_S_0_0(angles, flt_angles, csf_a_stride, &thr, w, h, 0, 0);

        //thr is shifted to make it's Q format equivalent to xh,xv,xd

        /**
         * max value of xh_sq and xv_sq is 1301381973 and that of xd_sq is 1195806729
         *
         * max(val before shift for h and v) is 9.995357299 * —10^17.
         * 9.995357299 * —10^17 * 2^4 is close to 2^64.
         * Hence shift is done based on width subtracting 4
         *
         * max(val before shift for d) is 1.355006643 * —10^18
         * 1.355006643 * —10^18 * 2^3 is close to 2^64
         * Hence shift is done based on width subtracting 3
         */
        ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                           add_shift_xhcub, shift_xhcub, accum_inner_h);
        ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                           add_shift_xvcub, shift_xvcub, accum_inner_v);
        ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                           add_shift_xdcub, shift_xdcub, accum_inner_d);
    }

    /* i=0, j */
    if (top <= 0) {
        for (j = start_col; j < end_col; ++j) {
            xh = src->band_h[j] * i_rfactor[0];
            xv = src->band_v[j] * i_rfactor[1];
            xd = src->band_d[j] * i_rfactor[2];
            ADM_CM_THRESH_S_0_J(angles, flt_angles, csf_a_stride, &thr, w, h, 0, j);

            ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                               add_shift_xhcub, shift_xhcub, accum_inner_h);
            ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                               add_shift_xvcub, shift_xvcub, accum_inner_v);
            ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                               add_shift_xdcub, shift_xdcub, accum_inner_d);
        }
    }

    /* i=0,j=w-1 */
    if ((top <= 0) && (right > (w - 1)))
    {
        xh = src->band_h[w - 1] * i_rfactor[0];
        xv = src->band_v[w - 1] * i_rfactor[1];
        xd = src->band_d[w - 1] * i_rfactor[2];
        ADM_CM_THRESH_S_0_W_M_1(angles, flt_angles, csf_a_stride, &thr, w, h, 0, (w - 1));

        ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                           add_shift_xhcub, shift_xhcub, accum_inner_h);
        ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                           add_shift_xvcub, shift_xvcub, accum_inner_v);
        ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                           add_shift_xdcub, shift_xdcub, accum_inner_d);
    }
    //Shift is done based on height
    accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
    accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
    accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;

    if ((left > 0) && (right <= (w - 1))) /* Completely within frame */
    {
        for (i = start_row; i < end_row; ++i) {
            accum_inner_h = 0;
            accum_inner_v = 0;
            accum_inner_d = 0;
            for (j = start_col; j < end_col; ++j) {
                xh = src->band_h[i * src_stride + j] * i_rfactor[0];
                xv = src->band_v[i * src_stride + j] * i_rfactor[1];
                xd = src->band_d[i * src_stride + j] * i_rfactor[2];
                ADM_CM_THRESH_S_I_J(angles, flt_angles, csf_a_stride, &thr, w, h, i, j);

                ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                                   add_shift_xhcub, shift_xhcub, accum_inner_h);
                ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                                   add_shift_xvcub, shift_xvcub, accum_inner_v);
                ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                                   add_shift_xdcub, shift_xdcub, accum_inner_d);
            }
            accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
            accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
            accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;
        }
    }
    else if ((left <= 0) && (right <= (w - 1))) /* Right border within frame, left outside */
    {
        for (i = start_row; i < end_row; ++i) {
            accum_inner_h = 0;
            accum_inner_v = 0;
            accum_inner_d = 0;

            /* j = 0 */
            xh = src->band_h[i * src_stride] * i_rfactor[0];
            xv = src->band_v[i * src_stride] * i_rfactor[1];
            xd = src->band_d[i * src_stride] * i_rfactor[2];
            ADM_CM_THRESH_S_I_0(angles, flt_angles, csf_a_stride, &thr, w, h, i, 0);

            ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                               add_shift_xhcub, shift_xhcub, accum_inner_h);
            ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                               add_shift_xvcub, shift_xvcub, accum_inner_v);
            ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                               add_shift_xdcub, shift_xdcub, accum_inner_d);

            /* j within frame */
            for (j = start_col; j < end_col; ++j) {
                xh = src->band_h[i * src_stride + j] * i_rfactor[0];
                xv = src->band_v[i * src_stride + j] * i_rfactor[1];
                xd = src->band_d[i * src_stride + j] * i_rfactor[2];
                ADM_CM_THRESH_S_I_J(angles, flt_angles, csf_a_stride, &thr, w, h, i, j);

                ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                                   add_shift_xhcub, shift_xhcub, accum_inner_h);
                ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                                   add_shift_xvcub, shift_xvcub, accum_inner_v);
                ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                                   add_shift_xdcub, shift_xdcub, accum_inner_d);
            }
            accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
            accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
            accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;
        }
    }
    else if ((left > 0) && (right > (w - 1))) /* Left border within frame, right outside */
    {
        for (i = start_row; i < end_row; ++i) {
            accum_inner_h = 0;
            accum_inner_v = 0;
            accum_inner_d = 0;
            /* j within frame */
            for (j = start_col; j < end_col; ++j) {
                xh = src->band_h[i * src_stride + j] * i_rfactor[0];
                xv = src->band_v[i * src_stride + j] * i_rfactor[1];
                xd = src->band_d[i * src_stride + j] * i_rfactor[2];
                ADM_CM_THRESH_S_I_J(angles, flt_angles, csf_a_stride, &thr, w, h, i, j);

                ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                                   add_shift_xhcub, shift_xhcub, accum_inner_h);
                ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                                   add_shift_xvcub, shift_xvcub, accum_inner_v);
                ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                                   add_shift_xdcub, shift_xdcub, accum_inner_d);
            }
            /* j = w-1 */
            xh = src->band_h[i * src_stride + w - 1] * i_rfactor[0];
            xv = src->band_v[i * src_stride + w - 1] * i_rfactor[1];
            xd = src->band_d[i * src_stride + w - 1] * i_rfactor[2];
            ADM_CM_THRESH_S_I_W_M_1(angles, flt_angles, csf_a_stride, &thr, w, h, i, (w - 1));

            ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                               add_shift_xhcub, shift_xhcub, accum_inner_h);
            ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                               add_shift_xvcub, shift_xvcub, accum_inner_v);
            ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                               add_shift_xdcub, shift_xdcub, accum_inner_d);

            accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
            accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
            accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;

        }
    }
    else /* Both borders outside frame */
    {
        for (i = start_row; i < end_row; ++i) {
            accum_inner_h = 0;
            accum_inner_v = 0;
            accum_inner_d = 0;

            /* j = 0 */
            xh = src->band_h[i * src_stride] * i_rfactor[0];
            xv = src->band_v[i * src_stride] * i_rfactor[1];
            xd = src->band_d[i * src_stride] * i_rfactor[2];
            ADM_CM_THRESH_S_I_0(angles, flt_angles, csf_a_stride, &thr, w, h, i, 0);

            ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                               add_shift_xhcub, shift_xhcub, accum_inner_h);
            ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                               add_shift_xvcub, shift_xvcub, accum_inner_v);
            ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                               add_shift_xdcub, shift_xdcub, accum_inner_d);

            /* j within frame */
            for (j = start_col; j < end_col; ++j) {
                xh = src->band_h[i * src_stride + j] * i_rfactor[0];
                xv = src->band_v[i * src_stride + j] * i_rfactor[1];
                xd = src->band_d[i * src_stride + j] * i_rfactor[2];
                ADM_CM_THRESH_S_I_J(angles, flt_angles, csf_a_stride, &thr, w, h, i, j);

                ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                                   add_shift_xhcub, shift_xhcub, accum_inner_h);
                ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                                   add_shift_xvcub, shift_xvcub, accum_inner_v);
                ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                                   add_shift_xdcub, shift_xdcub, accum_inner_d);
            }
            /* j = w-1 */
            xh = src->band_h[i * src_stride + w - 1] * i_rfactor[0];
            xv = src->band_v[i * src_stride + w - 1] * i_rfactor[1];
            xd = src->band_d[i * src_stride + w - 1] * i_rfactor[2];
            ADM_CM_THRESH_S_I_W_M_1(angles, flt_angles, csf_a_stride, &thr, w, h, i, (w - 1));

            ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                               add_shift_xhcub, shift_xhcub, accum_inner_h);
            ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                               add_shift_xvcub, shift_xvcub, accum_inner_v);
            ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                               add_shift_xdcub, shift_xdcub, accum_inner_d);

            accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
            accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
            accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;
        }
    }
    accum_inner_h = 0;
    accum_inner_v = 0;
    accum_inner_d = 0;

    /* i=h-1,j=0 */
    if ((bottom > (h - 1)) && (left <= 0))
    {
        xh = src->band_h[(h - 1) * src_stride] * i_rfactor[0];
        xv = src->band_v[(h - 1) * src_stride] * i_rfactor[1];
        xd = src->band_d[(h - 1) * src_stride] * i_rfactor[2];
        ADM_CM_THRESH_S_H_M_1_0(angles, flt_angles, csf_a_stride, &thr, w, h, (h - 1), 0);

        ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                           add_shift_xhcub, shift_xhcub, accum_inner_h);
        ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                           add_shift_xvcub, shift_xvcub, accum_inner_v);
        ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                           add_shift_xdcub, shift_xdcub, accum_inner_d);
    }

    /* i=h-1,j */
    if (bottom > (h - 1)) {
        for (j = start_col; j < end_col; ++j) {
            xh = src->band_h[(h - 1) * src_stride + j] * i_rfactor[0];
            xv = src->band_v[(h - 1) * src_stride + j] * i_rfactor[1];
            xd = src->band_d[(h - 1) * src_stride + j] * i_rfactor[2];
            ADM_CM_THRESH_S_H_M_1_J(angles, flt_angles, csf_a_stride, &thr, w, h, (h - 1), j);

            ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                               add_shift_xhcub, shift_xhcub, accum_inner_h);
            ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                               add_shift_xvcub, shift_xvcub, accum_inner_v);
            ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                               add_shift_xdcub, shift_xdcub, accum_inner_d);
        }
    }

    /* i-h-1,j=w-1 */
    if ((bottom > (h - 1)) && (right > (w - 1)))
    {
        xh = src->band_h[(h - 1) * src_stride + w - 1] * i_rfactor[0];
        xv = src->band_v[(h - 1) * src_stride + w - 1] * i_rfactor[1];
        xd = src->band_d[(h - 1) * src_stride + w - 1] * i_rfactor[2];
        ADM_CM_THRESH_S_H_M_1_W_M_1(angles, flt_angles, csf_a_stride, &thr, w, h,
            (h - 1), (w - 1));

        ADM_CM_ACCUM_ROUND(xh, thr, shift_xhsub, xh_sq, add_shift_xhsq, shift_xhsq, val,
                           add_shift_xhcub, shift_xhcub, accum_inner_h);
        ADM_CM_ACCUM_ROUND(xv, thr, shift_xvsub, xv_sq, add_shift_xvsq, shift_xvsq, val,
                           add_shift_xvcub, shift_xvcub, accum_inner_v);
        ADM_CM_ACCUM_ROUND(xd, thr, shift_xdsub, xd_sq, add_shift_xdsq, shift_xdsq, val,
                           add_shift_xdcub, shift_xdcub, accum_inner_d);
    }
    accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
    accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
    accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;

    /**
     * For h and v total shifts pending from last stage is 6 rfactor[0,1] has 21 shifts
     * => after cubing (6+21)*3=81 after squaring shifted by 29
     * hence pending is 52-shift's done based on width and height
     *
     * For d total shifts pending from last stage is 6 rfactor[2] has 23 shifts
     * => after cubing (6+23)*3=87 after squaring shifted by 30
     * hence pending is 57-shift's done based on width and height
     */
    float f_accum_h = (float)(accum_h / pow(2, (52 - shift_xhcub - shift_inner_accum)));
    float f_accum_v = (float)(accum_v / pow(2, (52 - shift_xvcub - shift_inner_accum)));
    float f_accum_d = (float)(accum_d / pow(2, (57 - shift_xdcub - shift_inner_accum)));

    // TODO: if we integrate adm_p_norm, adm_p_norm=3.0f here
    // This would mean:
    // float num_scale_h = powf(f_accum_h, 1.0f / adm_p_norm) + powf((bottom - top) *
    //                     (right - left) * adm_noise_weight, 1.0f / adm_p_norm);
    // float num_scale_v = powf(f_accum_v, 1.0f / adm_p_norm) + powf((bottom - top) *
    //                     (right - left) * adm_noise_weight, 1.0f / adm_p_norm);
    // float num_scale_d = powf(f_accum_d, 1.0f / adm_p_norm) + powf((bottom - top) *
    //                     (right - left) * adm_noise_weight, 1.0f / adm_p_norm);
    float num_scale_h = powf(f_accum_h, 1.0f / 3.0f) + powf((bottom - top) *
                        (right - left) * adm_noise_weight, 1.0f / 3.0f);
    float num_scale_v = powf(f_accum_v, 1.0f / 3.0f) + powf((bottom - top) *
                        (right - left) * adm_noise_weight, 1.0f / 3.0f);
    float num_scale_d = powf(f_accum_d, 1.0f / 3.0f) + powf((bottom - top) *
                        (right - left) * adm_noise_weight, 1.0f / 3.0f);

    return (num_scale_h + num_scale_v + num_scale_d);
}

__device__ float i4_adm_cm(AdmBuffer *buf, int w, int h, int src_stride, int csf_a_stride, int scale,
                       double adm_norm_view_dist, int adm_ref_display_height, int adm_csf_mode, double adm_csf_scale,
                       double adm_csf_diag_scale, double adm_noise_weight, bool measure_aim)
{
    i4_adm_dwt_band_t *src;
    i4_adm_dwt_band_t *csf_f;
    i4_adm_dwt_band_t *csf_a;
    if (measure_aim) {
        src = &buf->i4_decouple_a;
        csf_f = &buf->i4_csf_a;
        csf_a = &buf->i4_csf_f;
    } else {
        src = &buf->i4_decouple_r;
        csf_f = &buf->i4_csf_f;
        csf_a = &buf->i4_csf_a;
    }

    // for ADM: scales goes from 0 to 3 but in noise floor paper, it goes from
    // 1 to 4 (from finest scale to coarsest scale).
    float factor1, factor2;
	if (adm_csf_mode == ADM_CSF_MODE_BARTEN) {
	    factor1 = barten_csf(scale, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM,
	        adm_csf_scale);
	    factor2 = barten_csf(scale, adm_norm_view_dist, adm_ref_display_height, DEFAULT_ADM_CSF_LUM,
	        adm_csf_diag_scale);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND) {
	    factor1 = barten_watson_blend_csf(scale, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf(scale, 1, adm_norm_view_dist, adm_ref_display_height);
	} else if (adm_csf_mode == ADM_CSF_MODE_BARTEN_WATSON_BLEND_MAE) {
	    factor1 = barten_watson_blend_csf_mae(scale, 0, adm_norm_view_dist, adm_ref_display_height);
	    factor2 = barten_watson_blend_csf_mae(scale, 1, adm_norm_view_dist, adm_ref_display_height);
	} else {
	    factor1 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], scale, 1, adm_norm_view_dist,
	        adm_ref_display_height);
	    factor2 = 1.0f / dwt_quant_step(&dwt_7_9_YCbCr_threshold[0], scale, 2, adm_norm_view_dist,
	        adm_ref_display_height);
	}
	float rfactor1[3] = { factor1, factor1, factor2 };

    const uint32_t rfactor[3] = { (uint32_t)(rfactor1[0] * pow(2, 32)),
                                  (uint32_t)(rfactor1[1] * pow(2, 32)),
                                  (uint32_t)(rfactor1[2] * pow(2, 32)) };

    const uint32_t shift_dst[3] = { 28, 28, 28 };
    const uint32_t shift_flt[3] = { 32, 32, 32 };
    int32_t add_bef_shift_dst[3], add_bef_shift_flt[3];

    for (unsigned idx = 0; idx < 3; ++idx) {
        add_bef_shift_dst[idx] = (1u << (shift_dst[idx] - 1));
        add_bef_shift_flt[idx] = (1u << (shift_flt[idx] - 1));

    }

    uint32_t shift_cub = (uint32_t)ceil(log2(w));
    uint32_t add_shift_cub = (uint32_t)pow(2, (shift_cub - 1));

    uint32_t shift_inner_accum = (uint32_t)ceil(log2(h));
    uint32_t add_shift_inner_accum = (uint32_t)pow(2, (shift_inner_accum - 1));

    float final_shift[3] = { (float)pow(2,(45 - shift_cub - shift_inner_accum)),
                             (float)pow(2,(39 - shift_cub - shift_inner_accum)),
                             (float)pow(2,(36 - shift_cub - shift_inner_accum)) };

    const int32_t shift_sq = 30;
    const int32_t add_shift_sq = 536870912; //2^29
    const int32_t shift_sub = 0;
    int32_t *angles[3] = { csf_a->band_h, csf_a->band_v, csf_a->band_d };
    int32_t *flt_angles[3] = { csf_f->band_h, csf_f->band_v, csf_f->band_d };

    /* The computation of the scales is not required for the regions which lie
     * outside the frame borders
     */
    const int left = w * ADM_BORDER_FACTOR - 0.5;
    const int top = h * ADM_BORDER_FACTOR - 0.5;
    const int right = w - left;
    const int bottom = h - top;

    const int start_col = (left > 1) ? left : 1;
    const int end_col = (right < (w - 1)) ? right : (w - 1);
    const int start_row = (top > 1) ? top : 1;
    const int end_row = (bottom < (h - 1)) ? bottom : (h - 1);

    int i, j;
    int32_t xh, xv, xd, thr;
    int32_t xh_sq, xv_sq, xd_sq;
    int64_t val;
    int64_t accum_h = 0, accum_v = 0, accum_d = 0;
    int64_t accum_inner_h = 0, accum_inner_v = 0, accum_inner_d = 0;
    /* i=0,j=0 */
    if ((top <= 0) && (left <= 0))
    {
        xh = (int32_t)((((int64_t)src->band_h[0] * rfactor[0]) + add_bef_shift_dst[scale - 1])
            >> shift_dst[scale - 1]);
        xv = (int32_t)((((int64_t)src->band_v[0] * rfactor[1]) + add_bef_shift_dst[scale - 1])
            >> shift_dst[scale - 1]);
        xd = (int32_t)((((int64_t)src->band_d[0] * rfactor[2]) + add_bef_shift_dst[scale - 1])
            >> shift_dst[scale - 1]);
        I4_ADM_CM_THRESH_S_0_0(angles, flt_angles, csf_a_stride, &thr, w, h, 0, 0,
                                       add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

        I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_h);
        I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_v);
        I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_d);
    }

    /* i=0, j */
    if (top <= 0)
    {
        for (j = start_col; j < end_col; ++j)
        {
            xh = (int32_t)((((int64_t)src->band_h[j] * rfactor[0]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xv = (int32_t)((((int64_t)src->band_v[j] * rfactor[1]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xd = (int32_t)((((int64_t)src->band_d[j] * rfactor[2]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            I4_ADM_CM_THRESH_S_0_J(angles, flt_angles, csf_a_stride, &thr, w, h,
                                           0, j, add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

            I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_h);
            I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_v);
            I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_d);
        }
    }

    /* i=0,j=w-1 */
    if ((top <= 0) && (right > (w - 1)))
    {
        xh = (int32_t)((((int64_t)src->band_h[w - 1] * rfactor[0]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        xv = (int32_t)((((int64_t)src->band_v[w - 1] * rfactor[1]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        xd = (int32_t)((((int64_t)src->band_d[w - 1] * rfactor[2]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        I4_ADM_CM_THRESH_S_0_W_M_1(angles, flt_angles, csf_a_stride, &thr, w, h, 0, (w - 1),
                                           add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

        I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_h);
        I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_v);
        I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_d);
    }

    accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
    accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
    accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;

    if ((left > 0) && (right <= (w - 1))) /* Completely within frame */
    {
        for (i = start_row; i < end_row; ++i)
        {
            accum_inner_h = 0;
            accum_inner_v = 0;
            accum_inner_d = 0;
            for (j = start_col; j < end_col; ++j)
            {

                xh = (int32_t)((((int64_t)src->band_h[i * src_stride + j] * rfactor[0]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                xv = (int32_t)((((int64_t)src->band_v[i * src_stride + j] * rfactor[1]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                xd = (int32_t)((((int64_t)src->band_d[i * src_stride + j] * rfactor[2]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                I4_ADM_CM_THRESH_S_I_J(angles, flt_angles, csf_a_stride, &thr, w, h, i, j,
                                               add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

                I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_h);
                I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_v);
                I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_d);
            }
            accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
            accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
            accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;
        }
    }
    else if ((left <= 0) && (right <= (w - 1))) /* Right border within frame, left outside */
    {
        for (i = start_row; i < end_row; ++i)
        {
            accum_inner_h = 0;
            accum_inner_v = 0;
            accum_inner_d = 0;

            /* j = 0 */
            xh = (int32_t)((((int64_t)src->band_h[i * src_stride] * rfactor[0]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xv = (int32_t)((((int64_t)src->band_v[i * src_stride] * rfactor[1]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xd = (int32_t)((((int64_t)src->band_d[i * src_stride] * rfactor[2]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            I4_ADM_CM_THRESH_S_I_0(angles, flt_angles, csf_a_stride, &thr, w, h, i, 0,
                                           add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

            I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_h);
            I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_v);
            I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_d);

            /* j within frame */
            for (j = start_col; j < end_col; ++j)
            {
                xh = (int32_t)((((int64_t)src->band_h[i * src_stride + j] * rfactor[0]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                xv = (int32_t)((((int64_t)src->band_v[i * src_stride + j] * rfactor[1]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                xd = (int32_t)((((int64_t)src->band_d[i * src_stride + j] * rfactor[2]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                I4_ADM_CM_THRESH_S_I_J(angles, flt_angles, csf_a_stride, &thr, w, h, i, j,
                                               add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

                I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_h);
                I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_v);
                I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_d);
            }
            accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
            accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
            accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;
        }
    }
    else if ((left > 0) && (right > (w - 1))) /* Left border within frame, right outside */
    {
        for (i = start_row; i < end_row; ++i)
        {
            accum_inner_h = 0;
            accum_inner_v = 0;
            accum_inner_d = 0;
            /* j within frame */
            for (j = start_col; j < end_col; ++j)
            {
                xh = (int32_t)((((int64_t)src->band_h[i * src_stride + j] * rfactor[0]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                xv = (int32_t)((((int64_t)src->band_v[i * src_stride + j] * rfactor[1]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                xd = (int32_t)((((int64_t)src->band_d[i * src_stride + j] * rfactor[2]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                I4_ADM_CM_THRESH_S_I_J(angles, flt_angles, csf_a_stride, &thr, w, h, i, j,
                                               add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

                I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_h);
                I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_v);
                I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_d);
            }
            /* j = w-1 */
            xh = (int32_t)((((int64_t)src->band_h[i * src_stride + w - 1] * rfactor[i * src_stride + w - 1])
                + add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xv = (int32_t)((((int64_t)src->band_v[i * src_stride + w - 1] * rfactor[i * src_stride + w - 1])
                + add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xd = (int32_t)((((int64_t)src->band_d[i * src_stride + w - 1] * rfactor[i * src_stride + w - 1])
                + add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            I4_ADM_CM_THRESH_S_I_W_M_1(angles, flt_angles, csf_a_stride, &thr, w, h, i, (w - 1),
                                               add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

            I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_h);
            I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_v);
            I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_d);

            accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
            accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
            accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;
        }
    }
    else /* Both borders outside frame */
    {
        for (i = start_row; i < end_row; ++i)
        {
            accum_inner_h = 0;
            accum_inner_v = 0;
            accum_inner_d = 0;

            /* j = 0 */
            xh = (int32_t)((((int64_t)src->band_h[i * src_stride] * rfactor[0]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xv = (int32_t)((((int64_t)src->band_v[i * src_stride] * rfactor[1]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xd = (int32_t)((((int64_t)src->band_d[i * src_stride] * rfactor[2]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            I4_ADM_CM_THRESH_S_I_0(angles, flt_angles, csf_a_stride, &thr, w, h, i, 0,
                                           add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

            I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_h);
            I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_v);
            I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_d);

            /* j within frame */
            for (j = start_col; j < end_col; ++j)
            {
                xh = (int32_t)((((int64_t)src->band_h[i * src_stride + j] * rfactor[0]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                xv = (int32_t)((((int64_t)src->band_v[i * src_stride + j] * rfactor[1]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                xd = (int32_t)((((int64_t)src->band_d[i * src_stride + j] * rfactor[2]) +
                    add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
                I4_ADM_CM_THRESH_S_I_J(angles, flt_angles, csf_a_stride, &thr, w, h, i, j,
                                               add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

                I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_h);
                I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_v);
                I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                      add_shift_cub, shift_cub, accum_inner_d);
            }
            /* j = w-1 */
            xh = (int32_t)((((int64_t)src->band_h[i * src_stride + w - 1] * rfactor[0]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xv = (int32_t)((((int64_t)src->band_v[i * src_stride + w - 1] * rfactor[1]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xd = (int32_t)((((int64_t)src->band_d[i * src_stride + w - 1] * rfactor[2]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            I4_ADM_CM_THRESH_S_I_W_M_1(angles, flt_angles, csf_a_stride, &thr, w, h, i, (w - 1),
                                               add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

            I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_h);
            I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_v);
            I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_d);

            accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
            accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
            accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;
        }
    }
    accum_inner_h = 0;
    accum_inner_v = 0;
    accum_inner_d = 0;

    /* i=h-1,j=0 */
    if ((bottom > (h - 1)) && (left <= 0))
    {
        xh = (int32_t)((((int64_t)src->band_h[(h - 1) * src_stride] * rfactor[0]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        xv = (int32_t)((((int64_t)src->band_v[(h - 1) * src_stride] * rfactor[1]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        xd = (int32_t)((((int64_t)src->band_d[(h - 1) * src_stride] * rfactor[2]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        I4_ADM_CM_THRESH_S_H_M_1_0(angles, flt_angles, csf_a_stride, &thr, w, h, (h - 1), 0,
                                           add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

        I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_h);
        I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_v);
        I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_d);
    }

    /* i=h-1,j */
    if (bottom > (h - 1))
    {
        for (j = start_col; j < end_col; ++j)
        {
            xh = (int32_t)((((int64_t)src->band_h[(h - 1) * src_stride + j] * rfactor[0]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xv = (int32_t)((((int64_t)src->band_v[(h - 1) * src_stride + j] * rfactor[1]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            xd = (int32_t)((((int64_t)src->band_d[(h - 1) * src_stride + j] * rfactor[2]) +
                add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
            I4_ADM_CM_THRESH_S_H_M_1_J(angles, flt_angles, csf_a_stride, &thr, w, h, (h - 1), j,
                                               add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

            I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_h);
            I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_v);
            I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                                  add_shift_cub, shift_cub, accum_inner_d);
        }
    }

    /* i-h-1,j=w-1 */
    if ((bottom > (h - 1)) && (right > (w - 1)))
    {
        xh = (int32_t)((((int64_t)src->band_h[(h - 1) * src_stride + w - 1] * rfactor[0]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        xv = (int32_t)((((int64_t)src->band_v[(h - 1) * src_stride + w - 1] * rfactor[1]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        xd = (int32_t)((((int64_t)src->band_d[(h - 1) * src_stride + w - 1] * rfactor[2]) +
            add_bef_shift_dst[scale - 1]) >> shift_dst[scale - 1]);
        I4_ADM_CM_THRESH_S_H_M_1_W_M_1(angles, flt_angles, csf_a_stride, &thr, w, h, (h - 1),
                                               (w - 1), add_bef_shift_flt[scale - 1], shift_flt[scale - 1]);

        I4_ADM_CM_ACCUM_ROUND(xh, thr, shift_sub, xh_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_h);
        I4_ADM_CM_ACCUM_ROUND(xv, thr, shift_sub, xv_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_v);
        I4_ADM_CM_ACCUM_ROUND(xd, thr, shift_sub, xd_sq, add_shift_sq, shift_sq, val,
                              add_shift_cub, shift_cub, accum_inner_d);
    }
    accum_h += (accum_inner_h + add_shift_inner_accum) >> shift_inner_accum;
    accum_v += (accum_inner_v + add_shift_inner_accum) >> shift_inner_accum;
    accum_d += (accum_inner_d + add_shift_inner_accum) >> shift_inner_accum;

    /**
     * Converted to floating-point for calculating the final scores
     * Final shifts is calculated from 3*(shifts_from_previous_stage(i.e src comes from dwt)+32)-total_shifts_done_in_this_function
     */
    float f_accum_h = (float)(accum_h / final_shift[scale - 1]);
    float f_accum_v = (float)(accum_v / final_shift[scale - 1]);
    float f_accum_d = (float)(accum_d / final_shift[scale - 1]);

    // TODO: if we integrate adm_p_norm, adm_p_norm=3.0f here
    // This would mean:
    // float num_scale_h = powf(f_accum_h, 1.0f / adm_p_norm) + powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / adm_p_norm);
    // float num_scale_v = powf(f_accum_v, 1.0f / adm_p_norm) + powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / adm_p_norm);
    // float num_scale_d = powf(f_accum_d, 1.0f / adm_p_norm) + powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / adm_p_norm);
    float num_scale_h = powf(f_accum_h, 1.0f / 3.0f) + powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / 3.0f);
    float num_scale_v = powf(f_accum_v, 1.0f / 3.0f) + powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / 3.0f);
    float num_scale_d = powf(f_accum_d, 1.0f / 3.0f) + powf((bottom - top) * (right - left) * adm_noise_weight, 1.0f / 3.0f);

    return (num_scale_h + num_scale_v + num_scale_d);
}

__device__ static void i16_to_i32(adm_dwt_band_t *src, i4_adm_dwt_band_t *dst,
                       int w, int h, int stride)
{
    for (int i = 0; i < (h + 1) / 2; ++i) {
        int16_t *src_band_a_addr = &src->band_a[i * stride];
        int32_t *dst_band_a_addr = &dst->band_a[i * stride];
        for (int j = 0; j < (w + 1) / 2; ++j) {
            *(dst_band_a_addr++) = (int32_t)(*(src_band_a_addr++));
        }
    }
}

__device__ void adm_dwt2_8(const uint8_t *src, const adm_dwt_band_t *dst,
                       AdmBuffer *buf, int w, int h, int src_stride,
                       int dst_stride)
{
    const int16_t *filter_lo = dwt2_db2_coeffs_lo;
    const int16_t *filter_hi = dwt2_db2_coeffs_hi;

    const int16_t shift_VP = 8;
    const int16_t shift_HP = 16;
    const int32_t add_shift_VP = 128;
    const int32_t add_shift_HP = 32768;

    int **ind_y = buf->ind_y;
    int **ind_x = buf->ind_x;

    int16_t *tmplo = (int16_t *)buf->tmp_ref;
    int16_t *tmphi = tmplo + w;
    int32_t accum;

    for (int i = 0; i < (h + 1) / 2; ++i) {
        /* Vertical pass. */
        for (int j = 0; j < w; ++j) {
            uint16_t u_s0 = src[ind_y[0][i] * src_stride + j];
            uint16_t u_s1 = src[ind_y[1][i] * src_stride + j];
            uint16_t u_s2 = src[ind_y[2][i] * src_stride + j];
            uint16_t u_s3 = src[ind_y[3][i] * src_stride + j];

            accum = 0;
            accum += (int32_t)filter_lo[0] * (int32_t)u_s0;
            accum += (int32_t)filter_lo[1] * (int32_t)u_s1;
            accum += (int32_t)filter_lo[2] * (int32_t)u_s2;
            accum += (int32_t)filter_lo[3] * (int32_t)u_s3;

            /* normalizing is done for range from(0 to N) to (-N/2 to N/2) */
            accum -= (int32_t)dwt2_db2_coeffs_lo_sum * add_shift_VP;

            tmplo[j] = (accum + add_shift_VP) >> shift_VP;

            accum = 0;
            accum += (int32_t)filter_hi[0] * (int32_t)u_s0;
            accum += (int32_t)filter_hi[1] * (int32_t)u_s1;
            accum += (int32_t)filter_hi[2] * (int32_t)u_s2;
            accum += (int32_t)filter_hi[3] * (int32_t)u_s3;

            /* normalizing is done for range from(0 to N) to (-N/2 to N/2) */
            accum -= (int32_t)dwt2_db2_coeffs_hi_sum * add_shift_VP;

            tmphi[j] = (accum + add_shift_VP) >> shift_VP;
        }

        /* Horizontal pass (lo and hi). */
        for (int j = 0; j < (w + 1) / 2; ++j) {
            int j0 = ind_x[0][j];
            int j1 = ind_x[1][j];
            int j2 = ind_x[2][j];
            int j3 = ind_x[3][j];

            int16_t s0 = tmplo[j0];
            int16_t s1 = tmplo[j1];
            int16_t s2 = tmplo[j2];
            int16_t s3 = tmplo[j3];

            accum = 0;
            accum += (int32_t)filter_lo[0] * s0;
            accum += (int32_t)filter_lo[1] * s1;
            accum += (int32_t)filter_lo[2] * s2;
            accum += (int32_t)filter_lo[3] * s3;
            dst->band_a[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;

            accum = 0;
            accum += (int32_t)filter_hi[0] * s0;
            accum += (int32_t)filter_hi[1] * s1;
            accum += (int32_t)filter_hi[2] * s2;
            accum += (int32_t)filter_hi[3] * s3;
            dst->band_v[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;

            s0 = tmphi[j0];
            s1 = tmphi[j1];
            s2 = tmphi[j2];
            s3 = tmphi[j3];

            accum = 0;
            accum += (int32_t)filter_lo[0] * s0;
            accum += (int32_t)filter_lo[1] * s1;
            accum += (int32_t)filter_lo[2] * s2;
            accum += (int32_t)filter_lo[3] * s3;
            dst->band_h[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;

            accum = 0;
            accum += (int32_t)filter_hi[0] * s0;
            accum += (int32_t)filter_hi[1] * s1;
            accum += (int32_t)filter_hi[2] * s2;
            accum += (int32_t)filter_hi[3] * s3;
            dst->band_d[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;
        }
    }
}

__device__ static void adm_dwt2_8_lo(const uint8_t *src, const adm_dwt_band_t *dst,
                       AdmBuffer *buf, int w, int h, int src_stride,
                       int dst_stride)
{
    //8 bit only low-pass filtering using DWT2 
    const int16_t *filter_lo = dwt2_db2_coeffs_lo;

    const int16_t shift_VP = 8;
    const int16_t shift_HP = 16;
    const int32_t add_shift_VP = 128;
    const int32_t add_shift_HP = 32768;

    int **ind_y = buf->ind_y;
    int **ind_x = buf->ind_x;

    int16_t *tmplo = (int16_t *)buf->tmp_ref;
    int32_t accum;

    for (int i = 0; i < (h + 1) / 2; ++i) {
        /* Vertical pass. */
        for (int j = 0; j < w; ++j) {
            uint16_t u_s0 = src[ind_y[0][i] * src_stride + j];
            uint16_t u_s1 = src[ind_y[1][i] * src_stride + j];
            uint16_t u_s2 = src[ind_y[2][i] * src_stride + j];
            uint16_t u_s3 = src[ind_y[3][i] * src_stride + j];

            accum = 0;
            accum += (int32_t)filter_lo[0] * (int32_t)u_s0;
            accum += (int32_t)filter_lo[1] * (int32_t)u_s1;
            accum += (int32_t)filter_lo[2] * (int32_t)u_s2;
            accum += (int32_t)filter_lo[3] * (int32_t)u_s3;

            /* normalizing is done for range from(0 to N) to (-N/2 to N/2) */
            accum -= (int32_t)dwt2_db2_coeffs_lo_sum * add_shift_VP;

            tmplo[j] = (accum + add_shift_VP) >> shift_VP;
        }

        /* Horizontal pass */
        for (int j = 0; j < (w + 1) / 2; ++j) {
            int j0 = ind_x[0][j];
            int j1 = ind_x[1][j];
            int j2 = ind_x[2][j];
            int j3 = ind_x[3][j];

            int16_t s0 = tmplo[j0];
            int16_t s1 = tmplo[j1];
            int16_t s2 = tmplo[j2];
            int16_t s3 = tmplo[j3];

            accum = 0;
            accum += (int32_t)filter_lo[0] * s0;
            accum += (int32_t)filter_lo[1] * s1;
            accum += (int32_t)filter_lo[2] * s2;
            accum += (int32_t)filter_lo[3] * s3;
            dst->band_a[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;

        }
    }
}

__device__ static void adm_dwt2_16_lo(const uint16_t *src, const adm_dwt_band_t *dst, AdmBuffer *buf, int w, int h,
                        int src_stride, int dst_stride, int inp_size_bits)
{
    //16 bit only low-pass filtering using DWT2 
    const int16_t *filter_lo = dwt2_db2_coeffs_lo;

    const int16_t shift_VP = inp_size_bits;
    const int16_t shift_HP = 16;
    const int32_t add_shift_VP = 1 << (inp_size_bits - 1);
    const int32_t add_shift_HP = 32768;

    int **ind_y = buf->ind_y;
    int **ind_x = buf->ind_x;

    int16_t *tmplo = (int16_t *)buf->tmp_ref;
    int32_t accum;

    for (int i = 0; i < (h + 1) / 2; ++i) {
        /* Vertical pass. */
        for (int j = 0; j < w; ++j) {
            uint16_t u_s0 = src[ind_y[0][i] * src_stride + j];
            uint16_t u_s1 = src[ind_y[1][i] * src_stride + j];
            uint16_t u_s2 = src[ind_y[2][i] * src_stride + j];
            uint16_t u_s3 = src[ind_y[3][i] * src_stride + j];

            accum = 0;
            accum += (int32_t)filter_lo[0] * (int32_t)u_s0;
            accum += (int32_t)filter_lo[1] * (int32_t)u_s1;
            accum += (int32_t)filter_lo[2] * (int32_t)u_s2;
            accum += (int32_t)filter_lo[3] * (int32_t)u_s3;

            /* normalizing is done for range from(0 to N) to (-N/2 to N/2) */
            accum -= (int32_t)dwt2_db2_coeffs_lo_sum * add_shift_VP;

            tmplo[j] = (accum + add_shift_VP) >> shift_VP;
        }

        /* Horizontal pass (lo and hi). */
        for (int j = 0; j < (w + 1) / 2; ++j) {
            int j0 = ind_x[0][j];
            int j1 = ind_x[1][j];
            int j2 = ind_x[2][j];
            int j3 = ind_x[3][j];

            int16_t s0 = tmplo[j0];
            int16_t s1 = tmplo[j1];
            int16_t s2 = tmplo[j2];
            int16_t s3 = tmplo[j3];

            accum = 0;
            accum += (int32_t)filter_lo[0] * s0;
            accum += (int32_t)filter_lo[1] * s1;
            accum += (int32_t)filter_lo[2] * s2;
            accum += (int32_t)filter_lo[3] * s3;
            dst->band_a[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;
        }
    }
}

__device__ void adm_dwt2_16(const uint16_t *src, const adm_dwt_band_t *dst, AdmBuffer *buf, int w, int h,
                        int src_stride, int dst_stride, int inp_size_bits)
{
    const int16_t *filter_lo = dwt2_db2_coeffs_lo;
    const int16_t *filter_hi = dwt2_db2_coeffs_hi;

    const int16_t shift_VP = inp_size_bits;
    const int16_t shift_HP = 16;
    const int32_t add_shift_VP = 1 << (inp_size_bits - 1);
    const int32_t add_shift_HP = 32768;

    int **ind_y = buf->ind_y;
    int **ind_x = buf->ind_x;

    int16_t *tmplo = (int16_t *)buf->tmp_ref;
    int16_t *tmphi = tmplo + w;
    int32_t accum;

    for (int i = 0; i < (h + 1) / 2; ++i) {
        /* Vertical pass. */
        for (int j = 0; j < w; ++j) {
            uint16_t u_s0 = src[ind_y[0][i] * src_stride + j];
            uint16_t u_s1 = src[ind_y[1][i] * src_stride + j];
            uint16_t u_s2 = src[ind_y[2][i] * src_stride + j];
            uint16_t u_s3 = src[ind_y[3][i] * src_stride + j];

            accum = 0;
            accum += (int32_t)filter_lo[0] * (int32_t)u_s0;
            accum += (int32_t)filter_lo[1] * (int32_t)u_s1;
            accum += (int32_t)filter_lo[2] * (int32_t)u_s2;
            accum += (int32_t)filter_lo[3] * (int32_t)u_s3;

            /* normalizing is done for range from(0 to N) to (-N/2 to N/2) */
            accum -= (int32_t)dwt2_db2_coeffs_lo_sum * add_shift_VP;

            tmplo[j] = (accum + add_shift_VP) >> shift_VP;

            accum = 0;
            accum += (int32_t)filter_hi[0] * (int32_t)u_s0;
            accum += (int32_t)filter_hi[1] * (int32_t)u_s1;
            accum += (int32_t)filter_hi[2] * (int32_t)u_s2;
            accum += (int32_t)filter_hi[3] * (int32_t)u_s3;

            /* normalizing is done for range from(0 to N) to (-N/2 to N/2) */
            accum -= (int32_t)dwt2_db2_coeffs_hi_sum * add_shift_VP;

            tmphi[j] = (accum + add_shift_VP) >> shift_VP;
        }

        /* Horizontal pass (lo and hi). */
        for (int j = 0; j < (w + 1) / 2; ++j) {
            int j0 = ind_x[0][j];
            int j1 = ind_x[1][j];
            int j2 = ind_x[2][j];
            int j3 = ind_x[3][j];

            int16_t s0 = tmplo[j0];
            int16_t s1 = tmplo[j1];
            int16_t s2 = tmplo[j2];
            int16_t s3 = tmplo[j3];

            accum = 0;
            accum += (int32_t)filter_lo[0] * s0;
            accum += (int32_t)filter_lo[1] * s1;
            accum += (int32_t)filter_lo[2] * s2;
            accum += (int32_t)filter_lo[3] * s3;
            dst->band_a[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;

            accum = 0;
            accum += (int32_t)filter_hi[0] * s0;
            accum += (int32_t)filter_hi[1] * s1;
            accum += (int32_t)filter_hi[2] * s2;
            accum += (int32_t)filter_hi[3] * s3;
            dst->band_v[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;

            s0 = tmphi[j0];
            s1 = tmphi[j1];
            s2 = tmphi[j2];
            s3 = tmphi[j3];

            accum = 0;
            accum += (int32_t)filter_lo[0] * s0;
            accum += (int32_t)filter_lo[1] * s1;
            accum += (int32_t)filter_lo[2] * s2;
            accum += (int32_t)filter_lo[3] * s3;
            dst->band_h[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;

            accum = 0;
            accum += (int32_t)filter_hi[0] * s0;
            accum += (int32_t)filter_hi[1] * s1;
            accum += (int32_t)filter_hi[2] * s2;
            accum += (int32_t)filter_hi[3] * s3;
            dst->band_d[i * dst_stride + j] = (accum + add_shift_HP) >> shift_HP;
        }
    }
}

__device__ void adm_dwt2_s123_combined(const int32_t *i4_ref_scale, const int32_t *i4_curr_dis,
                                   AdmBuffer *buf, int w, int h, int ref_stride,
                                   int dis_stride, int dst_stride, int scale)
{
    const i4_adm_dwt_band_t *i4_ref_dwt2 = &buf->i4_ref_dwt2;
    const i4_adm_dwt_band_t *i4_dis_dwt2 = &buf->i4_dis_dwt2;
    int **ind_y = buf->ind_y;
    int **ind_x = buf->ind_x;

    const int16_t *filter_lo = dwt2_db2_coeffs_lo;
    const int16_t *filter_hi = dwt2_db2_coeffs_hi;

    const int32_t add_bef_shift_round_VP[3] = { 0, 32768, 32768 };
    const int32_t add_bef_shift_round_HP[3] = { 16384, 32768, 16384 };
    const int16_t shift_VerticalPass[3] = { 0, 16, 16 };
    const int16_t shift_HorizontalPass[3] = { 15, 16, 15 };

    int32_t *tmplo_ref = buf->tmp_ref;
    int32_t *tmphi_ref = tmplo_ref + w;
    int32_t *tmplo_dis = tmphi_ref + w;
    int32_t *tmphi_dis = tmplo_dis + w;
    int32_t s10, s11, s12, s13;

    int64_t accum_ref;

    for (int i = 0; i < (h + 1) / 2; ++i)
    {
        /* Vertical pass. */
        for (int j = 0; j < w; ++j)
        {
            s10 = i4_ref_scale[ind_y[0][i] * ref_stride + j];
            s11 = i4_ref_scale[ind_y[1][i] * ref_stride + j];
            s12 = i4_ref_scale[ind_y[2][i] * ref_stride + j];
            s13 = i4_ref_scale[ind_y[3][i] * ref_stride + j];
            accum_ref = 0;
            accum_ref += (int64_t)filter_lo[0] * s10;
            accum_ref += (int64_t)filter_lo[1] * s11;
            accum_ref += (int64_t)filter_lo[2] * s12;
            accum_ref += (int64_t)filter_lo[3] * s13;
            tmplo_ref[j] = (int32_t)((accum_ref + add_bef_shift_round_VP[scale - 1])
                >> shift_VerticalPass[scale - 1]);
            accum_ref = 0;
            accum_ref += (int64_t)filter_hi[0] * s10;
            accum_ref += (int64_t)filter_hi[1] * s11;
            accum_ref += (int64_t)filter_hi[2] * s12;
            accum_ref += (int64_t)filter_hi[3] * s13;
            tmphi_ref[j] = (int32_t)((accum_ref + add_bef_shift_round_VP[scale - 1])
                >> shift_VerticalPass[scale - 1]);

            s10 = i4_curr_dis[ind_y[0][i] * dis_stride + j];
            s11 = i4_curr_dis[ind_y[1][i] * dis_stride + j];
            s12 = i4_curr_dis[ind_y[2][i] * dis_stride + j];
            s13 = i4_curr_dis[ind_y[3][i] * dis_stride + j];
            accum_ref = 0;
            accum_ref += (int64_t)filter_lo[0] * s10;
            accum_ref += (int64_t)filter_lo[1] * s11;
            accum_ref += (int64_t)filter_lo[2] * s12;
            accum_ref += (int64_t)filter_lo[3] * s13;
            tmplo_dis[j] = (int32_t)((accum_ref + add_bef_shift_round_VP[scale - 1])
                >> shift_VerticalPass[scale - 1]);
            accum_ref = 0;
            accum_ref += (int64_t)filter_hi[0] * s10;
            accum_ref += (int64_t)filter_hi[1] * s11;
            accum_ref += (int64_t)filter_hi[2] * s12;
            accum_ref += (int64_t)filter_hi[3] * s13;
            tmphi_dis[j] = (int32_t)((accum_ref + add_bef_shift_round_VP[scale - 1])
                >> shift_VerticalPass[scale - 1]);
        }
        /* Horizontal pass (lo and hi). */
        for (int j = 0; j < (w + 1) / 2; ++j)
        {
            int j0 = ind_x[0][j];
            int j1 = ind_x[1][j];
            int j2 = ind_x[2][j];
            int j3 = ind_x[3][j];

            s10 = tmplo_ref[j0];
            s11 = tmplo_ref[j1];
            s12 = tmplo_ref[j2];
            s13 = tmplo_ref[j3];

            accum_ref = 0;
            accum_ref += (int64_t)filter_lo[0] * s10;
            accum_ref += (int64_t)filter_lo[1] * s11;
            accum_ref += (int64_t)filter_lo[2] * s12;
            accum_ref += (int64_t)filter_lo[3] * s13;
            i4_ref_dwt2->band_a[i * dst_stride + j] = (int32_t)((accum_ref +
                add_bef_shift_round_HP[scale - 1]) >> shift_HorizontalPass[scale - 1]);

            accum_ref = 0;
            accum_ref += (int64_t)filter_hi[0] * s10;
            accum_ref += (int64_t)filter_hi[1] * s11;
            accum_ref += (int64_t)filter_hi[2] * s12;
            accum_ref += (int64_t)filter_hi[3] * s13;
            i4_ref_dwt2->band_v[i * dst_stride + j] = (int32_t)((accum_ref +
                add_bef_shift_round_HP[scale - 1]) >> shift_HorizontalPass[scale - 1]);

            s10 = tmphi_ref[j0];
            s11 = tmphi_ref[j1];
            s12 = tmphi_ref[j2];
            s13 = tmphi_ref[j3];

            accum_ref = 0;
            accum_ref += (int64_t)filter_lo[0] * s10;
            accum_ref += (int64_t)filter_lo[1] * s11;
            accum_ref += (int64_t)filter_lo[2] * s12;
            accum_ref += (int64_t)filter_lo[3] * s13;
            i4_ref_dwt2->band_h[i * dst_stride + j] = (int32_t)((accum_ref +
                add_bef_shift_round_HP[scale - 1]) >> shift_HorizontalPass[scale - 1]);

            accum_ref = 0;
            accum_ref += (int64_t)filter_hi[0] * s10;
            accum_ref += (int64_t)filter_hi[1] * s11;
            accum_ref += (int64_t)filter_hi[2] * s12;
            accum_ref += (int64_t)filter_hi[3] * s13;
            i4_ref_dwt2->band_d[i * dst_stride + j] = (int32_t)((accum_ref +
                add_bef_shift_round_HP[scale - 1]) >> shift_HorizontalPass[scale - 1]);

            s10 = tmplo_dis[j0];
            s11 = tmplo_dis[j1];
            s12 = tmplo_dis[j2];
            s13 = tmplo_dis[j3];

            accum_ref = 0;
            accum_ref += (int64_t)filter_lo[0] * s10;
            accum_ref += (int64_t)filter_lo[1] * s11;
            accum_ref += (int64_t)filter_lo[2] * s12;
            accum_ref += (int64_t)filter_lo[3] * s13;
            i4_dis_dwt2->band_a[i * dst_stride + j] = (int32_t)((accum_ref +
                add_bef_shift_round_HP[scale - 1]) >> shift_HorizontalPass[scale - 1]);

            accum_ref = 0;
            accum_ref += (int64_t)filter_hi[0] * s10;
            accum_ref += (int64_t)filter_hi[1] * s11;
            accum_ref += (int64_t)filter_hi[2] * s12;
            accum_ref += (int64_t)filter_hi[3] * s13;
            i4_dis_dwt2->band_v[i * dst_stride + j] = (int32_t)((accum_ref +
                add_bef_shift_round_HP[scale - 1]) >> shift_HorizontalPass[scale - 1]);

            s10 = tmphi_dis[j0];
            s11 = tmphi_dis[j1];
            s12 = tmphi_dis[j2];
            s13 = tmphi_dis[j3];

            accum_ref = 0;
            accum_ref += (int64_t)filter_lo[0] * s10;
            accum_ref += (int64_t)filter_lo[1] * s11;
            accum_ref += (int64_t)filter_lo[2] * s12;
            accum_ref += (int64_t)filter_lo[3] * s13;
            i4_dis_dwt2->band_h[i * dst_stride + j] = (int32_t)((accum_ref +
                add_bef_shift_round_HP[scale - 1]) >> shift_HorizontalPass[scale - 1]);

            accum_ref = 0;
            accum_ref += (int64_t)filter_hi[0] * s10;
            accum_ref += (int64_t)filter_hi[1] * s11;
            accum_ref += (int64_t)filter_hi[2] * s12;
            accum_ref += (int64_t)filter_hi[3] * s13;
            i4_dis_dwt2->band_d[i * dst_stride + j] = (int32_t)((accum_ref +
                add_bef_shift_round_HP[scale - 1]) >> shift_HorizontalPass[scale - 1]);
        }
    }
}

typedef struct {
    double score, num, den, aim;  // adm2, adm_num, adm_den, aim
    double scores[8];             // per-scale num/den pairs (scale0..3)
} AdmScore;

__device__ void integer_compute_adm(AdmState *s, VmafPicture *ref_pic, VmafPicture *dis_pic,
                         AdmBuffer *buf, AdmScore out[2])
{
    // Evaluate ADM at one or two viewing distances (the second is used only
    // when adm_norm_view_dist_extra > 0). The DWT + decouple stages are
    // view-distance-independent, so they run once per scale; only the CSF
    // weighting + pooling is repeated per distance, reusing the shared buffers.
    // Everything below is derived from s; named locals keep the inner loop terse.
    const double nvd[2] = { s->adm_norm_view_dist, s->adm_norm_view_dist_extra };
    const int n_vd = (s->adm_norm_view_dist_extra > 0.0) ? 2 : 1;
    const double adm_enhn_gain_limit = s->adm_enhn_gain_limit;
    const double adm_csf_scale = s->adm_csf_scale;
    const double adm_csf_diag_scale = s->adm_csf_diag_scale;
    const double adm_noise_weight = s->adm_noise_weight;
    const int adm_ref_display_height = s->adm_ref_display_height;
    const int adm_csf_mode = s->adm_csf_mode;
    const bool adm_skip_aim = s->adm_skip_aim;
    const bool adm_skip_scale0 = s->adm_skip_scale0;

    int w = ref_pic->w[0];
    int h = ref_pic->h[0];

    const double numden_limit = 1e-10 * (w * h) / (1920.0 * 1080.0);

    size_t curr_ref_stride;
    size_t curr_dis_stride;
    size_t buf_stride = buf->ind_size_x >> 2;

    int32_t *i4_curr_ref_scale = NULL;
    int32_t *i4_curr_dis_scale = NULL;

    if (ref_pic->bpc == 8) {
        curr_ref_stride = ref_pic->stride[0];
        curr_dis_stride = dis_pic->stride[0];
    }
    else {
        curr_ref_stride = ref_pic->stride[0] >> 1;
        curr_dis_stride = dis_pic->stride[0] >> 1;
    }

    double num[2] = { 0, 0 };
    double den[2] = { 0, 0 };
    double aim_num[2] = { 0, 0 };

    for (unsigned scale = 0; scale < 4; ++scale) {
        dwt2_src_indices_filt(buf->ind_y, buf->ind_x, w, h);

        // DWT (and decouple) once per scale -- view-distance-independent.
        if (scale == 0) {
            if (adm_skip_scale0) {
                // skip scale 0 by downsampling by 2 using low-pass filters in DWT2
                if (ref_pic->bpc == 8) {
                    adm_dwt2_8_lo(ref_pic->data[0], &buf->ref_dwt2, buf, w, h,
                            curr_ref_stride, buf_stride);
                    adm_dwt2_8_lo(dis_pic->data[0], &buf->dis_dwt2, buf, w, h,
                            curr_dis_stride, buf_stride);
                }
                else {
                    adm_dwt2_16_lo(ref_pic->data[0], &buf->ref_dwt2, buf, w, h,
                                curr_ref_stride, buf_stride, ref_pic->bpc);
                    adm_dwt2_16_lo(dis_pic->data[0], &buf->dis_dwt2, buf, w, h,
                                curr_dis_stride, buf_stride, dis_pic->bpc);
                }

                i16_to_i32(&buf->ref_dwt2, &buf->i4_ref_dwt2, w, h, buf_stride);
                i16_to_i32(&buf->dis_dwt2, &buf->i4_dis_dwt2, w, h, buf_stride);

                w = (w + 1) / 2;
                h = (h + 1) / 2;
            }
            else {
                if (ref_pic->bpc == 8) {
                    s->dwt2_8(ref_pic->data[0], &buf->ref_dwt2, buf, w, h,
                              curr_ref_stride, buf_stride);
                    s->dwt2_8(dis_pic->data[0], &buf->dis_dwt2, buf, w, h,
                              curr_dis_stride, buf_stride);
                }
                else {
                    s->dwt2_16(ref_pic->data[0], &buf->ref_dwt2, buf, w, h,
                                curr_ref_stride, buf_stride, ref_pic->bpc);
                    s->dwt2_16(dis_pic->data[0], &buf->dis_dwt2, buf, w, h,
                                curr_dis_stride, buf_stride, dis_pic->bpc);
                }

                i16_to_i32(&buf->ref_dwt2, &buf->i4_ref_dwt2, w, h, buf_stride);
                i16_to_i32(&buf->dis_dwt2, &buf->i4_dis_dwt2, w, h, buf_stride);

                w = (w + 1) / 2;
                h = (h + 1) / 2;

                s->adm_decouple(buf, w, h, buf_stride, adm_enhn_gain_limit, div_lookup);
            }
        }
        else {
            s->adm_dwt2_s123_combined(i4_curr_ref_scale, i4_curr_dis_scale, buf, w, h, curr_ref_stride,
                                   curr_dis_stride, buf_stride, scale);

            w = (w + 1) / 2;
            h = (h + 1) / 2;

            s->adm_decouple_s123(buf, w, h, buf_stride, adm_enhn_gain_limit, div_lookup);
        }

        // CSF weighting + pooling, once per viewing distance. Running the passes
        // back-to-back is safe: CSF only writes csf_a/csf_f and leaves the
        // decouple buffers it reads unchanged, so the passes are independent.
        for (int v = 0; v < n_vd; v++) {
            float num_scale = 0.0;
            float den_scale = 0.0;
            float aim_num_scale = 0.0;

            if (scale == 0 && adm_skip_scale0) {
                den_scale = 1e-10;  // avoid divide by zero
            }
            else if (scale == 0) {
                den_scale = s->adm_csf_den_scale(&buf->ref_dwt2, w, h, buf_stride,
                                    nvd[v], adm_ref_display_height,
                                    adm_csf_mode, adm_csf_scale,
                                    adm_csf_diag_scale, adm_noise_weight);

                s->adm_csf(buf, w, h, buf_stride, nvd[v],
                           adm_ref_display_height, adm_csf_mode, adm_csf_scale,
                           adm_csf_diag_scale, false);

                num_scale = s->adm_cm(buf, w, h, buf_stride, buf_stride,
                                nvd[v], adm_ref_display_height,
                                adm_csf_mode, adm_csf_scale,
                                adm_csf_diag_scale, adm_noise_weight, false);

                if (!adm_skip_aim) {
                    s->adm_csf(buf, w, h, buf_stride, nvd[v],
                               adm_ref_display_height, adm_csf_mode,
                               adm_csf_scale, adm_csf_diag_scale, true);

                    aim_num_scale = s->adm_cm(buf, w, h, buf_stride, buf_stride,
                                    nvd[v], adm_ref_display_height,
                                    adm_csf_mode, adm_csf_scale,
                                    adm_csf_diag_scale, 0.0, true);
                }
            }
            else {
                den_scale = s->adm_csf_den_s123(
                        &buf->i4_ref_dwt2, scale, w, h, buf_stride,
                        nvd[v], adm_ref_display_height,
                        adm_csf_mode, adm_csf_scale, adm_csf_diag_scale,
                        adm_noise_weight);

                s->i4_adm_csf(buf, scale, w, h, buf_stride, nvd[v],
                              adm_ref_display_height, adm_csf_mode, adm_csf_scale,
                              adm_csf_diag_scale, false);

                num_scale = s->i4_adm_cm(buf, w, h, buf_stride, buf_stride, scale,
                                 nvd[v], adm_ref_display_height,
                                 adm_csf_mode, adm_csf_scale, adm_csf_diag_scale,
                                 adm_noise_weight, false);

                if (!adm_skip_aim) {
                    s->i4_adm_csf(buf, scale, w, h, buf_stride,
                                  nvd[v], adm_ref_display_height, adm_csf_mode,
                                  adm_csf_scale, adm_csf_diag_scale, true);

                    aim_num_scale = s->i4_adm_cm(buf, w, h, buf_stride, buf_stride,
                                 scale, nvd[v], adm_ref_display_height,
                                 adm_csf_mode, adm_csf_scale, adm_csf_diag_scale,
                                 0.0, true);
                }
            }

            num[v] += num_scale;
            den[v] += den_scale;
            aim_num[v] += aim_num_scale;

            out[v].scores[2 * scale + 0] = num_scale;
            out[v].scores[2 * scale + 1] = den_scale;
        }

        i4_curr_ref_scale = buf->i4_ref_dwt2.band_a;
        i4_curr_dis_scale = buf->i4_dis_dwt2.band_a;

        curr_ref_stride = buf_stride;
        curr_dis_stride = buf_stride;
    }

    for (int v = 0; v < n_vd; v++) {
        double num_v = num[v] < numden_limit ? 0 : num[v];
        double den_v = den[v] < numden_limit ? 0 : den[v];

        if (den_v == 0.0) {
            out[v].score = 1.0f;
        }
        else {
            // normalize AIM score by the DLM denominator
            out[v].aim = aim_num[v] / den_v;
            out[v].score = num_v / den_v;
        }
        out[v].num = num_v;
        out[v].den = den_v;
    }
}

__device__ static inline Pointer init_dwt_band(adm_dwt_band_t *band, char *data_top, size_t stride)
{
    band->band_a = (int16_t *)data_top; data_top += stride;
    band->band_h = (int16_t *)data_top; data_top += stride;
    band->band_v = (int16_t *)data_top; data_top += stride;
    band->band_d = (int16_t *)data_top; data_top += stride;
    return data_top;
}

__device__ static inline Pointer init_index(int32_t **index, char *data_top, size_t stride)
{
    index[0] = (int32_t *)data_top; data_top += stride;
    index[1] = (int32_t *)data_top; data_top += stride;
    index[2] = (int32_t *)data_top; data_top += stride;
    index[3] = (int32_t *)data_top; data_top += stride;
    return data_top;
}

__device__ static inline Pointer i4_init_dwt_band(i4_adm_dwt_band_t *band, char *data_top, size_t stride)
{
    band->band_a = (int32_t *)data_top; data_top += stride;
    band->band_h = (int32_t *)data_top; data_top += stride;
    band->band_v = (int32_t *)data_top; data_top += stride;
    band->band_d = (int32_t *)data_top; data_top += stride;
    return data_top;
}

__device__ static inline Pointer init_dwt_band_hvd(adm_dwt_band_t *band, char *data_top, size_t stride)
{
    band->band_a = NULL;
    band->band_h = (int16_t *)data_top; data_top += stride;
    band->band_v = (int16_t *)data_top; data_top += stride;
    band->band_d = (int16_t *)data_top; data_top += stride;
    return data_top;
}

__device__ static inline Pointer i4_init_dwt_band_hvd(i4_adm_dwt_band_t *band, char *data_top, size_t stride)
{
    band->band_a = NULL;
    band->band_h = (int32_t *)data_top; data_top += stride;
    band->band_v = (int32_t *)data_top; data_top += stride;
    band->band_d = (int32_t *)data_top; data_top += stride;
    return data_top;
}

__device__ int adm_buffer_alloc(AdmBuffer *buf, int w, int h)
{
    memset(buf, 0, sizeof(*buf));

    buf->ind_size_x   = ALIGN_CEIL(((w + 1) / 2) * sizeof(int32_t));
    buf->ind_size_y   = ALIGN_CEIL(((h + 1) / 2) * sizeof(int32_t));
    size_t buf_sz_one = buf->ind_size_x * ((h + 1) / 2);

    buf->data_buf = aligned_malloc(buf_sz_one * NUM_BUFS_ADM, MAX_ALIGN);
    if (!buf->data_buf) return -ENOMEM;
    memset(buf->data_buf, 0, buf_sz_one * NUM_BUFS_ADM);
    buf->tmp_ref = aligned_malloc(ALIGN_CEIL(w * sizeof(int32_t)) * 4, MAX_ALIGN);
    if (!buf->tmp_ref) return -ENOMEM;
    buf->buf_x_orig = aligned_malloc(buf->ind_size_x * 4, MAX_ALIGN);
    if (!buf->buf_x_orig) return -ENOMEM;
    buf->buf_y_orig = aligned_malloc(buf->ind_size_y * 4, MAX_ALIGN);
    if (!buf->buf_y_orig) return -ENOMEM;

    Pointer data_top = buf->data_buf;
    data_top = init_dwt_band(&buf->ref_dwt2, data_top, buf_sz_one / 2);
    data_top = init_dwt_band(&buf->dis_dwt2, data_top, buf_sz_one / 2);
    data_top = init_dwt_band_hvd(&buf->decouple_r, data_top, buf_sz_one / 2);
    data_top = init_dwt_band_hvd(&buf->decouple_a, data_top, buf_sz_one / 2);
    data_top = init_dwt_band_hvd(&buf->csf_a, data_top, buf_sz_one / 2);
    data_top = init_dwt_band_hvd(&buf->csf_f, data_top, buf_sz_one / 2);

    data_top = i4_init_dwt_band(&buf->i4_ref_dwt2, data_top, buf_sz_one);
    data_top = i4_init_dwt_band(&buf->i4_dis_dwt2, data_top, buf_sz_one);
    data_top = i4_init_dwt_band_hvd(&buf->i4_decouple_r, data_top, buf_sz_one);
    data_top = i4_init_dwt_band_hvd(&buf->i4_decouple_a, data_top, buf_sz_one);
    data_top = i4_init_dwt_band_hvd(&buf->i4_csf_a, data_top, buf_sz_one);
    data_top = i4_init_dwt_band_hvd(&buf->i4_csf_f, data_top, buf_sz_one);

    Pointer ind_buf_y = buf->buf_y_orig;
    init_index(buf->ind_y, ind_buf_y, buf->ind_size_y);
    Pointer ind_buf_x = buf->buf_x_orig;
    init_index(buf->ind_x, ind_buf_x, buf->ind_size_x);

    div_lookup_generator();

    return 0;

}

__device__ void adm_buffer_free(AdmBuffer *buf)
{
    if (buf->data_buf)    aligned_free(buf->data_buf);
    if (buf->tmp_ref)     aligned_free(buf->tmp_ref);
    if (buf->buf_x_orig)  aligned_free(buf->buf_x_orig);
    if (buf->buf_y_orig)  aligned_free(buf->buf_y_orig);
    memset(buf, 0, sizeof(*buf));
}








static const Option own_options[] = {
{"debug",false,-DBL_MAX,DBL_MAX,true,false,nullptr},
{"adm_csf_scale",DEFAULT_ADM_CSF_SCALE,0.0,50.0,false,false,nullptr},
{"adm_csf_diag_scale",DEFAULT_ADM_CSF_DIAG_SCALE,0.0,50.0,false,false,nullptr},
{"adm_dlm_weight",0.5,0.0,1.0,false,false,nullptr},
{"adm_enhn_gain_limit",DEFAULT_ADM_ENHN_GAIN_LIMIT,1.0,DEFAULT_ADM_ENHN_GAIN_LIMIT,false,false,nullptr},
{"adm_norm_view_dist",DEFAULT_ADM_NORM_VIEW_DIST,0.75,24.0,false,false,nullptr},
{"adm_norm_view_dist_extra",0.0,0.0,24.0,false,false,nullptr},
{"adm_ref_display_height",DEFAULT_ADM_REF_DISPLAY_HEIGHT,1,4320,false,false,nullptr},
{"adm_csf_mode",DEFAULT_ADM_CSF_MODE,0,3,false,false,nullptr},
{"adm_noise_weight",DEFAULT_ADM_NOISE_WEIGHT,0.0,1500.0,false,false,nullptr},
{"adm_skip_aim",false,-DBL_MAX,DBL_MAX,true,false,nullptr},
{"adm_skip_scale0",false,-DBL_MAX,DBL_MAX,true,false,nullptr},
{"adm_min_val",DEFAULT_ADM_MIN_VAL,0.0,1.0,false,false,nullptr}
};
__device__ void own_set_options(AdmState *s, Params *params) {
    s->debug = static_cast<decltype(s->debug)>(params->number[0]);
    s->adm_csf_scale = static_cast<decltype(s->adm_csf_scale)>(params->number[1]);
    s->adm_csf_diag_scale = static_cast<decltype(s->adm_csf_diag_scale)>(params->number[2]);
    s->adm_dlm_weight = static_cast<decltype(s->adm_dlm_weight)>(params->number[3]);
    s->adm_enhn_gain_limit = static_cast<decltype(s->adm_enhn_gain_limit)>(params->number[4]);
    s->adm_norm_view_dist = static_cast<decltype(s->adm_norm_view_dist)>(params->number[5]);
    s->adm_norm_view_dist_extra = static_cast<decltype(s->adm_norm_view_dist_extra)>(params->number[6]);
    s->adm_ref_display_height = static_cast<decltype(s->adm_ref_display_height)>(params->number[7]);
    s->adm_csf_mode = static_cast<decltype(s->adm_csf_mode)>(params->number[8]);
    s->adm_noise_weight = static_cast<decltype(s->adm_noise_weight)>(params->number[9]);
    s->adm_skip_aim = static_cast<decltype(s->adm_skip_aim)>(params->number[10]);
    s->adm_skip_scale0 = static_cast<decltype(s->adm_skip_scale0)>(params->number[11]);
    s->adm_min_val = static_cast<decltype(s->adm_min_val)>(params->number[12]);
}

} // namespace
#undef FEATURE_ADM_H_
#undef NUM_BUFS_ADM
#undef DEFAULT_ADM_ENHN_GAIN_LIMIT
#undef DEFAULT_ADM_NORM_VIEW_DIST
#undef DEFAULT_ADM_REF_DISPLAY_HEIGHT
#undef ADM_BORDER_FACTOR
#undef DEFAULT_ADM_NOISE_WEIGHT
#undef DEFAULT_ADM_CSF_SCALE
#undef DEFAULT_ADM_CSF_DIAG_SCALE
#undef DEFAULT_ADM_MIN_VAL
#undef DEFAULT_ADM_CSF_MODE
#undef DEFAULT_ADM_CSF_LUM
#undef DIVS
#undef ONE_BY_15
#undef I4_ONE_BY_15
#undef BARTEN_CSF_TOOLS_H_
#undef CLAMP
#undef MAX
#undef ADM_CM_THRESH_S_0_0
#undef ADM_CM_THRESH_S_0_W_M_1
#undef ADM_CM_THRESH_S_0_J
#undef ADM_CM_THRESH_S_H_M_1_0
#undef ADM_CM_THRESH_S_H_M_1_W_M_1
#undef ADM_CM_THRESH_S_H_M_1_J
#undef ADM_CM_THRESH_S_I_J
#undef ADM_CM_THRESH_S_I_0
#undef ADM_CM_THRESH_S_I_W_M_1
#undef I4_ADM_CM_THRESH_S_0_0
#undef I4_ADM_CM_THRESH_S_0_W_M_1
#undef I4_ADM_CM_THRESH_S_0_J
#undef I4_ADM_CM_THRESH_S_H_M_1_0
#undef I4_ADM_CM_THRESH_S_H_M_1_W_M_1
#undef I4_ADM_CM_THRESH_S_H_M_1_J
#undef I4_ADM_CM_THRESH_S_I_J
#undef I4_ADM_CM_THRESH_S_I_0
#undef I4_ADM_CM_THRESH_S_I_W_M_1
#undef ADM_CM_ACCUM_ROUND
#undef I4_ADM_CM_ACCUM_ROUND
#undef MIN

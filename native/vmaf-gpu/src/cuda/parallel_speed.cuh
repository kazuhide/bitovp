/**
 *
 *  Copyright 2016-2025 Netflix, Inc.
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

// CUDA matrix adaptation of the owned Vulkan SPEED port, itself adapted from
// Netflix/vmaf 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef speed.c.
// All intermediate stores remain binary32; compile with --fmad=false.
#pragma once
namespace bitovp::gpu::parallel_speed_detail {
struct SpeedMath {
    float *f;
    static constexpr double eigenvalue_epsilon = 1e-6;
    static constexpr int eigenvalue_max_iterations = 500;
    struct SpeedDimensions {
        int original_height;
        int original_width;
        int scaled_height;
        int scaled_width;
        int alloc_height;
        int alloc_width;
        int operating_height;
        int operating_width;
        int block_size;
        int truncated_width;
        int truncated_height;
        int num_blocks_horizontal;
        int num_blocks_vertical;
        int num_blocks;
        int elements_in_block;
        int submatrix_width;
        int submatrix_height;
    };
    // Explicit CUDA RTE conversion prevents a float sqrt/division approximation
    // replacing the double operations used by the official scalar C implementation.
    __device__ static float round_float(double value) { return __double2float_rn(value); }
    __device__ float cpu_sqrt(float value) { return __double2float_rn(__dsqrt_rn(double(value))); }
    // CUDA round-to-nearest division preserves the official binary32 division.
    // Do not replace this with the approximate __fdividef intrinsic.
    __device__ float cpu_div(float numerator, float denominator) { return __fdiv_rn(numerator, denominator); }
    __device__ void copy_floats(int destination, int source, int count) { for (int i=0; i<count; ++i) f[destination+i]=f[source+i]; }

    __device__ float vector_norm(int x, int n)
    {
        float sum = 0;
        for (int i = 0; i < n; i++)
            sum += f[(x) + (i)] * f[(x) + (i)];
        return cpu_sqrt(sum);
    }

    __device__ int get_sign(float x)
    {
        return (x >= 0 ? 1 : -1);
    }

    __device__ float pythagoras(float x, float y)
    {

        return cpu_sqrt(x * x + y * y);
    }

    __device__ float compute_column_norm(int A, int col, int start_row, int size)
    {

        float norm = 0;
        for (int i = start_row; i < size; i++)
            norm += f[(A) + (i * size + col)] * f[(A) + (i * size + col)];
        return cpu_sqrt(norm);
    }

    __device__ float compute_householder_transform(int A, int col, int start_row,
                                               int size)
    {
        if (size - start_row == 1)
            return 0.0f;
        float xnorm = compute_column_norm(A, col, start_row + 1, size);
        if (xnorm == 0.0f)
            return 0.0f;
        float alpha = f[(A) + (start_row * size + col)];
        float beta = -get_sign(alpha) * pythagoras(alpha, xnorm);
        float tau = cpu_div(beta - alpha, beta);
        float s = alpha - beta;
        if (s != 0.0f) {
            for (int i = start_row; i < size; i++)
                f[(A) + (i * size + col)] = cpu_div(f[(A) + (i * size + col)], s);
            f[(A) + (start_row * size + col)] = beta;
        }
        return tau;
    }

    __device__ void tridiagonal_multiply(int A, int v, int x, float tau_i,
                                     int start, int size)
    {
        for (int i = start; i < size; i++) {
            f[(x) + (i)] = 0.0f;
            for (int j = start; j < size; j++)
                f[(x) + (i)] += tau_i * f[(A) + (i * size + j)] * f[(v) + (j)];
        }
    }

    __device__ float tridiagonal_dot_product(int x, int v, int start, int size)
    {
        float res = 0;
        for (int i = start; i < size; i++)
            res += f[(x) + (i)] * f[(v) + (i)];
        return res;
    }

    __device__ void tridiagonal_axpy(int x, int v, float alpha, int start, int size)
    {
        for (int i = start; i < size; i++)
            f[(x) + (i)] += alpha * f[(v) + (i)];
    }

    __device__ void tridiagonal_syr2(int A, int x, int v, int start, int size)
    {
        for (int i = start; i < size; i++) {
            for (int j = start; j < size; j++) {
                f[(A) + (i * size + j)] -= f[(x) + (i)] * f[(v) + (j)] + f[(v) + (i)] * f[(x) + (j)];
            }
        }
    }

    __device__ void convert_to_tridiagonal(int A, int size, int d, int sd,
                                       int scratch_cursor)
    {
        int v = scratch_cursor; scratch_cursor += size;
        int x = scratch_cursor; scratch_cursor += size;



        for (int i = 0; i < size - 2; i++) {


            float tau_i = compute_householder_transform(A, i, i + 1, size);


            for (int j = i + 1; j < size; j++)
                f[(v) + (j)] = f[(A) + (j * size + i)];

            if (tau_i != 0.0f) {


                f[(A) + ((i + 1) * size + i)] = f[(v) + (i + 1)];
                f[(v) + (i + 1)] = 1.0f;



                tridiagonal_multiply(A, v, x, tau_i, i + 1, size);

                float xv = tridiagonal_dot_product(x, v, i + 1, size);
                float alpha = round_float(-0.5 * double(tau_i) * double(xv));
                tridiagonal_axpy(x, v, alpha, i + 1, size);

                tridiagonal_syr2(A, x, v, i + 1, size);
            }
        }


        for (int i = 0; i < size; i++)
            f[(d) + (i)] = f[(A) + (i * size + i)];
        for (int i = 0; i < size - 1; i++)
            f[(sd) + (i)] = f[(A) + ((i + 1) * size + i)];
    }

    __device__ void chop_small_elements(int d, int sd, int size)
    {
        for (int i = 0; i < size - 1; i++) {
            if (abs(f[(sd) + (i)]) < eigenvalue_epsilon * (abs(f[(d) + (i)]) + abs(f[(d) + (i + 1)])))
                f[(sd) + (i)] = 0.0f;
        }
    }

    __device__ float trailing_eigenvalue(int d, int sd, int n)
    {
        float ta = f[(d) + (n - 2)];
        float tb = f[(d) + (n - 1)];
        float tab = f[(sd) + (n - 2)];
        float dt = (ta - tb) / 2.0;

        if (dt > 0)
            return tb - tab * cpu_div(tab, dt + pythagoras(dt, tab));
        else if (dt == 0)
            return tb - abs(tab);
        else
            return tb + tab * cpu_div(tab, -dt + pythagoras(dt, tab));
    }

    __device__ void create_givens(const float a, const float b, float &c, float &s)
    {
        if (b == 0) {
            c = 1;
            s = 0;
        } else if (abs(b) > abs(a)) {
            float t = cpu_div(-a, b);
            float s1 = round_float(1.0 / sqrt(double(1 + t * t)));
            s = s1;
            c = s1 * t;
        } else {
            float t = cpu_div(-b, a);
            float c1 = round_float(1.0 / sqrt(double(1 + t * t)));
            c = c1;
            s = c1 * t;
        }
    }

    __device__ void qr_step(int d, int sd, int n)
    {
        float mu = trailing_eigenvalue(d, sd, n);
        if (eigenvalue_epsilon * abs(mu) > abs(f[(d) + (0)]) + abs(f[(sd) + (0)]))
            mu = 0;

        float x = f[(d) + (0)] - mu;
        float z = f[(sd) + (0)];

        float ak = 0;
        float bk = 0;
        float zk = 0;

        float ap = f[(d) + (0)];
        float bp = f[(sd) + (0)];

        float aq = f[(d) + (1)];

        if (n == 2) {
            float c, s;
            create_givens(x, z, c, s);

            float ap1 = c * (c * ap - s * bp) + s * (s * aq - c * bp);
            float bp1 = c * (s * ap + c * bp) - s * (s * bp + c * aq);
            float aq1 = s * (s * ap + c * bp) + c * (s * bp + c * aq);

            ak = ap1;
            bk = bp1;

            ap = aq1;

            f[(d) + (0)] = ak;
            f[(sd) + (0)] = bk;
            f[(d) + (1)] = ap;

            return;
        }

        float bq = f[(sd) + (1)];

        for (int k = 0; k < n - 1; k++) {
            float c, s;
            create_givens(x, z, c, s);


            float bk1 = c * bk - s * zk;

            float ap1 = c * (c * ap - s * bp) + s * (s * aq - c * bp);
            float bp1 = c * (s * ap + c * bp) - s * (s * bp + c * aq);
            float zp1 = -s * bq;

            float aq1 = s * (s * ap + c * bp) + c * (s * bp + c * aq);
            float bq1 = c * bq;

            ak = ap1;
            bk = bp1;
            zk = zp1;

            ap = aq1;
            bp = bq1;

            if (k < n - 2)
                aq = f[(d) + (k + 2)];

            if (k < n - 3)
                bq = f[(sd) + (k + 2)];

            f[(d) + (k)] = ak;

            if (k > 0)
                f[(sd) + (k - 1)] = bk1;

            if (k < n - 2) {
                f[(sd) + (k + 1)] = bp;
            }

            x = bk;
            z = zk;
        }

        f[(d) + (n - 1)] = ap;
        f[(sd) + (n - 2)] = bk;
    }

    __device__ void compute_eigenvalues_tridiagonal(int d, int sd,
                                                int eigenvalues, int size)
    {

        chop_small_elements(d, sd, size);


        int b = size - 1;
        int iter = 0;
        while (b > 0 && iter < eigenvalue_max_iterations) {
            if (f[(sd) + (b - 1)] == 0.0f) {
                b--;
                continue;
            }


            int a = b - 1;
            while (a > 0) {
                if (f[(sd) + (a - 1)] == 0.0f) {
                    break;
                }
                a--;
            }

            const int n_block = b - a + 1;
            int d_block = d + a;
            int sd_block = sd + a;
            qr_step(d_block, sd_block, n_block);
            chop_small_elements(d_block, sd_block, n_block);
            iter++;
        }

        if (iter == eigenvalue_max_iterations) {

        }

        for (int i = 0; i < size; i++)
            f[(eigenvalues) + (i)] = f[(d) + (i)];
    }

    __device__ void compute_eigenvalues(int A_immutable, int eigenvalues,
                                    int size, int scratch_cursor)
    {
        int A = scratch_cursor; scratch_cursor += size * size;
        int d = scratch_cursor; scratch_cursor += size;
        int sd = scratch_cursor; scratch_cursor += size;
        int tmp = scratch_cursor; scratch_cursor += 2 * size;

        copy_floats(A, A_immutable, size * size);

        if (size == 1) {
            f[(eigenvalues) + (0)] = f[(A) + (0 * size + 0)];
            return;
        }
        convert_to_tridiagonal(A, size, d, sd, tmp);
        compute_eigenvalues_tridiagonal(d, sd, eigenvalues, size);
    }

    __device__ float compute_mean(SpeedDimensions dim, int data,
                              int stride_px, int start_row, int start_col)
    {
        float result = 0;
        for (int i = 0; i < dim.submatrix_height; i++) {
            for (int j = 0; j < dim.submatrix_width; j++)
                result += f[(data) + ((start_row + i) * stride_px + (start_col + j))];
        }

        return cpu_div(result, float(dim.submatrix_width * dim.submatrix_height));
    }

    __device__ double compute_cov_kernel_scalar(int data_x, int data_y,
                                     int stride_px, int height,
                                     int width, double mean_x,
                                     double mean_y)
    {
        double result = 0;
        for (int i = 0; i < height; i++) {
            for (int j = 0; j < width; j++) {
                double val_x = f[(data_x) + (i * stride_px + j)];
                double val_y = f[(data_y) + (i * stride_px + j)];
                result += (val_x - mean_x) * (val_y - mean_y);
            }
        }
        return result;
    }

    __device__ float compute_covariance(SpeedDimensions dim, int data,
                                    int means, int stride_px,
                                    int start_row_x, int start_col_x,
                                    int start_row_y, int start_col_y)
    {
        double mean_x = f[(means) + (start_row_x * dim.block_size + start_col_x)];
        double mean_y = f[(means) + (start_row_y * dim.block_size + start_col_y)];
        int data_x = data + start_row_x * stride_px + start_col_x;
        int data_y = data + start_row_y * stride_px + start_col_y;
        double result = compute_cov_kernel_scalar(data_x, data_y, stride_px,
                               dim.submatrix_height, dim.submatrix_width,
                               mean_x, mean_y);
        return round_float(result / (dim.submatrix_width * dim.submatrix_height));
    }

    __device__ bool is_matrix_regular(SpeedDimensions dim, int eigenvalues)
    {
        for (int i = 0; i < dim.elements_in_block; i++) {
            if (f[(eigenvalues) + (i)] < eigenvalue_epsilon) {
                return false;
            }
        }
        return true;
    }
};
} // namespace bitovp::gpu::parallel_speed_detail

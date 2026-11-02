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

// Adapted from official Netflix/vmaf 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef
// speed.c scalar matrix/eigen/covariance routines. Float pointers become
// workspace element offsets; storage is supplied by the including shader.
#define EIGENVALUE_EPS 1e-6LF
#define EIGENVALUE_MAX_ITERS 500
#define EINVAL 22
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
// Expose the double result's bits before rounding to binary32. A plain
// float(sqrt(double(x))) can be lowered back to a less accurate float sqrt.
// Matrix intermediates use normal binary32 values; preserve the other IEEE
// classes explicitly as well, using arithmetic scaling for subnormals.
float round_float(double value) {
    uvec2 bits = unpackDouble2x32(value);
    uint sign_bit = bits.y & 0x80000000u;
    uint exponent = (bits.y >> 20u) & 2047u;
    if (exponent == 2047u) return uintBitsToFloat(sign_bit | 0x7f800000u |
        (((bits.y & 0xfffffu) != 0u || bits.x != 0u) ? 0x400000u : 0u));
    int destination_exponent = int(exponent) - 1023 + 127;
    if (destination_exponent >= 255) return uintBitsToFloat(sign_bit | 0x7f800000u);
    if (destination_exponent <= 0) {
        double magnitude = abs(value) * 713623846352979940529142984724747568191373312.0LF;
        uint integral = uint(magnitude);
        double fraction = magnitude - double(integral);
        if (fraction > 0.5LF || (fraction == 0.5LF && (integral & 1u) != 0u)) ++integral;
        return uintBitsToFloat(sign_bit | integral);
    }
    uint fraction = ((bits.y & 0xfffffu) << 3u) | (bits.x >> 29u);
    uint remainder = bits.x & 0x1fffffffu;
    if (remainder > 0x10000000u || (remainder == 0x10000000u && (fraction & 1u) != 0u)) ++fraction;
    return uintBitsToFloat(sign_bit | (uint(destination_exponent) << 23u) + fraction);
}
precise float cpu_sqrt(float value) { return round_float(sqrt(double(value))); }
// Vulkan float division may use a reciprocal approximation. Performing this
// scalar operation in double before the explicit float rounding retains the
// CPU scalar operation's precision without changing the matrix's float stores.
precise float cpu_div(float numerator, float denominator) { return round_float(double(numerator) / double(denominator)); }
void copy_floats(int destination, int source, int count) { for (int i=0; i<count; ++i) f[destination+i]=f[source+i]; }
struct Matrix {
    int rows;
    int cols;
    int data;
};

void matrix_init(inout Matrix mat, int rows, int cols, int scratch_cursor)
{
    mat.data = scratch_cursor;
    mat.rows = rows;
    mat.cols = cols;
}

void matrix_transpose(inout Matrix m)
{
    
    
    int size = m.rows;
    for (int i = 0; i < size; i++) {
        for (int j = 0; j < i; j++) {
            precise float temp = f[(m.data) + (i * size + j)];
            f[(m.data) + (i * size + j)] = f[(m.data) + (j * size + i)];
            f[(m.data) + (j * size + i)] = temp;
        }
    }
}

void matrix_zero(inout Matrix m)
{
    for (int i = 0; i < m.rows; i++) {
        for (int j = 0; j < m.cols; j++) {
            f[(m.data) + (i * m.cols + j)] = 0;
        }
    }
}

void matrix_identity(inout Matrix m)
{
    for (int i = 0; i < m.rows; i++) {
        for (int j = 0; j < m.cols; j++) {
            f[(m.data) + (i * m.cols + j)] = (i == j ? 1 : 0);
        }
    }
}

void matrix_copy(inout Matrix dst, inout Matrix src)
{
    dst.rows = src.rows;
    dst.cols = src.cols;
    for (int i = 0; i < dst.rows; i++) {
        for (int j = 0; j < dst.cols; j++) {
            f[(dst.data) + (i * dst.cols + j)] = f[(src.data) + (i * src.cols + j)];
        }
    }
}

void matrix_mul(inout Matrix dst, inout Matrix x, inout Matrix y)
{
    
    matrix_zero(dst);
    for (int i = 0; i < x.rows; i++) {
        for (int k = 0; k < x.cols; k++) {
            for (int j = 0; j < y.cols; j++) {
                f[(dst.data) + (i * dst.cols + j)] +=
                    f[(x.data) + (i * x.cols + k)] * f[(y.data) + (k * y.cols + j)];
            }
        }
    }
}

void matrix_minor(inout Matrix mat, int d)
{
    
    
    int size = mat.rows;
    for (int i = 0; i < size; i++) {
        for (int j = 0; j < size; j++) {
            if (i < d || j < d) {
                if (i == j)
                    f[(mat.data) + (i * size + j)] = 1;
                else
                    f[(mat.data) + (i * size + j)] = 0;
            }
        }
    }
}

void matrix_identity_minus_v_vt(inout Matrix dst, int v)
{
    
    
    
    int size = dst.rows;
    for (int i = 0; i < size; i++) {
        for (int j = 0; j < size; j++) {
            f[(dst.data) + (i * size + j)] = -2 * f[(v) + (i)] * f[(v) + (j)];
        }
    }

    for (int i = 0; i < size; i++)
        f[(dst.data) + (i * size + i)] += 1;
}

precise float vector_norm(int x, int n)
{
    precise float sum = 0;
    for (int i = 0; i < n; i++)
        sum += f[(x) + (i)] * f[(x) + (i)];
    return cpu_sqrt(sum);
}

void vector_div(int x, float d, int y, int n)
{
    for (int i = 0; i < n; i++)
        f[(y) + (i)] = cpu_div(f[(x) + (i)], d);
}

void matrix_take_kth_column(inout Matrix mat, int v, int k)
{
    
    for (int i = 0; i < mat.rows; i++)
        f[(v) + (i)] = f[(mat.data) + (i * mat.cols + k)];
}

int get_sign(float x)
{
    return (x >= 0 ? 1 : -1);
}

precise float pythagoras(float x, float y)
{
    
    return cpu_sqrt(x * x + y * y);
}

precise float compute_column_norm(int A, int col, int start_row, int size)
{
    
    precise float norm = 0;
    for (int i = start_row; i < size; i++)
        norm += f[(A) + (i * size + col)] * f[(A) + (i * size + col)];
    return cpu_sqrt(norm);
}









precise float compute_householder_transform(int A, int col, int start_row,
                                           int size)
{
    if (size - start_row == 1)
        return 0.0f;
    precise float xnorm = compute_column_norm(A, col, start_row + 1, size);
    if (xnorm == 0.0f)
        return 0.0f;
    precise float alpha = f[(A) + (start_row * size + col)];
    precise float beta = -get_sign(alpha) * pythagoras(alpha, xnorm);
    precise float tau = cpu_div(beta - alpha, beta);
    precise float s = alpha - beta;
    if (s != 0.0f) {
        for (int i = start_row; i < size; i++)
            f[(A) + (i * size + col)] = cpu_div(f[(A) + (i * size + col)], s);
        f[(A) + (start_row * size + col)] = beta;
    }
    return tau;
}




void tridiagonal_multiply(int A, int v, int x, float tau_i,
                                 int start, int size)
{
    for (int i = start; i < size; i++) {
        f[(x) + (i)] = 0.0f;
        for (int j = start; j < size; j++)
            f[(x) + (i)] += tau_i * f[(A) + (i * size + j)] * f[(v) + (j)];
    }
}




precise float tridiagonal_dot_product(int x, int v, int start, int size)
{
    precise float res = 0;
    for (int i = start; i < size; i++)
        res += f[(x) + (i)] * f[(v) + (i)];
    return res;
}




void tridiagonal_axpy(int x, int v, float alpha, int start, int size)
{
    for (int i = start; i < size; i++)
        f[(x) + (i)] += alpha * f[(v) + (i)];
}




void tridiagonal_syr2(int A, int x, int v, int start, int size)
{
    for (int i = start; i < size; i++) {
        for (int j = start; j < size; j++) {
            f[(A) + (i * size + j)] -= f[(x) + (i)] * f[(v) + (j)] + f[(v) + (i)] * f[(x) + (j)];
        }
    }
}



void convert_to_tridiagonal(int A, int size, int d, int sd,
                                   int scratch_cursor)
{
    int v = scratch_cursor; scratch_cursor += size;
    int x = scratch_cursor; scratch_cursor += size;

    
    
    for (int i = 0; i < size - 2; i++) {
        
        
        precise float tau_i = compute_householder_transform(A, i, i + 1, size);

        
        for (int j = i + 1; j < size; j++)
            f[(v) + (j)] = f[(A) + (j * size + i)];

        if (tau_i != 0.0f) {
            
            
            f[(A) + ((i + 1) * size + i)] = f[(v) + (i + 1)];
            f[(v) + (i + 1)] = 1.0f;
            
            
            
            tridiagonal_multiply(A, v, x, tau_i, i + 1, size);
            
            precise float xv = tridiagonal_dot_product(x, v, i + 1, size);
            precise float alpha = round_float(-0.5LF * double(tau_i) * double(xv));
            tridiagonal_axpy(x, v, alpha, i + 1, size);
            
            tridiagonal_syr2(A, x, v, i + 1, size);
        }
    }

    
    for (int i = 0; i < size; i++)
        f[(d) + (i)] = f[(A) + (i * size + i)];
    for (int i = 0; i < size - 1; i++)
        f[(sd) + (i)] = f[(A) + ((i + 1) * size + i)];
}

void chop_small_elements(int d, int sd, int size)
{
    for (int i = 0; i < size - 1; i++) {
        if (abs(f[(sd) + (i)]) < EIGENVALUE_EPS * (abs(f[(d) + (i)]) + abs(f[(d) + (i + 1)])))
            f[(sd) + (i)] = 0.0f;
    }
}

precise float trailing_eigenvalue(int d, int sd, int n)
{
    precise float ta = f[(d) + (n - 2)];
    precise float tb = f[(d) + (n - 1)];
    precise float tab = f[(sd) + (n - 2)];
    precise float dt = (ta - tb) / 2.0;

    if (dt > 0)
        return tb - tab * cpu_div(tab, dt + pythagoras(dt, tab));
    else if (dt == 0)
        return tb - abs(tab);
    else
        return tb + tab * cpu_div(tab, -dt + pythagoras(dt, tab));
}

void create_givens(const float a, const float b, out float c, out float s)
{
    if (b == 0) {
        c = 1;
        s = 0;
    } else if (abs(b) > abs(a)) {
        precise float t = cpu_div(-a, b);
        precise float s1 = round_float(1.0LF / sqrt(double(1 + t * t)));
        s = s1;
        c = s1 * t;
    } else {
        precise float t = cpu_div(-b, a);
        precise float c1 = round_float(1.0LF / sqrt(double(1 + t * t)));
        c = c1;
        s = c1 * t;
    }
}

void qr_step(int d, int sd, int n)
{
    precise float mu = trailing_eigenvalue(d, sd, n);
    if (EIGENVALUE_EPS * abs(mu) > abs(f[(d) + (0)]) + abs(f[(sd) + (0)]))
        mu = 0;

    precise float x = f[(d) + (0)] - mu;
    precise float z = f[(sd) + (0)];

    precise float ak = 0;
    precise float bk = 0;
    precise float zk = 0;

    precise float ap = f[(d) + (0)];
    precise float bp = f[(sd) + (0)];

    precise float aq = f[(d) + (1)];

    if (n == 2) {
        precise float c, s;
        create_givens(x, z, c, s);

        precise float ap1 = c * (c * ap - s * bp) + s * (s * aq - c * bp);
        precise float bp1 = c * (s * ap + c * bp) - s * (s * bp + c * aq);
        precise float aq1 = s * (s * ap + c * bp) + c * (s * bp + c * aq);

        ak = ap1;
        bk = bp1;

        ap = aq1;

        f[(d) + (0)] = ak;
        f[(sd) + (0)] = bk;
        f[(d) + (1)] = ap;

        return;
    }

    precise float bq = f[(sd) + (1)];

    for (int k = 0; k < n - 1; k++) {
        precise float c, s;
        create_givens(x, z, c, s);

        
        precise float bk1 = c * bk - s * zk;

        precise float ap1 = c * (c * ap - s * bp) + s * (s * aq - c * bp);
        precise float bp1 = c * (s * ap + c * bp) - s * (s * bp + c * aq);
        precise float zp1 = -s * bq;

        precise float aq1 = s * (s * ap + c * bp) + c * (s * bp + c * aq);
        precise float bq1 = c * bq;

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


void compute_eigenvalues_tridiagonal(int d, int sd,
                                            int eigenvalues, int size)
{
    
    chop_small_elements(d, sd, size);

    
    int b = size - 1;
    int iter = 0;
    while (b > 0 && iter < EIGENVALUE_MAX_ITERS) {
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

    if (iter == EIGENVALUE_MAX_ITERS) {
        
    }

    for (int i = 0; i < size; i++)
        f[(eigenvalues) + (i)] = f[(d) + (i)];
}

void compute_eigenvalues(int A_immutable, int eigenvalues,
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




void matrix_qr_decomposition(inout Matrix A, inout Matrix Q, inout Matrix R,
                                    inout Matrix tmp_q, inout Matrix tmp_z)
{
    
    int size = A.rows;

    
    
    
    Matrix tmp_mul = R;
    int vec = R.data;

    
    matrix_copy(tmp_z, A);

    
    matrix_identity(Q);

    for (int k = 0; k < size - 1; k++) {
        matrix_minor(tmp_z, k);
        matrix_take_kth_column(tmp_z, vec, k);

        precise float norm = vector_norm(vec, size);
        int sign = get_sign(f[(A.data) + (k * size + k)]);
        f[(vec) + (k)] += sign * norm;

        vector_div(vec, vector_norm(vec, size), vec, size);
        matrix_identity_minus_v_vt(tmp_q, vec);

        matrix_mul(tmp_mul, tmp_q, tmp_z);
        matrix_copy(tmp_z, tmp_mul);
        matrix_mul(tmp_mul, tmp_q, Q);
        matrix_copy(Q, tmp_mul);
    }

    matrix_mul(R, Q, A);
    matrix_transpose(Q);
}



int solve_triangular_system(inout Matrix R, inout Matrix X, inout Matrix B)
{
    
    
    
    

    for (int i = R.rows - 1; i >= 0; i--) {
        precise float denominator = f[(R.data) + (i * R.cols + i)];
        if (abs(denominator) < EIGENVALUE_EPS) {
            return -EINVAL;
        }
        for (int j = 0; j < X.cols; j++) {
            precise float independent_term = f[(B.data) + (i * B.cols + j)];
            for (int k = i + 1; k < R.rows; k++) {
                independent_term -=
                    (f[(X.data) + (k * X.cols + j)] * f[(R.data) + (i * R.cols + k)]);
            }
            f[(X.data) + (i * X.cols + j)] = cpu_div(independent_term, denominator);
        }
    }
    return 0;
}


int solve_linear_system(int A_data, int A_size, int B_data,
                               int B_cols, int output_data,
                               int tmp_buffer)
{
    int A_buffer = tmp_buffer; tmp_buffer += A_size * A_size;
    int Q_buffer = tmp_buffer; tmp_buffer += A_size * A_size;
    int R_buffer = tmp_buffer; tmp_buffer += A_size * A_size;
    int tmp1_buffer = tmp_buffer; tmp_buffer += A_size * A_size;
    int tmp2_buffer = tmp_buffer; tmp_buffer += A_size * A_size;
    int tmp_rect_buffer = tmp_buffer; tmp_buffer += A_size * B_cols;

    Matrix A_immutable; matrix_init(A_immutable, A_size, A_size, A_data);
    Matrix A; matrix_init(A, A_size, A_size, A_buffer);
    matrix_copy(A, A_immutable);

    Matrix Q; matrix_init(Q, A_size, A_size, Q_buffer);
    Matrix R; matrix_init(R, A_size, A_size, R_buffer);
    Matrix tmp1; matrix_init(tmp1, A_size, A_size, tmp1_buffer);
    Matrix tmp2; matrix_init(tmp2, A_size, A_size, tmp2_buffer);

    Matrix B_immutable; matrix_init(B_immutable, A_size, B_cols, B_data);

    Matrix tmp_rect; matrix_init(tmp_rect, A_size, B_cols, tmp_rect_buffer);
    Matrix X; matrix_init(X, A_size, B_cols, output_data);

    
    
    matrix_qr_decomposition(A, Q, R, tmp1, tmp2);
    matrix_transpose(Q);
    matrix_mul(tmp_rect, Q, B_immutable);
    int err = solve_triangular_system(R, X, tmp_rect);
    return err;
}

precise float compute_mean(SpeedDimensions dim, int data,
                          int stride_px, int start_row, int start_col)
{
    precise float result = 0;
    for (int i = 0; i < dim.submatrix_height; i++) {
        for (int j = 0; j < dim.submatrix_width; j++)
            result += f[(data) + ((start_row + i) * stride_px + (start_col + j))];
    }

    return cpu_div(result, float(dim.submatrix_width * dim.submatrix_height));
}



precise double compute_cov_kernel_scalar(int data_x, int data_y,
                                 int stride_px, int height,
                                 int width, double mean_x,
                                 double mean_y)
{
    precise double result = 0;
    for (int i = 0; i < height; i++) {
        for (int j = 0; j < width; j++) {
            precise double val_x = f[(data_x) + (i * stride_px + j)];
            precise double val_y = f[(data_y) + (i * stride_px + j)];
            result += (val_x - mean_x) * (val_y - mean_y);
        }
    }
    return result;
}





precise float compute_covariance(SpeedDimensions dim, int data,
                                int means, int stride_px,
                                int start_row_x, int start_col_x,
                                int start_row_y, int start_col_y)
{
    precise double mean_x = f[(means) + (start_row_x * dim.block_size + start_col_x)];
    precise double mean_y = f[(means) + (start_row_y * dim.block_size + start_col_y)];
    int data_x = data + start_row_x * stride_px + start_col_x;
    int data_y = data + start_row_y * stride_px + start_col_y;
    precise double result = compute_cov_kernel_scalar(data_x, data_y, stride_px,
                           dim.submatrix_height, dim.submatrix_width,
                           mean_x, mean_y);
    return round_float(result / (dim.submatrix_width * dim.submatrix_height));
}

void compute_covariance_matrix(SpeedDimensions dim, int data,
                                      int cov_mat, int means,
                                      int stride_px)
{
    for (int start_row = 0; start_row < dim.block_size; start_row++) {
        for (int start_col = 0; start_col < dim.block_size; start_col++) {
            f[(means) + (start_row * dim.block_size + start_col)] =
                compute_mean(dim, data, stride_px, start_row, start_col);
        }
    }
    int elements_in_block = dim.block_size * dim.block_size;

    for (int x_index = 0; x_index < dim.elements_in_block; x_index++) {
        for (int y_index = 0; y_index <= x_index; y_index++) {
            int start_row_x = x_index / dim.block_size;
            int start_col_x = x_index % dim.block_size;
            int start_row_y = y_index / dim.block_size;
            int start_col_y = y_index % dim.block_size;
            precise float covariance =
                compute_covariance(dim, data, means, stride_px, start_row_x,
                                   start_col_x, start_row_y, start_col_y);
            f[(cov_mat) + (x_index * elements_in_block + y_index)] = covariance;
            f[(cov_mat) + (y_index * elements_in_block + x_index)] = covariance;
        }
    }
}

void compute_independent_term(SpeedDimensions dim, int data,
                                     int independent_term, int stride_px)
{
    for (int start_i = 0; start_i < dim.block_size; start_i++) {
        for (int start_j = 0; start_j < dim.block_size; start_j++) {
            for (int i = start_i; i < dim.truncated_height; i += dim.block_size) {
                for (int j = start_j; j < dim.truncated_width; j += dim.block_size) {
                    int out_row = start_i * dim.block_size + start_j;
                    int out_col =
                        (((i - start_i) / dim.block_size) *
                            dim.num_blocks_horizontal) + ((j - start_j) / dim.block_size);
                    f[(independent_term) + (out_row * dim.num_blocks + out_col)] =
                        f[(data) + (i * stride_px + j)];
                }
            }
        }
    }
}

void compute_pointwise_product_and_division(SpeedDimensions dim,
                                                   int X, int Y,
                                                   float denominator)
{
    for (int i = 0; i < dim.elements_in_block; i++) {
        for (int j = 0; j < dim.num_blocks; j++) {
            f[(X) + (i * dim.num_blocks + j)] =
                cpu_div(f[(X) + (i * dim.num_blocks + j)] * f[(Y) + (i * dim.num_blocks + j)], denominator);
        }
    }
}

void sum_columns(SpeedDimensions dim, int X)
{
    for (int i = 1; i < dim.elements_in_block; i++) {
        for (int j = 0; j < dim.num_blocks; j++) {
            f[(X) + (0 * dim.num_blocks + j)] += f[(X) + (i * dim.num_blocks + j)];
        }
    }
}

bool is_matrix_regular(SpeedDimensions dim, int eigenvalues)
{
    for (int i = 0; i < dim.elements_in_block; i++) {
        if (f[(eigenvalues) + (i)] < EIGENVALUE_EPS) {
            return false;
        }
    }
    return true;
}

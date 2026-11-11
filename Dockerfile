# syntax=docker/dockerfile:1
# Worker image with FFmpeg, streaming protocols, and VMAF models.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS whisper-build
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ make patch python3 ca-certificates && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4 https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/d1be6fde11ac6e0407606b4e42fe72d34add8037 /tmp/whisper.tar.gz
COPY apps/worker/native/whisper-cli-quality.patch /tmp/whisper-cli-quality.patch
COPY apps/worker/scripts/test-whisper-cli-quality.py /tmp/test-whisper-cli-quality.py
RUN mkdir /source && tar xzf /tmp/whisper.tar.gz -C /source --strip-components=1 \
    && patch --directory=/source -p1 --fuzz=0 < /tmp/whisper-cli-quality.patch \
    && python3 /tmp/test-whisper-cli-quality.py /source/examples/cli/cli.cpp \
    && cmake -S /source -B /source/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_IS_DEV=OFF -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_METAL=OFF -DGGML_BLAS=OFF -DGGML_OPENMP=OFF -DWHISPER_COREML=OFF \
    && cmake --build /source/build --target whisper-cli -j2 \
    && test "$(/source/build/bin/whisper-cli --version)" = "whisper.cpp version: 1.9.5"

# Isolated CPU-only caption alignment dependencies; no model execution at build time.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS caption-alignment-runtime
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential cmake pkg-config libsndfile1 sox ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/bitovp-caption-alignment \
    && case "$TARGETARCH" in \
      amd64) TORCH_WHEEL="https://download-r2.pytorch.org/whl/cpu/torch-2.10.0%2Bcpu-cp311-cp311-manylinux_2_28_x86_64.whl#sha256=b7cb1ec66cefb90fd7b676eac72cfda3b8d4e4d0cacd7a531963bc2e0a9710ab" ;; \
      arm64) TORCH_WHEEL="https://download-r2.pytorch.org/whl/cpu/torch-2.10.0%2Bcpu-cp311-cp311-manylinux_2_28_aarch64.whl#sha256=1cfcb9b1558c6e52dffd0d4effce83b13c5ae5d97338164c372048c21f9cfccb" ;; \
      *) exit 1 ;; esac \
    && /opt/bitovp-caption-alignment/bin/pip install --no-cache-dir "$TORCH_WHEEL" \
    && /opt/bitovp-caption-alignment/bin/pip install --no-cache-dir "https://files.pythonhosted.org/packages/01/12/d3027a7e4dc2eea0b12a4bf8414a7109f055004e1771666e01d8859d3ca0/qwen_asr-0.0.6-py3-none-any.whl#sha256=b9c55a38413298f3a990a4475467399daec6e8f4172363053fc42e2166c2dfd3" "transformers==4.57.6" "accelerate==1.12.0" "nagisa==0.2.11" \
    && /opt/bitovp-caption-alignment/bin/python -c "import importlib.metadata as m; assert m.version('torch') == '2.10.0+cpu'; assert m.version('qwen-asr') == '0.0.6'; assert m.version('transformers') == '4.57.6'"

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
COPY --from=whisper-build /source/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /source/LICENSE /usr/local/share/licenses/whisper.cpp/LICENSE
ADD --chmod=0644 --checksum=sha256:68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5 https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf /usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf
ADD --chmod=0644 --checksum=sha256:6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2 https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE /usr/local/share/fonts/bitovp/OFL.txt
ADD --chmod=0644 --checksum=sha256:de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551 https://raw.githubusercontent.com/google/fonts/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf /usr/local/share/fonts/bitovp/NotoEmoji-wght.ttf
ADD --chmod=0644 --checksum=sha256:500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b https://raw.githubusercontent.com/google/fonts/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/OFL.txt /usr/local/share/licenses/noto-emoji/OFL.txt
ENV EDITING_FONT_PATH=/usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf
RUN chmod 0755 /usr/local/share/fonts /usr/local/share/fonts/bitovp

# Pin release names and verify bytes because upstream rotates build assets.
ARG FFMPEG_BUILD="autobuild-2026-11-05-12-48"
ARG FFMPEG_VER="n8.1.3-34-ga35157abb9"
ARG FFMPEG_SHA256_AMD64="1bbd8ff31a24ecbe0714f21e47cc0c4382cc51340c32d5d35fc6fda44e168ab5"
ARG FFMPEG_SHA256_ARM64="96d237c0c6cb03ccf6b196b4ac4f2357a3a9425f7d4c59e1a85c3c326a3b1a50"
ARG FFMPEG_URL=""
ARG FFMPEG_SHA256=""
ARG TARGETARCH

RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends \
		openssl \
		ca-certificates \
		curl \
		xz-utils \
		libstdc++6 \
		fontconfig \
	&& fc-cache -f /usr/local/share/fonts/bitovp \
	&& if [ -z "$FFMPEG_URL" ]; then \
		case "$TARGETARCH" in \
			amd64) FF_ARCH=linux64; FF_SHA="$FFMPEG_SHA256_AMD64" ;; \
			arm64) FF_ARCH=linuxarm64; FF_SHA="$FFMPEG_SHA256_ARM64" ;; \
			*) echo "unsupported TARGETARCH: '$TARGETARCH' (need amd64 or arm64)" >&2; exit 1 ;; \
		esac; \
		FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}/ffmpeg-${FFMPEG_VER}-${FF_ARCH}-gpl-8.1.tar.xz"; \
	else \
		FF_SHA="$FFMPEG_SHA256"; \
	fi \
	&& echo "ffmpeg asset (TARGETARCH=${TARGETARCH}): ${FFMPEG_URL}" \
	&& curl -fSL "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz \
	&& if [ -n "$FF_SHA" ]; then \
		echo "$FF_SHA  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
	else \
		echo "WARNING: FFMPEG_URL override without FFMPEG_SHA256 — checksum verification SKIPPED" >&2; \
	fi \
	&& tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 \
		--wildcards '*/bin/ffmpeg' '*/bin/ffprobe' \
	&& chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
	&& rm -f /tmp/ffmpeg.tar.xz \
	&& /usr/local/bin/ffmpeg -hide_banner -version | grep -q -- '--enable-libvmaf' \
	&& /usr/local/bin/ffmpeg -hide_banner -version | grep -q -- '--enable-libsrt' \
	&& /usr/local/bin/ffmpeg -hide_banner -filters | grep -q ' libvmaf ' \
	&& apt-get purge -y --auto-remove curl xz-utils \
	&& rm -rf /var/lib/apt/lists/*

ARG VMAF_MODEL_REF="3f9e02af258a5c0e30124fc585a3c3af90126dee"
ENV VMAF_MODEL_DIR=/opt/vmaf/model
COPY docker/vmaf-models.sha256 ${VMAF_MODEL_DIR}/vmaf-models.sha256
RUN --mount=type=bind,source=docker/vmaf-build-proof.sh,target=/tmp/vmaf-build-proof.sh \
	apt-get update \
	&& apt-get install -y --no-install-recommends curl ca-certificates \
	&& mkdir -p "$VMAF_MODEL_DIR" \
	&& base="https://raw.githubusercontent.com/Netflix/vmaf/${VMAF_MODEL_REF}/model" \
	&& for m in \
		vmaf_v0.6.1.json \
		vmaf_v0.6.1neg.json \
		vmaf_4k_v0.6.1.json \
		vmaf_float_v0.6.1.json \
		vmaf_float_v0.6.1neg.json \
		vmaf_float_4k_v0.6.1.json \
	; do \
		curl -fSL "$base/$m" -o "$VMAF_MODEL_DIR/$m" ; \
	done \
	&& for m in \
		vmaf_v1.0.16_3d0h \
		vmaf_v1.0.16_3d0h_2160 \
		vmaf_v1.0.16_5d0h \
		vmaf_v1.0.16_1d5h_2160 \
	; do \
		curl -fSL "$base/vmaf_v1.0.16/$m.json" -o "$VMAF_MODEL_DIR/$m.json" ; \
	done \
	&& for m in \
		vmaf_v1.0.16_hfr_3d0h \
		vmaf_v1.0.16_hfr_3d0h_2160 \
		vmaf_v1.0.16_hfr_5d0h \
		vmaf_v1.0.16_hfr_1d5h_2160 \
	; do \
		curl -fSL "$base/vmaf_v1.0.16_hfr/$m.json" -o "$VMAF_MODEL_DIR/$m.json" ; \
	done \
	&& (cd "$VMAF_MODEL_DIR" && sha256sum -c --strict vmaf-models.sha256) \
	&& sh /tmp/vmaf-build-proof.sh ffmpeg "$VMAF_MODEL_DIR" \
	&& apt-get purge -y --auto-remove curl \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=caption-alignment-runtime /opt/bitovp-caption-alignment /opt/bitovp-caption-alignment
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 libsndfile1 sox libgomp1 \
	&& rm -rf /var/lib/apt/lists/*

ENV COREPACK_HOME=/corepack
RUN corepack enable \
	&& corepack prepare pnpm@11.28.8+sha512.f6988a32046b9a3f78d7d7ee0747926bbe905ff9dff73bf19abb87bd7d1906a2ac90d93f73be32b5f9e14c2899569bcb0c9c5ec8a19e083f5d71bbab6dd9e0b8 --activate \
	&& chmod -R a+rX /corepack

WORKDIR /app

ARG GIT_COMMIT=unknown
ENV BITOVP_COMMIT=$GIT_COMMIT
LABEL org.opencontainers.image.revision=$GIT_COMMIT

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile --filter "@bitovp/worker..." \
	|| ( echo "filtered frozen install failed — falling back to full frozen install" \
		&& pnpm install --frozen-lockfile )

RUN pnpm --filter @bitovp/db run build

USER node

CMD ["pnpm", "--filter", "@bitovp/worker", "start"]

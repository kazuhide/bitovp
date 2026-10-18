# syntax=docker/dockerfile:1
# Worker image with FFmpeg, streaming protocols, and VMAF models.
FROM node:24-bookworm-slim

# Pin release names and verify bytes because upstream rotates build assets.
ARG FFMPEG_BUILD="autobuild-2026-10-17-20-51"
ARG FFMPEG_VER="n8.1.3-18-g46d899d7a0"
ARG FFMPEG_SHA256_AMD64="44a434bd1b3f98ab92f8e6545b17fc64c2e8af508688c912eb4e8447c115680c"
ARG FFMPEG_SHA256_ARM64="a3de0970c7785bd53950053307883cb289e285d6e44cc1e2b7c3d22f960241a6"
ARG FFMPEG_URL=""
ARG FFMPEG_SHA256=""
ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		openssl \
		ca-certificates \
		curl \
		xz-utils \
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
RUN apt-get update \
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
	&& ffmpeg -hide_banner \
		-f lavfi -i testsrc=size=64x64:rate=5:duration=0.4 \
		-f lavfi -i testsrc=size=64x64:rate=5:duration=0.4 \
		-lavfi "[0:v][1:v]libvmaf=model=path=$VMAF_MODEL_DIR/vmaf_v1.0.16_3d0h.json" \
		-f null - 2>&1 | grep -q 'VMAF score' \
	&& apt-get purge -y --auto-remove curl \
	&& rm -rf /var/lib/apt/lists/*

ENV COREPACK_HOME=/corepack
RUN corepack enable \
	&& corepack prepare pnpm@11.20.0 --activate \
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

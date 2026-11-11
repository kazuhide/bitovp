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

# FFmpeg and ffprobe, compiled from source. Every source is pinned by commit or
# release and by SHA-256, and every compile step runs without network access.
# Libraries that bitovp does not use are left out; FFmpeg's own codecs, formats
# and filters are all kept. The commits and the build options follow the recipe
# of github.com/BtbN/FFmpeg-Builds at c63bb308a1de.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS ffmpeg-toolchain
RUN apt-get update \
	&& apt-get install -y --no-install-recommends autoconf automake cmake g++ gperf libtool make nasm ninja-build pkg-config python3 xxd \
	&& rm -rf /var/lib/apt/lists/*
# Fontconfig needs a newer Meson than Debian 12 has.
ADD --checksum=sha256:ab0a6ca09f8ef70c564c8241fb5a23957886a0b53fb58412b5e07eaf07dba743 https://github.com/mesonbuild/meson/releases/download/1.12.1/meson-1.12.1.tar.gz /tmp/meson.tar.gz
RUN --network=none mkdir /opt/meson && tar xzf /tmp/meson.tar.gz -C /opt/meson --strip-components=1 \
	&& printf '#!/bin/sh\nexec python3 /opt/meson/meson.py "$@"\n' > /usr/local/bin/meson \
	&& chmod 0755 /usr/local/bin/meson \
	&& test "$(meson --version)" = "1.12.1"
# OpenSSL and SVT-AV1 store their build time. SOURCE_DATE_EPOCH fixes it, to the
# date of the FFmpeg commit, so that the same sources give the same bytes.
ENV SOURCE_DATE_EPOCH=1793770217 \
	PKG_CONFIG_LIBDIR=/opt/ffbuild/lib/pkgconfig \
	CFLAGS="-I/opt/ffbuild/include -O2 -pipe -fPIC -DPIC -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fstack-clash-protection -pthread" \
	CXXFLAGS="-I/opt/ffbuild/include -O2 -pipe -fPIC -DPIC -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fstack-clash-protection -pthread" \
	LDFLAGS="-L/opt/ffbuild/lib -O2 -pipe -fstack-protector-strong -fstack-clash-protection -Wl,-z,relro,-z,now -pthread"
WORKDIR /src

FROM ffmpeg-toolchain AS ffmpeg-zlib
ADD --checksum=sha256:bb27c6019ed72ea6d3ceb574cd8074083a7391afa08404ddf945bcd24f01742b https://codeload.github.com/madler/zlib/tar.gz/9d314c341b2ce16e01ae44e27ec3dd2f32aa58fd zlib.tar.gz
RUN --network=none mkdir zlib && tar xzf zlib.tar.gz -C zlib --strip-components=1 && cd zlib \
	&& ./configure --prefix=/opt/ffbuild --static \
	&& make -j"$(nproc)" && make install \
	&& install -D -m 0644 LICENSE /opt/ffbuild/share/licenses/zlib/LICENSE

# TLS for RTMPS, and SRT with its encryption.
FROM ffmpeg-zlib AS ffmpeg-tls
ADD --checksum=sha256:a2157c2830efdec3788939b00c9b0638306d3f0bbb76dc4832ee503bb397df98 https://github.com/openssl/openssl/releases/download/openssl-3.6.5/openssl-3.6.5.tar.gz openssl.tar.gz
RUN --network=none mkdir openssl && tar xzf openssl.tar.gz -C openssl --strip-components=1 && cd openssl \
	&& CFLAGS="$CFLAGS -fno-strict-aliasing" ./Configure threads zlib no-shared no-tests no-apps no-legacy no-ssl3 enable-camellia enable-ec enable-srp \
		--prefix=/opt/ffbuild --libdir=lib --openssldir=/etc/ssl \
	&& make -j"$(nproc)" build_sw && make install_sw \
	&& install -D -m 0644 LICENSE.txt /opt/ffbuild/share/licenses/openssl/LICENSE.txt
ADD --checksum=sha256:4946189b19692b40d2872b16410f5b58b8023888e93275fc9e76415614ce941c https://codeload.github.com/Haivision/srt/tar.gz/9f2390232a8256ed4c72a5418c2b2777c49ad737 srt.tar.gz
RUN --network=none mkdir srt && tar xzf srt.tar.gz -C srt --strip-components=1 && cd srt \
	&& cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/ffbuild -DCMAKE_INSTALL_LIBDIR=lib \
		-DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DENABLE_CXX_DEPS=ON -DUSE_STATIC_LIBSTDCXX=ON -DENABLE_ENCRYPTION=ON -DENABLE_APPS=OFF \
	&& cmake --build build && cmake --install build \
	&& echo "Libs.private: -l:libstdc++.a" >> /opt/ffbuild/lib/pkgconfig/srt.pc \
	&& install -D -m 0644 LICENSE /opt/ffbuild/share/licenses/srt/LICENSE

# Caption rendering: libass and what it needs.
FROM ffmpeg-zlib AS ffmpeg-text
ADD --checksum=sha256:13bda7af58a59bddc052ddb34b3472eb1ee18fdc72465f626daa3e2dd530b269 https://codeload.github.com/GNOME/libxml2/tar.gz/c79c9612fcc77b06b0d16f35fd363d938bdbbf5e libxml2.tar.gz
RUN --network=none mkdir libxml2 && tar xzf libxml2.tar.gz -C libxml2 --strip-components=1 && cd libxml2 \
	&& ./autogen.sh --prefix=/opt/ffbuild --without-python --disable-maintainer-mode --disable-shared --enable-static \
	&& make -j"$(nproc)" && make install \
	&& install -D -m 0644 Copyright /opt/ffbuild/share/licenses/libxml2/Copyright
ADD --checksum=sha256:fda0f8f46b11c059e036ec776c2e18d1cd18a9db48136b563cad12e16a2e62c9 https://codeload.github.com/freetype/freetype/tar.gz/4ba7c3d82ab8b3cc80b869337d2c2b1913c5e415 freetype.tar.gz
# FreeType's build copies its dlg submodule, which the archive of a commit lacks.
# This is the revision that the FreeType commit records.
ADD --checksum=sha256:263a4a3777d9839e34cd41db988310659e0c00eab37beb7aedd30511a460133b https://codeload.github.com/nyorain/dlg/tar.gz/395ccad2c1e0daae535c4d20bb0a3f2424648e17 dlg.tar.gz
RUN --network=none mkdir freetype && tar xzf freetype.tar.gz -C freetype --strip-components=1 && cd freetype \
	&& tar xzf ../dlg.tar.gz -C subprojects/dlg --strip-components=1 \
	&& ./autogen.sh \
	&& ./configure --prefix=/opt/ffbuild --disable-shared --enable-static --with-zlib=yes --with-bzip2=no --with-png=no --with-harfbuzz=no --with-brotli=no \
	&& make -j"$(nproc)" && make install \
	&& install -D -m 0644 -t /opt/ffbuild/share/licenses/freetype LICENSE.TXT docs/FTL.TXT docs/GPLv2.TXT
ADD --checksum=sha256:c4b5dfbde9a212ec480eb289f06be6ebffa1b2af5d38061c9a2f78bade609f82 https://codeload.github.com/harfbuzz/harfbuzz/tar.gz/75d8ac5d2313842550174eaab0cbaf653c8f2f77 harfbuzz.tar.gz
RUN --network=none mkdir harfbuzz && tar xzf harfbuzz.tar.gz -C harfbuzz --strip-components=1 && cd harfbuzz \
	&& meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
		-Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled -Dicu=disabled \
		-Dtests=disabled -Dintrospection=disabled -Ddocs=disabled -Ddoc_tests=false -Dutilities=disabled \
		-Dsubset=disabled -Draster=disabled -Dvector=disabled -Dgpu=disabled \
	&& ninja -C build install \
	&& echo "Libs.private: -lpthread" >> /opt/ffbuild/lib/pkgconfig/harfbuzz.pc \
	&& install -D -m 0644 COPYING /opt/ffbuild/share/licenses/harfbuzz/COPYING
ADD --checksum=sha256:0a666e0f5a42e9e938e38f6c2859fe39eda37ca9852e8afd1c2d226be163a529 https://codeload.github.com/fribidi/fribidi/tar.gz/d2f3e1f4946e7cef9789e1c3ebdb4a60d4314c7f fribidi.tar.gz
RUN --network=none mkdir fribidi && tar xzf fribidi.tar.gz -C fribidi --strip-components=1 && cd fribidi \
	&& meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
		-Dbin=false -Ddocs=false -Dtests=false \
	&& ninja -C build install \
	&& sed -i 's/Cflags:/Cflags: -DFRIBIDI_LIB_STATIC/' /opt/ffbuild/lib/pkgconfig/fribidi.pc \
	&& install -D -m 0644 COPYING /opt/ffbuild/share/licenses/fribidi/COPYING
ADD --checksum=sha256:6b4fbe4836f6b1be34a5ba86961b13347169cbefaedaf08fc0b2ddfb718c0193 https://codeload.github.com/adah1972/libunibreak/tar.gz/f8172fe771ef620112247cadfb876aecaa4f769e libunibreak.tar.gz
RUN --network=none mkdir libunibreak && tar xzf libunibreak.tar.gz -C libunibreak --strip-components=1 && cd libunibreak \
	&& ./bootstrap \
	&& ./configure --prefix=/opt/ffbuild --disable-shared --enable-static --with-pic \
	&& make -j"$(nproc)" && make install \
	&& install -D -m 0644 LICENCE /opt/ffbuild/share/licenses/libunibreak/LICENCE
# Only the library and its headers are kept: the image's own Fontconfig package
# provides the configuration under /etc/fonts.
ADD --checksum=sha256:6ae28798f69f70393e17aa39a01a968776af2ebae28f90276c021fb4bb0ecaa3 https://codeload.github.com/fontconfig/fontconfig/tar.gz/b25ffeabd15b76f86c0c6736f6df2f1b89858010 fontconfig.tar.gz
RUN --network=none mkdir fontconfig && tar xzf fontconfig.tar.gz -C fontconfig --strip-components=1 && cd fontconfig \
	&& meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --sysconfdir=/etc --localstatedir=/var --buildtype=release --default-library=static \
		-Ddoc=disabled -Dnls=disabled -Diconv=enabled -Dxml-backend=libxml2 -Dtools=disabled -Dcache-build=disabled -Dtests=disabled \
	&& DESTDIR=/tmp/fontconfig ninja -C build install \
	&& cp -a /tmp/fontconfig/opt/ffbuild/lib/. /opt/ffbuild/lib/ \
	&& cp -a /tmp/fontconfig/opt/ffbuild/include/. /opt/ffbuild/include/ \
	&& install -D -m 0644 COPYING /opt/ffbuild/share/licenses/fontconfig/COPYING
# As in that recipe, libass's read_file gets a name that no other library in the
# static link can define as well.
ADD --checksum=sha256:edb3e866ca9394152484bc9a83b68a395f5c9052ae0dc502e4100035c250330b https://codeload.github.com/libass/libass/tar.gz/f61db567e6593df3470e91594bcd4ad2d0473aff libass.tar.gz
RUN --network=none mkdir libass && tar xzf libass.tar.gz -C libass --strip-components=1 && cd libass \
	&& CFLAGS="$CFLAGS -Dread_file=libass_internal_read_file" meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
		-Dtest=disabled -Dcompare=disabled -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled -Dfontconfig=enabled -Dasm=enabled -Dlibunibreak=enabled \
	&& ninja -C build install \
	&& install -D -m 0644 COPYING /opt/ffbuild/share/licenses/libass/COPYING

# An archive of a commit holds no Git history, so libvmaf, SVT-AV1 and dav1d would
# report a release version. Each is told its revision instead: bitovp records the
# libvmaf version with every measurement, and a revision is not a release.
FROM ffmpeg-toolchain AS ffmpeg-vmaf
# libvmaf's command-line tool is not built. As in that recipe, the swap, min and
# max of svm.cpp get names that the C++ library does not use.
ARG LIBVMAF_COMMIT="f712fa7564fe49b12991d83920b83573af2ae063"
ADD --checksum=sha256:18e7e34c4165d4fd9781beb4aac11866c3b7d5ad4e1149b201417e7b7e379b54 https://codeload.github.com/Netflix/vmaf/tar.gz/${LIBVMAF_COMMIT} vmaf.tar.gz
RUN --network=none mkdir vmaf && tar xzf vmaf.tar.gz -C vmaf --strip-components=1 && cd vmaf \
	&& revision=$(printf '%.7s' "$LIBVMAF_COMMIT") \
	&& sed -i "s/@VCS_TAG@/$revision/" libvmaf/include/vcs_version.h.in \
	&& grep -q "\"$revision\"" libvmaf/include/vcs_version.h.in \
	&& echo > libvmaf/tools/meson.build \
	&& sed -i -E -e 's/([^.>:_[:alnum:]])swap\(/\1libsvm_swap(/g' -e 's/([^.>:_[:alnum:]])min\(/\1libsvm_min(/g' -e 's/([^.>:_[:alnum:]])max\(/\1libsvm_max(/g' libvmaf/src/svm.cpp \
	&& meson setup build libvmaf --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
		-Dbuilt_in_models=true -Denable_tests=false -Denable_docs=false -Denable_float=true -Denable_avx512=true -Denable_asm=true \
	&& ninja -C build install \
	&& sed -i 's/Libs.private:/Libs.private: -l:libstdc++.a/; t; $ a Libs.private: -l:libstdc++.a' /opt/ffbuild/lib/pkgconfig/libvmaf.pc \
	&& install -D -m 0644 LICENSE /opt/ffbuild/share/licenses/libvmaf/LICENSE

# H.264 and AV1 encoding, AV1 decoding.
FROM ffmpeg-toolchain AS ffmpeg-codecs
ADD --checksum=sha256:d0967a1348c85dfde363bb52610403be898171493100561efa0dd05d5fd1ae50 https://codeload.github.com/mirror/x264/tar.gz/0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee x264.tar.gz
RUN --network=none mkdir x264 && tar xzf x264.tar.gz -C x264 --strip-components=1 && cd x264 \
	&& ./configure --prefix=/opt/ffbuild --disable-cli --enable-static --enable-pic --disable-lavf --disable-swscale \
	&& make -j"$(nproc)" && make install \
	&& install -D -m 0644 COPYING /opt/ffbuild/share/licenses/x264/COPYING
ARG SVTAV1_COMMIT="ad11d76a6c9cb05ec49d166cf20ec5d286715dc1"
ADD --checksum=sha256:a27ef1d03167efd516682bf740d76c0bce70770c59ecc6d1cbb639daa5b3f2f2 https://codeload.github.com/AOMediaCodec/SVT-AV1/tar.gz/${SVTAV1_COMMIT} svt-av1.tar.gz
RUN --network=none mkdir svt-av1 && tar xzf svt-av1.tar.gz -C svt-av1 --strip-components=1 && cd svt-av1 \
	&& revision=$(printf '%.9s' "$SVTAV1_COMMIT") \
	&& sed -i "s/@PACKAGE_VERSION_STRING@/@PACKAGE_VERSION_STRING@-g$revision/" Source/Lib/Codec/EbVersion.h.in \
	&& grep -q -- "-g$revision\"" Source/Lib/Codec/EbVersion.h.in \
	&& cmake -S . -B build-static -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/ffbuild -DCMAKE_INSTALL_LIBDIR=lib \
		-DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DBUILD_APPS=OFF -DSVT_AV1_LTO=OFF \
	&& cmake --build build-static && cmake --install build-static \
	&& install -D -m 0644 -t /opt/ffbuild/share/licenses/svt-av1 LICENSE.md LICENSE-BSD2.md PATENTS.md
ARG DAV1D_COMMIT="b8b2d726b4b78a2fb174cb45baff441b5969672c"
ADD --checksum=sha256:9c97302591bc60d51cc8583ac179fdebc661e45542b9c12fd41de585f2e67882 https://codeload.github.com/videolan/dav1d/tar.gz/${DAV1D_COMMIT} dav1d.tar.gz
RUN --network=none mkdir dav1d && tar xzf dav1d.tar.gz -C dav1d --strip-components=1 && cd dav1d \
	&& revision=$(printf '%.7s' "$DAV1D_COMMIT") \
	&& sed -i "s/@VCS_TAG@/$revision/" include/vcs_version.h.in \
	&& grep -q "\"$revision\"" include/vcs_version.h.in \
	&& meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
		-Denable_tools=false -Denable_tests=false \
	&& ninja -C build install \
	&& install -D -m 0644 COPYING /opt/ffbuild/share/licenses/dav1d/COPYING

FROM ffmpeg-toolchain AS ffmpeg-build
COPY --from=ffmpeg-tls /opt/ffbuild/ /opt/ffbuild/
COPY --from=ffmpeg-text /opt/ffbuild/ /opt/ffbuild/
COPY --from=ffmpeg-vmaf /opt/ffbuild/ /opt/ffbuild/
COPY --from=ffmpeg-codecs /opt/ffbuild/ /opt/ffbuild/
# Headers for NVIDIA decoding and encoding; the driver's libraries are loaded at run time.
ADD --checksum=sha256:625ddd8f2a603699fdba101bebcde0e7a97bcc7b8a82ec7f45a7d06d61336597 https://codeload.github.com/FFmpeg/nv-codec-headers/tar.gz/ced4f8eba3ba5dd431932cba17928f0dffdaeb2b nv-codec-headers.tar.gz
RUN --network=none mkdir nv-codec-headers && tar xzf nv-codec-headers.tar.gz -C nv-codec-headers --strip-components=1 \
	&& make -C nv-codec-headers PREFIX=/opt/ffbuild install
# FFMPEG_VER is what FFmpeg reports as its version: the release tag, the number of
# commits after it, and the revision. Only what FFmpeg itself provides is built in,
# plus the libraries above.
ARG FFMPEG_VER="n8.1.3-34-ga35157abb9"
ARG FFMPEG_COMMIT="a35157abb96167fd7308edc92b55408d5bb084b0"
ADD --checksum=sha256:0dd30eb8eca5370dc2dad5f9958d9d7221fa4e8a1d407fd06fbc305c15c9314e https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/${FFMPEG_COMMIT} ffmpeg.tar.gz
RUN --network=none mkdir ffmpeg && tar xzf ffmpeg.tar.gz -C ffmpeg --strip-components=1 && cd ffmpeg \
	&& case "$FFMPEG_VER" in *-g"$(printf '%.10s' "$FFMPEG_COMMIT")") ;; *) echo "FFMPEG_VER does not end with the revision of FFMPEG_COMMIT" >&2; exit 1 ;; esac \
	&& printf '%s\n' "$FFMPEG_VER" > VERSION \
	&& ./configure --prefix=/opt/ffmpeg --pkg-config-flags=--static \
		--extra-ldflags="-static-libgcc" --extra-ldexeflags=-pie \
		--disable-autodetect --disable-debug --disable-doc --disable-ffplay \
		--enable-gpl --enable-version3 \
		--enable-zlib --enable-iconv --enable-openssl --enable-libxml2 \
		--enable-libfreetype --enable-libharfbuzz --enable-libfribidi --enable-fontconfig --enable-libass \
		--enable-libvmaf --enable-libx264 --enable-libsvtav1 --enable-libdav1d --enable-libsrt \
		--enable-ffnvcodec --enable-cuda --enable-cuvid --enable-nvdec --enable-nvenc \
	|| { tail -n 60 ffbuild/config.log; exit 1; }
RUN --network=none cd ffmpeg && make -j"$(nproc)" && make install \
	&& mkdir -p /out/bin /out/share/licenses \
	&& cp /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /out/bin/ \
	&& cp -a /opt/ffbuild/share/licenses/. /out/share/licenses/ \
	&& install -D -m 0644 -t /out/share/licenses/ffmpeg COPYING.GPLv3 LICENSE.md \
	&& /out/bin/ffmpeg -hide_banner -version \
	&& ldd /out/bin/ffmpeg && ldd /out/bin/ffprobe

# The two programs and the licences of what they contain.
FROM scratch AS ffmpeg
COPY --from=ffmpeg-build /out/ /

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
COPY --from=whisper-build /source/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /source/LICENSE /usr/local/share/licenses/whisper.cpp/LICENSE
ADD --chmod=0644 --checksum=sha256:68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5 https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf /usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf
ADD --chmod=0644 --checksum=sha256:6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2 https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE /usr/local/share/fonts/bitovp/OFL.txt
ADD --chmod=0644 --checksum=sha256:de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551 https://raw.githubusercontent.com/google/fonts/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf /usr/local/share/fonts/bitovp/NotoEmoji-wght.ttf
ADD --chmod=0644 --checksum=sha256:500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b https://raw.githubusercontent.com/google/fonts/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/OFL.txt /usr/local/share/licenses/noto-emoji/OFL.txt
ENV EDITING_FONT_PATH=/usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf
RUN chmod 0755 /usr/local/share/fonts /usr/local/share/fonts/bitovp

COPY --from=ffmpeg /bin/ffmpeg /bin/ffprobe /usr/local/bin/
COPY --from=ffmpeg /share/licenses/ /usr/local/share/licenses/

RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends \
		openssl \
		ca-certificates \
		libstdc++6 \
		fontconfig \
	&& fc-cache -f /usr/local/share/fonts/bitovp \
	&& /usr/local/bin/ffmpeg -hide_banner -version | grep -q -- '--enable-libvmaf' \
	&& /usr/local/bin/ffmpeg -hide_banner -version | grep -q -- '--enable-libsrt' \
	&& /usr/local/bin/ffmpeg -hide_banner -filters | grep -q ' libvmaf ' \
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

# FFmpeg build record

The worker image compiles its own FFmpeg and ffprobe from pinned sources. This
file records that build: the sources and their checksums, the tools, the
commands, what each configure step reported, what came out, and what was checked
on the result. The rules for operating and changing the build are in
[OPERATIONS.md](OPERATIONS.md), section "Worker FFmpeg".

The record describes `Dockerfile` at commit `42e5d926` (2026-11-12 07:32 UTC).
`Dockerfile` and the files under `docker/` are unchanged since commit
`87e70e9b`, which introduced the build. `scripts/native-media-tools.sh` is as
PR #112 left it.

## Where the facts come from

- **The CI log** is the log of the job `native-media` (job 130743607114) of CI
  run 43084022985, for commit `22498424`, on 2026-11-11 from 19:06:14 to
  19:19:55 UTC. The runner was GitHub-hosted and x86-64, with the image
  `ubuntu-26.04` version `20261101.186.1` (Ubuntu 26.04.1 LTS). The job built
  the `ffmpeg` stage with `scripts/native-media-tools.sh`, and no step came from
  a cache. Its steps are cited as "CI #N".
- **The arm64 log** is the log of a build of the same stage for `linux/arm64`
  with Docker Desktop. It holds no clock times; the file was last written on
  2026-11-11 at 23:53 UTC. The pinned archives and the base image came from the
  builder's store (`CACHED`), and every `RUN` step ran. Its steps are cited as
  "arm64 #N".
- **The capability lists** are what the programs print for `-buildconf`,
  `-decoders`, `-encoders`, `-demuxers`, `-muxers`, `-filters`, `-bsfs`,
  `-hwaccels`, `-protocols` and `-pix_fmts`. They were saved for the programs of
  this build and for the earlier prebuilt build, on `linux/amd64` and on
  `linux/arm64`.
- **The logs of PR #112** are the logs of the jobs `native-media`, `media-smoke`
  and `installed-gui` for four of its five commits (`334b4e0f`, `47025a92`,
  `be4d3ddb` and `4ae4c43b`), on 2026-11-12. For three of them they hold a run
  in which the jobs compiled and a run in which they reused a build; for
  `be4d3ddb` they hold a run that reused. They print the SHA-256 of the
  programs, which the CI log does not.
- **The later logs** are the logs of the same three jobs for the merge commit
  `42e5d926` on `main` and for the first two commits of PR #114, which added
  this record (`3b5edb98` and `a403ff35`), and the logs of the two jobs of the
  first run of the workflow "FFmpeg from source".
- **The logs of PR #116** are the logs of the job `media-smoke` for its first
  commit (`c1812e8d`), on 2026-11-12: the run of the pull request and six runs
  that were started on its branch one after the other. PR #116 made the media
  check print what x264 reports that it uses of the processor.
- **The log of PR #117** is the log of the job `native-media` for its commit
  `c6650ebc`, on 2026-11-12. PR #117 made the worker name libvmaf's size limits
  in the error of a measurement, and added the test of those limits to that
  job.
- **The research records** are the measurements, reviews and notes made for
  PR #109. **The design note** is the note written for that PR.
- **The measurement records** of the check on a real GPU, of the small-picture
  tests and of the test of x264 with and without AVX-512 are result tables, logs
  and the scripts that made them. **The table of means** lists what the job
  `media-smoke` printed in the 38 jobs that passed from 2026-11-11 05:08 to
  2026-11-12 06:01 UTC (36 workflow runs, two of them with a second attempt),
  read from the logs of those jobs.

The logs, the lists, the records and the note are kept outside the repository.
The CI log and the arm64 log report the same size for `Dockerfile`, 24.18 kB
(CI #1, arm64 #1).

BuildKit numbers the steps of a build (`#N`) and prints `DONE` with the seconds
that a step took. Stages that do not depend on each other run at the same time,
so their output is interleaved in a log and their times overlap. The excerpts
below leave out BuildKit's step number and the seconds counter at the start of
each line, and show every cut as `[…]`. Commands are copied from `Dockerfile`
with each tab written as two spaces, and a tab in a log or in a script of the
appendix is written in the same way.

## What is built and where

The build makes two programs, `ffmpeg` and `ffprobe`. They report the version
`n8.1.3-34-ga35157abb9`: the release tag `n8.1.3`, the 34 commits after it, and
the revision `a35157abb9`, which is on FFmpeg's `release/8.1` branch. The
programs hold FFmpeg's own codecs, formats and filters, fourteen libraries that
the same build compiles, and FFmpeg's code for NVIDIA decoding and encoding,
which needs only headers at build time. Libraries that bitovp does not use are
left out. The commits and the build options follow the recipe of
`github.com/BtbN/FFmpeg-Builds` at `c63bb308a1de`; the image downloaded a daily
build of that project before.

The build is eight stages of `Dockerfile`:

| Stage | Starts from | What it adds |
|---|---|---|
| `ffmpeg-toolchain` | the base image | Debian's compiler and build tools, Meson 1.12.1, the environment of the build |
| `ffmpeg-zlib` | `ffmpeg-toolchain` | zlib |
| `ffmpeg-tls` | `ffmpeg-zlib` | OpenSSL, SRT |
| `ffmpeg-text` | `ffmpeg-zlib` | libxml2, FreeType, HarfBuzz, FriBidi, libunibreak, Fontconfig, libass |
| `ffmpeg-vmaf` | `ffmpeg-toolchain` | libvmaf |
| `ffmpeg-codecs` | `ffmpeg-toolchain` | x264, SVT-AV1, dav1d |
| `ffmpeg-build` | `ffmpeg-toolchain` | `/opt/ffbuild` of the four stages above, the NVIDIA headers, FFmpeg itself, the checks |
| `ffmpeg` | `scratch` | nothing: it holds only `/bin/ffmpeg`, `/bin/ffprobe` and `/share/licenses/` |

Every library is installed as a static library under `/opt/ffbuild`, with its
licence text under `/opt/ffbuild/share/licenses/`. FFmpeg's configure finds the
libraries through `PKG_CONFIG_LIBDIR=/opt/ffbuild/lib/pkgconfig`.

The last stage of the image takes the programs and the licences from the
`ffmpeg` stage:

```dockerfile
COPY --from=ffmpeg /bin/ffmpeg /bin/ffprobe /usr/local/bin/
COPY --from=ffmpeg /share/licenses/ /usr/local/share/licenses/
```

### Running the build

Building the worker image runs these stages. This command builds the programs
alone into a new directory:

```bash
docker build --file Dockerfile --target ffmpeg --output type=local,dest=<new directory> .
```

The directory then holds `bin/ffmpeg`, `bin/ffprobe` and `share/licenses/`.

`sh scripts/native-media-tools.sh <new directory>` runs the same build and then
downloads the fourteen VMAF models that the image pins into
`<new directory>/model`, checks them against `docker/vmaf-models.sha256`, and
runs the proof described under "Verification record". It prints FFmpeg's version
line, `VMAF models: 14 files verified`, `FFmpeg: built from the pinned sources`
and the SHA-256 of the two programs. The script needs Docker with BuildKit and
runs on Linux only. The host needs glibc 2.36 or newer, because the programs are
linked in the image, which is Debian 12. The script refuses a directory that
exists, and a path that holds anything but letters, digits and `/ . _ -`.

With `--cache <cache directory>` in front of the new directory, the script keeps
what it built in the cache directory, and a later run for the same sources
copies that build and compiles nothing. CI runs the script this way (see "How CI
obtains this build").

### What makes the build repeatable

- Every source is the archive of one commit or of one release, added with
  `ADD --checksum=sha256:…`. The build stops when the downloaded bytes differ.
- Every `RUN` step of these stages is `RUN --network=none`, except the one that
  installs Debian's packages. Every `meson setup` has `--wrap-mode=nodownload`.
  No compile step can fetch what is not pinned.
- `SOURCE_DATE_EPOCH=1793770217` is 2026-11-04 05:30:17 UTC, the date of the
  pinned FFmpeg commit. OpenSSL and SVT-AV1 store their build time, and this
  value fixes it.
- The base image is pinned by digest.
- The test "the worker image compiles FFmpeg from sources pinned by commit or
  release and by checksum, without network access" in
  `scripts/gated-tests.test.mjs` fails when `Dockerfile` breaks one of these
  rules.

The design note records that four builds on each architecture, one of them
without any cache, gave the same bytes for both programs. The research records
state the condition: the bytes hold for the Debian packages of 2026-11-11
(`gcc-12` 12.2.0-14+deb12u1, `binutils` 2.40-2, `libc6-dev` 2.36-9+deb12u14),
and a new compiler package may change them.

Two inputs are not fixed. The Debian packages are whatever `apt-get` offers on
the day of the build (see "Toolchain"). The Dockerfile frontend is named by line
1 of `Dockerfile` as `# syntax=docker/dockerfile:1`; in both logs it resolved to
`docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e`
(CI #4, arm64 #3).

## How CI obtains this build

Three jobs need the programs:

| Job | Workflow file | Runner | What it does with the programs |
|---|---|---|---|
| `native-media` | `ci.yml` | `ubuntu-latest` | runs every test that drives real FFmpeg |
| `media-smoke` | `offline-media.yml` | `ubuntu-latest` | builds the worker image and validates a ten-second asset with it |
| `installed-gui` | `installed-gui.yml` | `ubuntu-24.04` | builds the images of an installation and runs the browser tests |

From PR #109 to PR #112 each of the three compiled the stages of this record in
every run. Since PR #112 a job compiles them only when no build is kept for the
same sources. [OPERATIONS.md](OPERATIONS.md) holds the rules: when a run
compiles, what makes the reuse safe, and how to delete the kept builds. This
section records how the hand-over works and what the runs of PR #112 showed.

### Keeping and reusing a build

Each job restores the directory `$RUNNER_TEMP/ffmpeg-build` with `actions/cache`
under the key `ffmpeg-<os>-<arch>-<hash>`. The hash is `hashFiles` of
`Dockerfile`, `docker/vmaf-models.sha256` and `scripts/native-media-tools.sh`.
The step has no `restore-keys`, so a build of other sources is never taken. The
job then runs the script with that directory:

```sh
sh scripts/native-media-tools.sh --cache "$RUNNER_TEMP/ffmpeg-build" "$RUNNER_TEMP/native-media"
```

With `--cache` the script computes a key of its own for the same inputs: the
SHA-256 of the processor's name (`uname -m`) and of the `sha256sum` lines of the
three files. What stands under that key in the cache directory decides between
two paths.

- **Nothing stands under the key.** The script builds as under "Running the
  build" and downloads the models. Before it builds, it stops with status 1 when
  the cache directory could not take the result: when the directory cannot be
  written, or when it does not exist and the directory above it cannot be
  written.
- **A build stands under the key.** The script takes it only when it is whole.
  It must hold the list `SHA256SUMS` and the directories `bin`, `model` and
  `share`, and no other name beside them; below them only plain files, and no
  empty directory; exactly the files that the list names, with the SHA-256 that
  the list records; and both programs, executable. The script then copies the
  three directories into the new directory, and calls neither Docker nor curl.
  It writes nothing into the cache directory, so a cache directory that cannot
  be written still serves the build that it holds. A build that is not whole
  stops the script with status 1. The script does not build in its place, so a
  cache that went wrong is seen.

On both paths the script then checks that `model` holds the fourteen models of
`docker/vmaf-models.sha256` and nothing else, verifies their SHA-256, and runs
the proof described under "Verification record" with the `ffmpeg` of the new
directory.

A build that the script has just made is kept only after these checks. The
script copies `bin`, `model` and `share` into a directory with another name
inside the cache directory, writes `SHA256SUMS` there, checks the copy as it
checks a build that it finds, and gives it the key as its name with one rename.
A run that ends before that rename leaves nothing under the key. The script
removes the directory with the other name when it fails there, and when one of
the signals HUP, INT and TERM ends it. A kill that cannot be caught can leave
that directory, and no run takes it for a build.

At its end the script prints FFmpeg's version line, the number of models, which
path it took, and the SHA-256 of the two programs. A run that compiled prints:

```text
ffmpeg version n8.1.3-34-ga35157abb9 Copyright (c) 2000-2026 the FFmpeg developers
VMAF models: 14 files verified
FFmpeg: built from the pinned sources
61720e87dc039495ef04e47d7d6c2108e980c4092ba33517b6eae635f85311f6  bin/ffmpeg
45947b87ba291cb4f1020e4ab12b8b8d9534eabbdd85ed84a118176c8301fdd1  bin/ffprobe
```

A run that reused a build prints the same lines, with this one in the place of
the third:

```text
FFmpeg: reused the build kept under the key of these sources (43316518fa6d14ffd07a073208b55dfc6c9ed228197104862dcbcdb401ba697b)
```

That is the key of an x86-64 runner for the three files as they are at the
commit that this record describes.

The check of a kept build finds damage, not replacement: whoever can write the
cache can store another build with a list of its own. That a kept build was
compiled from these sources rests on who can write the cache, which
`OPERATIONS.md` describes.

### The image builds take the same programs

`media-smoke` and `installed-gui` give the new directory to the image build, so
the image holds the programs that the job has just proven:

- `pnpm test:media --ffmpeg <directory>` adds
  `--build-context ffmpeg=<directory>` to its `docker build`.
- `node scripts/installed-gui-smoke.mjs --ffmpeg <directory>` writes
  `additional_contexts` with the directory into its Compose override, for the
  builds of the worker and the migrate images.

The directory then stands for the stage `ffmpeg`. The two `COPY --from=ffmpeg`
lines of the last stage read from it, and none of the eight stages of this
record is built. The checks and the proof of the last stage (see "Checks in the
build") run in every image build as before. Both scripts refuse a directory that
is not an absolute path to a directory outside the checkout with `bin/ffmpeg`
and `bin/ffprobe` in it.

### The runs of PR #112 and the first runs on `main`

The three workflows ran twice for commit `4ae4c43b` on 2026-11-12, the last
commit of PR #112. It changed the script and so had a new key. The first attempt
found no build under the key; the second attempt was started again by hand after
the first had stored one.

| Job | Compiled (first attempt) | Reused (second attempt) |
|---|---|---|
| `native-media` | 14 min 35 s (job 131025078534) | 2 min 29 s (job 131033668866) |
| `media-smoke` | 18 min 34 s (job 131025078112) | 5 min 57 s (job 131033678537) |
| `installed-gui` | 16 min 56 s (job 131025078085) | 6 min 40 s (job 131033686901) |

- In the first attempt each job compiled on its own runner, and each printed
  the five lines above with the same two SHA-256. The three jobs do not wait for
  each other. `native-media` ended first, and GitHub stored its cache directory
  as an archive of 41,988,693 bytes; the other two logged
  `Failed to save: Unable to reserve cache … another job may be creating this cache`
  and passed all the same.
- In the second attempt each job logged `Cache restored successfully`, printed
  the line of a reused build with the key above and the same two SHA-256, and
  its log holds no step of an `ffmpeg-*` stage.
- The tests gave the same totals in both attempts. `native-media`: 11, 8 and
  43 tests that need FFmpeg passed, 0 skipped. `media-smoke`: 6 files with 36
  tests passed. `installed-gui`: 10 browser tests passed.
- The VMAF means of `media-smoke` were 98.282, 93.116 and 5.527 in the first
  attempt and 98.282, 93.142 and 5.088 in the second, with the same bytes of
  `ffmpeg`. The section "The VMAF means of the media job" explains the two
  sets.

Three of the four earlier commits of PR #112 had run on the same day with the
script as it was then. The times are those of `native-media`, `media-smoke` and
`installed-gui`, in this order:

| Commit | Compiled | Reused |
|---|---|---|
| `334b4e0f` | 14 min 3 s, 11 min 20 s and 19 min 6 s | 1 min 45 s, 5 min 24 s and 5 min 14 s |
| `47025a92` | 14 min 22 s, 12 min 21 s and 19 min 5 s | 1 min 41 s, 5 min 57 s and 6 min 30 s |
| `be4d3ddb` | not at all: it changed none of the three files | 2 min 24 s, 5 min 29 s and 7 min 8 s, in its first attempt |

At `47025a92` the job `media-smoke` ended first, and its archive had 41,988,639
bytes. The jobs of `be4d3ddb` reused that build: their logs show its key,
`46c02b06…`, and an archive of that size.

PR #112 was merged on 2026-11-12 at 07:32 UTC. The three jobs of the merge
commit `42e5d926` on `main` found no build, because what a pull request stores
is read by that pull request alone. Each compiled once more and printed the same
two SHA-256: `native-media` in 12 min 32 s (job 131040319726), `media-smoke` in
18 min 11 s (job 131040320129) and `installed-gui` in 16 min 52 s (job
131040319216). `media-smoke` printed set B of the VMAF means. `native-media`
ended first, and GitHub stored its cache directory for `main` as an archive of
41,988,616 bytes. Later runs on `main` and pull requests into `main` can restore
that entry (see `OPERATIONS.md`).

PR #114, which added this record, restored it. For its first commit `3b5edb98`
the three jobs took the entry of `main` and reused the build: `native-media` in
2 min 16 s (job 131049388346), `media-smoke` in 6 min 24 s (job 131049388156)
and `installed-gui` in 7 min 39 s (job 131049387707). `media-smoke` printed set
B again. For its second commit `a403ff35` the three jobs took the same entry, in
2 min 31 s (job 131066756606), 6 min 19 s (job 131066755561) and 7 min 2 s (job
131066755405), and `media-smoke` printed set A.

The four archives that GitHub stored for these runs, three for PR #112 and one
for `main`, hold the same programs and have four sizes, from 41,988,572 to
41,988,693 bytes. Why the sizes differ was not looked into.

### When a job still compiles, and the weekly build

A job compiles when no build is kept for its key where the job may read:

- after a change to one of the three files. An update of the base image's
  digest is such a change, because the digest stands in `Dockerfile`;
- on `main` after such a change is merged, because what a pull request stores
  is read by that pull request alone;
- when GitHub has removed the entry, which it does when no run has read it for
  seven days, and may do earlier when the repository's caches exceed their size
  limit.

A run that reuses a build does not show that the pinned sources can still be
downloaded and compiled, and the two image jobs no longer show that `Dockerfile`
alone builds the image that an installation gets. The workflow "FFmpeg from
source" (`.github/workflows/ffmpeg-source-build.yml`) shows both without the
cache, every Sunday at 19:17 UTC and on request:

| Job | What it runs |
|---|---|
| `ffmpeg-from-source` | the script without `--cache`: it downloads the sources and the models, compiles the stages and runs the proof |
| `image-from-source` | `pnpm test:media` without `--ffmpeg`: it builds the whole worker image from `Dockerfile` and validates the ten-second asset with it |

`gh workflow run ffmpeg-source-build.yml` starts both jobs at any time. The job
`ffmpeg-from-source` always compiles, so its log is a build log of the kind that
this record rests on (see "Renewing this record").

The workflow ran for the first time on 2026-11-12 at 07:32 UTC, started by hand
for `42e5d926` (run 43176043401). `ffmpeg-from-source` (job 131040424225) took 9
min 4 s; it compiled the stages and printed the same two SHA-256 as every other
compile by the script. `image-from-source` (job 131040424501) took 18 min 27 s:
it built the whole image from `Dockerfile` alone in 16 min 41 s, passed the 6
test files with 36 tests, and printed set B of the VMAF means (see "The VMAF
means of the media job").

## Sources

Eighteen archives are pinned: sixteen by commit, and Meson and OpenSSL by
release. The tables list them in the order of `Dockerfile`. The sizes are from
the research records, where each archive was downloaded twice with the same
SHA-256; Meson's size was not recorded there.

| Source | Commit or release | SHA-256 of the archive | Bytes |
|---|---|---|---|
| Meson | release `1.12.1` | `ab0a6ca09f8ef70c564c8241fb5a23957886a0b53fb58412b5e07eaf07dba743` | not recorded |
| zlib | commit `9d314c341b2ce16e01ae44e27ec3dd2f32aa58fd` | `bb27c6019ed72ea6d3ceb574cd8074083a7391afa08404ddf945bcd24f01742b` | 1570648 |
| OpenSSL | release `openssl-3.6.5` | `a2157c2830efdec3788939b00c9b0638306d3f0bbb76dc4832ee503bb397df98` | 55078161 |
| SRT | commit `9f2390232a8256ed4c72a5418c2b2777c49ad737` | `4946189b19692b40d2872b16410f5b58b8023888e93275fc9e76415614ce941c` | 1809298 |
| libxml2 | commit `c79c9612fcc77b06b0d16f35fd363d938bdbbf5e` | `13bda7af58a59bddc052ddb34b3472eb1ee18fdc72465f626daa3e2dd530b269` | 2971273 |
| FreeType | commit `4ba7c3d82ab8b3cc80b869337d2c2b1913c5e415` | `fda0f8f46b11c059e036ec776c2e18d1cd18a9db48136b563cad12e16a2e62c9` | 2595365 |
| dlg | commit `395ccad2c1e0daae535c4d20bb0a3f2424648e17` | `263a4a3777d9839e34cd41db988310659e0c00eab37beb7aedd30511a460133b` | 837072 |
| HarfBuzz | commit `75d8ac5d2313842550174eaab0cbaf653c8f2f77` | `c4b5dfbde9a212ec480eb289f06be6ebffa1b2af5d38061c9a2f78bade609f82` | 39019446 |
| FriBidi | commit `d2f3e1f4946e7cef9789e1c3ebdb4a60d4314c7f` | `0a666e0f5a42e9e938e38f6c2859fe39eda37ca9852e8afd1c2d226be163a529` | 2162113 |
| libunibreak | commit `f8172fe771ef620112247cadfb876aecaa4f769e` | `6b4fbe4836f6b1be34a5ba86961b13347169cbefaedaf08fc0b2ddfb718c0193` | 348069 |
| Fontconfig | commit `b25ffeabd15b76f86c0c6736f6df2f1b89858010` | `6ae28798f69f70393e17aa39a01a968776af2ebae28f90276c021fb4bb0ecaa3` | 678463 |
| libass | commit `f61db567e6593df3470e91594bcd4ad2d0473aff` | `edb3e866ca9394152484bc9a83b68a395f5c9052ae0dc502e4100035c250330b` | 352592 |
| libvmaf | commit `f712fa7564fe49b12991d83920b83573af2ae063` | `18e7e34c4165d4fd9781beb4aac11866c3b7d5ad4e1149b201417e7b7e379b54` | 18656913 |
| x264 | commit `0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee` | `d0967a1348c85dfde363bb52610403be898171493100561efa0dd05d5fd1ae50` | 1040667 |
| SVT-AV1 | commit `ad11d76a6c9cb05ec49d166cf20ec5d286715dc1` | `a27ef1d03167efd516682bf740d76c0bce70770c59ecc6d1cbb639daa5b3f2f2` | 11283471 |
| dav1d | commit `b8b2d726b4b78a2fb174cb45baff441b5969672c` | `9c97302591bc60d51cc8583ac179fdebc661e45542b9c12fd41de585f2e67882` | 1755660 |
| nv-codec-headers | commit `ced4f8eba3ba5dd431932cba17928f0dffdaeb2b` | `625ddd8f2a603699fdba101bebcde0e7a97bcc7b8a82ec7f45a7d06d61336597` | 84047 |
| FFmpeg | commit `a35157abb96167fd7308edc92b55408d5bb084b0` | `0dd30eb8eca5370dc2dad5f9958d9d7221fa4e8a1d407fd06fbc305c15c9314e` | 16924021 |

Fifteen of the commit archives come from GitHub (`codeload.github.com`), and
Meson and OpenSSL from the releases that their projects publish on GitHub. x264
comes from VideoLAN's own server, where its project keeps it. GitHub has only a
mirror of x264, and when the pin was reviewed no branch of the mirror held the
pinned commit.

| Source | Archive |
|---|---|
| Meson | `https://github.com/mesonbuild/meson/releases/download/1.12.1/meson-1.12.1.tar.gz` |
| zlib | `https://codeload.github.com/madler/zlib/tar.gz/9d314c341b2ce16e01ae44e27ec3dd2f32aa58fd` |
| OpenSSL | `https://github.com/openssl/openssl/releases/download/openssl-3.6.5/openssl-3.6.5.tar.gz` |
| SRT | `https://codeload.github.com/Haivision/srt/tar.gz/9f2390232a8256ed4c72a5418c2b2777c49ad737` |
| libxml2 | `https://codeload.github.com/GNOME/libxml2/tar.gz/c79c9612fcc77b06b0d16f35fd363d938bdbbf5e` |
| FreeType | `https://codeload.github.com/freetype/freetype/tar.gz/4ba7c3d82ab8b3cc80b869337d2c2b1913c5e415` |
| dlg | `https://codeload.github.com/nyorain/dlg/tar.gz/395ccad2c1e0daae535c4d20bb0a3f2424648e17` |
| HarfBuzz | `https://codeload.github.com/harfbuzz/harfbuzz/tar.gz/75d8ac5d2313842550174eaab0cbaf653c8f2f77` |
| FriBidi | `https://codeload.github.com/fribidi/fribidi/tar.gz/d2f3e1f4946e7cef9789e1c3ebdb4a60d4314c7f` |
| libunibreak | `https://codeload.github.com/adah1972/libunibreak/tar.gz/f8172fe771ef620112247cadfb876aecaa4f769e` |
| Fontconfig | `https://codeload.github.com/fontconfig/fontconfig/tar.gz/b25ffeabd15b76f86c0c6736f6df2f1b89858010` |
| libass | `https://codeload.github.com/libass/libass/tar.gz/f61db567e6593df3470e91594bcd4ad2d0473aff` |
| libvmaf | `https://codeload.github.com/Netflix/vmaf/tar.gz/f712fa7564fe49b12991d83920b83573af2ae063` |
| x264 | `https://code.videolan.org/videolan/x264/-/archive/0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee/x264-0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee.tar.gz` |
| SVT-AV1 | `https://codeload.github.com/AOMediaCodec/SVT-AV1/tar.gz/ad11d76a6c9cb05ec49d166cf20ec5d286715dc1` |
| dav1d | `https://codeload.github.com/videolan/dav1d/tar.gz/b8b2d726b4b78a2fb174cb45baff441b5969672c` |
| nv-codec-headers | `https://codeload.github.com/FFmpeg/nv-codec-headers/tar.gz/ced4f8eba3ba5dd431932cba17928f0dffdaeb2b` |
| FFmpeg | `https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/a35157abb96167fd7308edc92b55408d5bb084b0` |

The branch is the one on which the security review found the pinned commit. The
version is what the source reports about itself in the build logs; the sections
on each library give the step.

| Source | Branch or tag of the pin | Version in the build logs |
|---|---|---|
| Meson | release tag `1.12.1` | 1.12.1 |
| zlib | `develop` | 1.3.2.1-motley |
| OpenSSL | release tag `openssl-3.6.5` | 3.6.5 |
| SRT | `master` | not printed |
| libxml2 | `master` | 2.16.0 |
| FreeType | `master` | 2.15 (26.7.20 for pkg-config) |
| dlg | `master` | not compiled |
| HarfBuzz | `main` | 15.0.0 |
| FriBidi | `master` | 1.0.17 |
| libunibreak | `master` | 8.0 |
| Fontconfig | `main` | 2.18.3 |
| libass | `master` | 0.17.5 |
| libvmaf | `master` | 3.2.0; the library is told to report `f712fa7` |
| x264 | `master` on `code.videolan.org` | not printed |
| SVT-AV1 | `main` | v4.3.0; the library is told to report `v4.3.0-gad11d76a6` |
| dav1d | `master` | 1.5.4; the library is told to report `b8b2d72` |
| nv-codec-headers | `sdk/13.0` | not printed |
| FFmpeg | `release/8.1` | `n8.1.3-34-ga35157abb9` |

The uses are those that the design note, `Dockerfile` and `docs/OPERATIONS.md`
give. A licence is named where the shipped text or the security review names it;
the other texts are permission notices that name no licence.

| Source | What it is for | Licence |
|---|---|---|
| Meson | Build tool for HarfBuzz, FriBidi, Fontconfig, libass, libvmaf and dav1d; not part of the programs | no text shipped |
| zlib | Compression; in bitovp, PNG image assets. OpenSSL and FreeType are built with it | permission notice |
| OpenSSL | TLS for RTMPS, and the encryption of SRT | Apache License 2.0 |
| SRT | SRT delivery | Mozilla Public License 2.0 |
| libxml2 | Fontconfig's configuration files, and reading DASH | permission notice |
| FreeType | Caption rendering | FreeType License or GPL version 2, by choice |
| dlg | FreeType's build copies it; it is not compiled | no text shipped |
| HarfBuzz | Caption rendering | "Old MIT" licence |
| FriBidi | Caption rendering | LGPL version 2.1 or later |
| libunibreak | Caption rendering | permission notice |
| Fontconfig | Caption rendering: the font provider of libass | permission notice |
| libass | Caption rendering | ISC License |
| libvmaf | VMAF and CAMBI | BSD+Patent (`BSD-2-Clause-Patent`) |
| x264 | H.264 encoding: clip export and normalisation | GPL version 2 or later |
| SVT-AV1 | AV1 encoding, for test material only | BSD 3-Clause Clear License, with a patent licence text |
| dav1d | AV1 decoding | permission notice, with a patent licence text |
| nv-codec-headers | Headers for NVIDIA decoding and encoding; the driver's libraries are loaded at run time | notice at the head of each header |
| FFmpeg | The programs | GPL version 3 or later, as configured |

The section "Result" lists the licence files that the build ships.

## Toolchain

`ffmpeg-toolchain` starts from the base image of the other stages of
`Dockerfile`, which is Debian 12:

```text
node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
```

Its first step installs the compiler and the build tools. Apart from the `ADD`
steps, which download the archives, it is the only step of the eight stages that
has network access:

```dockerfile
RUN apt-get update \
  && apt-get install -y --no-install-recommends autoconf automake cmake g++ gperf libtool make nasm ninja-build pkg-config python3 xxd \
  && rm -rf /var/lib/apt/lists/*
```

`apt-get` installed 98 packages in both builds (CI #27, 13.5 s; arm64 #25,
27.5 s). From the CI log:

```text
0 upgraded, 98 newly installed, 0 to remove and 3 not upgraded.
Need to get 108 MB of archives.
After this operation, 448 MB of additional disk space will be used.
```

From the arm64 log:

```text
0 upgraded, 98 newly installed, 0 to remove and 3 not upgraded.
Need to get 97.2 MB of archives.
After this operation, 430 MB of additional disk space will be used.
```

In both logs 83 packages came from `bookworm/main` and 15 from
`bookworm-security/main`, and every package that both builds installed has the
same version in both. Two package names differ between the architectures:
`binutils-x86-64-linux-gnu` and `libquadmath0` on x86-64,
`binutils-aarch64-linux-gnu` and `libhwasan0` on arm64. The appendix lists all
packages. These are the tools that the build calls, and the compiler's parts:

| Package | Version |
|---|---|
| `autoconf` | `2.71-3` |
| `automake` | `1:1.16.5-1.3` |
| `libtool` | `2.4.7-7~deb12u1` |
| `m4` | `1.4.19-3` |
| `make` | `4.3-4.1` |
| `cmake` | `3.25.1-1` |
| `ninja-build` | `1.11.1-2~deb12u1` |
| `nasm` | `2.16.01-1` |
| `pkg-config` | `1.8.1-1` |
| `gperf` | `3.1-1` |
| `xxd` | `2:9.0.1378-2+deb12u2` |
| `python3` | `3.11.2-1+b1` |
| `python3.11` | `3.11.2-6+deb12u9` |
| `perl` | `5.36.0-7+deb12u4` |
| `gcc` | `4:12.2.0-3` |
| `gcc-12` | `12.2.0-14+deb12u1` |
| `g++` | `4:12.2.0-3` |
| `g++-12` | `12.2.0-14+deb12u1` |
| `cpp-12` | `12.2.0-14+deb12u1` |
| `libgcc-12-dev` | `12.2.0-14+deb12u1` |
| `libstdc++-12-dev` | `12.2.0-14+deb12u1` |
| `binutils` | `2.40-2` |
| `libc6-dev` | `2.36-9+deb12u14` |
| `linux-libc-dev` | `6.1.190-1` |

The tools report themselves in the logs, for example to Meson while it
configures Fontconfig (CI #55) and libass (CI #58):

```text
C compiler for the host machine: cc (gcc 12.2.0 "cc (Debian 12.2.0-14+deb12u1) 12.2.0")
C linker for the host machine: cc ld.bfd 2.40
[…]
Found pkg-config: YES (/usr/bin/pkg-config) 1.8.1
[…]
Found CMake: /usr/bin/cmake (3.25.1)
[…]
Found ninja-1.11.1 at /usr/bin/ninja
[…]
Nasm compiler for the host machine: nasm (nasm 2.16.01)
```

These packages are not pinned. A build on another day installs what Debian 12
offers on that day, and parts of the compiler's and the C library's packages are
linked into the programs. The programs' bytes can therefore change although
`Dockerfile` did not.

Debian 12's Meson is too old for Fontconfig. The second step unpacks Meson
1.12.1 from its pinned release and checks the version that it reports (CI #29,
1.1 s; arm64 #27, 0.8 s):

```dockerfile
RUN --network=none mkdir /opt/meson && tar xzf /tmp/meson.tar.gz -C /opt/meson --strip-components=1 \
  && printf '#!/bin/sh\nexec python3 /opt/meson/meson.py "$@"\n' > /usr/local/bin/meson \
  && chmod 0755 /usr/local/bin/meson \
  && test "$(meson --version)" = "1.12.1"
```

The stage ends with the environment that every later step inherits, and with the
working directory:

```dockerfile
ENV SOURCE_DATE_EPOCH=1793770217 \
  PKG_CONFIG_LIBDIR=/opt/ffbuild/lib/pkgconfig \
  CFLAGS="-I/opt/ffbuild/include -O2 -pipe -fPIC -DPIC -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fstack-clash-protection -pthread" \
  CXXFLAGS="-I/opt/ffbuild/include -O2 -pipe -fPIC -DPIC -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fstack-clash-protection -pthread" \
  LDFLAGS="-L/opt/ffbuild/lib -O2 -pipe -fstack-protector-strong -fstack-clash-protection -Wl,-z,relro,-z,now -pthread"
WORKDIR /src
```

The flags ask for optimised, position-independent code, fortified library
functions, stack protection, and relocations that are read-only after immediate
binding. The include path and the library path point at `/opt/ffbuild`.

## Libraries, in build order

Each library is one `RUN --network=none` step: it unpacks the archive,
configures, compiles, installs into `/opt/ffbuild`, and installs the licence
text. The table gives the step of each in both logs, and the seconds that
BuildKit printed for it. The lists of installed files in the sections below
leave out libtool's `.la` files, which libxml2, FreeType and libunibreak install
beside their libraries.

| Step | Stage | CI step | CI seconds | arm64 step | arm64 seconds |
|---|---|---|---|---|---|
| Debian packages | `ffmpeg-toolchain` | #27 | 13.5 | #25 | 27.5 |
| Meson | `ffmpeg-toolchain` | #29 | 1.1 | #27 | 0.8 |
| zlib | `ffmpeg-zlib` | #35 | 2.7 | #32 | 0.5 |
| OpenSSL | `ffmpeg-tls` | #40 | 248.9 | #35 | 38.0 |
| SRT | `ffmpeg-tls` | #49 | 51.4 | #47 | 15.9 |
| libxml2 | `ffmpeg-text` | #39 | 55.3 | #39 | 14.8 |
| FreeType | `ffmpeg-text` | #43 | 34.2 | #43 | 15.9 |
| HarfBuzz | `ffmpeg-text` | #46 | 185.2 | #45 | 28.2 |
| FriBidi | `ffmpeg-text` | #51 | 6.7 | #52 | 0.9 |
| libunibreak | `ffmpeg-text` | #53 | 15.2 | #54 | 3.9 |
| Fontconfig | `ffmpeg-text` | #55 | 37.0 | #56 | 7.9 |
| libass | `ffmpeg-text` | #58 | 9.9 | #58 | 1.3 |
| libvmaf | `ffmpeg-vmaf` | #38 | 33.3 | #36 | 4.0 |
| x264 | `ffmpeg-codecs` | #33 | 98.1 | #37 | 6.9 |
| SVT-AV1 | `ffmpeg-codecs` | #47 | 256.0 | #40 | 48.1 |
| dav1d | `ffmpeg-codecs` | #62 | 45.1 | #50 | 2.7 |
| NVIDIA headers | `ffmpeg-build` | #65 | 0.1 | #63 | 0.1 |
| FFmpeg: configure | `ffmpeg-build` | #67 | 9.7 | #65 | 4.5 |
| FFmpeg: make, install, checks | `ffmpeg-build` | #68 | 279.4 | #66 | 56.1 |

Stages run at the same time, so the times of steps in different stages overlap,
and how long a step takes depends on what runs beside it. In the CI log the
whole `docker build` took 11 min 48 s, from `#0` at 19:06:51.8 UTC to the end of
CI #70 at 19:18:40.2 UTC. The rows of the table for its longest chain of stages
(`ffmpeg-toolchain`, `ffmpeg-codecs`, `ffmpeg-build`) add up to 703.0 s. In the
arm64 log the rows for the longest chain (`ffmpeg-toolchain`, `ffmpeg-zlib`,
`ffmpeg-text`, `ffmpeg-build`) add up to 162.4 s.

The design note records the cost of earlier builds: 158 s and 171 s for a whole
build without a cache on an Apple silicon Mac whose Docker has 10 cores and
8 GB, between 7 min 44 s and 12 min 16 s for the CI step in the three runs of
PR #109, and 12 to 17 minutes for a `linux/amd64` build under emulation on that
Mac.

### zlib

Stage `ffmpeg-zlib`; CI #35, arm64 #32.

```dockerfile
RUN --network=none mkdir zlib && tar xzf zlib.tar.gz -C zlib --strip-components=1 && cd zlib \
  && ./configure --prefix=/opt/ffbuild --static \
  && make -j"$(nproc)" && make install \
  && install -D -m 0644 LICENSE /opt/ffbuild/share/licenses/zlib/LICENSE
```

From the CI log:

```text
Checking for gcc...
Building static library libz.a version 1.3.2.1-motley with gcc.
[…]
cp libz.a /opt/ffbuild/lib
[…]
cp zlib.3 /opt/ffbuild/share/man/man3
[…]
cp zlib.pc /opt/ffbuild/lib/pkgconfig
[…]
cp zlib.h zconf.h /opt/ffbuild/include
```

The arm64 log has the same version line:

```text
Building static library libz.a version 1.3.2.1-motley with gcc.
```

Installed: `lib/libz.a`, `lib/pkgconfig/zlib.pc`, `include/zlib.h`,
`include/zconf.h`, `share/man/man3/zlib.3` and `share/licenses/zlib/LICENSE`.

### OpenSSL

Stage `ffmpeg-tls`, which is for TLS and for SRT with its encryption; CI #40,
arm64 #35.

```dockerfile
RUN --network=none mkdir openssl && tar xzf openssl.tar.gz -C openssl --strip-components=1 && cd openssl \
  && CFLAGS="$CFLAGS -fno-strict-aliasing" ./Configure threads zlib no-shared no-tests no-apps no-legacy no-ssl3 enable-camellia enable-ec enable-srp \
    --prefix=/opt/ffbuild --libdir=lib --openssldir=/etc/ssl \
  && make -j"$(nproc)" build_sw && make install_sw \
  && install -D -m 0644 LICENSE.txt /opt/ffbuild/share/licenses/openssl/LICENSE.txt
```

From the CI log:

```text
Configuring OpenSSL version 3.6.5 for target linux-x86_64
Using os-specific seed configuration
Created configdata.pm
Running configdata.pm
Created Makefile.in
Created Makefile
Created include/openssl/configuration.h
[…]
***   OpenSSL has been successfully configured                     ***
[…]
install libcrypto.a -> /opt/ffbuild/lib/libcrypto.a
install libssl.a -> /opt/ffbuild/lib/libssl.a
install exporters/libcrypto.pc -> /opt/ffbuild/lib/pkgconfig/libcrypto.pc
install exporters/libssl.pc -> /opt/ffbuild/lib/pkgconfig/libssl.pc
install exporters/openssl.pc -> /opt/ffbuild/lib/pkgconfig/openssl.pc
[…]
install exporters/OpenSSLConfig.cmake -> /opt/ffbuild/lib/cmake/OpenSSL/OpenSSLConfig.cmake
install exporters/OpenSSLConfigVersion.cmake -> /opt/ffbuild/lib/cmake/OpenSSL/OpenSSLConfigVersion.cmake
```

The arm64 log names the other target:

```text
Configuring OpenSSL version 3.6.5 for target linux-aarch64
```

Installed: `lib/libcrypto.a`, `lib/libssl.a`, three pkg-config files, two CMake
files, 142 headers in `include/openssl`, and
`share/licenses/openssl/LICENSE.txt`. The security review records that the
programs report `OpenSSL 3.6.5 29 Sep 2026` and `OPENSSLDIR "/etc/ssl"`, as the
earlier build did.

### SRT

Stage `ffmpeg-tls`; CI #49, arm64 #47.

```dockerfile
RUN --network=none mkdir srt && tar xzf srt.tar.gz -C srt --strip-components=1 && cd srt \
  && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/ffbuild -DCMAKE_INSTALL_LIBDIR=lib \
    -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DENABLE_CXX_DEPS=ON -DUSE_STATIC_LIBSTDCXX=ON -DENABLE_ENCRYPTION=ON -DENABLE_APPS=OFF \
  && cmake --build build && cmake --install build \
  && echo "Libs.private: -l:libstdc++.a" >> /opt/ffbuild/lib/pkgconfig/srt.pc \
  && install -D -m 0644 LICENSE /opt/ffbuild/share/licenses/srt/LICENSE
```

The step appends `Libs.private: -l:libstdc++.a` to `srt.pc`. SRT is written in
C++, and with this line the programs take the C++ library from its static
archive.

From the CI log:

```text
-- The C compiler identification is GNU 12.2.0
-- The CXX compiler identification is GNU 12.2.0
[…]
-- BUILD TYPE: Release
[…]
-- Checking for module 'openssl libcrypto'
--   Found openssl libcrypto, version 3.6.5;3.6.5
-- SSL via pkg-config: -L /opt/ffbuild/lib -I /opt/ffbuild/include -l;ssl;crypto
-- ENCRYPTION: ENABLED, using: openssl libcrypto
-- SSL libraries: ssl;crypto
-- ENCRYPTION AEAD API: DISABLED
-- MAXREXMITBW API: DISABLED
[…]
-- STDCXX_SYNC: OFF
-- MONOTONIC_CLOCK: ON
-- DETECTED SYSTEM: LINUX;  LINUX=1
-- ENABLE_BONDING: OFF
[…]
-- INSTALL DIRS: bin=bin lib=lib shlib=lib include=include
-- APPS: DISABLED
-- Configuring done
-- Generating done
-- Build files have been written to: /src/srt/build
[…]
[41/41] Linking CXX static library libsrt.a
-- Install configuration: "Release"
-- Installing: /opt/ffbuild/lib/libsrt.a
-- Installing: /opt/ffbuild/include/srt/version.h
-- Installing: /opt/ffbuild/include/srt/srt.h
-- Installing: /opt/ffbuild/include/srt/logging_api.h
-- Installing: /opt/ffbuild/include/srt/access_control.h
-- Installing: /opt/ffbuild/include/srt/platform_sys.h
-- Installing: /opt/ffbuild/include/srt/udt.h
-- Installing: /opt/ffbuild/lib/pkgconfig/haisrt.pc
-- Installing: /opt/ffbuild/lib/pkgconfig/srt.pc
-- Installing: /opt/ffbuild/bin/srt-ffplay
```

Installed: `lib/libsrt.a`, six headers in `include/srt`, `srt.pc` and
`haisrt.pc`, the script `bin/srt-ffplay`, and `share/licenses/srt/LICENSE`. The
log does not print SRT's version.

### libxml2

Stage `ffmpeg-text`, which is for caption rendering: libass and what it needs;
CI #39, arm64 #39.

```dockerfile
RUN --network=none mkdir libxml2 && tar xzf libxml2.tar.gz -C libxml2 --strip-components=1 && cd libxml2 \
  && ./autogen.sh --prefix=/opt/ffbuild --without-python --disable-maintainer-mode --disable-shared --enable-static \
  && make -j"$(nproc)" && make install \
  && install -D -m 0644 Copyright /opt/ffbuild/share/licenses/libxml2/Copyright
```

From the CI log:

```text
checking whether to build shared libraries... no
checking whether to build static libraries... yes
[…]
checking for libiconv... none required
[…]
Now type 'make' to compile libxml2.
[…]
libtool: install: /usr/bin/install -c .libs/libxml2.a /opt/ffbuild/lib/libxml2.a
[…]
 /usr/bin/install -c -m 644 libxml2-config.cmake '/opt/ffbuild/lib/cmake/libxml2'
[…]
 /usr/bin/install -c -m 644 libxml-2.0.pc '/opt/ffbuild/lib/pkgconfig'
```

"none required" means that the C library's own iconv is used. The log of this
step does not print the version; Fontconfig's configure step finds `libxml-2.0`
as 2.16.0 (CI #55).

Installed: `lib/libxml2.a`, the headers in `include/libxml2/libxml`,
`lib/pkgconfig/libxml-2.0.pc`, `lib/cmake/libxml2/libxml2-config.cmake`, the
programs `bin/xml2-config`, `bin/xmllint` and `bin/xmlcatalog`, and
`share/licenses/libxml2/Copyright`.

### FreeType, with dlg

Stage `ffmpeg-text`; CI #43, arm64 #43.

FreeType's build copies its `dlg` submodule, which the archive of a commit does
not hold. The step therefore unpacks the dlg archive into `subprojects/dlg`
first. The pinned dlg revision is the one that the FreeType commit records.

```dockerfile
RUN --network=none mkdir freetype && tar xzf freetype.tar.gz -C freetype --strip-components=1 && cd freetype \
  && tar xzf ../dlg.tar.gz -C subprojects/dlg --strip-components=1 \
  && ./autogen.sh \
  && ./configure --prefix=/opt/ffbuild --disable-shared --enable-static --with-zlib=yes --with-bzip2=no --with-png=no --with-harfbuzz=no --with-brotli=no \
  && make -j"$(nproc)" && make install \
  && install -D -m 0644 -t /opt/ffbuild/share/licenses/freetype LICENSE.TXT docs/FTL.TXT docs/GPLv2.TXT
```

From the CI log:

```text
FreeType 2.15:
[…]
Copying files from `subprojects/dlg' to `src/dlg' and `include/dlg'
[…]
Library configuration:
  external zlib: yes (pkg-config)
  bzip2:         no
  libpng:        no
  harfbuzz:      no
  brotli:        no
  hvf:           no
  pthread:       yes
[…]
libtool: install: /usr/bin/install -c /src/freetype/objs/.libs/libfreetype.a /opt/ffbuild/lib/libfreetype.a
[…]
/usr/bin/install -c -m 644 ./builds/unix/freetype2.pc             \
          /opt/ffbuild/lib/pkgconfig/freetype2.pc
```

Installed: `lib/libfreetype.a`, the headers under `include/freetype2`,
`lib/pkgconfig/freetype2.pc`, `share/aclocal/freetype2.m4`, and three texts in
`share/licenses/freetype`. pkg-config gives FreeType's version as 26.7.20.

### HarfBuzz

Stage `ffmpeg-text`; CI #46, arm64 #45.

```dockerfile
RUN --network=none mkdir harfbuzz && tar xzf harfbuzz.tar.gz -C harfbuzz --strip-components=1 && cd harfbuzz \
  && meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
    -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled -Dicu=disabled \
    -Dtests=disabled -Dintrospection=disabled -Ddocs=disabled -Ddoc_tests=false -Dutilities=disabled \
    -Dsubset=disabled -Draster=disabled -Dvector=disabled -Dgpu=disabled \
  && ninja -C build install \
  && echo "Libs.private: -lpthread" >> /opt/ffbuild/lib/pkgconfig/harfbuzz.pc \
  && install -D -m 0644 COPYING /opt/ffbuild/share/licenses/harfbuzz/COPYING
```

The step appends `Libs.private: -lpthread` to `harfbuzz.pc`.

From the CI log:

```text
Project version: 15.0.0
[…]
Run-time dependency freetype2 found: YES 26.7.20
[…]
Run-time dependency libpng found: NO  (tried pkg-config and cmake)
Run-time dependency zlib found: YES 1.3.2.1-motley
[…]
Build targets in project: 22
[…]
  Unicode callbacks (you want at least one)
    Builtin                   : YES
    Glib                      : NO
    ICU                       : NO
[…]
  Font callbacks (the more the merrier)
    Builtin                   : YES
    FreeType                  : YES
    Fontations                : NO
[…]
  Additional libraries
    Subset                    : NO
    Raster                    : NO
    Vector                    : NO
    GPU                       : NO
[…]
  Dependencies used by additional libraries
    PNG                       : NO
    Zlib                      : YES
[…]
  Other features
    Utilities                 : NO
    Documentation             : NO
    GObject bindings          : NO
    Cairo integration         : NO
    Introspection             : NO
    Experimental APIs         : NO
[…]
[76/77] Linking static target src/libharfbuzz.a
[…]
Installing src/libharfbuzz.a to /opt/ffbuild/lib
[…]
Installing /src/harfbuzz/build/meson-private/harfbuzz.pc to /opt/ffbuild/lib/pkgconfig
Installing /src/harfbuzz/build/src/harfbuzz-config.cmake to /opt/ffbuild/lib/cmake/harfbuzz
```

Ninja ran 77 steps. Installed: `lib/libharfbuzz.a`, the headers in
`include/harfbuzz`, `lib/pkgconfig/harfbuzz.pc`,
`lib/cmake/harfbuzz/harfbuzz-config.cmake`, and
`share/licenses/harfbuzz/COPYING`.

### FriBidi

Stage `ffmpeg-text`; CI #51, arm64 #52.

```dockerfile
RUN --network=none mkdir fribidi && tar xzf fribidi.tar.gz -C fribidi --strip-components=1 && cd fribidi \
  && meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
    -Dbin=false -Ddocs=false -Dtests=false \
  && ninja -C build install \
  && sed -i 's/Cflags:/Cflags: -DFRIBIDI_LIB_STATIC/' /opt/ffbuild/lib/pkgconfig/fribidi.pc \
  && install -D -m 0644 COPYING /opt/ffbuild/share/licenses/fribidi/COPYING
```

The step adds `-DFRIBIDI_LIB_STATIC` to the `Cflags` line of `fribidi.pc`.

From the CI log:

```text
Project name: fribidi
Project version: 1.0.17
[…]
Build targets in project: 15
[…]
  User defined options
    bin            : false
    buildtype      : release
    default_library: static
    docs           : false
    libdir         : lib
    prefix         : /opt/ffbuild
    tests          : false
    wrap_mode      : nodownload
[…]
Installing lib/libfribidi.a to /opt/ffbuild/lib
[…]
Installing /src/fribidi/build/meson-private/fribidi.pc to /opt/ffbuild/lib/pkgconfig
```

Ninja ran 47 steps. Installed: `lib/libfribidi.a`, the headers in
`include/fribidi`, `lib/pkgconfig/fribidi.pc`, and
`share/licenses/fribidi/COPYING`.

### libunibreak

Stage `ffmpeg-text`; CI #53, arm64 #54.

```dockerfile
RUN --network=none mkdir libunibreak && tar xzf libunibreak.tar.gz -C libunibreak --strip-components=1 && cd libunibreak \
  && ./bootstrap \
  && ./configure --prefix=/opt/ffbuild --disable-shared --enable-static --with-pic \
  && make -j"$(nproc)" && make install \
  && install -D -m 0644 LICENCE /opt/ffbuild/share/licenses/libunibreak/LICENCE
```

From the CI log:

```text
checking whether to build shared libraries... no
checking whether to build static libraries... yes
[…]
libtool: install: /usr/bin/install -c .libs/libunibreak.a /opt/ffbuild/lib/libunibreak.a
[…]
[ -f //opt/ffbuild/lib/libunibreak.a ] && \
rm -f //opt/ffbuild/lib/liblinebreak.a && \
ln -s libunibreak.a //opt/ffbuild/lib/liblinebreak.a
[…]
 /usr/bin/install -c -m 644 unibreakbase.h unibreakdef.h linebreak.h graphemebreak.h wordbreak.h '/opt/ffbuild/include'
[…]
 /usr/bin/install -c -m 644 libunibreak.pc '/opt/ffbuild/lib/pkgconfig'
```

Installed: `lib/libunibreak.a`, the link `lib/liblinebreak.a` to it, five
headers in `include`, `lib/pkgconfig/libunibreak.pc`, and
`share/licenses/libunibreak/LICENCE`. libass's configure step finds the library
as version 8.0 (CI #58).

### Fontconfig

Stage `ffmpeg-text`; CI #55, arm64 #56.

Only the library and its headers are kept. The image's own Fontconfig package
provides the configuration under `/etc/fonts`. The step therefore installs into
`/tmp/fontconfig` and copies `lib` and `include` from there.

```dockerfile
RUN --network=none mkdir fontconfig && tar xzf fontconfig.tar.gz -C fontconfig --strip-components=1 && cd fontconfig \
  && meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --sysconfdir=/etc --localstatedir=/var --buildtype=release --default-library=static \
    -Ddoc=disabled -Dnls=disabled -Diconv=enabled -Dxml-backend=libxml2 -Dtools=disabled -Dcache-build=disabled -Dtests=disabled \
  && DESTDIR=/tmp/fontconfig ninja -C build install \
  && cp -a /tmp/fontconfig/opt/ffbuild/lib/. /opt/ffbuild/lib/ \
  && cp -a /tmp/fontconfig/opt/ffbuild/include/. /opt/ffbuild/include/ \
  && install -D -m 0644 COPYING /opt/ffbuild/share/licenses/fontconfig/COPYING
```

From the CI log:

```text
Project name: fontconfig
Project version: 2.18.3
[…]
Run-time dependency freetype2 found: YES 26.7.20
[…]
Run-time dependency json-c found: NO  (tried pkg-config and cmake)
Run-time dependency libxml-2.0 found: YES 2.16.0
[…]
Library iconv found: NO
Header "iconv.h" has symbol "libiconv_open" with dependency intl: NO
Has header "iconv.h" : YES
[…]
Build targets in project: 16
[…]
fontconfig 2.18.3

  General
    Documentation              : NO
    NLS                        : NO
    Tests                      : NO
    Tests (external fonts)     : YES
    Pytest                     : NO
    Tools                      : NO
    iconv                      : YES
    XML backend                : libxml-2.0
    Fontations support         : disabled
    WOFF2 support (Fontations) : NO

  Defaults
    Hinting                    : slight
    Sub Pixel Rendering        : none
    Bitmap                     : no-except-emoji
    Font directories           : /usr/share/fonts, /usr/local/share/fonts
    Additional font directories:

  Paths
    Cache directory            : /var/cache/fontconfig
    Template directory         : /opt/ffbuild/share/fontconfig/conf.avail
    Base config directory      : /etc/fonts
    Config directory           : /etc/fonts/conf.d
    XML directory              : /opt/ffbuild/share/xml/fontconfig
[…]
Installing libfontconfig.a to /tmp/fontconfig/opt/ffbuild/lib
[…]
Installing /src/fontconfig/build/fontconfig/fontconfig.h to /tmp/fontconfig/opt/ffbuild/include/fontconfig
[…]
Installing /src/fontconfig/build/meson-private/fontconfig.pc to /tmp/fontconfig/opt/ffbuild/lib/pkgconfig
```

Ninja ran 47 steps. Kept: `lib/libfontconfig.a`, `lib/pkgconfig/fontconfig.pc`,
the headers in `include/fontconfig`, and `share/licenses/fontconfig/COPYING`.

### libass

Stage `ffmpeg-text`; CI #58, arm64 #58.

As in the recipe that the build follows, libass's `read_file` gets a name that
no other library in the static link can define as well.

```dockerfile
RUN --network=none mkdir libass && tar xzf libass.tar.gz -C libass --strip-components=1 && cd libass \
  && CFLAGS="$CFLAGS -Dread_file=libass_internal_read_file" meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
    -Dtest=disabled -Dcompare=disabled -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled -Dfontconfig=enabled -Dasm=enabled -Dlibunibreak=enabled \
  && ninja -C build install \
  && install -D -m 0644 COPYING /opt/ffbuild/share/licenses/libass/COPYING
```

From the CI log:

```text
Project name: libass
Project version: 0.17.5
[…]
Run-time dependency iconv found: YES
[…]
Run-time dependency freetype2 found: YES 26.7.20
Run-time dependency fribidi found: YES 1.0.17
Run-time dependency harfbuzz found: YES 15.0.0
Run-time dependency libunibreak found: YES 8.0
[…]
Run-time dependency libpng found: NO  (tried pkg-config and cmake)
Run-time dependency fontconfig found: YES 2.18.3
[…]
Nasm compiler for the host machine: nasm (nasm 2.16.01)
[…]
Build targets in project: 5
[…]
libass 0.17.5

    Font providers   : Fontconfig
    ASM optimizations: YES
[…]
[35/36] Linking static target libass/libass.a
[…]
Installing libass/libass.a to /opt/ffbuild/lib
Installing /src/libass/libass/ass.h to /opt/ffbuild/include/ass
Installing /src/libass/libass/ass_types.h to /opt/ffbuild/include/ass
Installing /src/libass/build/meson-private/libass.pc to /opt/ffbuild/lib/pkgconfig
```

Ninja ran 36 steps on x86-64 and 37 on arm64. The arm64 log reports the same
project version, 6 build targets, and assembly as well:

```text
    Font providers   : Fontconfig
    ASM optimizations: YES
```

Installed: `lib/libass.a`, `include/ass/ass.h`, `include/ass/ass_types.h`,
`lib/pkgconfig/libass.pc`, and `share/licenses/libass/COPYING`.

### libvmaf

Stage `ffmpeg-vmaf`; CI #38, arm64 #36.

An archive of a commit holds no Git history, so libvmaf, SVT-AV1 and dav1d would
report a release version. Each is told its revision instead: bitovp records the
libvmaf version with every measurement, and a revision is not a release. Before
it configures, the step

- writes the first seven characters of `LIBVMAF_COMMIT`, `f712fa7`, into
  `vcs_version.h.in`, and checks that they are there;
- empties `libvmaf/tools/meson.build`, so that the command-line tool is not
  built;
- gives the `swap`, `min` and `max` of `svm.cpp` names that the C++ library does
  not use, as the recipe does.

After the install it makes `libvmaf.pc` name `-l:libstdc++.a` under
`Libs.private`.

```dockerfile
ARG LIBVMAF_COMMIT="f712fa7564fe49b12991d83920b83573af2ae063"
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
```

From the CI log:

```text
Project name: libvmaf
Project version: 3.2.0
[…]
Program nasm found: YES (/usr/bin/nasm)
[…]
Program xxd found: YES (/usr/bin/xxd)
[…]
Build targets in project: 24
[…]
libvmaf 3.2.0

  User defined options
    buildtype      : release
    built_in_models: true
    default_library: static
    enable_asm     : true
    enable_avx512  : true
    enable_docs    : false
    enable_float   : true
    enable_tests   : false
    libdir         : lib
    prefix         : /opt/ffbuild
    wrap_mode      : nodownload
[…]
[64/118] Linking static target src/libx86_avx2.a
[…]
[88/118] Linking static target src/libx86_avx512.a
[…]
[117/118] Linking static target src/libvmaf.a
[…]
Installing src/libvmaf.a to /opt/ffbuild/lib
Installing /src/vmaf/libvmaf/include/libvmaf/libvmaf.h to /opt/ffbuild/include/libvmaf
Installing /src/vmaf/libvmaf/include/libvmaf/feature.h to /opt/ffbuild/include/libvmaf
Installing /src/vmaf/libvmaf/include/libvmaf/model.h to /opt/ffbuild/include/libvmaf
Installing /src/vmaf/libvmaf/include/libvmaf/picture.h to /opt/ffbuild/include/libvmaf
Installing /src/vmaf/build/include/libvmaf/version.h to /opt/ffbuild/include/libvmaf
Installing /src/vmaf/build/meson-private/libvmaf.pc to /opt/ffbuild/lib/pkgconfig
```

Ninja ran 118 steps on x86-64, among them the generation of 17 built-in models.
The arm64 log has 23 build targets and 110 steps, and in place of the two x86
libraries:

```text
[57/110] Linking static target src/libarm64_v8.a
```

Installed: `lib/libvmaf.a`, five headers in `include/libvmaf`,
`lib/pkgconfig/libvmaf.pc`, and `share/licenses/libvmaf/LICENSE`.

### x264

Stage `ffmpeg-codecs`, which is for H.264 and AV1 encoding and for AV1 decoding;
CI #33, arm64 #37.

```dockerfile
RUN --network=none mkdir x264 && tar xzf x264.tar.gz -C x264 --strip-components=1 && cd x264 \
  && ./configure --prefix=/opt/ffbuild --disable-cli --enable-static --enable-pic --disable-lavf --disable-swscale \
  && make -j"$(nproc)" && make install \
  && install -D -m 0644 COPYING /opt/ffbuild/share/licenses/x264/COPYING
```

From the CI log:

```text
platform:       X86_64
byte order:     little-endian
system:         LINUX
cli:            no
libx264:        internal
shared:         no
static:         yes
bashcompletion: no
asm:            yes
interlaced:     yes
avs:            no
lavf:           no
ffms:           no
mp4:            no
gpl:            yes
thread:         posix
opencl:         yes
filters:        crop select_every
lto:            no
debug:          no
gprof:          no
strip:          no
PIC:            yes
bit depth:      all
chroma format:  all
[…]
You can run 'make' or 'make fprofiled' now.
[…]
install -m 644 ./x264.h x264_config.h /opt/ffbuild/include
install -m 644 x264.pc /opt/ffbuild/lib/pkgconfig
install -d /opt/ffbuild/lib
install -m 644 libx264.a /opt/ffbuild/lib
```

The arm64 log differs in the first line:

```text
platform:       AARCH64
```

Installed: `lib/libx264.a`, `include/x264.h`, `include/x264_config.h`,
`lib/pkgconfig/x264.pc`, and `share/licenses/x264/COPYING`. The log does not
print x264's version.

### SVT-AV1

Stage `ffmpeg-codecs`; CI #47, arm64 #40.

The step appends `-g` and the first nine characters of `SVTAV1_COMMIT` to the
version that the library reports, and checks the result. The library then
reports `v4.3.0-gad11d76a6`.

```dockerfile
ARG SVTAV1_COMMIT="ad11d76a6c9cb05ec49d166cf20ec5d286715dc1"
RUN --network=none mkdir svt-av1 && tar xzf svt-av1.tar.gz -C svt-av1 --strip-components=1 && cd svt-av1 \
  && revision=$(printf '%.9s' "$SVTAV1_COMMIT") \
  && sed -i "s/@PACKAGE_VERSION_STRING@/@PACKAGE_VERSION_STRING@-g$revision/" Source/Lib/Codec/EbVersion.h.in \
  && grep -q -- "-g$revision\"" Source/Lib/Codec/EbVersion.h.in \
  && cmake -S . -B build-static -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/ffbuild -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DBUILD_APPS=OFF -DSVT_AV1_LTO=OFF \
  && cmake --build build-static && cmake --install build-static \
  && install -D -m 0644 -t /opt/ffbuild/share/licenses/svt-av1 LICENSE.md LICENSE-BSD2.md PATENTS.md
```

From the CI log:

```text
-- The C compiler identification is GNU 12.2.0
[…]
-- Performing Test HAVE_X86_PLATFORM
-- Performing Test HAVE_X86_PLATFORM - Success
-- Performing Test HAVE_ARM_PLATFORM
-- Performing Test HAVE_ARM_PLATFORM - Failed
-- Looking for a ASM_NASM compiler
-- Looking for a ASM_NASM compiler - /usr/bin/nasm
[…]
-- BUILD_SHARED_LIBS: OFF
[…]
-- Performing Test HAS_AVX512
-- Performing Test HAS_AVX512 - Success
[…]
-- Configuring done
-- Generating done
-- Build files have been written to: /src/svt-av1/build-static
[…]
-- Configured version: v4.3.0
[…]
[281/281] Linking C static library /src/svt-av1/Bin/Release/libSvtAv1Enc.a
-- Install configuration: "Release"
-- Installing: /opt/ffbuild/lib/libSvtAv1Enc.a
[…]
-- Installing: /opt/ffbuild/lib/pkgconfig/SvtAv1Enc.pc
```

From the arm64 log:

```text
-- Performing Test HAVE_X86_PLATFORM
-- Performing Test HAVE_X86_PLATFORM - Failed
-- Performing Test HAVE_ARM_PLATFORM
-- Performing Test HAVE_ARM_PLATFORM - Success
[…]
-- Performing Test NEON_FLAG_SUPPORTED
-- Performing Test NEON_FLAG_SUPPORTED - Success
[…]
-- Performing Test NEON_DOTPROD_FLAG_SUPPORTED
-- Performing Test NEON_DOTPROD_FLAG_SUPPORTED - Success
-- Performing Test NEON_I8MM_FLAG_SUPPORTED
-- Performing Test NEON_I8MM_FLAG_SUPPORTED - Success
-- Performing Test SVE_FLAG_SUPPORTED
-- Performing Test SVE_FLAG_SUPPORTED - Success
-- Performing Test SVE2_FLAG_SUPPORTED
-- Performing Test SVE2_FLAG_SUPPORTED - Success
-- Performing Test HAVE_SVE_HEADERS
-- Performing Test HAVE_SVE_HEADERS - Failed
-- Performing Test CAN_COMPILE_SVE
-- Performing Test CAN_COMPILE_SVE - Success
-- BUILD_SHARED_LIBS: OFF
[…]
-- Performing Test HAS_AVX512
-- Performing Test HAS_AVX512 - Failed
[…]
-- Configured version: v4.3.0
```

Ninja ran 281 steps on x86-64 and 225 on arm64. Installed: `lib/libSvtAv1Enc.a`,
seven headers in `include/svt-av1`, `lib/pkgconfig/SvtAv1Enc.pc`, four CMake
files, and three texts in `share/licenses/svt-av1`.

### dav1d

Stage `ffmpeg-codecs`; CI #62, arm64 #50.

The step writes the first seven characters of `DAV1D_COMMIT`, `b8b2d72`, into
`vcs_version.h.in`, and checks that they are there.

```dockerfile
ARG DAV1D_COMMIT="b8b2d726b4b78a2fb174cb45baff441b5969672c"
RUN --network=none mkdir dav1d && tar xzf dav1d.tar.gz -C dav1d --strip-components=1 && cd dav1d \
  && revision=$(printf '%.7s' "$DAV1D_COMMIT") \
  && sed -i "s/@VCS_TAG@/$revision/" include/vcs_version.h.in \
  && grep -q "\"$revision\"" include/vcs_version.h.in \
  && meson setup build --wrap-mode=nodownload --prefix=/opt/ffbuild --libdir=lib --buildtype=release --default-library=static \
    -Denable_tools=false -Denable_tests=false \
  && ninja -C build install \
  && install -D -m 0644 -t /opt/ffbuild/share/licenses/dav1d COPYING doc/PATENTS
```

From the CI log:

```text
Project name: dav1d
Project version: 1.5.4
[…]
Fetching value of define "DAV1D_API_VERSION_MAJOR" : 7
Fetching value of define "DAV1D_API_VERSION_MINOR" : 0
Fetching value of define "DAV1D_API_VERSION_PATCH" : 0
[…]
Program nasm found: YES (/usr/bin/nasm)
[…]
Build targets in project: 5
[…]
dav1d 1.5.4

  User defined options
    buildtype      : release
    default_library: static
    enable_tests   : false
    enable_tools   : false
    libdir         : lib
    prefix         : /opt/ffbuild
    wrap_mode      : nodownload
[…]
[100/101] Linking static target src/libdav1d.a
[…]
Installing src/libdav1d.a to /opt/ffbuild/lib
Installing /src/dav1d/include/dav1d/common.h to /opt/ffbuild/include/dav1d
Installing /src/dav1d/include/dav1d/data.h to /opt/ffbuild/include/dav1d
Installing /src/dav1d/include/dav1d/dav1d.h to /opt/ffbuild/include/dav1d
Installing /src/dav1d/include/dav1d/headers.h to /opt/ffbuild/include/dav1d
Installing /src/dav1d/include/dav1d/picture.h to /opt/ffbuild/include/dav1d
Installing /src/dav1d/include/dav1d/version.h to /opt/ffbuild/include/dav1d
Installing /src/dav1d/build/meson-private/dav1d.pc to /opt/ffbuild/lib/pkgconfig
```

Ninja ran 101 steps on x86-64 and 74 on arm64. Installed: `lib/libdav1d.a`, six
headers in `include/dav1d`, `lib/pkgconfig/dav1d.pc`, and two texts in
`share/licenses/dav1d`.

### NVIDIA headers

Stage `ffmpeg-build`; CI #65, arm64 #63.

The stage starts from `ffmpeg-toolchain` and copies `/opt/ffbuild` from the four
library stages:

```dockerfile
COPY --from=ffmpeg-tls /opt/ffbuild/ /opt/ffbuild/
COPY --from=ffmpeg-text /opt/ffbuild/ /opt/ffbuild/
COPY --from=ffmpeg-vmaf /opt/ffbuild/ /opt/ffbuild/
COPY --from=ffmpeg-codecs /opt/ffbuild/ /opt/ffbuild/
```

nv-codec-headers holds the headers for NVIDIA decoding and encoding. Nothing is
compiled here; the driver's libraries are loaded at run time. The repository has
no licence file, and each header starts with its own notice. The step collects
those notices into one file and checks that it holds as many notices as there
are headers.

```dockerfile
RUN --network=none mkdir nv-codec-headers && tar xzf nv-codec-headers.tar.gz -C nv-codec-headers --strip-components=1 \
  && make -C nv-codec-headers PREFIX=/opt/ffbuild install \
  && mkdir -p /opt/ffbuild/share/licenses/nv-codec-headers \
  && cd nv-codec-headers/include/ffnvcodec \
  && awk 'FNR==1{print FILENAME ":"; p=1} p{print} /\*\//{p=0}' *.h > /opt/ffbuild/share/licenses/nv-codec-headers/NOTICE \
  && test "$(grep -c 'Permission is hereby granted' /opt/ffbuild/share/licenses/nv-codec-headers/NOTICE)" = "$(ls *.h | wc -l)"
```

From the CI log:

```text
make: Entering directory '/src/nv-codec-headers'
sed 's#@@PREFIX@@#/opt/ffbuild#' ffnvcodec.pc.in > ffnvcodec.pc
install -m 0755 -d '/opt/ffbuild/include/ffnvcodec'
install -m 0644 include/ffnvcodec/*.h '/opt/ffbuild/include/ffnvcodec'
install -m 0755 -d '/opt/ffbuild/lib/pkgconfig'
install -m 0644 ffnvcodec.pc '/opt/ffbuild/lib/pkgconfig'
make: Leaving directory '/src/nv-codec-headers'
```

Installed: the headers in `include/ffnvcodec`, `lib/pkgconfig/ffnvcodec.pc`, and
`share/licenses/nv-codec-headers/NOTICE`.

## FFmpeg

Stage `ffmpeg-build`. One step configures FFmpeg (CI #67, 9.7 s; arm64 #65,
4.5 s). The next compiles, installs and checks it (CI #68, 279.4 s; arm64 #66,
56.1 s).

### Configure

`FFMPEG_VER` is what FFmpeg reports as its version. The step stops unless
`FFMPEG_VER` ends with `-g` and the first ten characters of `FFMPEG_COMMIT`, and
then writes `FFMPEG_VER` into the file `VERSION` of the source tree. Only what
FFmpeg itself provides is built in, plus the libraries above. When configure
fails, the step prints the last 60 lines of `ffbuild/config.log`.

```dockerfile
ARG FFMPEG_VER="n8.1.3-34-ga35157abb9"
ARG FFMPEG_COMMIT="a35157abb96167fd7308edc92b55408d5bb084b0"
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
```

The configure line has 29 options: four at its start, and 25 that enable or
disable a part.

| Options | What they select |
|---|---|
| `--prefix=/opt/ffmpeg` | where `make install` puts the programs |
| `--pkg-config-flags=--static` | pkg-config also names what each static library needs |
| `--extra-ldflags="-static-libgcc"`, `--extra-ldexeflags=-pie` | linker flags; the programs are position-independent executables |
| `--disable-autodetect` | no library is enabled unless the line names it |
| `--disable-debug`, `--disable-doc`, `--disable-ffplay` | no debug symbols, no documentation, no `ffplay` |
| `--enable-gpl`, `--enable-version3` | FFmpeg under the GPL, version 3 or later |
| `--enable-zlib`, `--enable-iconv`, `--enable-openssl`, `--enable-libxml2` | zlib, the C library's iconv, OpenSSL, libxml2 |
| `--enable-libfreetype`, `--enable-libharfbuzz`, `--enable-libfribidi`, `--enable-fontconfig`, `--enable-libass` | the caption libraries |
| `--enable-libvmaf`, `--enable-libx264`, `--enable-libsvtav1`, `--enable-libdav1d`, `--enable-libsrt` | libvmaf, x264, SVT-AV1, dav1d, SRT |
| `--enable-ffnvcodec`, `--enable-cuda`, `--enable-cuvid`, `--enable-nvdec`, `--enable-nvenc` | NVIDIA decoding and encoding through nv-codec-headers |

Configure's summary starts with the build's general settings. From the CI log
(CI #67):

```text
install prefix            /opt/ffmpeg
source path               .
C compiler                gcc
C library                 glibc
ARCH                      x86 (generic)
big-endian                no
runtime cpu detection     yes
standalone assembly       yes
x86 assembler             nasm
MMX enabled               yes
MMXEXT enabled            yes
SSE enabled               yes
SSSE3 enabled             yes
AESNI enabled             yes
CLMUL enabled             yes
AVX enabled               yes
AVX2 enabled              yes
AVX-512 enabled           yes
AVX-512ICL enabled        yes
XOP enabled               yes
FMA3 enabled              yes
FMA4 enabled              yes
i686 features enabled     yes
CMOV is fast              yes
EBX available             yes
EBP available             yes
debug symbols             no
strip symbols             yes
optimize for size         no
optimizations             yes
static                    yes
shared                    no
network support           yes
threading support         pthreads
safe bitstream reader     yes
texi2html enabled         no
perl enabled              yes
pod2man enabled           yes
makeinfo enabled          no
makeinfo supports HTML    no
experimental features     yes
xmllint enabled           no
```

In the arm64 log (arm64 #65) the `ARCH` line differs, and eight lines about
Arm's extensions stand where the CI log has thirteen about x86's. Six more lines
of the CI log are not in the arm64 log: `standalone assembly`, `x86 assembler`,
`i686 features enabled`, `CMOV is fast`, `EBX available` and `EBP available`.
The other lines are the same:

```text
ARCH                      aarch64 (generic)
[…]
NEON enabled              yes
DOTPROD enabled           yes
I8MM enabled              yes
SVE enabled               yes
SVE2 enabled              yes
SME enabled               yes
SME-I16I64 enabled        no
SME2 enabled              no
```

The summary then lists what is enabled. The libraries, the hardware
acceleration, the devices and the licence, from the CI log (CI #67):

```text
External libraries:
iconv                   libfribidi              libx264
libass                  libharfbuzz             libxml2
libdav1d                libsrt                  openssl
libfontconfig           libsvtav1               zlib
libfreetype             libvmaf

External libraries providing hardware acceleration:
cuda                    ffnvcodec               nvenc
cuvid                   nvdec

Libraries:
avcodec                 avformat                swscale
avdevice                avutil
avfilter                swresample

Programs:
ffmpeg                  ffprobe
[…]
Enabled hwaccels:
av1_nvdec               mpeg1_nvdec             vp8_nvdec
h264_nvdec              mpeg2_nvdec             vp9_nvdec
hevc_nvdec              mpeg4_nvdec             wmv3_nvdec
mjpeg_nvdec             vc1_nvdec
[…]
Enabled indevs:
fbdev                   oss
lavfi                   v4l2

Enabled outdevs:
fbdev                   oss                     v4l2

License: GPL version 3 or later
```

`iconv` is the C library's own; the build compiles no iconv library.

Both logs name the same components in every section of the summary:

| Section of the summary | Names |
|---|---|
| External libraries | 14 |
| External libraries providing hardware acceleration | 5 |
| Libraries | 7 |
| Programs | 2 |
| Enabled decoders | 522 |
| Enabled encoders | 182 |
| Enabled hwaccels | 11 |
| Enabled parsers | 68 |
| Enabled demuxers | 360 |
| Enabled muxers | 183 |
| Enabled protocols | 41 |
| Enabled filters | 476 |
| Enabled bsfs | 50 |
| Enabled indevs | 4 |
| Enabled outdevs | 3 |

The protocols of the summary:

```text
async cache concat concatf crypto data dtls fd ffrtmpcrypt ffrtmphttp file ftp gopher gophers http httpproxy https
icecast ipfs_gateway ipns_gateway libsrt md5 mmsh mmst pipe prompeg rtmp rtmpe rtmps rtmpt rtmpte rtmpts rtp srtp
subfile tcp tee tls udp udplite unix
```

The bitstream filters of the summary:

```text
aac_adtstoasc ahx_to_mp2 apv_metadata av1_frame_merge av1_frame_split av1_metadata chomp dca_core dovi_rpu dts2pts
dump_extradata dv_error_marker eac3_core eia608_to_smpte436m evc_frame_merge extract_extradata filter_units
h264_metadata h264_mp4toannexb h264_redundant_pps hapqa_extract hevc_metadata hevc_mp4toannexb imx_dump_header
lcevc_metadata media100_to_mjpegb mjpeg2jpeg mjpega_dump_header mov2textsub mpeg2_metadata mpeg4_unpack_bframes noise
null opus_metadata pcm_rechunk pgs_frame_merge prores_metadata remove_extradata setts showinfo smpte436m_to_eia608
text2movsub trace_headers truehd_core vp9_metadata vp9_raw_reorder vp9_superframe vp9_superframe_split vvc_metadata
vvc_mp4toannexb
```

The appendix lists the decoders, encoders, parsers, demuxers, muxers and filters
of the summary.

### Make, install and checks

```dockerfile
RUN --network=none cd ffmpeg && make -j"$(nproc)" && make install \
  && mkdir -p /out/bin /out/share/licenses \
  && cp /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /out/bin/ \
  && cp -a /opt/ffbuild/share/licenses/. /out/share/licenses/ \
  && install -D -m 0644 -t /out/share/licenses/ffmpeg COPYING.GPLv3 LICENSE.md \
  && /out/bin/ffmpeg -hide_banner -version \
  && ldd /out/bin/ffmpeg && ldd /out/bin/ffprobe
```

In the CI log `make` printed 2,264 `CC` lines and 168 `X86ASM` lines; in the
arm64 log 2,171 `CC` lines and 60 `AS` lines. Both printed 219 `INSTALL` lines.
The compiler gave 46 warnings on x86-64 and 38 on arm64, and no error. On x86-64
the warnings are 20 of `-Wstack-usage=`, 13 of `-Wformat-truncation=`, 9 of
`-Wstringop-overflow=`, 3 of `-Warray-bounds` and 1 of `-Wdiscarded-qualifiers`.
On arm64 they are the same, except that `-Wstringop-overflow=` appears once.

The end of the compile, from the CI log (CI #68):

```text
AR  libavdevice/libavdevice.a
AR  libavfilter/libavfilter.a
AR  libavformat/libavformat.a
AR  libavcodec/libavcodec.a
AR  libswresample/libswresample.a
AR  libswscale/libswscale.a
[…]
AR  libavutil/libavutil.a
LDXX  ffmpeg_g
LDXX  ffprobe_g
STRIP  ffmpeg
STRIP  ffprobe
INSTALL  install-progs-yes
INSTALL  ffmpeg
INSTALL  ffprobe
```

The step then copies the two programs to `/out/bin`, and the licence texts of
the libraries and FFmpeg's own `COPYING.GPLv3` and `LICENSE.md` to
`/out/share/licenses`. It ends by running the new `ffmpeg` once and by printing
the dynamic libraries of both programs with `ldd`. From the CI log (CI #68; the
`configuration:` line is folded here):

```text
ffmpeg version n8.1.3-34-ga35157abb9 Copyright (c) 2000-2026 the FFmpeg developers
built with gcc 12 (Debian 12.2.0-14+deb12u1)
configuration: --prefix=/opt/ffmpeg --pkg-config-flags=--static --extra-ldflags=-static-libgcc --extra-ldexeflags=-pie --disable-autodetect
    --disable-debug --disable-doc --disable-ffplay --enable-gpl --enable-version3 --enable-zlib --enable-iconv --enable-openssl --enable-libxml2
    --enable-libfreetype --enable-libharfbuzz --enable-libfribidi --enable-fontconfig --enable-libass --enable-libvmaf --enable-libx264
    --enable-libsvtav1 --enable-libdav1d --enable-libsrt --enable-ffnvcodec --enable-cuda --enable-cuvid --enable-nvdec --enable-nvenc
libavutil      60. 26.103 / 60. 26.103
libavcodec     62. 28.103 / 62. 28.103
libavformat    62. 12.103 / 62. 12.103
libavdevice    62.  3.103 / 62.  3.103
libavfilter    11. 14.103 / 11. 14.103
libswscale      9.  5.103 /  9.  5.103
libswresample   6.  3.103 /  6.  3.103

Exiting with exit code 0
  linux-vdso.so.1 (0x00007257fb8a5000)
  libm.so.6 => /lib/x86_64-linux-gnu/libm.so.6 (0x00007257f7e42000)
  libgcc_s.so.1 => /lib/x86_64-linux-gnu/libgcc_s.so.1 (0x00007257f7e22000)
  libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007257f7c40000)
  /lib64/ld-linux-x86-64.so.2 (0x00007257fb8a7000)
  linux-vdso.so.1 (0x000072e4809c7000)
  libm.so.6 => /lib/x86_64-linux-gnu/libm.so.6 (0x000072e47cf98000)
  libgcc_s.so.1 => /lib/x86_64-linux-gnu/libgcc_s.so.1 (0x000072e47cf78000)
  libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x000072e47cd96000)
  /lib64/ld-linux-x86-64.so.2 (0x000072e4809c9000)
```

The arm64 log (arm64 #66) prints the same version, compiler, configuration and
library versions. Its `ldd` lines for `ffmpeg`:

```text
  linux-vdso.so.1 (0x0000ffff9be2d000)
  libm.so.6 => /lib/aarch64-linux-gnu/libm.so.6 (0x0000ffff98c20000)
  libgcc_s.so.1 => /lib/aarch64-linux-gnu/libgcc_s.so.1 (0x0000ffff98be0000)
  libc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x0000ffff98a30000)
  /lib/ld-linux-aarch64.so.1 (0x0000ffff9bde0000)
```

The last stage holds only the result:

```dockerfile
FROM scratch AS ffmpeg
COPY --from=ffmpeg-build /out/ /
```

BuildKit then wrote the stage to the directory that was asked for (CI #70,
arm64 #68):

```text
copying files 99.89MB 0.2s done
copying files 82.24MB 0.4s done
```

## Result

### The programs

| | `linux/amd64` | `linux/arm64` |
|---|---|---|
| `bin/ffmpeg` | 49,949,992 bytes | 41,116,224 bytes |
| `bin/ffprobe` | 49,736,936 bytes | 40,919,584 bytes |
| Kind of file | ELF 64-bit pie executable, x86-64, dynamically linked, stripped | ELF 64-bit pie executable, ARM aarch64, dynamically linked, stripped |
| Interpreter | `/lib64/ld-linux-x86-64.so.2` | `/lib/ld-linux-aarch64.so.1` |

The `linux/arm64` column describes the output of the arm64 log. The
`linux/amd64` column describes programs that were built under emulation on an
Apple silicon Mac. The design note gives the size of each program of the earlier
prebuilt build as 131 MB on arm64 and 173 MB on amd64.

| Build | Program | SHA-256 |
|---|---|---|
| `linux/arm64` | `bin/ffmpeg` | `bb3ef616c69301516eb6e283d3a4ac6d664b9de8c33536303517f75d17bebefc` |
| `linux/arm64` | `bin/ffprobe` | `ddf4f257db90696013185b49793357eeb6742ffa51600e222108e79dc5bece83` |
| `linux/amd64`, built under emulation | `bin/ffmpeg` | `61720e87dc039495ef04e47d7d6c2108e980c4092ba33517b6eae635f85311f6` |
| `linux/amd64`, built under emulation | `bin/ffprobe` | `45947b87ba291cb4f1020e4ab12b8b8d9534eabbdd85ed84a118176c8301fdd1` |
| `linux/amd64`, built natively by CI | `bin/ffmpeg` | `61720e87dc039495ef04e47d7d6c2108e980c4092ba33517b6eae635f85311f6` |
| `linux/amd64`, built natively by CI | `bin/ffprobe` | `45947b87ba291cb4f1020e4ab12b8b8d9534eabbdd85ed84a118176c8301fdd1` |

The `linux/arm64` values are those of the arm64 log's output, and the research
records give the same values for the arm64 builds made for PR #109. The values
of the emulated `linux/amd64` build are those of four builds, which gave the
same bytes.

The values of the natively built `linux/amd64` programs were printed by CI on
2026-11-12, in the first run of PR #112. Three jobs of that run compiled the
stages, each on its own GitHub-hosted x86-64 runner: `native-media` (job
130930199559), `media-smoke` (job 130930199149) and `installed-gui` (job
130930199315). All three printed these two values. A native build and a build
under emulation therefore gave the same bytes, and what was measured with the
emulated programs holds for the programs that CI compiles.

Every later run of the script that compiled printed the same two values: six
more jobs of PR #112 (for the commits `47025a92` and `4ae4c43b`), the three jobs
of the merge commit `42e5d926` on `main`, and the first run of the weekly job
`ffmpeg-from-source`. That makes thirteen compiles by the script on
GitHub-hosted runners, with the runner images `ubuntu-26.04` and `ubuntu-24.04`.
The weekly job `image-from-source` compiles the stages inside its image build
and does not print the values.

BuildKit reports the size of what it copies out. For the output of the CI log it
reports 99.89 MB (CI #70), and for the arm64 output 82.24 MB (arm64 #68). The
files of the emulated `linux/amd64` build have 99,864,029 bytes in all, and
those of the arm64 output 82,212,909 bytes; BuildKit's figure is about 0.03 MB
larger in both cases. The run of the CI log did not print the SHA-256 of its
programs; the script has printed them since PR #112.

### Dynamic links and hardening

`ldd` names what the programs load at run time: `libm.so.6`, `libgcc_s.so.1`,
`libc.so.6` and the dynamic loader (CI #68, arm64 #66). Everything else is
linked statically, the C++ library included. `libgcc_s.so.1` is loaded although
the configure line passes `-static-libgcc`; the records do not say why. The
NVIDIA driver's libraries are not linked; FFmpeg loads them when a GPU is used.

The research records add two findings.

- The newest glibc symbols that the programs need are `hypot` and `hypotf` of
  GLIBC_2.35 and `arc4random` of GLIBC_2.36. A host therefore needs glibc 2.36
  or newer. The earlier build needed GLIBC_2.28.
- On both architectures both programs are position-independent, have read-only
  relocations with immediate binding, a stack that is not executable, no segment
  that is writable and executable, no text relocations, no run path, a stack
  protector, and 17 imported fortified functions. Neither this build nor the
  earlier one has branch protection or CET.

### Licence texts

The `ffmpeg` stage holds 22 licence files in 16 directories under
`share/licenses/`, 177,101 bytes in all. The files are the same in the amd64 and
in the arm64 output.

| Directory | Files, with their bytes |
|---|---|
| `dav1d` | `COPYING` (1,317), `PATENTS` (5,730) |
| `ffmpeg` | `COPYING.GPLv3` (35,147), `LICENSE.md` (4,346) |
| `fontconfig` | `COPYING` (8,616) |
| `freetype` | `FTL.TXT` (6,743), `GPLv2.TXT` (17,994), `LICENSE.TXT` (2,149) |
| `fribidi` | `COPYING` (26,419) |
| `harfbuzz` | `COPYING` (1,971) |
| `libass` | `COPYING` (755) |
| `libunibreak` | `LICENCE` (1,045) |
| `libvmaf` | `LICENSE` (2,833) |
| `libxml2` | `Copyright` (1,314) |
| `nv-codec-headers` | `NOTICE` (6,035) |
| `openssl` | `LICENSE.txt` (10,175) |
| `srt` | `LICENSE` (16,726) |
| `svt-av1` | `LICENSE-BSD2.md` (1,316), `LICENSE.md` (1,709), `PATENTS.md` (5,767) |
| `x264` | `COPYING` (17,992) |
| `zlib` | `LICENSE` (1,002) |

The image copies them to `/usr/local/share/licenses/`. The design note records
that the image's user `node` can read all 24 licence files in the 18 directories
there: these 16, and those of whisper.cpp and of the emoji font. FFmpeg's
configure takes these libraries without `--enable-nonfree` and reports
`License: GPL version 3 or later` (CI #67, arm64 #65). The security review read
the licences of OpenSSL, x264, SRT, FreeType, FriBidi and the permissive rest as
compatible with the GPL version 3. That is the review's reading, not legal
advice.

### What the programs offer

The capability lists of this build are the same, name for name, on `linux/amd64`
and on `linux/arm64`.

| List | Names |
|---|---|
| Decoders | 522 |
| Encoders | 182 |
| Demuxers | 367 |
| Muxers | 187 |
| Filters | 480 |
| Bitstream filters | 50 |
| Hardware acceleration methods | 1 (`cuda`) |
| Protocols | 37 for input, 31 for output |
| Pixel formats | 267 |
| Options that `-buildconf` prints | 29 |

Some of these numbers differ from configure's summary, because the lists hold
the names that the programs print. The demuxer list has 367 lines for the
summary's 360 demuxers: `mov` prints six names and `matroska` two, and one line,
`d`, stands for the four input devices, because the script that wrote the lists
takes their device flag for a name. The muxer list has 187 names for the
summary's 183 muxers: it also holds the four names of the three output devices,
`stream_segment` prints a second name, `ssegment`, and `matroska_audio` prints
the name `matroska` again. The filter list also holds `buffer`, `buffersink`,
`abuffer` and `abuffersink`, so it has 480 names for the summary's 476. The
protocol list is by direction, and it calls `srt`, `ipfs` and `ipns` what the
summary calls `libsrt`, `ipfs_gateway` and `ipns_gateway`. `-hwaccels` prints
the method `cuda`, where the summary lists the eleven `*_nvdec` hwaccels.

The protocols for input:

```text
async cache concat concatf crypto data dtls fd ffrtmpcrypt ffrtmphttp file ftp gopher gophers http httpproxy
https ipfs ipns mmsh mmst pipe rtmp rtmpe rtmps rtmpt rtmpte rtmpts rtp srt srtp subfile tcp tls udp udplite
unix
```

The protocols for output:

```text
crypto dtls fd ffrtmpcrypt ffrtmphttp file ftp gopher gophers http httpproxy https icecast md5 pipe prompeg
rtmp rtmpe rtmps rtmpt rtmpte rtmpts rtp srt srtp tcp tee tls udp udplite unix
```

The design note lists what the product's code, tests included, asks of FFmpeg.
The last row is from `docs/OPERATIONS.md` and the build review, which names the
worker's `ffprobe -f png_pipe`. Each of these is in the lists:

| The product needs | Entry in the lists |
|---|---|
| VMAF and CAMBI | filter `libvmaf` |
| H.264 encoding | encoders `libx264` and `libx264rgb` |
| AV1 encoding, in tests only | encoder `libsvtav1` |
| AV1 decoding | decoder `libdav1d` |
| Caption rendering | filters `ass` and `subtitles` |
| SRT | protocol `srt`, for input and for output |
| RTMP and RTMPS | protocols `rtmp`, `rtmps` and `tls`, for input and for output |
| NVIDIA decoding with `-hwaccel cuda` and `hwdownload` | method `cuda`, filter `hwdownload` |
| PNG image assets | demuxer `png_pipe`, decoder `png` |

The other NVIDIA parts are built as well. The decoders that end with `_cuvid`:

```text
av1_cuvid h264_cuvid hevc_cuvid mjpeg_cuvid mpeg1_cuvid mpeg2_cuvid mpeg4_cuvid vc1_cuvid vp8_cuvid vp9_cuvid
```

The encoders that end with `_nvenc`:

```text
av1_nvenc h264_nvenc hevc_nvenc
```

Of the filters that work on GPU frames, the lists hold `hwdownload`, `hwupload`,
`hwupload_cuda` and `hwmap`; the earlier build's other CUDA filters, such as
`scale_cuda`, are not built (see the next section).

Among FFmpeg's own components the lists hold the decoders `h264`, `hevc`, `vp8`,
`vp9`, `av1`, `ffv1`, `png`, `mjpeg`, `prores`, `aac`, `opus`, `vorbis` and
`mp3`, the encoders `aac`, `ffv1`, `png`, `rawvideo` and `pcm_s16le`, the muxers
`mp4`, `mov`, `matroska`, `flv`, `mpegts`, `hls`, `dash`, `image2`, `null` and
`framemd5`, the demuxers `mov`, `mp4`, `matroska`, `flv`, `mpegts`, `hls`,
`dash`, `image2` and `concat`, and the filters `scale`, `format`, `fps`, `psnr`,
`ssim`, `overlay`, `drawtext`, `aresample` and `testsrc`.

## Differences from the earlier prebuilt build

Until PR #109 the image downloaded a prebuilt FFmpeg: the daily build
`autobuild-2026-11-05-12-48` of `github.com/BtbN/FFmpeg-Builds`, which reports
the version `n8.1.3-34-ga35157abb9-20261105`. The design note records why this
was changed: the pinned download was expected to disappear about 2026-11-19
12:00 UTC, and the image could then no longer be built. The build review gives
the rule behind that date: the recipe's README says "The last 14 daily builds
are kept". The design note also records that the daily build that the releases
1.0.0 and 1.1.0 pin, `autobuild-2026-10-24-13-02`, had already disappeared: its
download address answered 404.

This build compiles the same FFmpeg commit as the earlier build and, for every
library that it still contains, the same commit. The recipe revision
`c63bb308a1de` is the one that the tag of that daily build points at.

### What changed in the build itself

- The version strings of two parts differ. FFmpeg reports
  `n8.1.3-34-ga35157abb9` without the publisher's build date at its end. SVT-AV1
  reports `v4.3.0-gad11d76a6` where the earlier build reports
  `v4.3.0-106-gad11d76a6`: the number of commits after the tag cannot be read
  from an archive. libvmaf reports `f712fa7` and dav1d `b8b2d72`, as before.
- The compiler differs. The earlier build was compiled with GCC 16.2, the
  publisher's cross compiler; this build with Debian 12's GCC 12.2.
- FreeType is built once, without HarfBuzz; the earlier build built it twice.
  The design note states that this changes only FreeType's automatic hinting,
  which FFmpeg's caption filter does not use.
- Character set conversion uses the C library's iconv, not GNU libiconv. The
  product does not convert the character set of captions.
- FreeType is built without PNG, Brotli and bzip2. It cannot read bitmap fonts
  of colour emoji, or WOFF2. The two fonts that the image bundles are not
  affected.
- The build time is fixed with `SOURCE_DATE_EPOCH`.
- The build arguments `FFMPEG_URL` and `FFMPEG_SHA256` are gone. Another FFmpeg
  can replace the `ffmpeg` stage with `--build-context ffmpeg=<directory>`;
  `docs/OPERATIONS.md` describes it. The design note records a trial with the
  earlier build in such a directory: no `ffmpeg-*` stage ran.
- The programs need glibc 2.36 or newer; the earlier ones needed glibc 2.28 or
  newer.
- Each program is smaller: about 41 MB for 131 MB on arm64, and about 50 MB for
  173 MB on amd64.

### What is no longer included

Apart from the options that `-buildconf` prints (see the end of this section),
nothing is in this build's capability lists that the earlier build's lists lack,
on either architecture. The lists of bitstream filters and of pixel formats are
the same. The other lists are shorter:

| List | Earlier, arm64 | Earlier, amd64 | This build | Removed, arm64 | Removed, amd64 |
|---|---|---|---|---|---|
| Decoders | 550 | 560 | 522 | 28 | 38 |
| Encoders | 224 | 231 | 182 | 42 | 49 |
| Demuxers | 372 | 372 | 367 | 5 | 5 |
| Muxers | 190 | 190 | 187 | 3 | 3 |
| Filters | 555 | 562 | 480 | 75 | 82 |
| Hardware acceleration methods | 6 | 7 | 1 | 5 | 6 |
| Protocols for input | 41 | 41 | 37 | 4 | 4 |
| Protocols for output | 34 | 34 | 31 | 3 | 3 |
| Bitstream filters | 50 | 50 | 50 | 0 | 0 |
| Pixel formats | 267 | 267 | 267 | 0 | 0 |
| Options that `-buildconf` prints | 101 | 100 | 29 | | |

What is gone needed a library, a system interface or a build option that this
build leaves out. The design note describes the groups:

- Decoders: ARIB captions, teletext, JPEG XL, SVG, AVS3, the decoders of
  external libraries for AV1, VP8, VP9, H.264, Opus, Vorbis and AMR, and the
  V4L2 and AMF hardware decoders. FFmpeg itself or dav1d still decodes AV1, VP8,
  VP9, H.264, Opus, Vorbis and AMR.
- Encoders: x265, libvpx, libaom, rav1e, Opus, MP3, Vorbis, Theora, WebP, JPEG
  XL, OpenJPEG, Xvid, VVenC, Kvazaar, OpenH264, APV, twolame, AMR, HAP, and the
  VAAPI, Vulkan, AMF and V4L2 hardware encoders.
- Filters: the OpenCL, Vulkan, VAAPI and AMF families, the filters that run on
  CUDA such as `scale_cuda`, libplacebo, zscale, vidstab, rubberband, frei0r,
  lv2, LCEVC, ICC and ZeroMQ.
- Hardware acceleration: `cuda` stays. `vaapi`, `vulkan`, `opencl`, `amf` and
  `drm` are gone, and on amd64 `qsv` as well.
- Formats and protocols: AviSynth, VapourSynth, DVD, game music, tracker music,
  Chromaprint, PulseAudio, XVideo, Blu-ray, RIST, SFTP and ZeroMQ.
- Compression: Matroska and TIFF files that are compressed with bzip2 or LZMA
  can no longer be read.
- Others: the SoX resampler (libsoxr), and the capture devices of X11, KMS,
  PulseAudio and OpenAL.

The groups are those of arm64. On amd64 the lists also lose the QSV decoders,
encoders and filters, and AVS2 (`libdavs2`, `libxavs2`).

The removed names, from the capability lists. Decoders on both architectures:

```text
av1_amf h263_v4l2m2m h264_amf h264_v4l2m2m hevc_amf hevc_v4l2m2m libaom-av1 libaribb24 libaribcaption libjxl
libjxl_anim libopencore_amrnb libopencore_amrwb libopenh264 libopus librsvg libuavs3d libvorbis libvpx
libvpx-vp9 libzvbi_teletextdec mpeg1_v4l2m2m mpeg2_v4l2m2m mpeg4_v4l2m2m vc1_v4l2m2m vp8_v4l2m2m vp9_amf
vp9_v4l2m2m
```

Decoders on amd64 only:

```text
av1_qsv h264_qsv hevc_qsv libdavs2 mjpeg_qsv mpeg2_qsv vc1_qsv vp8_qsv vp9_qsv vvc_qsv
```

Encoders on both architectures:

```text
av1_amf av1_vaapi av1_vulkan ffv1_vulkan h263_v4l2m2m h264_amf h264_v4l2m2m h264_vaapi h264_vulkan hap
hevc_amf hevc_v4l2m2m hevc_vaapi hevc_vulkan libaom-av1 libjxl libjxl_anim libkvazaar libmp3lame liboapv
libopencore_amrnb libopenh264 libopenjpeg libopus librav1e libtheora libtwolame libvorbis libvpx libvpx-vp9
libvvenc libwebp libwebp_anim libx265 libxvid mjpeg_vaapi mpeg2_vaapi mpeg4_v4l2m2m prores_ks_vulkan
vp8_v4l2m2m vp8_vaapi vp9_vaapi
```

Encoders on amd64 only:

```text
av1_qsv h264_qsv hevc_qsv libxavs2 mjpeg_qsv mpeg2_qsv vp9_qsv
```

Filters on both architectures:

```text
avgblur_opencl avgblur_vulkan azmq bilateral_cuda blackdetect_vulkan blend_vulkan boxblur_opencl bwdif_cuda
bwdif_vulkan chromaber_vulkan chromakey_cuda color_vulkan colorkey_opencl colorspace_cuda convolution_opencl
deinterlace_vaapi denoise_vaapi deshake_opencl dilation_opencl drawbox_vaapi erosion_opencl flip_vulkan frei0r
frei0r_src gblur_vulkan hflip_vulkan hstack_vaapi iccdetect iccgen interlace_vulkan lcevc libplacebo lv2
nlmeans_opencl nlmeans_vulkan openclsrc overlay_cuda overlay_opencl overlay_vaapi overlay_vulkan pad_cuda
pad_opencl pad_vaapi prewitt_opencl procamp_vaapi program_opencl remap_opencl roberts_opencl rubberband
scale_cuda scale_vaapi scale_vulkan scdet_vulkan sharpness_vaapi sobel_opencl sr_amf thumbnail_cuda
tonemap_opencl tonemap_vaapi transpose_opencl transpose_vaapi transpose_vulkan unsharp_opencl vflip_vulkan
vidstabdetect vidstabtransform vpp_amf vsrc_amf vstack_vaapi xfade_opencl xfade_vulkan xstack_vaapi yadif_cuda
zmq zscale
```

Filters on amd64 only:

```text
deinterlace_qsv hstack_qsv overlay_qsv scale_qsv vpp_qsv vstack_qsv xstack_qsv
```

Demuxers, muxers and protocols, the same on both architectures:

```text
demuxers:          avisynth dvdvideo libgme libopenmpt vapoursynth
muxers:            chromaprint pulse xv
input protocols:   bluray rist sftp zmq
output protocols:  rist sftp zmq
```

The demuxer lists hold every input device as the one line `d` (see "What the
programs offer"), so they cannot name an input device that is gone. The design
note names them: the capture devices of X11, KMS, PulseAudio and OpenAL.

Hardware acceleration methods on both architectures, and on amd64 only:

```text
amf drm opencl vaapi vulkan
qsv
```

The configuration lines that `-buildconf` prints differ in more than the
libraries. The earlier line names a cross compiler
(`--cc=x86_64-ffbuild-linux-gnu-gcc` on amd64,
`--cc=aarch64-ffbuild-linux-gnu-gcc` on arm64) and the option
`--extra-version=20261105`. Of this build's 29 options, 19 are in the earlier
line as they are. Three have another value there: `--prefix`, `--extra-ldflags`
and `--extra-ldexeflags`. Seven are not there: `--disable-autodetect`,
`--disable-doc`, `--disable-ffplay`, `--enable-cuda`, `--enable-cuvid`,
`--enable-nvdec` and `--enable-nvenc`. The earlier line has `--enable-ffnvcodec`
and `--enable-cuda-llvm`, and the earlier build contains the same NVIDIA
decoders and encoders (see below).

### What was confirmed to be the same

The design note records a comparison of the two builds' final programs on the
same files, on `linux/arm64` and, under emulation, on `linux/amd64`. The results
were the same on both architectures:

| What was compared | Result |
|---|---|
| VMAF and CAMBI per frame, with PSNR, SSIM and MS-SSIM: 5 pairs of videos, models v1.0.16 and v0.6.1 | 378 frames, 5,904 values: equal; the pooled values too |
| The version that libvmaf reports | `f712fa7` in both |
| Decoded pictures: H.264 with 8 and 10 bits, FFV1, AV1 | 5 files, 204 frames: equal |
| Captions: the product's ASS form, the bundled fonts, portrait and landscape | 32 frames: equal |
| Encoding: x264 under four settings, SVT-AV1, AAC | 335 packets: equal |
| Scaling, pixel format conversion, frame rate conversion | 114 frames: equal |
| Audio resampling | 94 packets: equal |
| The VMAF proof of the image build | passes |

The v0.6.1 model was used both from a file and as the model that is built into
libvmaf. The design note and the reviews record more that is the same:

- HTTPS with and without certificate verification, RTMP, RTMPS, and SRT with a
  passphrase behave as with the earlier build. This was run on loopback inside a
  container, on arm64.
- `apps/worker/scripts/vmaf-acceptance.sh` reproduces its fixed scores,
  65.146268 and 74.027285, in the new image.
- The programs have the same hardening as the earlier ones (see "Result").
- Both builds have the eleven `*_nvdec` hwaccels, the ten `*_cuvid` decoders,
  the three `*_nvenc` encoders and the device type `cuda`.
- CI on x86-64: the job `media-smoke` printed the same VMAF means with the
  earlier build and with this build. It has printed one of two sets, which the
  section "The VMAF means of the media job" traces to the runner's processor,
  and each set was printed with both builds: 98.282, 93.142 and 5.088 for
  `cbe95324` (earlier build) and for `87e70e9b` (this build), and 98.282, 93.116
  and 5.527 for `61c086e9` (earlier build) and for `22498424` (this build).

The section "Verification record" holds the later comparison on a real GPU.

## Verification record

### Checks in the build

The stage `ffmpeg-build` stops when configure fails, when a library is missing,
or when the new `ffmpeg` does not run (see "FFmpeg").

The last stage of the image checks the programs that it copied. Three checks
look for libvmaf and SRT in the configuration and for the `libvmaf` filter:

```dockerfile
  && /usr/local/bin/ffmpeg -hide_banner -version | grep -q -- '--enable-libvmaf' \
  && /usr/local/bin/ffmpeg -hide_banner -version | grep -q -- '--enable-libsrt' \
  && /usr/local/bin/ffmpeg -hide_banner -filters | grep -q ' libvmaf ' \
```

The image then downloads the fourteen VMAF models that
`docker/vmaf-models.sha256` lists, from the commit
`3f9e02af258a5c0e30124fc585a3c3af90126dee` of `Netflix/vmaf`, verifies their
SHA-256, and runs the proof `docker/vmaf-build-proof.sh`:

```dockerfile
  && (cd "$VMAF_MODEL_DIR" && sha256sum -c --strict vmaf-models.sha256) \
  && sh /tmp/vmaf-build-proof.sh ffmpeg "$VMAF_MODEL_DIR" \
```

The proof scores two identical 640x360 test pictures with the model
`vmaf_v1.0.16_3d0h.json`:

```sh
"$ffmpeg" -hide_banner -nostdin \
  -f lavfi -i testsrc=size=640x360:rate=5:duration=0.4 \
  -f lavfi -i testsrc=size=640x360:rate=5:duration=0.4 \
  -lavfi "[0:v][1:v]libvmaf=model=path=$model" \
  -f null - >"$log" 2>&1 || status=$?
```

It passes only when FFmpeg ends with status 0 and the log holds a line that ends
with `VMAF score: 100.000000`. Both conditions are needed: when libvmaf refuses
a picture, FFmpeg fails and the log still holds `VMAF score: 0.000000`. PR #108
introduced this proof, because the check before it passed although the scoring
failed: its 64x64 test pictures are too small for the v1.0.16 models.
`scripts/native-media-tools.sh` runs the same proof on the programs that it
builds.

### Tests in CI

The job `native-media` of `.github/workflows/ci.yml` gets the programs with
`scripts/native-media-tools.sh` (see "How CI obtains this build"), puts them on
the `PATH`, and runs every test that drives real FFmpeg. In the CI log, where
the job compiled:

| Step of the job | Result |
|---|---|
| `pnpm test:gated-runner` | 19 tests, 19 passed, 0 skipped |
| `scripts/native-media-tools.sh`: `docker build` | 11 min 48 s |
| `scripts/native-media-tools.sh`: models and proof | `ffmpeg version n8.1.3-34-ga35157abb9`, `VMAF models: 14 files verified` |
| `pnpm test:native-media`, `@bitovp/core` | 11 tests that need FFmpeg passed, 0 skipped |
| `pnpm test:native-media`, `@bitovp/worker` | 8 tests that need FFmpeg passed, 0 skipped |
| `pnpm test:native-media`, worker scripts | 43 tests in 3 files passed, 0 skipped |

The first step ran 19 tests in the CI log. With the tests that PR #112 added
and the test of this record it runs 23. The group of `@bitovp/core` has 17 tests
since PR #117: the six that it added hold libvmaf's size limits against these
programs (see "libvmaf and small pictures"). These tests of
`scripts/gated-tests.test.mjs` guard this build without compiling anything:

- "the worker image compiles FFmpeg from sources pinned by commit or release and
  by checksum, without network access" reads `Dockerfile`. It follows the stages
  that make the `ffmpeg` stage and checks the base images, every `ADD` with its
  checksum and the form of its URL, every `RUN`, the list of eighteen sources,
  the package step, `FFMPEG_VER` against `FFMPEG_COMMIT`, the 25 options of
  configure that enable or disable a part, the sixteen licence directories, and
  the checks and the proof of the last stage.
- "the FFmpeg build record holds the stages, the sources and the commands of the
  Dockerfile's FFmpeg build in their order, and no other" compares this file
  with `Dockerfile` (see "Renewing this record").
- "the installer builds the Dockerfile's own FFmpeg stage into a new directory
  with a plain path, and proves it with the pinned models" runs
  `scripts/native-media-tools.sh` against stand-ins for `docker`, `uname`,
  `curl` and `sha256sum`. The stand-in for `docker` writes the `ffmpeg` that the
  proof then runs.
- "the installer keeps a build that passed the proof under a key of what it is
  made from, and takes a kept build only whole" runs the script with `--cache`:
  a first run that builds and keeps, a second run that copies, and kept builds
  that are damaged in one way each.
- "the VMAF proof passes only when FFmpeg ends without an error and scores two
  identical pictures as 100" runs the proof against stand-ins for FFmpeg.
- "the three jobs that need the image's FFmpeg reuse a build only under the key
  of the installer's own inputs and hold nothing that a wrong build could reach,
  and two weekly jobs build from the sources" reads the workflows.

Two more jobs build the worker image: the job `media-smoke` of the workflow
"Offline media" and the job `installed-gui` of the workflow "Installed GUI".
Until PR #112 they compiled the same stages in every run. The research records
hold their results for the last commit of PR #109: `media-smoke` ran 6 test
files with 36 tests, and printed the VMAF means 98.282, 93.142 and 5.088;
`installed-gui` passed 10 browser tests. All 15 required checks passed for that
commit. The section "How CI obtains this build" holds the same totals for the
runs of PR #112, in which the image builds took the programs from the directory
that the script left; the VMAF means of those runs are of both sets (see the
next section). The time limits of the three jobs are 30, 40 and 50 minutes.

### The VMAF means of the media job

The media check (`pnpm test:media`, which the job `media-smoke` runs) prints,
when it has passed, the means of three comparisons: the reference with itself,
an x264 encode of it, and a strongly degraded x264 encode. It requires that the
first is at least 90, that the second is not above the first, and that the third
is more than 5 below the second; it requires no exact value. Since PR #116 it
prints one more line after the means, `x264 CPU capabilities:`, with what x264
reported that it uses of the processor in the two encodes. On an arm64 host the
check printed a third set of means (see the end of this section). In the CI jobs
that this record read, all on GitHub's x86-64 runners, it printed one of two
sets:

| Set | self | encoded | degraded |
|---|---|---|---|
| A | 98.282 | 93.142 | 5.088 |
| B | 98.282 | 93.116 | 5.527 |

Of the 38 `media-smoke` jobs in the table of means (see "Where the facts come
from"), 25 printed set A and 13 set B. Each set was printed with the earlier
prebuilt build and with this build, and in eight of the nine Azure regions that
the logs name both sets were printed. Jobs that compiled printed both sets: A
for `334b4e0f` and `47025a92`, B for `4ae4c43b` and for the merge commit on
`main`. Jobs that reused a build printed both as well: A in the second attempt
of `4ae4c43b`, with the bytes that had printed B in the first; and with the one
build that `main` had stored, B for `3b5edb98` and A for `a403ff35`. The logs
with means that are kept, up to the runs of `a403ff35`, are of 13 jobs. They
name one runner image (`ubuntu-26.04` version `20261101.186.1`) and one version
of the runner software (2.338.2); 8 of them hold set A and 5 set B. The set
therefore follows neither the commit, nor the build, nor the runner's software,
and jobs that get the programs in the same way print both. The seven jobs of
PR #116 that are listed below show it once more: one commit, one kept build, one
runner image and one version of the runner software, and both sets.

What is left is the runner's processor, and a test shows that the processor is
enough to give both sets. x264 chooses its functions by the vector extensions
that the processor has. `common/x86/mc-c.c` of the pinned revision gives four
functions of the macroblock tree one version for AVX2 and another for AVX-512,
among them `mbtree_propagate_cost`, which propagates the tree's costs. The two
versions of that function do not compute in the same way: in
`common/x86/mc-a2.asm` the AVX2 version multiplies by an approximation of the
reciprocal that it refines once (`rcpps`), and the AVX-512 version divides
(`vdivps`).

The test ran on 2026-11-12 from 07:27 to 07:36 UTC on the host of the GPU check
(see "Check on a real NVIDIA GPU, 2026-11-12"), whose processor has AVX-512. It
used the `linux/amd64` `ffmpeg` of that check (SHA-256 `61720e87…`, the bytes
that CI's native builds give), the source file of the media check
(`BigBuckBunny_320x180.mp4`; `scripts/media-smoke.mjs` holds its SHA-256,
`f78f3960…`, and the address of the archive that it comes in), and the commands
that the check then had, with the two differences that are named after them:

```sh
ffmpeg -v error -nostdin -y -ss 30 -threads 1 -i source.mp4 -t 10 -map 0:v:0 -an \
  -vf scale=320:180,fps=24,format=yuv420p -c:v ffv1 -threads 1 reference.mkv
ffmpeg -v info -nostdin -y -ss 30 -threads 1 -i source.mp4 -t 10 -map 0:v:0 -map 0:a:0 \
  -vf scale=320:180 -c:v libx264 -threads 1 -crf 23 -r 24 -g 48 -keyint_min 48 \
  -sc_threshold 0 -force_key_frames 'expr:gte(t,n_forced*2)' \
  -c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart bbb-10s.mp4
ffmpeg -v info -nostdin -y -threads 1 -i reference.mkv -an \
  -vf scale=80:46:flags=bilinear,scale=320:180:flags=bilinear \
  -c:v libx264 -threads 1 -crf 45 degraded.mp4
```

The three comparisons are the commands that `buildVmafCommand` of `@bitovp/core`
gives for the options in `runMediaCheck` of
`apps/worker/src/testing/media-smoke.ts`, with the model `vmaf_v0.6.1`; a mean
is `pooled_metrics.vmaf.mean` of libvmaf's JSON log. Two things differed from
the check as it then was. The test ran the two x264 encodes with `-v info`
instead of `-v error`, so that the log holds x264's line
`using cpu capabilities`, and it put `-v error -nostdin -y` in front of the
comparisons. Since PR #116 the check itself runs the two encodes with
`-v info -nostats` and reads that line. A variant adds
`-x264-params <parameter>` before the name of the output of the two x264
encodes, or `-cpuflags <flags>` right after `-y` in every command. The MD5 of
the packets is what `ffmpeg -i <file> -map 0:v:0 -c copy -f md5 -` prints, and
the MD5 of the reference's frames is what the same command prints without
`-c copy`; these two ran without `-cpuflags`.

| Variant | x264 reports AVX-512 | Encoded packets | Degraded packets | self | encoded | degraded |
|---|---|---|---|---|---|---|
| without a variant option | yes | `425ede39…` | `06ce7606…` | 98.282420 | 93.142497 | 5.088417 |
| `-x264-params asm=AVX2` | no | `04a059c4…` | `1ab5e6e7…` | 98.282420 | 93.115978 | 5.527475 |
| `-x264-params asm=AVX512` | yes | `425ede39…` | `06ce7606…` | 98.282420 | 93.142497 | 5.088417 |
| `-x264-params cpu-independent=1` | yes | `1f0da230…` | `3a05699c…` | 98.282420 | 93.122542 | 4.929811 |
| `-cpuflags -avx512-avx512icl` | yes | `425ede39…` | `06ce7606…` | 98.282420 | 93.142497 | 5.088417 |
| `-cpuflags -avx512-avx512icl` and `asm=AVX2` | no | `04a059c4…` | `1ab5e6e7…` | 98.282420 | 93.115978 | 5.527475 |
| `-x264-params mbtree=0` | yes | `ff683251…` | `ca235bba…` | 98.282420 | 92.213768 | 4.679245 |
| `-x264-params asm=AVX2:mbtree=0` | no | `ff683251…` | `ca235bba…` | 98.282420 | 92.213768 | 4.679245 |
| `-x264-params cpu-independent=1:mbtree=0` | yes | `46e982cb…` | `37d46bc1…` | 98.282420 | 92.265062 | 4.574816 |

- The first two rows are the sets A and B, to the last digit that CI prints. One
  machine gives both, and the only difference is whether x264 uses AVX-512.
- With the macroblock tree off, x264 writes the same packets with AVX-512 and
  without it. The tree is where the two encodes differ.
- `-cpuflags` takes AVX-512 from FFmpeg's own code and changes nothing, neither
  the packets nor the means.
- The frames of the reference have one MD5 in all nine variants, `c84fff17…`,
  and the mean of the self-comparison is the same in all of them.
- `cpu-independent=1` is x264's option for results that do not depend on the
  processor. It gives a third pair of encodes, and it changes the packets with
  the tree off as well: besides taking the C versions of two tree functions
  (`common/mc.c`), it leaves out two functions of the intra search
  (`encoder/encoder.c`).
- The earlier prebuilt build (SHA-256 of its `ffmpeg` `55e97eb5…`) was run in
  the same nine variants on the same host. Every checksum and every mean is the
  same as with this build.

Since PR #116 the logs hold x264's report, and they show the same. The first
commit of that pull request, `c1812e8d`, ran seven times on GitHub's x86-64
runners on 2026-11-12 from 11:42 to 12:23 UTC: once for the pull request, and
six times on its branch, started by hand: the first while the run of the pull
request was going, each later one after the one before had ended. All seven
name the runner image `ubuntu-26.04` version `20261101.186.1` and the runner
software 2.338.2, and all seven reused the build that `main` had stored.

| Run | Azure region | x264 reports AVX-512 | self | encoded | degraded |
|---|---|---|---|---|---|
| 43211484048, of the pull request | westus | no | 98.282 | 93.116 | 5.527 |
| 43211521248 | westcentralus | no | 98.282 | 93.116 | 5.527 |
| 43212507080 | eastus2 | yes | 98.282 | 93.142 | 5.088 |
| 43213387904 | westus2 | yes | 98.282 | 93.142 | 5.088 |
| 43214383595 | westus3 | no | 98.282 | 93.116 | 5.527 |
| 43215396495 | eastus | no | 98.282 | 93.116 | 5.527 |
| 43216434317 | westus2 | no | 98.282 | 93.116 | 5.527 |

After `x264 CPU capabilities:` the line holds
`MMX2 SSE2Fast SSSE3 SSE4.2 AVX FMA3 BMI2 AVX2 AVX512` in the two runs that
printed set A, and the same without `AVX512` in the five that printed set B.
These are the two reports of the test's first two variants, with the means of
those variants. One region, westus2, gave a runner of each kind.

What follows, and what does not:

- The media check passes on both kinds of runner, those where x264 uses AVX-512
  and those where it does not, because both sets meet its three requirements. A
  mean of an x264 encode in a CI log can be compared only with a run in which
  x264 used the same extensions. Since PR #116 the line `x264 CPU capabilities:`
  of a run names them.
- The difference is in the encode, not in the measurement: on one machine, with
  one libvmaf, the two encodes give the two sets of the runners, at the three
  decimals that CI prints.
- This is a property of x264 and not of this build. It was there with the
  earlier prebuilt build.
- The arm64 host that was tried gave a third set, 98.282, 93.123 and 4.778. This
  build printed it on 2026-11-12 on an Apple silicon Mac, in Docker Desktop,
  with the worker image built from `Dockerfile` for the platform of the host's
  Docker, `linux/arm64`. A prebuilt build that `Dockerfile` pinned in October
  2026 had printed the same: `docs/user-guide/QUALITY-AND-MONITORING.md` gives
  it for a local run, in a line written when the pin was
  `n8.1.3-18-g46d899d7a0`, and the research records hold it for a run of
  2026-10-24 on an arm64 host, whose log names no build. With the check of
  PR #116 the same Mac printed the same means on 2026-11-12, and
  `ARMv8 NEON DotProd I8MM` as x264's report. The test of the nine
  variants was not made on arm64. x264 has versions of the tree's functions for
  arm64 too (`common/aarch64/mc-c.c`), so other packets are to be expected, but
  the packets of the arm64 runs were not compared with those of x86-64, and
  whether anything else differs there is not known.
- For the seven runs of PR #116 the logs show which kind of runner printed which
  set: x264 reported AVX-512 in the runs of set A and did not in those of set B.
  For the jobs before it no log names what x264 used, and that their sets
  follow the same rule stays inferred from the test. No log names the processor
  itself: the line holds what x264 uses of it.
- Not established: the packets of a processor without AVX-512. The test took
  AVX-512 from x264 by an option; the five runs of set B are on runners where
  x264 reported no AVX-512, and they print the means of that variant at CI's
  three decimals, but CI prints no checksum of the packets. Whether
  `cpu-independent=1` gives the same packets on both kinds was not tried, nor
  was a processor without AVX2, nor a second arm64 processor, so there may be
  more sets than these three. The test shows that the tree is where the encodes
  differ, not which of its functions. It did not vary what libvmaf uses of the
  processor.

### Comparison with the earlier build

The section "Differences from the earlier prebuilt build" holds the comparison
that was made before PR #109 was merged: the capability lists, and the outputs
of both builds for the same inputs.

### Check on a real NVIDIA GPU, 2026-11-12

The design note records that neither CI nor the machine on which the build was
developed has an NVIDIA GPU. The NVIDIA parts were therefore run separately, on
2026-11-12 from 01:02 to 01:06 UTC, on an x86-64 Linux host with an NVIDIA
GeForce RTX 5060 Ti (driver 580.178.04). The host ran Ubuntu 24.04.5 LTS with
glibc 2.39. The programs under test were the `linux/amd64` programs that were
built under emulation. The programs that CI compiles natively have the same
SHA-256 (see "Result"), so the check holds for them as well. The programs under
test were compared with the earlier prebuilt build, whose `ffmpeg` has the
SHA-256
`55e97eb579487a04b351802aac38e347e40d9cbc4760cb050a5a998221156253`. On this host
`-hwaccels` printed `cuda` for this build, and `cuda`, `vaapi`, `qsv`, `drm`,
`opencl`, `vulkan` and `amf` for the earlier one.

**Decoding.** Nineteen files were decoded four times each: in software and on
the GPU, with each build. All 76 runs ended with status 0.

| Codec | Files | Bit depths | Sizes |
|---|---|---|---|
| H.264 | 7 | 8 | 640x360, 1920x1080, 3840x2160 |
| HEVC | 4 | 8 and 10 | 640x360, 1920x1080 |
| VP9 | 4 | 8 and 10 | 640x360, 1920x1080 |
| AV1 | 4 | 8 and 10 | 640x360, 1920x1080 |

The files hold 3,144 frames in all. The pixel formats are `yuv420p`,
`yuv420p10le` and, in one full-range H.264 file, `yuvj420p`. The HEVC, VP9 and
AV1 files of 1920x1080 were encoded for this check from a 10-second H.264 file:
HEVC and VP9 with the earlier build's libx265 and libvpx-vp9, which this build
does not have, and AV1 with this build's libsvtav1. The commands for software
and for the GPU, without their options `-hide_banner -nostdin -v error` and
`-y`; each ran under `nice -n 10`:

```text
ffmpeg -i <file> -map 0:v:0 -an -sn -f framemd5 <output>
ffmpeg -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda -i <file> -map 0:v:0 -an -sn \
  -vf "hwdownload,format=<nv12 or p010le>,format=<yuv420p or yuv420p10le>" -f framemd5 <output>
```

For every file the MD5 of every frame is the same in three comparisons: software
decoding with this build and with the earlier build; GPU decoding with this
build and with the earlier build; and GPU decoding and software decoding with
this build.

That the GPU did the decoding was checked in two ways. `nvidia-smi dmon` took
fourteen samples, one a second, and this build started two seconds after it to
decode a 30-second 1080p H.264 file 25 times in a row. The decoder's utilisation
was 8 %, 0 %, 0 % and 0 % in the first four samples, and between 92 % and 100 %
in the other ten. FFmpeg's debug output for this build has the lines
`Selecting decoder 'h264' because of requested hwaccel method cuda` and
`Loaded lib: libcuda.so.1`.

**Encoding.** Seven encodes of 240 frames of 1920x1080 were run with each build.
All 14 ended with status 0, and FFmpeg decoded each result in software with
status 0. For every case the two builds wrote the same packets (equal MD5 over
the packets) and files of the same size.

| Case | Options | Result | Bytes |
|---|---|---|---|
| `h264` | `-c:v h264_nvenc -preset p5 -b:v 4M -pix_fmt yuv420p` | H.264 Main, `yuv420p` | 4,912,490 |
| `hevc8` | `-c:v hevc_nvenc -preset p5 -b:v 3M -pix_fmt yuv420p` | HEVC Main, `yuv420p` | 3,559,642 |
| `hevc10` | `-c:v hevc_nvenc -preset p5 -b:v 3M -pix_fmt p010le` | HEVC Main 10, `yuv420p10le` | 3,571,074 |
| `av1-8` | `-c:v av1_nvenc -preset p5 -b:v 3M -pix_fmt yuv420p` | AV1 Main, `yuv420p` | 3,780,512 |
| `av1-10` | `-c:v av1_nvenc -preset p5 -b:v 3M -pix_fmt p010le` | AV1 Main, `yuv420p10le` | 3,767,817 |
| `gpu-to-gpu-h264` | `-c:v h264_nvenc -preset p5 -b:v 4M`, decoding on the GPU | H.264 Main, `yuv420p` | 4,912,490 |
| `gpu-to-gpu-hevc` | `-c:v hevc_nvenc -preset p5 -b:v 3M`, decoding on the GPU | HEVC Main 10, `yuv420p10le` | 3,230,326 |

The two `gpu-to-gpu` cases put
`-hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda` before the input,
so the frames go from the decoder to the encoder without a download. The input
of `gpu-to-gpu-hevc` is the 10-bit HEVC file of 1920x1080; the other six cases
read the 10-second H.264 file. The packets of `gpu-to-gpu-h264` have the same
MD5 as those of `h264`.

**The product's own code.** The worker's functions that choose the decoder and
that measure VMAF were run on the same host with each build, under Node 22.12.0.

- Decoder choice with the policy `auto`, for 23 inputs: the choice is the same
  with both builds for all 23. Eighteen inputs get the GPU, with the download
  format `nv12` for 12 inputs of 8 bits and `p010le` for 6 inputs of 10 bits.
  Five get the CPU, for the reasons `CUDA_UNSUPPORTED_H264_DEPTH`,
  `CUDA_UNSUPPORTED_CODEC`, `CUDA_CONTAINER_CROP_REQUIRES_CPU` and, twice,
  `CUDA_DISPLAY_MATRIX_REQUIRES_CPU`.
- A GPU that does not exist: with both builds the policy `auto` falls back to
  the CPU with the reason `CUDA_DEVICE_UNAVAILABLE`, and the policy `cuda` fails
  with "CUDA decode qualification failed (CUDA_DEVICE_UNAVAILABLE)."
- Whole measurements: nine pairs of videos, each measured four times, with each
  build and with CPU and GPU decoding. With GPU decoding both videos of a pair
  were decoded on the GPU. All 36 runs ended with status 0 at the first attempt,
  and each reports libvmaf `f712fa7`. For every pair the four runs give the same
  values for every frame.

| Pair | Model | Frames | Values | Mean VMAF |
|---|---|---|---|---|
| `h264-v0.6.1` | `vmaf_v0.6.1` | 240 | 4,320 | 91.049042 |
| `h264-v1-3d0h` | `vmaf_v1.0.16_3d0h` | 240 | 4,320 | 90.311682 |
| `h264-float` | `vmaf_float_v0.6.1` | 240 | 4,320 | 91.053082 |
| `hevc8` | `vmaf_v0.6.1` | 240 | 4,320 | 94.718273 |
| `vp9-8` | `vmaf_v0.6.1` | 240 | 4,320 | 91.974767 |
| `av1-8` | `vmaf_v0.6.1` | 240 | 4,320 | 93.730187 |
| `ten-bit-hevc-av1` | `vmaf_v0.6.1` | 240 | 4,320 | 94.551658 |
| `ten-bit-hevc-vp9-v1` | `vmaf_v1.0.16_3d0h` | 240 | 4,320 | 92.027433 |
| `uhd-4k-model` | `vmaf_4k_v0.6.1` | 16 | 288 | 84.899219 |

A run of the nine pairs holds 1,936 frames and 34,848 values. The values were
compared with their keys sorted. For the pair `h264-float` the hash of the
unsorted values differs between CPU and GPU decoding, and the sorted values are
the same.

**Limits of this check.**

- The programs were not compiled on the GPU host itself. They have the bytes of
  CI's native build (see "Result").
- Only `-hwaccel cuda`, which uses NVDEC, was run for decoding. The `*_cuvid`
  decoders were not run.
- The codecs covered are H.264, HEVC, VP9 and AV1. The other `*_nvdec` hwaccels
  were not run.
- One GPU model and one driver version were used.
- The repository's own CUDA scorer, `native/vmaf-gpu`, does not use this FFmpeg
  and was not part of the check.

## Known limits

### libvmaf and small pictures

The bundled libvmaf (commit `f712fa7564fe49b12991d83920b83573af2ae063`) does not
score every picture size with the eight `vmaf_v1.0.16_*` models. Two tests of
2026-11-11, A and B, record what happens, and two of 2026-11-12, C and D,
measured where the limits lie. All four ran the `linux/arm64` programs of this
build in a container of the base image, without network access, with the
fourteen models that the image bundles. The appendix holds the scripts of tests
A and B and the command that started them. Since PR #117 the worker knows these
limits and names them in the error of a measurement; "What follows for bitovp"
at the end of this section says how.

Test A gives both pictures the same size. Each run compares 10 frames of
`testsrc2` in 8-bit 4:2:0 with the same frames after `gblur=sigma=1.5`. Every
model ran at 29 sizes from 64x36 to 640x360. Of the 406 runs, 226 ended with
status 0, 80 with status 234 and 100 with status 139. The last three columns of
the table count the runs of each model.

| Model | No score (status 234) | Crash (status 139) | Status 0 | Status 234 | Status 139 |
|---|---|---|---|---|---|
| `vmaf_4k_v0.6.1` | never | never | 29 | 0 | 0 |
| `vmaf_float_4k_v0.6.1` | never | never | 29 | 0 | 0 |
| `vmaf_float_v0.6.1` | never | never | 29 | 0 | 0 |
| `vmaf_float_v0.6.1neg` | never | never | 29 | 0 | 0 |
| `vmaf_v0.6.1` | never | never | 29 | 0 | 0 |
| `vmaf_v0.6.1neg` | never | never | 29 | 0 | 0 |
| `vmaf_v1.0.16_1d5h_2160` | width and height both below 216 px | otherwise, width or height below 160 px | 11 | 10 | 8 |
| `vmaf_v1.0.16_3d0h` | width and height both below 216 px | otherwise, width or height below 160 px | 11 | 10 | 8 |
| `vmaf_v1.0.16_hfr_1d5h_2160` | width and height both below 216 px | otherwise, width or height below 160 px | 11 | 10 | 8 |
| `vmaf_v1.0.16_hfr_3d0h` | width and height both below 216 px | otherwise, width or height below 160 px | 11 | 10 | 8 |
| `vmaf_v1.0.16_5d0h` | width and height both below 216 px | otherwise, width or height below 266 px | 3 | 10 | 16 |
| `vmaf_v1.0.16_hfr_5d0h` | width and height both below 216 px | otherwise, width or height below 266 px | 3 | 10 | 16 |
| `vmaf_v1.0.16_3d0h_2160` | width and height both below 216 px | otherwise, width or height below 318 px | 1 | 10 | 18 |
| `vmaf_v1.0.16_hfr_3d0h_2160` | width and height both below 216 px | otherwise, width or height below 318 px | 1 | 10 | 18 |

The sizes of test A, by the status of the v1.0.16 models:

```text
status 234, all eight models:
64x36 96x54 128x72 144x144 160x90 160x120 160x160 176x144 192x108 214x120

status 139, the four models with the limit of 160 px:
216x100 216x122 240x136 256x144 264x148 266x150 400x100 100x400

status 0, the four models with the limit of 160 px:
216x216 284x160 316x178 318x180 320x180 320x240 352x288 384x216 426x240 480x270 640x360

status 0, the two models with the limit of 266 px:
352x288 480x270 640x360

status 0, the two models with the limit of 318 px:
640x360
```

A run with status 234 is a refusal. libvmaf logs
`vmaf_predict_score_at_index(): no feature 'cambi_hrs_1080_cmxv_17_vlt_0.06' at index 0`,
FFmpeg ends with `Conversion failed!`, and its log still holds the line
`VMAF score: 0.000000`. The cause is CAMBI, the banding feature of the v1.0.16
models. In the pinned source, `libvmaf/src/feature/cambi.c` defines
`CAMBI_MIN_WIDTH_HEIGHT (216)`, and the feature's `init` returns an error when
the width and the height are both below that value.

A run with status 139 is a crash. libvmaf logs
`SpEED: image too small, operating width or height is 0`, and the process ends
with a segmentation fault. The cause is the chroma SpEED feature of the v1.0.16
models. In `libvmaf/src/feature/speed.c`, `speed_init_dimensions` logs that
message and returns an error, and its callers `speed_init` and `init_chroma` do
not use the returned value.

The limit follows from the same file. The chroma planes of a 4:2:0 picture have
half its width and half its height. The feature scales them by the model's
`speed_prescale`, halves the result four times (`NUM_SCALES (4)`), and needs a
block of five values in each direction (`DEFAULT_BLOCK_SIZE (5)`).
`speed_prescale` is 1.0 unless a model sets it. The `5d0h` models set 0.6 and
the `3d0h_2160` models 0.5; the `3d0h` and `1d5h_2160` models do not set it. The
width and the height of a 4:2:0 picture must therefore be at least 160, 266 or
318 px. Every run of test A agrees with these limits.

The other chroma layouts follow from the same arithmetic. A side of the chroma
planes, times `speed_prescale` and rounded to a whole number, must be 80 or
more, so the smallest side is 80, 133 or 159 samples. libvmaf gives the chroma
planes of a 4:2:0 picture its width and its height, each shifted right by one
bit, and those of a 4:2:2 picture its shifted width and its whole height
(`libvmaf/src/picture.c`). An odd width or height therefore has the chroma
planes of the even one below it. The last three columns give the smallest
picture that SpEED takes:

| `speed_prescale` | Models | Smallest chroma side | 4:2:0 | 4:2:2 | 4:4:4 |
|---|---|---|---|---|---|
| 1.0 | `3d0h`, `hfr_3d0h`, `1d5h_2160`, `hfr_1d5h_2160` | 80 | 160x160 | 160x80 | 80x80 |
| 0.6 | `5d0h`, `hfr_5d0h` | 133 | 266x266 | 266x133 | 133x133 |
| 0.5 | `3d0h_2160`, `hfr_3d0h_2160` | 159 | 318x318 | 318x159 | 159x159 |

CAMBI's 216 holds in every layout: a picture that one of these models scores
also has a width or a height of 216 or more.

Test B follows the product's own method with a v1.0.16 model. Both pictures are
scaled to one canvas in 10 bits, and the size of the encoded picture goes to
CAMBI as `cambi.enc_width` and `cambi.enc_height`. Of its 43 runs of 5 frames
each, 21 ended with status 0, 11 with status 234 and 11 with status 139.

On a canvas of 1920x1080 with `vmaf_v1.0.16_3d0h`, the first line lists the
encoded sizes that are scored. The second line lists those that end with status
234 when the filter is set up, with the message
`problem during vmaf_use_features_from_model`:

```text
1920x1080 1280x720 640x360 384x216 320x180 256x144 216x384
216x122 214x120 192x108 160x90 128x72 108x192
```

CAMBI's options `enc_width` and `enc_height` accept values from 144 to 7680, so
an encoded width or height below 144 is refused. On a canvas of 3840x2160 with
`vmaf_v1.0.16_3d0h_2160`, an encode of 256x144 is scored and an encode of
192x108 ends with status 234.

When the encode is as large as the canvas, the status follows the limits of test
A. At 192x108 the options refuse the encoded size.

| Size of both pictures | `vmaf_v1.0.16_3d0h` | `vmaf_v1.0.16_5d0h` | `vmaf_v1.0.16_3d0h_2160` | `vmaf_v1.0.16_1d5h_2160` |
|---|---|---|---|---|
| 640x360 | 0 | 0 | 0 | 0 |
| 480x270 | 0 | 0 | 139 | 0 |
| 426x240 | 0 | 139 | 139 | 0 |
| 384x216 | 0 | 139 | 139 | 0 |
| 320x180 | 0 | 139 | 139 | 0 |
| 256x144 | 139 | 139 | 139 | 139 |
| 192x108 | 234 | 234 | 234 | 234 |

Test C measured the edges of the limits: 207 runs of 5 frames each, 71 in the
method of test B and 136 in that of test A, the latter in 4:2:0, 4:2:2 and 4:4:4
with 8 and with 10 bits. Of the 199 runs with a v1.0.16 model, 109 ended with
status 0, 16 with status 234 and 74 with status 139, each as the limits above
and the three rules below say. The other 8 ran `vmaf_v0.6.1`: it scored 64x36
and 32x18 in both methods and ended with a segmentation fault at 16x16 in both.
Test F of the next section found the edge: `vmaf_v0.6.1`, `vmaf_v0.6.1neg` and
`vmaf_4k_v0.6.1` score pictures of 17x17, 400x17 and, the first of them, 17x400,
1920x17 and 17x1080, and end with a segmentation fault at the same sizes with 16
in place of 17. Why was not looked into.

The three rules are for the size that the command of test B declares to CAMBI.
`cambi.c` holds the first in the feature's options and the other two in its
`init`:

- A declared width or height below 144 or above 7680 is refused when the filter
  is set up, with `problem during vmaf_use_features_from_model`. 143x400,
  400x143, 7681x4320 and 7680x7681 are refused; 144x400, 400x144 and 7680x4320
  are scored.
- A declared size that exceeds the pictures in width or in height counts as the
  size of the pictures. On a canvas of 1920x1080 a declared 2000x1200 is scored.
  On a canvas of 200x200 a declared 1920x1080 is refused, as pictures of 200x200
  are.
- Otherwise the 216 is asked of the declared size. 144x144, 215x215 and 144x215
  are refused with the first pictures, with `problem during vmaf_read_pictures`;
  216x144 and 144x216 are scored.

In the 136 runs in the method of test A, `testsrc2` drew the pictures in the
format of the comparison. It draws an odd width or height one pixel smaller
where that format halves the chroma, so the runs at such sizes compared pictures
of the even size below the named one. Such a picture has the same chroma planes
in libvmaf, and 214 is below 216 as 215 is, so those runs ended as the named
size does. The test of the repository that is named below draws in `yuv444p`
and converts, and its pictures have the named size.

Test D measured in which pixel format the method of test A compares, because
the format decides the chroma layout. The method of test B converts both
pictures to `yuv420p10le`. In the method of test A the worker's command scales
the encode to the reference's size with a `scale` filter, also when the two
sizes are equal, and puts no such filter on the reference. FFmpeg's libvmaf
filter takes twelve formats: `yuv420p`, `yuv422p` and `yuv444p`, each with 8,
10, 12 and 16 bits (`libavfilter/vf_libvmaf.c`). The 192 runs of test D used
the worker's graph with `vmaf_v1.0.16_3d0h`. The reference was a file in one of
28 pixel formats, 11 of the twelve and 17 others, and the encode a file in
`yuv420p`, `yuv420p10le` or `yuv444p`. Two sizes tell the layouts apart: the
model scores 216x100 in 4:2:2 and in 4:4:4, and 150x216 in 4:4:4 only. FFmpeg's
log names each conversion. 78 runs ended with status 0 and 114 with status 139:

- A reference in one of the twelve formats was never converted. The `scale`
  filter gave the encode the reference's format, and the status was that of the
  reference's layout (84 runs).
- A reference in another format was converted to the encode's format, and the
  status was that of the encode's layout (108 runs). The same held in 16 runs
  with full-range references from x264 and from FFmpeg's MJPEG encoder, whose
  formats ffprobe names `yuvj420p`, `yuvj422p` and `yuvj444p`.

The first rule rests on the `scale` filter. In four runs of the graph without
it, which the worker does not build, the outcome was that of the encode's layout
although both formats were among the twelve.

Test H of 2026-11-12 took test D to the encodes that it had left out: each of
the twelve formats, and full-range encodes. Its 216 runs used the `linux/amd64`
programs of this build on the host of the GPU check, with the same graph, the
same model and the same two sizes. 108 ended with status 0 and 108 with status
139:

- With a reference in `yuv420p` or `yuv444p` and the encode in each of the
  twelve formats, the status was that of the reference's layout (48 runs).
- With a reference that libvmaf does not take and the encode in each of the
  twelve formats, the status was that of the encode's layout (120 runs). The
  references were raw `nv12` and `gbrp`, and `yuvj420p`, `yuvj422p` and
  `yuvj444p` from x264 and from FFmpeg's MJPEG encoder.
- A full-range encode from the same two encoders took the reference's format
  when that was `yuv420p`, `yuv422p` or `yuv444p` (18 runs). Against the five
  references that libvmaf does not take, the `scale` filter gave it the
  limited-range format of its own layout, `yuv420p` for `yuvj420p` and so on.
  FFmpeg converted the reference to that format, and the status was that of the
  encode's layout (30 runs).

The 48 runs of the first item had been meant for full-range references. Raw
video does not keep the name of a full-range format, and the files that were
written as `yuvj420p` and `yuvj444p` came back as `yuv420p` and `yuv444p`.

An encode in any other format was not measured in this way. In eight runs of
the worker's command at 216x100 with a `yuvj420p` or `nv12` reference, the
encodes in `nv12` and `p010le` ended with SpEED's message, and those in `gbrp`,
`gray`, `yuv440p`, `yuvj440p` and `yuva444p` were scored.

The statuses of this section are those of libvmaf without worker threads. The
worker's command sets `n_threads` for a local run that has threads to give, and
test G of 2026-11-12, 11 runs, ran the refusals with and without it. Where
CAMBI's `init` refuses (pictures of 215x215, a declared encode of 215x215, and
the window of the next section), FFmpeg with `n_threads=4` logs `problem
getting pooled vmaf score`, writes no log file and ends with status 0; pictures
of 215x215 did the same with `n_threads=1`. The refusal of a declared 143x400
by the options keeps status 234, and SpEED's crash keeps status 139 and its
message.

What follows for bitovp:

- The proof of the image build uses 640x360, which all fourteen models score in
  test A, and the four models of test B in test B.
- The comment in `docker/vmaf-build-proof.sh` says that below 320x180 some
  pictures end libvmaf with a segmentation fault. That describes the proof's own
  model, `vmaf_v1.0.16_3d0h`. The limits of the `5d0h` and `3d0h_2160` models
  are higher.
- Since PR #117 the worker asks before a comparison whether the pictures are
  too small for the model. A measurement whose pictures are ends with an error
  that names the limit and what to do: use a model of the `vmaf_v0.6.1` family,
  or a larger reference. `packages/core/src/vmaf/size-limits.ts` holds the
  limits of this section for the eight models and for no other model. A VOD
  measurement asks before FFmpeg starts and before a comparison goes to the
  cloud. It gives the size of the reference. In the method of test B it gives
  4:2:0 and the size of the encode. In the method of test A it gives the
  reference's chroma layout when the reference's pixel format is one of the
  twelve, by the first rule of test D. When it is not, a full-range reference
  for example, and the pictures are too small for 4:2:0, it probes the encode
  and gives the encode's layout, by the second rule of test D and by test H,
  where the encode's format is one of the twelve or `yuvj420p`, `yuvj422p` or
  `yuvj444p`. It gives no layout otherwise. A live measurement asks once, after
  it has probed its source and before it captures anything, and gives no
  layout. Where the layout is not known, the check takes SpEED's limit for
  4:4:4, the lowest, so that it refuses nothing that libvmaf scores. When a run
  of the worker's own FFmpeg then ends with SpEED's message, the error names
  the limit instead of FFmpeg's status. A cloud comparison of that kind still
  reports only that it did not finish: its failure does not come back with
  FFmpeg's output. The check changes no command and no score. It is not made
  for a comparison that the GPU scorer runs, which is not libvmaf: "The GPU
  scorer and small pictures" below says what happens there. It knows the limits
  of this section and not those of "libvmaf and large or very wide pictures".
- `packages/core/src/vmaf/size-limits.ffmpeg.test.ts` holds those numbers
  against these programs in the job `native-media`. It builds its commands with
  the worker's command builder and runs FFmpeg 190 times: every v1.0.16 model in
  the three layouts at SpEED's edge and one pixel below it, the twelve pixel
  formats, CAMBI's 216, references and encodes in different formats, full-range
  ones among them, the declared sizes of test C, and three models of the
  `vmaf_v0.6.1` family at sizes that the v1.0.16 models refuse. It fails when a
  number no longer holds, and when the image holds another set of v1.0.16
  models than the eight.
- The copies of `cambi.c` and `speed.c` that were taken from the `master` branch
  of `Netflix/vmaf` on 2026-11-11 are byte for byte the pinned files. Both
  limits were therefore still in upstream's code on that day.

### The GPU scorer and small pictures

The repository's own GPU scorer, `native/vmaf-gpu`, is not this FFmpeg and not
its libvmaf, and it has the same smallest pictures in rules of its own. 71
comparisons of 2026-11-12 on the host of the GPU check record them: the scorer
of `main` at `e6ff8d14`, built on that host, with its CUDA backend, started as
the worker starts it, with `vmaf_v1.0.16_3d0h`, `vmaf_v1.0.16_5d0h` and
`vmaf_v1.0.16_3d0h_2160`. It scored 22 and refused 49. Two things differ from
the worker's command for libvmaf:

- The scorer compares every pair in 4:2:0, whatever the two formats are. It
  refused a `yuv444p` reference of 256x144 with all three models. libvmaf
  scored that reference with `vmaf_v1.0.16_3d0h` and `vmaf_v1.0.16_5d0h` in the
  method of test A.
- The scorer declares the encode's own size to CAMBI in every run, as the
  method of test B does and that of test A does not. With a reference of
  640x360 it scored encodes of 256x144 and 216x144 and refused encodes of
  214x144, 200x200, 144x144, 240x134 and 142x256, each with all three models.
  libvmaf scored all seven with all three models in the method of test A.

With these two, the rules of "libvmaf and small pictures" for 4:2:0 pictures
and for a declared encode said for each of the 71 comparisons whether the
scorer scored it. The comparisons were pairs of one size from 16x16 to 320x180,
a reference of 640x360 with an encode of 320x180 and with the seven encodes
above, and a reference of 1920x1080 with encodes of 640x360 to 1920x1080.

The scorer ends a refusal with status 1 and one line, which names no limit:

| Line after `bitovp-vmaf: ` | Refusals | What was too small |
|---|---|---|
| `input is too small or too large for official SpEED chroma blocks` | 20 | the pictures, for SpEED |
| `invalid Vulkan CAMBI encoding geometry` | 11 | the pictures or the encode: both sides below 216 |
| `override official extractor cambi failed (libvmaf -22)` | 18 | the encode: a side below 144 |

The second line names Vulkan and comes from the CUDA backend as well: the two
backends share the code that writes it.

Since PR #NNN the worker names the limit when a run of the scorer ends with
one of these lines and the sizes are below a limit of
`packages/core/src/vmaf/size-limits.ts`: the same sentences as for libvmaf, for
4:2:0 pictures and the declared encode. Every other failure of the scorer keeps
the scorer's line. The worker refuses nothing before the run. A test of
`packages/core` holds the lines against the scorer's source, and the 71 stored
results were held against the worker's function: it named every one of the 49
refusals, and its rules refuse none of the 22 comparisons that were scored.

Not measured: the Vulkan backend, a size above 1920x1080, an encode above 7680
pixels, and a 10-bit encode.

### libvmaf and large or very wide pictures

The review of PR #117 ran the size check against FFmpeg at sizes far from the
edges above, and found two things that the check does not know. Tests E and F of
2026-11-12 record them. They ran the programs, the models and the container of
tests A to D, with 2 frames in a run.

**CAMBI has an upper limit.** CAMBI works on a window of 65 samples, and its
`init` scales the window with the width plus the height (`adjust_window_size`
in `cambi.c`) in three steps. The first is `((65 * (width + height)) / 375) >>
4`, which gives 65 again at the 6000 of 3840x2160. The second halves the
result, rounding up, where the high-resolution speed-up applies. The third makes
the result odd. `init` refuses the pictures when the square of the window
reaches 4226 (`CAMBI_RECIPROCAL_LUT_SIZE` in `cambi.h`), which a window of 67
does. libvmaf logs `cambi: window_size 67 too large for reciprocal LUT`, and
FFmpeg ends with `problem during vmaf_read_pictures` and status 234. The eight
`vmaf_v1.0.16_*` models set `cambi_high_res_speedup` to 1080: the speed-up
applies when the encode has the pixels of 1920x1080 or more, where the encode
is the size that the command declares, or the pictures when it declares none.
`init` computes one window for that size and one for the size of the source,
which is the pictures because the worker's command declares no source, and
takes the larger. A declared size does not exceed the pictures (see the rules
above), so the pictures decide: their width and height may add up to 6092 at
most, and to 12092 when the window is halved.

The 32 runs of test E at these edges agree. 21 used the method of test B with
`vmaf_v1.0.16_3d0h` where the table names no model:

| Pictures | Width plus height | Declared encode | Window halved | Status |
|---|---|---|---|---|
| 3840x2160 | 6000 | 1280x720 | no | 0 |
| 3932x2160 | 6092 | 1280x720 | no | 0 |
| 3933x2160 | 6093 | 1280x720 | no | 234 |
| 4096x2160 | 6256 | 1280x720 | no | 234 |
| 4096x2160 | 6256 | 1920x1079 | no | 234 |
| 4096x2160 | 6256 | 1920x1080 | yes | 0 |
| 4096x2160 | 6256 | 4096x2160 | yes | 0 |
| 7680x4320 | 12000 | 1280x720 | no | 234 |
| 7680x4320 | 12000 | 1920x1080 | yes | 0 |
| 7772x4320 | 12092 | 1920x1080 | yes | 0 |
| 7773x4320 | 12093 | 1920x1080 | yes | 234 |
| 3932x2160, four other v1.0.16 models | 6092 | 1280x720 | no | 0 |
| 3933x2160, the same four models | 6093 | 1280x720 | no | 234 |
| 4096x2160, `vmaf_v0.6.1` and `vmaf_4k_v0.6.1` | 6256 | 1280x720 | no CAMBI | 0 |

The other 11 runs compared pictures of the named size and declared nothing, as
the method of test A does. 3840x2160, 4096x2160, 7680x4320 and 7772x4320 were
scored, and 7773x4320 was refused. A picture with fewer pixels than 1920x1080
meets the lower sum: 5876x216 and 216x5876 were scored, 5877x216 and 216x5877
refused; 6000x345 has 2,070,000 pixels and was refused, and 6000x346 was scored.

What this means for a measurement:

- In the method of test A the pictures have the reference's size and the
  command declares nothing. A reference with the pixels of 1920x1080 or more is
  scored up to a sum of 12092, which 7680x4320 is below. A reference with fewer
  pixels reaches the sum of 6093 only when it is more than 15 times as wide as
  high, or as high as wide.
- In the method of test B the pictures have the reference's display size and
  the command declares the encode's size. A reference of 3840x2160 stays below
  the limit with every encode. A reference of 4096x2160 or of 7680x4320 is
  refused with every encode that has fewer pixels than 1920x1080.
- The worker's check does not know this limit, and such a measurement fails as
  it did before PR #117: FFmpeg ends with "Invalid argument", or with status 0
  and no score where libvmaf runs with worker threads (test G). The models of
  the `vmaf_v0.6.1` family have no CAMBI; two of them scored the refused case
  of 4096x2160.

**Very wide and short pictures crash now and then.** Tests E and F compared
pictures of one size several times with `vmaf_v1.0.16_3d0h`, declaring nothing.
Some runs ended with a segmentation fault (status 139) and no message of
libvmaf, and the other runs of the same command gave a score:

| Pictures | Runs | Segmentation faults |
|---|---|---|
| 5000x216 | 8 | 1 |
| 3840x216 | 20 | 3 |
| 2560x216 | 8 | 1 |
| 3000x160, 2000x216, 3840x400, 216x5000 | 8 each | 0 |
| 1920x216 | 20 | 0 |
| 3840x2160 | 12 | 0 |

The crash comes with CAMBI. `vmaf_v0.6.1` scored 3840x216 in 12 of 12 runs, and
5000x216 in 4 of 4. With CAMBI added to it as a feature (`feature=name=cambi`)
4 of 12 runs at 3840x216 ended with a segmentation fault; with SpEED's chroma
feature added (`feature=name=speed_chroma`) all 12 gave a score.

The review read the cause in `cambi.c`. CAMBI computes at five scales and halves
the picture between them, rounding up: four times, and five when the window is
halved. `calculate_c_values` takes half the window as a number of rows, and its
last loop starts at the row `height - pad_size`. Where half the window exceeds
the height of the smallest scale, that row is negative, and
`calculate_c_values_row` reads its mask and writes its values before the start
of both buffers. A picture of 2560x216 has a window of 31 and a smallest scale
of 14 rows. By this arithmetic the zone begins at a width of 1871 for a height
of 160, of 2554 for 216 and of 4400 for 400: at pictures more than ten times as
wide as high. Every crash of the two tests lies in the zone and no run outside
it crashed; 3000x160 lies in it and gave 8 scores here, and crashed in 2 of 6
runs of the review. CAMBI computes at the size of the encode
(`preprocess_and_extract_cambi`), so where a command declares the encode's
size, that size decides and not the pictures'; this was read and not run. The
worker's check does not know the zone: such a run fails with FFmpeg's status,
and the same measurement may pass when it is started again.

### Other limits

- Fonts are scanned at the first caption render of each container. The image's
  `fc-cache` is Debian's, of Fontconfig 2.14.1, and writes `.cache-8` files. The
  Fontconfig inside FFmpeg is 2.18.3: it writes `.cache-12` files and reads the
  versions 9 to 12, so FFmpeg scans the font directories itself. The earlier
  build behaved in the same way.
- An RTMPS push does not verify the server's certificate. FFmpeg verifies a TLS
  certificate only when it is asked to: `TLS_VERIFY_DEFAULT` is 0 while the
  major version of libavformat is below 63, and it is 62. The product's feeder
  does not ask. The push is encrypted, but the server is not authenticated. The
  earlier build behaved in the same way. The security review found that
  verification works when it is requested: with `-tls_verify 1` FFmpeg finds the
  trust store of the image in `/etc/ssl/certs`. The feeder does not pass that
  option; passing it would be a change to the feeder, not to this build.
- Outside the image, the programs need a host with glibc 2.36 or newer (see
  "Result").
- Two inputs are not pinned: Debian's compiler and build tools, and the
  Dockerfile frontend (see "What makes the build repeatable"). The SHA-256
  values under "Result" hold for the Debian packages of 2026-11-11.
- The build stops when a server does not deliver an archive, or delivers bytes
  that do not match the pinned SHA-256. x264 depends on VideoLAN's server.
  BuildKit keeps a checksummed archive that it has downloaded and uses it again,
  also under `--no-cache`; a machine that has built before therefore does not
  notice an archive that has disappeared.
- When the `ffmpeg` stage is replaced with `--build-context ffmpeg=<directory>`,
  this record does not describe the programs in the image. `docs/OPERATIONS.md`
  states that the build does not verify a replaced FFmpeg.
- Part of the comparison with the earlier build was not made on real x86-64
  hardware. The design note lists the AVX-512 code as not compared, because the
  `linux/amd64` comparison ran under emulation, which does not use AVX-512. The
  GPU check later ran both builds on an x86-64 host whose processor reports
  AVX-512: software decoding of the 19 files and the nine measurements gave the
  same values with both builds. The comparisons of captions, of x264, SVT-AV1
  and AAC encoding, of scaling, pixel format conversion and frame rate
  conversion, and of audio resampling were made on arm64 and under emulation
  only, with one exception: the two x264 encodes of the media check were later
  made with both builds on the host of the GPU check, and gave the same packets
  (see "The VMAF means of the media job").
- x264 does not write the same packets on every processor. On x86-64 its
  macroblock tree gives other results with AVX-512 than without: one command on
  one input gave two different encodes on one host. The media check prints a
  third set of means on an arm64 host; its packets were not compared. A
  processor without AVX2 and a second arm64 processor were not tried, so there
  may be more. A VMAF score of an x264 encode can be compared only between
  processors on which x264 uses the same extensions; the media check prints them
  after its means, in the line `x264 CPU capabilities:`. The earlier prebuilt
  build behaves in the same way on x86-64. "The VMAF means of the media job"
  records the test.
- The limits of the GPU check are listed under "Verification record", and what
  the build no longer contains under "Differences from the earlier prebuilt
  build".

## Upstream fixes after the pinned revisions

This section is the state of 2026-11-11, with three additions of 2026-11-12 that
are marked. It is not kept current: nothing in the repository watches the
upstream projects. For a source on GitHub,
`gh api repos/<owner>/<repo>/compare/<pin>...<branch>` lists what the project
has committed after a pin; the table under "Sources" names the branch of every
pin.

The pins are those of the earlier build. The security review of PR #109 records
that thirteen of the library pins are the head of a development branch on the
day when the recipe was last updated, not releases, and that upstream publishes
no advisories for such snapshots. Before the merge the review read the subjects
of the commits that follow each pin, and read in full those that read as
security fixes. The list names those commits, and how that one review read
bitovp's use of the code at commit `87e70e9b`. Where its answer rests on how the
worker calls FFmpeg, the list names the condition, and the answer holds only as
long as the condition does.

- libunibreak: `2c5205aa35` (2026-11-03), an out-of-bounds write `brks[-1]`. The
  review: not reached. libass calls libunibreak only with `wrap_unicode`.
  FFmpeg's `subtitles` filter leaves that off for an ASS file and turns it on
  for a caption stream of another kind, and no code of the worker sets it. The
  answer holds as long as the captions are ASS files that the worker writes
  itself, as `apps/worker/src/library-editing/composition-render.ts` does.
- libass: `d4fa710425`, `1f0f8e344b` and `fe25f50686` (2026-10-29), writes and
  overflows in `sub_recode` and `ass_read_memory`. The review: not reached. They
  need a code page; FFmpeg passes `NULL` and uses `ass_read_file` and
  `ass_process_chunk`.
- zlib: `2fd31f0074` (2026-11-03), an out-of-bounds write after
  `inflateReset()`. The review: not reached. It happens only through
  `inflateGetDictionary()`, which FFmpeg does not call. A check of 2026-11-12
  for this record found no call in the other sources of the build either.
- SRT: `5c8f6464c5` (2026-11-10), key-stream reuse between the two directions of
  one connection. The review: not reached in practice. The feeder sends one way
  only; the fix also needs a new peer.
- FreeType: `3e8df65e4e` ("FT_Vector_NormLen: Fix issues", the commit right
  after the pin), `f1f3f7d722` and `6065d6a40e`. The review: they need a hostile
  font, and the fonts are the product's own. The worker gives the caption filter
  a font directory of its own and caption files that it writes itself. A font
  can also reach FreeType from inside a caption file or from a container's
  attachments, so the answer holds only as long as no caption file comes from
  outside.
- HarfBuzz: several font-parsing fixes (kerx, VARC/COLR) among 252 commits. As
  for FreeType.
- Fontconfig: `02d4b15daa`, cache validation. The caches are the image's own.
- dav1d: `e5fd231fe9` and `9143ecbe6d`, out-of-memory paths. dav1d decodes media
  that comes from outside. The review rates the two "Low"; that is its rating of
  the fixes, not a finding that the code is not reached.
- OpenSSL: 3.6.5 is the newest 3.6 release; the branch holds unreleased fixes.
  There is no release to move to. The review did not assess whether those fixes
  are reached.
- FFmpeg: one commit on `release/8.1` after the pin, `f1acb0a266` (2026-11-10,
  "avcodec/4xm: fix unaligned access"); on 2026-11-12 it was still the only
  one. The review answers that it is not reached and gives no reason. This
  record does not repeat the answer: the build contains the decoder `4xm`
  (`fourxm` in configure's summary), and whether an input can reach it was not
  examined.

The review's list names no fix for the other eight sources: Meson, libxml2, dlg,
FriBidi, libvmaf, x264, SVT-AV1 and the NVIDIA headers.

The review also checked the advisories of 2026 that it knew against the pins:

- FFmpeg: CVE-2026-8461 is reported fixed in 8.1.2 and CVE-2026-66038 in the
  distributions' 8.1.3. The pin is `n8.1.3` plus 34 commits. The review also
  looked for the fixes to the RASC decoder, for which it names no advisory: they
  are on `release/8.1` before the pin (`cf148db1a8`).
- OpenSSL: the advisory of 2026-09-29 points to 3.6.5, which is the pinned
  release.
- SRT: the fix for CVE-2026-55868 and CVE-2026-55869, `c63c311e`, is an ancestor
  of the pin.
- libxml2: CVE-2026-86142 is fixed on `master` as `595d7d8f6a`, which is in the
  pin's history.

One more advisory was checked on 2026-11-12, while this record was written.
SRT's advisory `GHSA-m96h-3rc9-xx6h` (published 2026-10-15, a heap overflow in
the listener's handshake) names 1.5.7 as the fixed release. The tag `v1.5.7` is
an ancestor of the pin: GitHub's comparison of the two reports the pin 18
commits ahead and none behind.

What the records state about this:

- The earlier build has the same revisions. The change to a build from source
  made none of these points better or worse.
- PR #109 did not raise the pins. The design note gives the reason: the build
  was to have the same contents as the earlier one. A newer pin changes the
  bytes of the programs, so the comparison with the earlier build has to be
  repeated, in a change of its own.
- The research records list newer pins for libunibreak, libass, zlib, SRT,
  FreeType and HarfBuzz as a follow-up.
- Nothing watches the upstream projects. The review suggests a scheduled job
  that lists `compare/<pin>...<branch>` for each source; the design note records
  that no such mechanism was built.
- The review states its own limits: it searched published advisories and read
  the subjects of the commits after each pin. It ran no scanner over the commit
  ranges and no fuzzing.

## Changing a pin and renewing this record

### Changing a pin

`docs/OPERATIONS.md` holds the rules in its section "Worker FFmpeg". In short:

1. Change the commit and the SHA-256 of the source's `ADD` line together. For
   libvmaf, SVT-AV1, dav1d and FFmpeg the commit is the `ARG` above that line:
   `LIBVMAF_COMMIT`, `SVTAV1_COMMIT`, `DAV1D_COMMIT` and `FFMPEG_COMMIT`.
2. Take a commit that is on the project's own branch, because an archive URL
   also answers for a commit that exists only in a fork. For a GitHub
   repository, `gh api repos/<owner>/<repo>/compare/<commit>...<branch>` must
   report `behind_by: 0`. For x264, the address
   `https://code.videolan.org/api/v4/projects/videolan%2Fx264/repository/commits/<commit>/refs?type=branch`
   must list the branch. The table under "Sources" names the branch of every
   pin.
3. For FFmpeg, set `FFMPEG_VER` to what
   `git describe --tags --long --abbrev=10` prints for the commit, and
   `SOURCE_DATE_EPOCH` to the commit's date (`git show -s --format=%ct`).
   `--long` keeps the number of commits and the revision in the name of a
   commit that is itself a tag. The build checks only that `FFMPEG_VER` ends
   with the first ten characters of the revision. For the pinned commit the
   command prints `n8.1.3-34-ga35157abb9`; for the commit of the tag `n8.1.3`
   it prints `n8.1.3-0-g1041abdc96`, where `git describe --tags` prints
   `n8.1.3` alone.
4. With a new FreeType commit, take the dlg revision that it records for
   `subprojects/dlg`. With a newer FFmpeg release, check which branch of the
   NVIDIA headers that release needs.
5. Meson's version is written twice in its URL and once in the check below it.

The test of `scripts/gated-tests.test.mjs` that reads `Dockerfile` checks the
form of every pin, not its value, so a new commit with its SHA-256 needs no
change there. A new source, another configure option or another licence
directory does. A second test compares this file with `Dockerfile` and fails
until the record follows the change (see "Renewing this record").

A new pin changes the bytes of the programs. The design note and the research
records therefore ask for the comparison with the build before it to be
repeated, and this record to be renewed. The build before is the `ffmpeg` stage
of the commit before the change, built with the command under "Running the
build". The earlier prebuilt build cannot serve again: its download was expected
to disappear about 2026-11-19.

### Renewing this record

The test "the FFmpeg build record holds the stages, the sources and the commands
of the Dockerfile's FFmpeg build in their order, and no other" of
`scripts/gated-tests.test.mjs` compares this file with `Dockerfile`. It fails
until the record follows a change:

- the table of stages has a row for each of the eight stages and for no other,
  in the order of `Dockerfile`, with the stage that each starts from;
- the table of archives holds the eighteen URLs in the order of `Dockerfile` and
  no other row, and the first table of sources holds, row for row, the same
  source with the SHA-256 of its `ADD` line and with a commit or release that
  the URL names;
- every other line of the eight stages, comments apart, is shown in a
  `dockerfile` block of this file, with each tab written as two spaces, in the
  order of `Dockerfile` and as often as `Dockerfile` has it;
- no `dockerfile` block shows a line that `Dockerfile` does not hold, and every
  block of this file is a `dockerfile`, `text`, `sh` or `bash` block;
- every line after the eight stages that names `ffmpeg` is shown, so that a
  check of `ffmpeg` which the image gains or loses is seen;
- the command of the proof under "Checks in the build" stands in
  `docker/vmaf-build-proof.sh` as this file shows it: whole, line for line and
  in one piece;
- a commit that this file names in full is one that `Dockerfile` pins;
- the models' revision and a row for each of the fourteen models are present.

The test finds the tables by the shape of their rows and the proof by its first
word, anywhere in this file. A row of three or more cells counts as a row of the
table of stages when its first cell is a lowercase name in backticks and its
second is such a name or the words "the base image". A row of two cells counts
as a row of the table of archives when its first holds no backtick and its
second is an `https://` address in backticks. A row of four cells counts as a
row of the first table of sources when its first holds no backtick, its second
is the word "commit" or "release" with one value in backticks, and its third is
a SHA-256 in backticks; a row of that table that gains a word in its second cell
is no longer found. A run of exactly 40 lowercase hexadecimal digits counts as a
commit that is named in full, also in the excerpt of a log. Exactly one `sh`
block may begin with the word `"$ffmpeg"`: the command of the proof. The test
takes the command as whole when the line in front of it in the script does not
end with a backslash and its own last line does not. The stages after the eight
repeat two of their lines, the first line of an `apt-get` step and the line that
removes the package lists; shown in a `dockerfile` block a second time, either
one fails the test as a line out of order. And the test holds three numbers: 8
stages, 18 sources and 14 models. When one of them changes, the test fails at
that number also when the record has followed, and the number is then changed in
the test.

A test that passes does not mean that the record is renewed. The test does not
compare the digest of the base image or the Debian packages, which change
without a change to what is compiled. It does not see a check in the last stage
that does not name `ffmpeg`, such as one of `ffprobe` or of the models. It does
not read the sentences: a version in the third table of sources, a commit that
is named by its first digits, or a number that was taken from a log can be out
of date while the test passes. And it cannot tell whether the excerpts of the
logs belong to a build of the new `Dockerfile`. The rest of this section is for
that.

The record rests on two build logs, on the capability lists and on the
measurements.

**The x86-64 log** is the log of a CI job that compiled the stages for the
commit, as GitHub serves it for one job, with a UTC time in front of every line.
Such a log has the line `FFmpeg: built from the pinned sources`. A job that
reused a build shows none of the build's steps (see "How CI obtains this
build"). The job `native-media` compiles in the first run after a pin has
changed, because the change gives it a new key. The job `ffmpeg-from-source` of
the workflow "FFmpeg from source" always compiles, and this command starts it
for a branch:

```sh
gh workflow run ffmpeg-source-build.yml --ref <branch>
```

`gh run list --workflow ffmpeg-source-build.yml --limit 1` then prints that run
with its id. These commands list the jobs of a run and save the log of one job:

```sh
gh api 'repos/<owner>/<repo>/actions/runs/<run id>/jobs?filter=all&per_page=100' \
  --jq '.jobs[] | [.id, .run_attempt, .name, .conclusion, .started_at, .completed_at] | @tsv'
esc=$(printf '\033')
gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<job id>/logs \
  | LC_ALL=C sed -E "s/${esc}\\[[0-9;]*[A-Za-z]//g" | LC_ALL=C tr -d '\r' \
  > native-media-<commit>.log
```

The first lists the jobs of every attempt with their numbers and times. Without
`filter=all` GitHub lists only the latest attempt, and a job that was started
again after another had stored a build has reused it. The last command saves the
log without its colour codes and carriage returns; `gh` 2.103 prints a log that
holds colour codes only with `--allow-escape-sequences`. GitHub keeps the log of
a job for 90 days unless the repository sets another time, so the log is saved
when the record is renewed.

**The arm64 log** is a build of the `ffmpeg` stage without the build cache, with
BuildKit's plain progress output, on a `linux/arm64` machine, in a checkout of
the commit:

```sh
docker build --no-cache --progress=plain --target ffmpeg \
  --output type=local,dest=<new directory> . > arm64-plain.log 2>&1
```

The research records give 168 s for this command, by the clock of the machine
that ran it.

**The capability lists** come from the programs themselves. The script `caps.sh`
in the appendix writes them: `sh caps.sh <ffmpeg> <new directory>`.

What to take again from a new pair of logs:

- the step numbers and times. BuildKit numbers the steps anew in every build,
  and the numbers differ between the two logs;
- the versions of the Debian packages, which change without a change to
  `Dockerfile`;
- what each library's configure step reports, and FFmpeg's configure summary;
- the sizes and the SHA-256 of the programs for each architecture, and the list
  of licence files;
- the capability lists, compared with those of the build before.

What to measure again:

- the outputs of the new programs against those of the build before, as in "What
  was confirmed to be the same";
- the check on a real NVIDIA GPU, when FFmpeg or the NVIDIA headers change;
- the small-picture tests, when libvmaf or the models change. The appendix
  holds the scripts of tests A and B. The edges that tests C and D measured,
  and the rules of test H, are in
  `packages/core/src/vmaf/size-limits.ffmpeg.test.ts`, which the job
  `native-media` runs: it fails when a limit has moved, and the numbers of
  `packages/core/src/vmaf/size-limits.ts` and of "libvmaf and small pictures"
  are then taken again. No test of the repository holds what tests E to G
  measured ("libvmaf and large or very wide pictures");
- the comparisons of "The GPU scorer and small pictures", when the scorer in
  `native/vmaf-gpu` changes what it compares or what it declares to CAMBI. A
  test of `packages/core` fails when the scorer words a refusal differently;
- the test of x264 with and without AVX-512, when x264 changes; "The VMAF means
  of the media job" names its commands. The names in `x264_cpu_names`
  (`common/cpu.c`) of the new revision are to be held against the rule for a
  name in the media check, `X264_NAME` in
  `apps/worker/src/testing/media-smoke.ts` and in `scripts/media-smoke.mjs`: the
  check fails on a report with a name that the rule does not take, or with
  more than 32 names;
- the upstream commits after each new pin, as in "Upstream fixes after the
  pinned revisions".

The capability lists, the small-picture tests A and B and the test of x264 can
be repeated with this file and the repository, and the repository's test runs
the edges of tests C and D and the rules of test H. The comparison of "What
was confirmed to be the same" and the check on a real GPU cannot: their sample
files and scripts are kept with the research records, outside the repository,
and so are the scripts and the result tables of tests C to H and of "The GPU
scorer and small pictures".

### History

| Date (UTC) | Commit | What happened |
|---|---|---|
| 2026-11-11 18:08 | `61c086e9` | PR #108 merged: the image build fails when FFmpeg cannot score with a bundled VMAF model |
| 2026-11-11 18:36 | `87e70e9b` | PR #109 merged: the image compiles FFmpeg from pinned sources |
| 2026-11-11 19:06 | `22498424` | PR #110 merged; the CI log of this record is the job `native-media` of its CI run, 19:06 to 19:19 |
| 2026-11-11 23:27 | | The results of small-picture test A were written |
| 2026-11-11 23:35 | `451ce7e6` | PR #111 merged |
| 2026-11-11 23:45 | | The results of small-picture test B were written |
| 2026-11-11 23:53 | | The arm64 log of this record was written |
| 2026-11-12 01:02 to 01:06 | | The check on a real NVIDIA GPU |
| 2026-11-12 02:29 to 02:57 | `334b4e0f` | The first runs of PR #112: three native builds with the SHA-256 of the emulated build, then three runs that reused one of them |
| 2026-11-12 04:21 to 05:23 | `47025a92` | Runs of the second commit of PR #112: three native builds, then three runs that reused one of them |
| 2026-11-12 06:01 to 06:23 | `be4d3ddb` | Runs of the third commit of PR #112; its three jobs that need FFmpeg reused the build of the second in their first attempt, from 06:01 to 06:08 |
| 2026-11-12 06:53 to 07:22 | `4ae4c43b` | The runs of PR #112 that "How CI obtains this build" records |
| 2026-11-12 07:27 to 07:36 | | The test of x264 with and without AVX-512 on the host of the GPU check |
| 2026-11-12 07:32 | `42e5d926` | PR #112 merged: CI reuses a kept build of the same sources, and a weekly workflow compiles the sources and builds the whole image; this record describes `Dockerfile` at this commit |
| 2026-11-12 07:32 to 07:51 | `42e5d926` | The first runs on `main` after PR #112: three native builds, of which `native-media` stored its build for `main`; and the first run of the workflow "FFmpeg from source" |
| 2026-11-12 07:54 to 08:17 | `3b5edb98` | The runs of the first commit of PR #114, which added this record; its three jobs that need FFmpeg restored the entry of `main` |
| 2026-11-12 08:34 to 08:48 | `a403ff35` | The runs of the second commit of PR #114; the same entry of `main`, and the other set of VMAF means |
| 2026-11-12 08:54 to 08:57 | `a403ff35` | The media check on an arm64 host, with the worker image built from `Dockerfile` |
| 2026-11-12 11:37 to 11:39 | | The media check with the change of PR #116 on the same arm64 host, from the tree that was committed as `c1812e8d` at 11:41: the same means, and x264's report |
| 2026-11-12 11:42 to 12:23 | `c1812e8d` | Seven runs of the job `media-smoke` for the first commit of PR #116, whose check prints what x264 reports that it uses of the processor: two with AVX-512 and set A, five without and set B |
| 2026-11-12 11:46 | | The results of small-picture test C were written |
| 2026-11-12 12:14 | | The results of small-picture test D were written |
| 2026-11-12 13:09 to 13:30 | `c6650ebc` | The first runs of PR #117, which names libvmaf's size limits in the worker's errors: the job `native-media` ran the test of the limits on x86-64 with the build that `main` had stored |
| 2026-11-12 14:06 | | The results of test E, on CAMBI's upper limit and on very wide pictures, were written |
| 2026-11-12 14:09 | | The results of test F, on the smallest pictures of the `vmaf_v0.6.1` models and on the feature that the crash on very wide pictures comes with, were written |
| 2026-11-12 14:16 | | The results of test G, on CAMBI's refusals with libvmaf's worker threads, were written |
| 2026-11-12 20:33 to 20:38 | | The first 50 comparisons of "The GPU scorer and small pictures", on the host of the GPU check |
| 2026-11-12 22:45 | | The other 21 comparisons of that section, with encodes smaller than their reference |
| 2026-11-12 22:49 to 23:05 | | The results of test H, on the encode's pixel format in the method of test A, were written |

PR #108 added `docker/vmaf-build-proof.sh`. `Dockerfile` and the directory
`docker/` are the same at `87e70e9b` and at `42e5d926`. PR #112 changed
`scripts/native-media-tools.sh`: it added `--cache`, and the lines that say
whether FFmpeg was built or reused and that give the SHA-256 of the programs.

## Appendix

### Debian packages of the toolchain step

Both builds installed 98 packages (CI #27, arm64 #25). These 96 have the same
name and the same version in both logs:

```text
autoconf=2.71-3 automake=1:1.16.5-1.3 autotools-dev=20220109.1 binutils=2.40-2 binutils-common=2.40-2 cmake=3.25.1-1
cmake-data=3.25.1-1 cpp=4:12.2.0-3 cpp-12=12.2.0-14+deb12u1 file=1:5.44-3 g++=4:12.2.0-3 g++-12=12.2.0-14+deb12u1
gcc=4:12.2.0-3 gcc-12=12.2.0-14+deb12u1 gperf=3.1-1 libarchive13=3.6.2-1+deb12u5 libasan8=12.2.0-14+deb12u1
libatomic1=12.2.0-14+deb12u1 libbinutils=2.40-2 libbrotli1=1.0.9-2+deb12u1 libc-dev-bin=2.36-9+deb12u14
libc6-dev=2.36-9+deb12u14 libcc1-0=12.2.0-14+deb12u1 libcrypt-dev=1:4.4.33-2 libctf-nobfd0=2.40-2 libctf0=2.40-2
libcurl4=7.88.1-10+deb12u15 libexpat1=2.5.0-1+deb12u5 libgcc-12-dev=12.2.0-14+deb12u1 libgdbm-compat4=1.23-3
libgdbm6=1.23-3 libgomp1=12.2.0-14+deb12u1 libgprofng0=2.40-2 libgssapi-krb5-2=1.20.1-2+deb12u5
libicu72=72.1-3+deb12u1 libisl23=0.25-1.1 libitm1=12.2.0-14+deb12u1 libjansson4=2.14-2 libjsoncpp25=1.9.5-4
libk5crypto3=1.20.1-2+deb12u5 libkeyutils1=1.6.3-2 libkrb5-3=1.20.1-2+deb12u5 libkrb5support0=1.20.1-2+deb12u5
libldap-2.5-0=2.5.13+dfsg-5 liblsan0=12.2.0-14+deb12u1 libmagic-mgc=1:5.44-3 libmagic1=1:5.44-3 libmpc3=1.3.1-1
libmpfr6=4.2.0-1 libncursesw6=6.4-4 libnghttp2-14=1.52.0-1+deb12u3 libnsl-dev=1.3.0-2 libnsl2=1.3.0-2
libperl5.36=5.36.0-7+deb12u4 libpkgconf3=1.8.1-1 libproc2-0=2:4.0.2-3 libpsl5=0.21.2-1 libpython3-stdlib=3.11.2-1+b1
libpython3.11-minimal=3.11.2-6+deb12u9 libpython3.11-stdlib=3.11.2-6+deb12u9 libreadline8=8.2-1.3 librhash0=1.4.3-3
librtmp1=2.4+20151223.gitfa8646d.1-2+b2 libsasl2-2=2.1.28+dfsg-10+deb12u1 libsasl2-modules-db=2.1.28+dfsg-10+deb12u1
libsqlite3-0=3.40.1-2+deb12u2 libssh2-1=1.10.0-3+deb12u1 libssl3=3.0.22-1~deb12u2 libstdc++-12-dev=12.2.0-14+deb12u1
libtirpc-common=1.3.3+ds-1 libtirpc-dev=1.3.3+ds-1 libtirpc3=1.3.3+ds-1 libtool=2.4.7-7~deb12u1
libtsan2=12.2.0-14+deb12u1 libubsan1=12.2.0-14+deb12u1 libuv1=1.44.2-1+deb12u1 libxml2=2.9.14+dfsg-1.3~deb12u6
linux-libc-dev=6.1.190-1 m4=1.4.19-3 make=4.3-4.1 media-types=10.0.0 nasm=2.16.01-1 ninja-build=1.11.1-2~deb12u1
perl=5.36.0-7+deb12u4 perl-modules-5.36=5.36.0-7+deb12u4 pkg-config=1.8.1-1 pkgconf=1.8.1-1 pkgconf-bin=1.8.1-1
procps=2:4.0.2-3 python3=3.11.2-1+b1 python3-minimal=3.11.2-1+b1 python3.11=3.11.2-6+deb12u9
python3.11-minimal=3.11.2-6+deb12u9 readline-common=8.2-1.3 rpcsvc-proto=1.4.3-1 xxd=2:9.0.1378-2+deb12u2
```

Only in the CI log, on x86-64:

```text
binutils-x86-64-linux-gnu=2.40-2 libquadmath0=12.2.0-14+deb12u1
```

Only in the arm64 log:

```text
binutils-aarch64-linux-gnu=2.40-2 libhwasan0=12.2.0-14+deb12u1
```

### Components in FFmpeg's configure summary

The lists are those of the CI log (CI #67), sorted by name. The arm64 log
(arm64 #65) has the same names in every list.

The 522 decoders:

```text
aac aac_fixed aac_latm aasc ac3 ac3_fixed acelp_kelvin adpcm_4xm adpcm_adx adpcm_afc adpcm_agm adpcm_aica adpcm_argo
adpcm_circus adpcm_ct adpcm_dtk adpcm_ea adpcm_ea_maxis_xa adpcm_ea_r1 adpcm_ea_r2 adpcm_ea_r3 adpcm_ea_xas adpcm_g722
adpcm_g726 adpcm_g726le adpcm_ima_acorn adpcm_ima_alp adpcm_ima_amv adpcm_ima_apc adpcm_ima_apm adpcm_ima_cunning
adpcm_ima_dat4 adpcm_ima_dk3 adpcm_ima_dk4 adpcm_ima_ea_eacs adpcm_ima_ea_sead adpcm_ima_escape adpcm_ima_hvqm2
adpcm_ima_hvqm4 adpcm_ima_iss adpcm_ima_magix adpcm_ima_moflex adpcm_ima_mtf adpcm_ima_oki adpcm_ima_pda adpcm_ima_qt
adpcm_ima_rad adpcm_ima_smjpeg adpcm_ima_ssi adpcm_ima_wav adpcm_ima_ws adpcm_ima_xbox adpcm_ms adpcm_mtaf adpcm_n64
adpcm_psx adpcm_psxc adpcm_sanyo adpcm_sbpro_2 adpcm_sbpro_3 adpcm_sbpro_4 adpcm_swf adpcm_thp adpcm_thp_le adpcm_vima
adpcm_xa adpcm_xmd adpcm_yamaha adpcm_zork agm ahx aic alac alias_pix als amrnb amrwb amv anm ansi anull apac ape apng
aptx aptx_hd apv arbc argo ass asv1 asv2 atrac1 atrac3 atrac3al atrac3p atrac3pal atrac9 aura aura2 av1 av1_cuvid avrn
avrp avs avui bethsoftvid bfi bink binkaudio_dct binkaudio_rdft bintext bitpacked bmp bmv_audio bmv_video bonk
brender_pix c93 cavs cbd2_dpcm ccaption cdgraphics cdtoons cdxl cfhd cinepak clearvideo cljr cllc comfortnoise cook
cpia cri cscd cyuv dca dds derf_dpcm dfa dfpwm dirac dnxhd dolby_e dpx dsd_lsbf dsd_lsbf_planar dsd_msbf
dsd_msbf_planar dsicinaudio dsicinvideo dss_sp dst dvaudio dvbsub dvdsub dvvideo dxa dxtory dxv eac3 eacmv eamad eatgq
eatgv eatqi eightbps eightsvx_exp eightsvx_fib escape124 escape130 evrc exr fastaudio ffv1 ffvhuff ffwavesynth fic
fits flac flashsv flashsv2 flic flv fmvc fourxm fraps frwu ftr g2m g723_1 g728 g729 gdv gem gif gremlin_dpcm gsm
gsm_ms h261 h263 h263i h263p h264 h264_cuvid hap hca hcom hdr hevc hevc_cuvid hnm4_video hq_hqa hqx huffyuv hymt iac
idcin idf iff_ilbm ilbc imc imm4 imm5 indeo2 indeo3 indeo4 indeo5 interplay_acm interplay_dpcm interplay_video ipu
jacosub jpeg2000 jpegls jv kgv1 kmvc lagarith lead libdav1d loco lscr m101 mace3 mace6 magicyuv mdec media100
metasound microdvd mimic misc4 mjpeg mjpeg_cuvid mjpegb mlp mmvideo mobiclip motionpixels movtext mp1 mp1float mp2
mp2float mp3 mp3adu mp3adufloat mp3float mp3on4 mp3on4float mpc7 mpc8 mpeg1_cuvid mpeg1video mpeg2_cuvid mpeg2video
mpeg4 mpeg4_cuvid mpegvideo mpl2 msa1 mscc msmpeg4v1 msmpeg4v2 msmpeg4v3 msnsiren msp2 msrle mss1 mss2 msvideo1 mszh
mts2 mv30 mvc1 mvc2 mvdv mvha mwsc mxpeg nellymoser notchlc nuv on2avc opus osq paf_audio paf_video pam pbm pcm_alaw
pcm_bluray pcm_dvd pcm_f16le pcm_f24le pcm_f32be pcm_f32le pcm_f64be pcm_f64le pcm_lxf pcm_mulaw pcm_s16be
pcm_s16be_planar pcm_s16le pcm_s16le_planar pcm_s24be pcm_s24daud pcm_s24le pcm_s24le_planar pcm_s32be pcm_s32le
pcm_s32le_planar pcm_s64be pcm_s64le pcm_s8 pcm_s8_planar pcm_sga pcm_u16be pcm_u16le pcm_u24be pcm_u24le pcm_u32be
pcm_u32le pcm_u8 pcm_vidc pcx pdv pfm pgm pgmyuv pgssub pgx phm photocd pictor pixlet pjs png ppm prores prores_raw
prosumer psd ptx qcelp qdm2 qdmc qdraw qoa qoi qpeg qtrle r10k r210 ra_144 ra_288 ralf rasc rawvideo realtext rka rl2
roq roq_dpcm rpza rscc rtv1 rv10 rv20 rv30 rv40 rv60 s302m sami sanm sbc scpr screenpresso sdx2_dpcm sga sgi sgirle
sheervideo shorten simbiosis_imx sipr siren smackaud smacker smc smvjpeg snow sol_dpcm sonic sp5x speedhq speex srgc
srt ssa stl subrip subviewer subviewer1 sunrast svq1 svq3 tak targa targa_y216 tdsc text theora thp tiertexseqvideo
tiff tmv truehd truemotion1 truemotion2 truemotion2rt truespeech tscc tscc2 tta twinvq txd ulti utvideo v210 v210x
v308 v408 v410 vb vble vbn vc1 vc1_cuvid vc1image vcr1 vmdaudio vmdvideo vmix vmnc vnull vorbis vp3 vp4 vp5 vp6 vp6a
vp6f vp7 vp8 vp8_cuvid vp9 vp9_cuvid vplayer vqa vqc vvc wady_dpcm wavarc wavpack wbmp wcmv webp webvtt wmalossless
wmapro wmav1 wmav2 wmavoice wmv1 wmv2 wmv3 wmv3image wnv1 wrapped_avframe ws_snd1 xan_dpcm xan_wc3 xan_wc4 xbin xbm
xface xl xma1 xma2 xpm xsub xwd y41p ylc yop yuv4 zero12v zerocodec zlib zmbv
```

The 182 encoders:

```text
a64multi a64multi5 aac ac3 ac3_fixed adpcm_adx adpcm_argo adpcm_g722 adpcm_g726 adpcm_g726le adpcm_ima_alp
adpcm_ima_amv adpcm_ima_apm adpcm_ima_qt adpcm_ima_ssi adpcm_ima_wav adpcm_ima_ws adpcm_ms adpcm_swf adpcm_yamaha alac
alias_pix amv anull apng aptx aptx_hd ass asv1 asv2 av1_nvenc avrp avui bitpacked bmp cfhd cinepak cljr comfortnoise
dca dfpwm dnxhd dpx dvbsub dvdsub dvvideo dxv eac3 exr ffv1 ffvhuff fits flac flashsv flashsv2 flv g723_1 gif h261
h263 h263p h264_nvenc hdr hevc_nvenc huffyuv jpeg2000 jpegls libsvtav1 libx264 libx264rgb ljpeg magicyuv mjpeg mlp
movtext mp2 mp2fixed mpeg1video mpeg2video mpeg4 msmpeg4v2 msmpeg4v3 msrle msvideo1 nellymoser opus pam pbm pcm_alaw
pcm_bluray pcm_dvd pcm_f32be pcm_f32le pcm_f64be pcm_f64le pcm_mulaw pcm_s16be pcm_s16be_planar pcm_s16le
pcm_s16le_planar pcm_s24be pcm_s24daud pcm_s24le pcm_s24le_planar pcm_s32be pcm_s32le pcm_s32le_planar pcm_s64be
pcm_s64le pcm_s8 pcm_s8_planar pcm_u16be pcm_u16le pcm_u24be pcm_u24le pcm_u32be pcm_u32le pcm_u8 pcm_vidc pcx pfm pgm
pgmyuv phm png ppm prores prores_aw prores_ks qoi qtrle r10k r210 ra_144 rawvideo roq roq_dpcm rpza rv10 rv20 s302m
sbc sgi smc snow speedhq srt ssa subrip sunrast svq1 targa text tiff truehd tta ttml utvideo v210 v308 v408 v410 vbn
vc2 vnull vorbis wavpack wbmp webvtt wmav1 wmav2 wmv1 wmv2 wrapped_avframe xbm xface xsub xwd y41p yuv4 zlib zmbv
```

The 68 parsers:

```text
aac aac_latm ac3 adx ahx amr apv av1 avs2 avs3 bmp cavsvideo cook cri dca dirac dnxhd dnxuc dolby_e dpx dvaudio dvbsub
dvd_nav dvdsub evc ffv1 flac ftr g723_1 g729 gif gsm h261 h263 h264 hdr hevc ipu jpeg2000 jpegxl jpegxs lcevc misc4
mjpeg mlp mpeg4video mpegaudio mpegvideo opus png pnm prores prores_raw qoi rv34 sbc sipr tak vc1 vorbis vp3 vp8 vp9
vvc webp xbm xma xwd
```

The 360 demuxers:

```text
aa aac aax ac3 ac4 ace acm act adf adp ads adx aea afc aiff aix alp amr amrnb amrwb anm apac apc ape apm apng aptx
aptx_hd apv aqtitle argo_asf argo_brp argo_cvg asf asf_o ass ast au av1 avi avr avs avs2 avs3 bethsoftvid bfi bfstm
bink binka bintext bit bitpacked bmv boa bonk brstm c93 caf cavsvideo cdg cdxl cine codec2 codec2raw concat dash data
daud dcstr derf dfa dfpwm dhav dirac dnxhd dsf dsicin dss dts dtshd dv dvbsub dvbtxt dxa ea ea_cdata eac3 epaf evc
ffmetadata filmstrip fits flac flic flv fourxm frm fsb fwse g722 g723_1 g726 g726le g728 g729 gdv genh gif gsm gxf
h261 h263 h264 hca hcom hevc hls hnm hxvs iamf ico idcin idf iff ifv ilbc image2 image2_alias_pix image2_brender_pix
image2pipe image_bmp_pipe image_cri_pipe image_dds_pipe image_dpx_pipe image_exr_pipe image_gem_pipe image_gif_pipe
image_hdr_pipe image_j2k_pipe image_jpeg_pipe image_jpegls_pipe image_jpegxl_pipe image_jpegxs_pipe image_pam_pipe
image_pbm_pipe image_pcx_pipe image_pfm_pipe image_pgm_pipe image_pgmyuv_pipe image_pgx_pipe image_phm_pipe
image_photocd_pipe image_pictor_pipe image_png_pipe image_ppm_pipe image_psd_pipe image_qdraw_pipe image_qoi_pipe
image_sgi_pipe image_sunrast_pipe image_svg_pipe image_tiff_pipe image_vbn_pipe image_webp_pipe image_xbm_pipe
image_xpm_pipe image_xwd_pipe imf ingenient ipmovie ipu ircam iss iv8 ivf ivr jacosub jpegxl_anim jv kux kvag laf lc3
live_flv lmlm4 loas lrc luodat lvf lxf m4v matroska mca mcc mgsts microdvd mjpeg mjpeg_2000 mlp mlv mm mmf mods moflex
mov mp3 mpc mpc8 mpegps mpegts mpegtsraw mpegvideo mpjpeg mpl2 mpsub msf msnwc_tcp msp mtaf mtv musx mv mvi mxf mxg nc
nistsphere nsp nsv nut nuv obu ogg oma osq paf pcm_alaw pcm_f32be pcm_f32le pcm_f64be pcm_f64le pcm_mulaw pcm_s16be
pcm_s16le pcm_s24be pcm_s24le pcm_s32be pcm_s32le pcm_s8 pcm_u16be pcm_u16le pcm_u24be pcm_u24le pcm_u32be pcm_u32le
pcm_u8 pcm_vidc pdv pjs pmp pp_bnk pva pvf qcp qoa r3d rawvideo rcwt realtext redspark rka rl2 rm roq rpl rsd rso rtp
rtsp s337m sami sap sbc sbg scc scd sdns sdp sdr2 sds sdx segafilm ser sga shorten siff simbiosis_imx sln smacker
smjpeg smush sol sox spdif srt stl str subviewer subviewer1 sup svag svs swf tak tedcaptions thp threedostr tiertexseq
tmv truehd tta tty txd ty usm v210 v210x vag vc1 vc1t vividas vivo vmd vobsub voc vpk vplayer vqf vvc w64 wady wav
wavarc wc3 webm_dash_manifest webvtt wsaud wsd wsvqa wtv wv wve xa xbin xmd xmv xvag xwma yop yuv4mpegpipe
```

The 183 muxers:

```text
a64 ac3 ac4 adts adx aea aiff alp amr amv apm apng aptx aptx_hd apv argo_asf argo_cvg asf asf_stream ass ast au avi
avif avm2 avs2 avs3 bit caf cavsvideo codec2 codec2raw crc dash data daud dfpwm dirac dnxhd dts dv eac3 evc f4v
ffmetadata fifo filmstrip fits flac flv framecrc framehash framemd5 g722 g723_1 g726 g726le gif gsm gxf h261 h263 h264
hash hds hevc hls iamf ico ilbc image2 image2pipe ipod ircam ismv ivf jacosub kvag latm lc3 lrc m4v matroska
matroska_audio mcc md5 microdvd mjpeg mkvtimestamp_v2 mlp mmf mov mp2 mp3 mp4 mpeg1system mpeg1vcd mpeg1video mpeg2dvd
mpeg2svcd mpeg2video mpeg2vob mpegts mpjpeg mxf mxf_d10 mxf_opatom null nut obu oga ogg ogv oma opus pcm_alaw
pcm_f32be pcm_f32le pcm_f64be pcm_f64le pcm_mulaw pcm_s16be pcm_s16le pcm_s24be pcm_s24le pcm_s32be pcm_s32le pcm_s8
pcm_u16be pcm_u16le pcm_u24be pcm_u24le pcm_u32be pcm_u32le pcm_u8 pcm_vidc psp rawvideo rcwt rm roq rso rtp
rtp_mpegts rtsp sap sbc scc segafilm segment smjpeg smoothstreaming sox spdif spx srt stream_segment streamhash sup
swf tee tg2 tgp truehd tta ttml uncodedframecrc vc1 vc1t voc vvc w64 wav webm webm_chunk webm_dash_manifest webp
webvtt whip wsaud wtv wv yuv4mpegpipe
```

The 476 filters:

```text
a3dscope aap abench abitscope acompressor acontrast acopy acrossfade acrossover acrusher acue addroi adeclick adeclip
adecorrelate adelay adenorm aderivative adrawgraph adrc adynamicequalizer adynamicsmooth aecho aemphasis aeval
aevalsrc aexciter afade afdelaysrc afftdn afftfilt afir afireqsrc afirsrc aformat afreqshift afwtdn agate
agraphmonitor ahistogram aiir aintegral ainterleave alatency alimiter allpass allrgb allyuv aloop alphaextract
alphamerge amerge ametadata amix amovie amplify amultiply anequalizer anlmdn anlmf anlms anoisesrc anull anullsink
anullsrc apad aperms aphasemeter aphaser aphaseshift apsnr apsyclip apulsator arealtime aresample areverse arls arnndn
asdr asegment aselect asendcmd asetnsamples asetpts asetrate asettb ashowinfo asidedata asisdr asoftclip
aspectralstats asplit ass astats astreamselect asubboost asubcut asupercut asuperpass asuperstop atadenoise atempo
atilt atrim avectorscope avgblur avsynctest axcorrelate backgroundkey bandpass bandreject bass bbox bench bilateral
biquad bitplanenoise blackdetect blackframe blend blockdetect blurdetect bm3d boxblur bwdif cas ccrepack cellauto
channelmap channelsplit chorus chromahold chromakey chromanr chromashift ciescope codecview color colorbalance
colorchannelmixer colorchart colorcontrast colorcorrect colordetect colorhold colorize colorkey colorlevels colormap
colormatrix colorspace colorspectrum colortemperature compand compensationdelay concat convolution convolve copy corr
cover_rect crop cropdetect crossfeed crystalizer cue curves datascope dblur dcshift dctdnoiz deband deblock decimate
deconvolve dedot deesser deflate deflicker dejudder delogo deshake despill detelecine dialoguenhance dilation displace
doubleweave drawbox drawgraph drawgrid drawtext drmeter dynaudnorm earwax ebur128 edgedetect elbg entropy epx eq
equalizer erosion estdif exposure extractplanes extrastereo fade feedback fftdnoiz fftfilt field fieldhint fieldmatch
fieldorder fillborders find_rect firequalizer flanger floodfill format fps framepack framerate framestep freezedetect
freezeframes fspp fsync gblur geq gradfun gradients graphmonitor grayworld greyedge guided haas haldclut haldclutsrc
hdcd headphone hflip highpass highshelf hilbert histeq histogram hqdn3d hqx hstack hsvhold hsvkey hue huesaturation
hwdownload hwmap hwupload hwupload_cuda hysteresis identity idet il inflate interlace interleave join kerndeint kirsch
lagfun latency lenscorrection libvmaf life limitdiff limiter loop loudnorm lowpass lowshelf lumakey lut lut1d lut2
lut3d lutrgb lutyuv mandelbrot maskedclamp maskedmax maskedmerge maskedmin maskedthreshold maskfun mcdeint mcompand
median mergeplanes mestimate metadata midequalizer minterpolate mix monochrome morpho movie mpdecimate mptestsrc msad
multiply negate nlmeans nnedi noformat noise normalize null nullsink nullsrc oscilloscope overlay owdenoise pad
pal100bars pal75bars palettegen paletteuse pan perlin perms perspective phase photosensitivity pixdesctest pixelize
pixscope pp7 premultiply premultiply_dynamic prewitt pseudocolor psnr pullup qp random readeia608 readvitc realtime
remap removegrain removelogo repeatfields replaygain reverse rgbashift rgbtestsrc roberts rotate sab scale scale2ref
scdet scharr scroll segment select selectivecolor sendcmd separatefields setdar setfield setparams setpts setrange
setsar settb shear showcqt showcwt showfreqs showinfo showpalette showspatial showspectrum showspectrumpic showvolume
showwaves showwavespic shuffleframes shufflepixels shuffleplanes sidechaincompress sidechaingate sidedata sierpinski
signalstats signature silencedetect silenceremove sinc sine siti smartblur smptebars smptehdbars sobel spectrumsynth
speechnorm split spp ssim ssim360 stereo3d stereotools stereowiden streamselect subtitles super2xsai superequalizer
surround swaprect swapuv tblend telecine testsrc testsrc2 thistogram threshold thumbnail tile tiltandshift tiltshelf
tinterlace tlut2 tmedian tmidequalizer tmix tonemap tpad transpose treble tremolo trim unpremultiply unsharp untile
uspp v360 vaguedenoiser varblur vectorscope vflip vfrdet vibrance vibrato vif vignette virtualbass vmafmotion volume
volumedetect vstack w3fdif waveform weave xbr xcorrelate xfade xmedian xpsnr xstack yadif yaepblur yuvtestsrc
zoneplate zoompan
```

### Scripts of the measurements

The capability lists were written by this script, `caps.sh`:

```sh
#!/bin/sh
# Writes one sorted list per kind of component that an FFmpeg build offers.
#   sh caps.sh <ffmpeg> <new or empty output directory>
set -eu
ff=${1:?}; out=${2:?}
mkdir -p "$out"
"$ff" -hide_banner -buildconf | tr -s ' \n' '\n' | grep -E '^--' | sort > "$out/configure"
for kind in decoders encoders; do
  "$ff" -hide_banner "-$kind" | sed '1,/^ *-\{3,\}$/d' | awk '{print $2}' | sort > "$out/$kind"
done
for kind in demuxers muxers; do
  "$ff" -hide_banner "-$kind" | sed '1,/^ *-\{2,\}$/d' | awk '{print $2}' | tr ',' '\n' | sort -u > "$out/$kind"
done
"$ff" -hide_banner -filters | awk '$3 ~ /->/ {print $2}' | sort > "$out/filters"
"$ff" -hide_banner -bsfs | sed 1d | sort > "$out/bsfs"
"$ff" -hide_banner -hwaccels | sed 1d | grep -v '^$' | sort > "$out/hwaccels"
"$ff" -hide_banner -protocols | awk '/^Input:/{d="in"; next} /^Output:/{d="out"; next} NF{print d":"$1}' | sort > "$out/protocols"
"$ff" -hide_banner -pix_fmts | sed '1,/^-\{3,\}/d' | awk '{print $2}' | sort > "$out/pix_fmts"
for f in "$out"/*; do printf '%-10s %s\n' "$(basename "$f")" "$(wc -l < "$f" | tr -d ' ')"; done
```

The two small-picture tests ran in a container of the base image, with the
programs, the models and the scripts mounted read-only. Test A was started with
this command, and test B in the same way with `matrix-b.sh`:

```sh
docker run --rm --network none \
  -v <directory of the arm64 build>:/ff:ro -v <directory of the models>:/models:ro \
  -v <directory of the scripts>:/scripts:ro -v <output directory>:/out \
  node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c \
  sh /scripts/matrix-a.sh /ff/bin/ffmpeg /models /out
```

The directory of the models holds the fourteen model files and nothing else:
`matrix-a.sh` takes every file there as a model.

Each script prints one line for every case: the model, the sizes, FFmpeg's
status, the number of frames that were scored, the mean, and the first lines of
an error.

Test A, `matrix-a.sh`:

```sh
#!/bin/sh
# Test A: both pictures at the same small size, 8-bit 4:2:0, the product's
# ordinary command shape (generation 3). One line per model and size:
#   model size status frames mean error
# sh matrix-a.sh <ffmpeg> <model directory> <output directory>
ff=$1; models=$2; out=$3
mkdir -p "$out/logs"
sizes="64x36 96x54 128x72 144x144 160x90 160x120 160x160 176x144 192x108 214x120 216x100 216x122 216x216 240x136 256x144 264x148 266x150 284x160 316x178 318x180 320x180 320x240 352x288 384x216 400x100 100x400 426x240 480x270 640x360"
for model in $(ls "$models" | sed 's/\.json$//'); do
  for size in $sizes; do
    log=$out/logs/a-$model-$size.json
    err=$out/logs/a-$model-$size.err
    rm -f "$log"
    "$ff" -hide_banner -nostdin \
      -f lavfi -i "testsrc2=size=$size:rate=25:duration=0.4,gblur=sigma=1.5,format=yuv420p" \
      -f lavfi -i "testsrc2=size=$size:rate=25:duration=0.4,format=yuv420p" \
      -filter_complex "[0:v]settb=AVTB,setpts=N/FRAME_RATE/TB[dist];[1:v]settb=AVTB,setpts=N/FRAME_RATE/TB[ref];[dist][ref]libvmaf=model=path=$models/$model.json:log_path=$log:log_fmt=json[out]" \
      -map "[out]" -f null - >"$err" 2>&1
    status=$?
    frames=-; mean=-
    if [ -s "$log" ]; then
      frames=$(grep -c '"frameNum"' "$log")
      mean=$(tr -d '\n' <"$log" | sed -n 's/.*"pooled_metrics".*"vmaf": *{[^}]*"mean": *\([-0-9.a-zA-Z]*\).*/\1/p')
    fi
    message=$(grep -i -E "too small|invalid argument|error|failed|problem|nan" "$err" | grep -v -i "^\[Parsed_" | head -2 | tr '\n' '|' | cut -c1-200)
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$model" "$size" "$status" "$frames" "${mean:--}" "$message"
  done
done
```

Test B, `matrix-b.sh`:

```sh
#!/bin/sh
# Test B: the product's frame-index method (generation 6) with a v1 model.
# Both pictures are scaled to the canvas in 10 bits; the encoded size of the
# distorted picture goes to CAMBI. One line per case:
#   model canvas encoded status frames mean error
# sh matrix-b.sh <ffmpeg> <model directory> <output directory>
ff=$1; models=$2; out=$3
mkdir -p "$out/logs"
run() {
  model=$1; canvas=$2; enc=$3
  cw=${canvas%x*}; ch=${canvas#*x}; ew=${enc%x*}; eh=${enc#*x}
  log=$out/logs/b-$model-$canvas-$enc.json
  err=$out/logs/b-$model-$canvas-$enc.err
  rm -f "$log"
  leg="setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709,scale=$cw:$ch:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=tv,format=yuv420p10le,setsar=1,settb=AVTB,setpts=N/(25/1)/TB"
  "$ff" -hide_banner -nostdin -threads 2 -apply_cropping codec \
    -f lavfi -i "testsrc2=size=$enc:rate=25:duration=0.2,gblur=sigma=1,format=yuv420p" \
    -threads 2 -apply_cropping codec \
    -f lavfi -i "testsrc2=size=$canvas:rate=25:duration=0.2,format=yuv420p" \
    -filter_complex_threads 1 \
    -filter_complex "[0:v:0]${leg}[dist];[1:v:0]${leg}[ref];[dist][ref]libvmaf=model='path=$models/$model.json\\:cambi.enc_width=$ew\\:cambi.enc_height=$eh\\:cambi.enc_bitdepth=8':log_fmt=json:log_path=$log:n_subsample=1:eof_action=endall:shortest=1:repeatlast=0[out]" \
    -map "[out]" -an -sn -f null - >"$err" 2>&1
  status=$?
  frames=-; mean=-
  if [ -s "$log" ]; then
    frames=$(grep -c '"frameNum"' "$log")
    mean=$(tr -d '\n' <"$log" | sed -n 's/.*"pooled_metrics".*"vmaf": *{[^}]*"mean": *\([-0-9.a-zA-Z]*\).*/\1/p')
  fi
  message=$(grep -i -E "too small|invalid argument|error|failed|problem|Segmentation" "$err" | head -2 | tr '\n' '|' | cut -c1-160)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$model" "$canvas" "$enc" "$status" "$frames" "${mean:--}" "$message"
}
# A 1080p reference with ever smaller encodes.
for enc in 1920x1080 1280x720 640x360 384x216 320x180 256x144 216x122 214x120 192x108 160x90 128x72 108x192 216x384; do
  run vmaf_v1.0.16_3d0h 1920x1080 "$enc"
done
run vmaf_v1.0.16_3d0h_2160 3840x2160 192x108
run vmaf_v1.0.16_3d0h_2160 3840x2160 256x144
# Small references, the encode as large as the reference.
for canvas in 640x360 480x270 426x240 384x216 320x180 256x144 192x108; do
  for model in vmaf_v1.0.16_3d0h vmaf_v1.0.16_5d0h vmaf_v1.0.16_3d0h_2160 vmaf_v1.0.16_1d5h_2160; do
    run "$model" "$canvas" "$canvas"
  done
done
```

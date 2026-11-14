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
  FFmpeg's output. The check changes no command and no score. It is made
  before a comparison that the GPU scorer runs as well, for 4:2:0 pictures and
  with no declared encode: "The GPU scorer and small pictures" below says why.
  It knows the limits of this section and not those of "libvmaf and large or
  very wide pictures".
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
the worker started it on that day, with `vmaf_v1.0.16_3d0h`,
`vmaf_v1.0.16_5d0h` and `vmaf_v1.0.16_3d0h_2160`. It scored 22 and refused 49.
Two things differed from the worker's command for libvmaf:

- The scorer compared every pair in 4:2:0, whatever the two formats were. It
  refused a `yuv444p` reference of 256x144 with all three models. libvmaf
  scored that reference with `vmaf_v1.0.16_3d0h` and `vmaf_v1.0.16_5d0h` in the
  method of test A.
- The scorer declared the encode's own size to CAMBI in every run, as the
  method of test B does and that of test A does not. With a reference of
  640x360 it scored encodes of 256x144 and 216x144 and refused encodes of
  214x144, 200x200, 144x144, 240x134 and 142x256, each with all three models.
  libvmaf scored all seven with all three models in the method of test A.

With these two, the rules of "libvmaf and small pictures" for 4:2:0 pictures
and for a declared encode said for each of the 71 comparisons whether the
scorer scored it. The comparisons were pairs of one size, from 16x16 to 320x180
and 266x266, a reference of 640x360 with an encode of 320x180 and with the
seven encodes above, and a reference of 1920x1080 with encodes of 640x360 to
1920x1080.

The scorer ended a refusal with status 1 and one line, which names no limit:

| Line after `bitovp-vmaf: ` | Refusals | What was too small |
|---|---|---|
| `input is too small or too large for official SpEED chroma blocks` | 20 | the pictures, for SpEED |
| `invalid Vulkan CAMBI encoding geometry` | 11 | the pictures or the encode: both sides below 216 |
| `override official extractor cambi failed (libvmaf -22)` | 18 | the encode: a side below 144 |

The second line names Vulkan and comes from the CUDA backend as well: the two
backends share the code that writes it. The scorer's source holds a fourth
line, `SPEED chroma is too small for its 5 by 5 block after prescale and
decimation` (`vulkan/speed_parameters.hpp`). No run printed it: the check
behind the first line holds the same arithmetic and comes earlier.

Since the change that "GPU scoring and libvmaf through FFmpeg" records, the
scorer declares no encode, and the worker starts it only for pairs that libvmaf
compares in 4:2:0 as well. What is left of the scorer's limits is that of the
pictures, and it is libvmaf's for 4:2:0 pictures. The worker therefore asks its
rule for those pictures before it starts the scorer, as it does before it
starts FFmpeg, and the measurement ends with the same sentence in both. It no
longer waits for the scorer's line, as it did after PR #119, and no sentence
says any more that a limit is that of GPU scoring alone.

The worker's two checks before a GPU run were held against the 71 stored
comparisons. The first is the rule for the pairs that the scorer can compare as
libvmaf does, the second the size of the pictures:

| Comparisons | On 2026-11-12 | The worker's checks now | Local CPU on 2026-11-12 |
|---|---|---|---|
| 22 | scored | both pass | scored all 22 |
| 28 | refused | the size check refuses | scored none |
| 15 | refused | both pass | scored all 15 |
| 6 | refused | the first check refuses | scored 2 |

The 15 are the five small encodes of the 640x360 reference with three models:
the scorer refused them for the declared encode alone. The six are the
`yuv444p` reference and a full-range `yuvj420p` reference of 256x144 with a
`yuv420p` encode, with three models each. Test I below ran the changed scorer's
CPU reference on two small encodes of a 640x360 reference, 128x72 and 144x144:
they scored 8.877257 and 33.212069 with `vmaf_v1.0.16_3d0h`, the means that
FFmpeg's libvmaf gave.

Test J below ran the 71 again on that host, through the worker's code and with
the CUDA and the Vulkan backend of the changed scorer. Each went as the third
column says: the 22 and the 15 were scored, with FFmpeg's mean to within
0.000001, the 28 were refused by the size check, and the six by the first
check.

Not measured in the 71 comparisons of 2026-11-12: the Vulkan backend, a size
above 1920x1080 and a 10-bit encode.

### GPU scoring and libvmaf through FFmpeg

The GPU scorer and the worker's command for libvmaf, the ordinary method, used
to give different scores for one pair. With 8-bit 4:2:0 files the whole
difference was two settings, and both act through CAMBI: the scorer compared
10-bit pictures whatever the reference was, and it declared the size and the
bit depth of the encode before scaling to CAMBI (`enc_width`, `enc_height`,
`enc_bitdepth`). An encode that was scaled up scored 0.96 to 1.50
higher with the scorer in 15 comparisons of 2026-11-12, and with both settings
applied by hand to the ordinary method, libvmaf gave the scorer's mean to
within 0.000001 in ten. The pictures were not the cause: the scorer's own
decoder, compiled alone, wrote pictures with the SHA-256 of FFmpeg's
`scale=W:H:flags=bicubic,format=yuv420p10le` for five pairs.

The worker now tells the scorer the reference's bit depth, the scorer declares
nothing to CAMBI when it scores, and the worker refuses the pairs for which the
scorer's pictures are still not libvmaf's. Scoring generations 12 (CUDA) and 13
(Vulkan) mark the results; generations 9 and 10 are those of the scorer before,
and their rows are not continued. Test I below held the scorer's CPU reference
against libvmaf through FFmpeg, and test J the scorer on two GPUs.

**Test I, 2026-11-13.** The changed scorer was built without a GPU backend, in
a container of `ubuntu:24.04` on arm64, against that distribution's FFmpeg
libraries (6.1.1: libavcodec 60.31.102, libswscale 7.5.100), with its 18 tests
passing. Its CPU reference is libvmaf at the revision that the scorer pins,
`74f930d1`, fed with the pictures of the scorer's own decoder; every GPU run is
checked against it. It was run next to the `linux/arm64` programs of this build
with the command of a **Local CPU** measurement by the ordinary method, on the
same two files, both with four libvmaf threads:

```text
ffmpeg -threads 2 -i <encode> -threads 2 -i <reference> -filter_complex \
  "[0:v]scale=<W>:<H>:flags=bicubic,fps=24,settb=AVTB,setpts=N/FRAME_RATE/TB[dist];[1:v]settb=AVTB,setpts=N/FRAME_RATE/TB[ref];[dist][ref]libvmaf=model=path=<model>:log_path=<log>:log_fmt=json:n_threads=4[out]" \
  -map "[out]" -f null -
bitovp-vmaf --reference <reference> --distorted <encode> --model <id>=<model> --output <receipt> \
  --backend cpu --bit-depth <8 or 10> --width <W> --height <H> --threads 4 --decode-threads 2
```

The `fps` filter is in the command of a VOD measurement whenever the worker
knows the reference's frame rate, with that rate; since 2026-11-14 it is in
the reference's chain as well, and each chain has `setpts=PTS-STARTPTS` before
it ("The reference's frame times"). GPU scoring has no such filter: the scorer
pairs the frames of the two files by their index.
The files were 24 or 48 frames of a moving test pattern over slow gradients,
at 24 frames a second with square pixels. 129 comparisons, with
`vmaf_v1.0.16_3d0h` (110), `vmaf_v1.0.16_5d0h` (12) and
`vmaf_v1.0.16_3d0h_2160` (7):

| Comparisons | Pairs | Result |
|---|---|---|
| 97 | the worker's rule lets them through | the two means are equal to the sixth decimal |
| 22 | the rule refuses them | the means differ by 0.00003 to 13.3 |
| 5 | the rule lets them through; the pictures are 216 or 360 wide | the means differ with four threads, by up to 0.39 over the runs of this test, and are equal with one: see "libvmaf and its thread count" |
| 5 | the rule lets them through; the pictures are too small for the model | neither gives a score |

In every receipt of a scored comparison, CAMBI's options `enc_width`,
`enc_height` and `enc_bitdepth` are `0`. Without the `fps` filter, FFmpeg gave
the same mean over the same number of frames in 120 of the 124 comparisons that
it scored; the other four are pairs of 216 wide pictures, whose means differ
from run to run.

The 97 by what ffprobe says of the two files. The references were H.264 files,
and FFV1 files in nine; 77 were 640x360 with encodes of 128x72 to 640x360, 24
of them of that size, and 20 were pairs of one size from 160x216 to 1920x1080,
five of them higher than wide. 85 encodes were H.264, five AV1 and seven FFV1.
"Limited" is a file that names the range `tv` or none. ffprobe names an 8-bit
full-range file `yuvj420p` when it is H.264, and `yuv420p` with the range `pc`
when it is AV1 or FFV1.

| Reference | Encode | Bit depth | Comparisons |
|---|---|---|---|
| `yuv420p`, limited | `yuv420p`, limited | 8 | 47 |
| `yuv420p`, limited | `yuv420p10le`, `yuv422p`, `yuv444p`, `yuv422p10le` or `yuv420p12le`, limited | 8 | 12 |
| `yuv420p10le`, limited | `yuv420p`, `yuv420p10le`, `yuv422p`, `yuv444p`, `yuv422p10le` or `yuv420p12le`, limited | 10 | 15 |
| `yuvj420p`, full | `yuvj420p` or `yuv420p`, full | 8 | 5 |
| `yuv420p`, full | `yuv420p`, `yuvj420p`, `yuvj422p` or `yuv420p10le`, full | 8 | 9 |
| `yuv420p10le`, full | `yuv420p10le`, `yuv420p`, `yuvj420p` or `yuvj422p`, full | 10 | 9 |

Each combination of the last three rows was measured with a scaled encode and
with an encode of the reference's size: FFmpeg converts the two in different
ways, as "A full-range encode of the reference's size" below says.

Two of the 47 name the same colour matrix on both sides, `bt709` in one and
`smpte170m` in the other; no other file of the 97 names a matrix. Nine of the
97 hold a file whose chroma sample location was written anew. In seven the two
files name different locations, `left` on one side and `center`, `topleft` or
`top` on the other; in two they name the same one, `left` and `topleft`. The
location that a file names did not change FFmpeg's score, and the worker's rule
does not read it.

The 22, each with `vmaf_v1.0.16_3d0h` against a reference of 640x360. The
difference is the scorer's mean minus FFmpeg's:

| Reference | Encode | Bit depth | Comparisons | Difference |
|---|---|---|---|---|
| `yuv422p10le` (ProRes) | `yuv420p` | 10 | 2 | -4.412912, +3.923670 |
| `yuv422p` (H.264) | `yuv420p` | 8 | 2 | -2.705356, +3.901499 |
| `yuv444p` (H.264) | `yuv420p` | 8 | 2 | -5.659261, +5.263560 |
| `yuv420p12le` (FFV1) | `yuv420p` | 10 | 2 | -0.000031, -0.048940 |
| `yuvj420p` or `yuv420p`, full | `yuv420p` or `yuv420p10le`, limited | 8 and 10 | 5 | -11.67 to -13.25 |
| `yuv420p10le`, full | `yuv420p10le`, limited | 10 | 1 | -3.684738 |
| `yuv420p` or `yuv420p10le`, limited | `yuvj420p`, `yuv420p` or `yuv420p10le`, full | 8 and 10 | 3 | +2.149615, +10.453317, +11.641452 |
| `yuvj420p`, full | `yuv420p10le` or `yuvj422p`, full | 8 | 2 | +0.015387, +1.019388 |
| `yuv420p`, `bt709` | `yuv420p`, no matrix or `smpte170m` | 8 | 2 | +1.472369 |
| `yuv420p`, no matrix | `yuv420p`, `bt709` | 8 | 1 | +10.108280 |

What libvmaf through FFmpeg does in these 22 and the scorer does not:

- It compares in the reference's pixel format when that is one of the twelve
  that the filter takes. The scorer holds 4:2:0 pictures of 8 or 10 bits and no
  other. With both inputs forced to `yuv420p10le`, FFmpeg's libvmaf gave the
  scorer's mean for the two ProRes comparisons (57.621154 and 55.596579).
- It converts a reference in another format, `yuvj420p` for one, to the format
  that the scale filter gives the encode. The scorer's 8-bit 4:2:0 picture is
  that format for an 8-bit 4:2:0 encode, `yuvj420p` or `yuv420p`, and for no
  other.
- When one file is full range and the other is not, it converts one of the two
  to the other's range before the comparison. The scorer keeps each file's
  samples as they are.
- When the two files name different colour matrices, or one names none, it
  converts the encode to the reference's matrix, and it takes a file that names
  none for BT.601 (`smpte170m`). The files of the last two rows hold the pixel
  data of an untagged pair whose two means were equal, 55.535454; only the tags
  differ. FFmpeg's scale filter printed
  `csp:unknown range:unknown -> csp:bt709 range:tv` for the first of the three.

**A full-range encode of the reference's size.** FFmpeg does not scale such an
encode; it converts its format, and where it widens 8-bit pictures to the 10
bits of the reference, swscale copies each plane and repeats the top bits of
full-range luma (`(v << 2) | (v >> 6)`), where its scaler shifts (`v << 2`).
The scorer of the first commit of this change converted one of the two names
of such a picture in the other way. A decoder gives full-range H.264 as
`yuvj420p`; swscale reads that name as a full-range source for a limited-range
target when its context is created, and it then keeps its scaler, also after
both ranges are set to full. A `yuvj420p` encode of 640x360 against a
full-range `yuv420p10le` reference of that size scored 66.447621 where FFmpeg
gave 66.863064. The review of PR #121 found it: until then, every full-range
encode that was compared in 10 bits had been scaled. The scorer now creates the
context for the plain format and sets the range apart (`without_range` in
`native/vmaf-gpu/src/decoder.cpp`), and its test `tests/runner_test.py` holds
its 10-bit pictures of both names against the scale filter's. Ten comparisons
of full-range pairs of one size, in the formats of the last three rows of the
table of the 97, were run for it, nine of them new to test I, and every number
of tests I and J is that of the scorer after this change. The scale filter of
FFmpeg 6.1.1 gives other 10-bit pictures for such an encode than that of the
pinned n8.1.3, unless both ranges are named for it; the test names them.

The rule lets through exactly the combinations that were measured equal, and
nothing that was measured different: `packages/core/src/vmaf/native-comparison.ts`,
with the combinations above in its test. It lets through more than was
measured: an encode in any of the twelve pixel formats that the libvmaf filter
takes or in `yuvj420p`, `yuvj422p` or `yuvj444p`, of which 16-bit encodes,
`yuv422p12le`, `yuvj444p` and 4:4:4 encodes of more than 8 bits were not
measured; a full-range encode in another format than `yuv420p`, `yuv420p10le`,
`yuvj420p` or `yuvj422p`; and a colour matrix that both files name, which was
measured for 8-bit limited-range pairs only. The review of PR #121 held 23
more pairs against the pinned FFmpeg in the container of this test, with
encodes in `yuvj444p`, `yuv444p`, `yuv444p10le`, `yuv420p12le`, `yuv422p12le`
and `yuv420p16le`, at one size and scaled, in full and in limited range: the
pictures that the scorer's decoder makes of the two files were FFmpeg's byte
for byte, and libvmaf gave FFmpeg's mean on them. The scorer itself was not run
on them, and nothing of them on a GPU. It refuses more than was measured
different:
every reference that is not `yuv420p`, `yuv420p10le` or, with an 8-bit 4:2:0
encode, `yuvj420p`; every pair with one full-range file; and every pair whose
files do not name the same colour matrix, by ffprobe's name for it.

The worker also takes a result only when its receipt holds the bit depth that
the worker asked for and no declared encode in CAMBI's options. A scorer that
was built from the source before this change declares the encode in every run,
so its results are refused (`NATIVE_RECEIPT_COMPARISON_MISMATCH`) and are not
stored as results of generations 12 and 13.

**Test J, 2026-11-13: both GPU backends, through the worker's code.** The host
of the GPU check holds an NVIDIA GeForce RTX 5060 Ti (driver 580.178.04) and,
in its AMD Ryzen AI 9 HX 370, a Radeon 890M (Mesa 25.2.8, RADV). The scorer was
built there from the source of this change with
`build.py --cuda --vulkan --test`, against Ubuntu 24.04's FFmpeg libraries
(6.1.1, those of test I). Its 54 tests passed: 18 that need no GPU, 17 of the
CUDA backend and 19 of the Vulkan backend. Its `--version` names the source
`15c680e0`.

Each comparison went through the worker's own code, bundled for the host's
Node 22: the rule, the size check, and `runNativeVmafScore`, which starts the
scorer as a measurement does and checks its receipt. It ran once with the CUDA
backend and once with the Vulkan backend on the AMD GPU, each run with its CPU
reference (`--verify-cpu`). Beside it ran the `linux/amd64` programs of this
build with the command that the worker's builder gives for a **Local CPU**
measurement, the `fps` filter with the reference's frame rate included, and
once more without that filter.

208 comparisons: the 129 of test I, which are 128 here; 17 with a 10-second
1920x1080 clip of Big Buck Bunny (240 frames); and 63 with small pictures and
small encodes, which with eight of the 17 are the 71 of "The GPU scorer and
small pictures".
Test I counts one pair that the rule refuses twice, with the scorer at 8 and at
10 bits; here the worker's rule decides the bit depth, and the pair is one
comparison.

| Comparisons | The worker's checks | FFmpeg | The scorer, on each GPU |
|---|---|---|---|
| 148 | both pass | scored all | scored all, over FFmpeg's number of frames |
| 27 | the rule refuses | scored 23 | not started |
| 33 | the size check refuses | scored none | started all the same, it refused each |

In the 148, the mean of the CUDA backend was within 0.0000015 of FFmpeg's and
equal to the sixth decimal in 106; that of the Vulkan backend was within
0.0000006 and equal to the sixth decimal in 147. The 148 are 102 of test I, its
97 and the five with pictures of 216 or 360 pixels in width, the 17 with the
clip, and 29 of the small ones.

The 17 with the clip, with eight libvmaf threads. The 8-bit reference is H.264
in `yuv420p`; its encodes of four sizes are x264 at `veryfast` and CRF 26, and
one more 1920x1080 encode is a test file of that host. The 10-bit reference is
the same clip in `yuv420p10le` (x264, CRF 10), with x264 encodes at CRF 26 in
`yuv420p10le` and in `yuv420p`:

| Reference | Encode | Model | FFmpeg | CUDA | Vulkan |
|---|---|---|---|---|---|
| 8-bit | 1920x1080 | `vmaf_v1.0.16_3d0h` | 89.396735 | 89.396735 | 89.396735 |
| 8-bit | 1280x720 | `vmaf_v1.0.16_3d0h` | 83.039229 | 83.039229 | 83.039229 |
| 8-bit | 960x540 | `vmaf_v1.0.16_3d0h` | 76.531548 | 76.531548 | 76.531548 |
| 8-bit | 640x360 | `vmaf_v1.0.16_3d0h` | 65.692018 | 65.692018 | 65.692018 |
| 8-bit | 1920x1080 | `vmaf_v1.0.16_5d0h` | 91.722389 | 91.722389 | 91.722389 |
| 8-bit | 1280x720 | `vmaf_v1.0.16_5d0h` | 86.987563 | 86.987563 | 86.987563 |
| 8-bit | 960x540 | `vmaf_v1.0.16_5d0h` | 82.254038 | 82.254037 | 82.254038 |
| 8-bit | 640x360 | `vmaf_v1.0.16_5d0h` | 73.123326 | 73.123326 | 73.123326 |
| 8-bit | 1920x1080, a second encode | `vmaf_v1.0.16_3d0h` | 90.311682 | 90.311682 | 90.311682 |
| 10-bit | 1920x1080, 10-bit | `vmaf_v1.0.16_3d0h` | 91.012434 | 91.012434 | 91.012434 |
| 10-bit | 1920x1080, 10-bit | `vmaf_v1.0.16_5d0h` | 93.279379 | 93.279379 | 93.279379 |
| 10-bit | 960x540, 10-bit | `vmaf_v1.0.16_3d0h` | 78.861772 | 78.861772 | 78.861772 |
| 10-bit | 960x540, 10-bit | `vmaf_v1.0.16_5d0h` | 84.623297 | 84.623297 | 84.623297 |
| 10-bit | 960x540, 8-bit | `vmaf_v1.0.16_3d0h` | 77.170642 | 77.170642 | 77.170642 |
| 10-bit | 960x540, 8-bit | `vmaf_v1.0.16_5d0h` | 82.988300 | 82.988300 | 82.988300 |
| 10-bit | 640x360, 8-bit | `vmaf_v1.0.16_3d0h` | 66.870929 | 66.870929 | 66.870929 |
| 10-bit | 640x360, 8-bit | `vmaf_v1.0.16_5d0h` | 74.146640 | 74.146639 | 74.146640 |

The scorer gave a score in 364 runs: 300 for the comparisons above, two of
which test I lists twice, ten with one libvmaf thread, and 54 as the worker's
calibration starts them, with 64 frames and with one, two and four frames in
flight; and in four more for the two pairs of "Frames that are not evenly
spaced" below. Each of the 368 compared at the rule's bit depth and declared
nothing to CAMBI. Inside these runs, a frame's score from the GPU was within
0.000024 (CUDA) and 0.000014 (Vulkan) of the CPU reference's, where the
scorer's bound is 0.0001, and a feature within 0.00000007, where its bound is
0.000001 or more.

FFmpeg without the `fps` filter gave the same mean over the same number of
frames in each of the 171 comparisons that it scored. The files of the 63 small
comparisons are 30 frames a second, the others 24.

The 27 that the rule refuses are the 22 of test I, which are 21 here, and six
of the small ones;
`runNativeVmafScore` gave the rule's sentence for each and started no scorer.
The 33 that the size check refuses are the five of test I and 28 of the small
ones. FFmpeg gave no score for any of them, and the scorer, which a measurement
would not have started, ended with status 1 in each.

A scorer that was built on that host from `main` on 2026-11-12, before this
change, was started by this worker for four comparisons. Each ended after its
run with `NATIVE_RECEIPT_COMPARISON_MISMATCH`.

**Frames that are not evenly spaced.** The `fps` filter of the **Local CPU**
command is in the encode's chain alone. It makes the encode's frames evenly
spaced at the reference's rate, and the reference's frames are numbered as they
come. For files whose frames are evenly spaced at one rate, which is every file
above, it changes nothing. Three more comparisons of test J used a reference of
40 frames, a clip of 24 frames a second with every sixth frame left out
(ffprobe: `r_frame_rate` 24/1, `avg_frame_rate` 960/47), at 640x360 with
`vmaf_v1.0.16_3d0h`:

| Encode | FFmpeg with the `fps` filter | FFmpeg without it | CUDA | Vulkan |
|---|---|---|---|---|
| 320x180, the same 40 frames at the same times | 19.321001 over 47 frames | 44.153269 over 40 | 44.153268 | 44.153269 |
| 640x360, the same 40 frames at the same times | 21.264858 over 47 frames | 52.956566 over 40 | 52.956566 | 52.956566 |
| 320x180, 48 evenly spaced frames | 18.348708 over 48 frames | 18.348708 over 48 | refused | refused |

In the first two, the filter fills the encode's gaps with repeated frames
while the reference keeps its 40, so the command of **Local CPU** compares
frames that do not belong together from the first gap on. The scorer pairs the
40 frames and gives the mean of FFmpeg without the filter. The worker refuses
the third before it starts the scorer
(`NATIVE_UNSUPPORTED_FRAME_RATE_CONVERSION`: it reads each file's frame rate
from `avg_frame_rate`, and the two differ), and the scorer by itself refuses a
pair whose frames' times are more than a quarter of a frame apart ("Comparison
presentation timestamps do not align"). So for a pair whose frames are not
evenly spaced and come at the same times in both files, GPU scoring and **Local
CPU** give different scores, and the difference is the `fps` filter's. This
change leaves both as they were: the worker starts GPU scoring for such a pair,
and the command of **Local CPU** keeps its filter. In test I's container the
first two pairs went the same way: FFmpeg gave 19.313067 and 21.264858 with the
filter, and 44.144341 and 52.956566 without it, which the scorer's CPU
reference gave as well.

That is the state of PR #121. Since 2026-11-14 the reference's chain has the
filter as well, the worker's check before a GPU run reads both of ffprobe's
frame rates of each file, in place of the check that gave
`NATIVE_UNSUPPORTED_FRAME_RATE_CONVERSION`, and the worker scores such a pair
on the CPU: "The reference's frame times" below.

Not measured: a reference or an encode in HEVC or VP9, a reference in AV1, and
a 10-bit reference in a codec other than H.264; a size above 1920x1080; a frame
rate other than 24 and 30; a file whose frames are evenly spaced at another
rate than ffprobe's `r_frame_rate` of it, which is the rate that the `fps`
filter gets, where the worker's check before a GPU run reads `avg_frame_rate`
(interlaced H.264 and MPEG-2 files that FFmpeg made gave the same rate as
`r_frame_rate` and as `avg_frame_rate`); a GPU of another model or with another
driver; a scorer that is linked with other FFmpeg libraries than those of
FFmpeg 6.1.1; and HDR files and decoding on the GPU, neither of which the
worker gives to the scorer. Test L of 2026-11-14 added encodes in HEVC, VP9 and
MPEG-2 and frame rates from 12 to 60.

### The reference's frame times

Two changes of 2026-11-14 gave the command of a **Local CPU** measurement by
the ordinary method its frame times. The first put the `fps` filter into the
reference's chain as well as the encode's, both with the reference's frame
rate `<R>`. The second put `setpts=PTS-STARTPTS` before each filter, so that
each chain counts its times from its own first frame:

```text
[0:v]scale=<W>:<H>:flags=bicubic,setpts=PTS-STARTPTS,fps=<R>,settb=AVTB,setpts=N/FRAME_RATE/TB[dist];
[1:v]setpts=PTS-STARTPTS,fps=<R>,settb=AVTB,setpts=N/FRAME_RATE/TB[ref];
[dist][ref]libvmaf=<as before>[out]
```

The filter gives a file one frame for every interval of that rate: it repeats
a frame over the intervals that the file leaves out after it, and of the
frames whose times round to one interval it keeps the last. Both chains then
number their frames, and libvmaf compares frame N of one with frame N of the
other. With the filter in the encode's chain alone, as it was from the first
commit, the frames of a reference that leaves frames out were numbered as they
came, and its frame N was another moment than the encode's frame N: the pairs
of "Frames that are not evenly spaced" above. Without `setpts=PTS-STARTPTS`
the intervals were counted from the start of the file, which is not the first
frame of a video stream that starts after the file: "A video stream that
starts after its file" below.

`<R>` is the reference's `r_frame_rate`, or its `avg_frame_rate` where ffprobe
gives no `r_frame_rate`. The worker passes it to every VOD measurement by the
ordinary method that is not scored on a GPU. The cloud worker and the Live
measurement build their command with the same code: a cloud measurement gets
the changed command with a worker image that is built from this version, and
the reference of a Live measurement is written through the `fps` filter before
it is scored. Test P below ran both. The frame-index method has its own
command, which neither change touches.

The scoring generation is still 3, because a new generation would mark every
stored report as outdated, and two files with a frame in every interval whose
video starts with the file score as they did in v1.2.1: test P found that in
579 comparisons. Other kinds of file score otherwise, under the same
generation. Since the first change the filter repeats or drops frames of a
reference that leaves frames out, whose frames lie more than half an interval
from where its frame rate puts them, whose last frame lasts longer than one
interval, or whose frame rate, as ffprobe reads it, is not that of its frames
(test P). A file whose video stream starts later than the file does by about
half an interval, or by that plus a whole number of intervals, had frames
dropped and repeated: an encode from the first commit to the second change,
and a reference between the two changes. Since the second change both give
the score of the same files without the delay ("A video stream that starts
after its file" and test P below).

**Test K, 2026-11-13 and 2026-11-14: the command before the first change and
after it.** In the container of test I, with the `linux/arm64` programs of
this build and four libvmaf threads, each pair was scored with the builder's
command as it was before the first change and as it was after it. "Before"
and "after" in test K, and in test L below, are those two. The files of every
group but I and O are FFmpeg's `testsrc2`: a small set of 160x90, scored with
`vmaf_v0.6.1`, and a set of 384x216, scored with `vmaf_v1.0.16_3d0h`. Their
ProRes files are `yuv422p10le`, the others `yuv420p`. FFmpeg 9.0.2 wrote them,
and this build's FFmpeg the files of I and O: each file but the MPEG-TS files,
which name no version, says `Lavf63.1.102` or `Lavf62.12.103` respectively.
692 comparisons, in which a pair of files that was scored with several models
counts once for each model:

| Group | Comparisons | Pairs |
|---|---|---|
| I | 128 | The pairs of test I |
| O | 3 | The pairs of "Frames that are not evenly spaced" |
| R, 160x90 | 128 | 3 seconds at 12, 15, 24000/1001, 25, 30000/1001, 50, 60000/1001 and 60 frames a second, a frame in every interval. An FFV1 reference in Matroska with encodes in H.264 (MP4, fragmented MP4, Matroska, MPEG-TS, QuickTime), MPEG-2 (MPEG-TS), VP9 (WebM), HEVC and AV1 (MP4); and references in ProRes (QuickTime), H.264 (MPEG-TS, Matroska, fragmented MP4, QuickTime), VP9 (WebM) and MPEG-2 (MPEG-TS) with an H.264 encode in MP4 |
| R, 384x216 | 144 | The same rates. An FFV1 reference in Matroska with those encodes and an H.264 encode in an MP4 file with a millisecond clock; and references in H.264 (MP4, Matroska, MPEG-TS) and ProRes (QuickTime) with H.264 encodes in MP4 and in Matroska |
| S, 160x90 | 120 | 10 seconds at 24000/1001, 25, 30000/1001 and 60000/1001. A file that starts 0, 1/4, 1/2 or 3/4 of an interval after zero, in Matroska, MPEG-TS, MP4 and MP4 with a millisecond clock, as the reference of an MP4 file that starts at zero, and as its encode |
| A, 160x90 | 15 | 10 seconds at 24, 24000/1001, 25, 30000/1001 and 60000/1001. A reference with AAC audio in Matroska and in MP4, or with Opus audio in WebM, as FFmpeg writes it, with an encode without audio |
| G | 24 at 160x90, 23 at 384x216 | Files that leave frames out |
| H | 24 at 160x90, 28 at 384x216 | Matroska files whose video stream starts after their audio |
| L, 384x216 | 42 | Copies of the files of H |
| M, 384x216 | 13 | The references of H with their video stream later by other delays: a whole number of intervals, and that plus half an interval |

The pairs of files with a frame in every interval, whose video starts with the
file:

| Group | Scored | The same mean over the same number of frames, before and after |
|---|---|---|
| I | 123 | 119. The other four have pictures of 216 pixels in width, whose means differ from run to run with four threads ("libvmaf and its thread count"); with one thread each gave one mean before and after |
| R, 160x90 | 128 | 128 |
| R, 384x216 | 144 | 144 |
| S | 120 | 120 |
| A | 15 | 15 |

Those are 530 comparisons of 513 pairs of files. The other five of group I are
too small for their model, and neither command gave a score. On the host of
the GPU check, with the `linux/amd64` programs of this build, the 123 of group
I and the 144 of group R at 384x216 gave the same mean before and after as
well.

**Frames that are left out.** The three pairs of group O, whose reference has
40 frames in 47 intervals of 24 frames a second:

| Encode | Before, arm64 | After, arm64 | Before, x86-64 | After, x86-64 |
|---|---|---|---|---|
| 320x180, the same 40 frames | 19.313067 | 44.005604 | 19.321001 | 44.015701 |
| 640x360, the same 40 frames | 21.264858 | 52.963515 | 21.264858 | 52.963515 |
| 320x180, 48 evenly spaced frames | 18.255709 | 28.530197 | 18.348708 | 28.620321 |

Group G at 384x216, in 150 intervals of 30000/1001 frames a second, with H.264
files. The means are those of both architectures:

| Reference | Encode | Before | After |
|---|---|---|---|
| Frame 50 left out | The same frame left out | 49.739236 | 89.172066 |
| Frame 50 left out | Every frame | 50.038745 | 88.772465 |
| Every frame | Frame 50 left out | 88.776644 | 88.776644 |
| Every frame | Every frame | 89.103486 | 89.103486 |
| 103 frames left out | The same frames left out | 18.710689 | 92.521542 |
| 103 frames left out | Every frame | 18.693335 | 32.065287 |

The first three rows were measured in MP4, QuickTime, Matroska and MPEG-TS,
and the first also in fragmented MP4 and in MP4 with a millisecond clock; the
last two in MP4, Matroska and MPEG-TS. Each container gave the means of the
table. A Matroska reference with a VP9 encode in WebM, both without frame 50,
went from 53.191176 to 97.390791. An encode that leaves frames out scores as
before, because the encode's chain has had the filter all along. The second to
last row was scored over 148 frames, the others over 150. Group G at 160x90
went the same way: 16 of its 24 comparisons have a reference that leaves
frames out and scored higher after the change (75.83 to 99.92 for one frame of
300 left out of both files), and the other eight scored as before.

What ffprobe says of these files decides whether the worker can see a file
that leaves frames out before a GPU run:

| File | `r_frame_rate` | `avg_frame_rate` | `nb_frames` |
|---|---|---|---|
| MP4 or QuickTime, frame 50 of 150 left out | 30000/1001 | 29800/1001 | 149 |
| Fragmented MP4, the same | 30000/1001 | 29800/1001 | not given |
| Matroska, WebM or MPEG-TS, the same | 30000/1001 | 30000/1001 | not given |
| MP4, 103 of 150 left out | 30000/1001 | 176250/17017 | 47 |
| Matroska or MPEG-TS, the same | 30000/1001 | 30000/1001 | not given |
| Matroska or WebM, every frame, 60000/1001 frames a second | 19001/317 | 19001/317 | not given |
| MP4, QuickTime or MPEG-TS, every frame, 60000/1001 frames a second | 60000/1001 | 60000/1001 | 180, or not given |

**A video stream that starts after its file.** One kind of file with a frame
in every interval did not pass the filter unchanged before the second change.
FFmpeg counts a file's times from the start of the file, which is the start of
its earliest stream, and the filter sends each frame to the interval that is
nearest to the frame's time. When the video starts half an interval after the
file, every frame lies on the border between two intervals. Matroska and WebM
keep times in whole milliseconds, so each frame's time is up to half a
millisecond off, to one side for some frames and to the other for the rest.
Two frames then go to one interval, of which the filter drops the first, and
another interval gets none, for which it repeats a frame: at 24 frames a
second and 21 ms it dropped every third frame and repeated the one after it.

Group H at 384x216, 5 seconds, H.264 in Matroska with AC-3 audio that starts
at zero. "Late" is a file whose video starts so much after its audio, and the
other file of a pair is the same video without audio:

| Frames a second | The video starts | The filter alone: frames dropped, repeated | Neither late | The reference late, before | The reference late, after | The encode late, before and after | Both late, before | Both late, after |
|---|---|---|---|---|---|---|---|---|
| 24 | 21 ms late | 40, 39 of 120 | 90.505946 | 90.505946 | 67.840270 | 69.007019 | 69.007019 | 89.295701 |
| 24000/1001 | 21 ms late | 35, 34 of 120 | 90.820227 | 90.820227 | 67.639228 | 68.541928 | 68.541928 | 89.887715 |
| 30000/1001 | 17 ms late | 25, 25 of 150 | 89.103486 | 89.103486 | 79.607887 | 80.057642 | 80.057642 | 88.624084 |
| 60000/1001 | 8 ms late | 50, 50 of 300 | 86.095282 | 86.095282 | 81.236996 | 81.359263 | 81.359263 | 85.890357 |
| 24000/1001 | 10 ms late | none | 90.820227 | 90.820227 | 90.820227 | 90.820227 | 90.820227 | 90.820227 |
| 25 | 20 ms late | none | 90.620082 | 90.620082 | 90.620082 | 90.620082 | 90.620082 | 90.620082 |
| 60000/1001 | 4 ms late | none | 86.095282 | 86.095282 | 86.095282 | 86.095282 | 86.095282 | 86.095282 |

An encode of this kind scored so from the first commit to the second change,
and a reference between the two changes. Both architectures gave these means.
Since the second change each comparison of the table gives the mean of
"Neither late", on both architectures and with both GPU scorers (test P).
Half an interval is 20.83 ms at 24 frames a second, 20.85 at 24000/1001,
16.68 at 30000/1001 and 8.34 at 60000/1001: the four delays that moved the
score are within half a millisecond of it. At 25 frames a second an interval
is 40 ms, every frame's time is a whole millisecond, and all frames go to the
same side. Group H at 160x90, 10 seconds, went the same way at 24,
24000/1001, 30000/1001 and 60000/1001 frames a second (99.957435 to 84.907801
for a reference at 24 with its video 21 ms late), and delays of 20 and 22 ms
at 24000/1001 moved nothing. A delay of 9 ms at 60000/1001 moved less: the
filter dropped the last of 600 frames and no other, and the reference's score
went from 98.889640 to 98.836310.

The delay need not be half an interval itself. Group M, the references of the
table with other delays, each with the encode that has no audio: a whole
number of intervals more than half an interval does the same, and a whole
number of intervals alone does nothing.

| Frames a second | The video starts | In intervals | The filter alone: frames dropped, repeated | The reference late, before | The reference late, after |
|---|---|---|---|---|---|
| 24 | 62 ms late | 1.49 | none | 90.505946 | 90.505946 |
| 24 | 63 ms late | 1.51 | 1, 0 of 120 | 90.505946 | 89.925110 |
| 24 | 104 ms late | 2.50 | 40, 40 of 120 | 90.505946 | 68.356296 |
| 24 | 146 ms late | 3.50 | 40, 39 of 120 | 90.505946 | 67.840270 |
| 24000/1001 | 62 ms late | 1.49 | none | 90.820227 | 90.820227 |
| 24000/1001 | 63 ms late | 1.51 | 6, 5 of 120 | 90.820227 | 87.311774 |
| 24000/1001 | 104 ms late | 2.49 | 30, 30 of 120 | 90.820227 | 73.956932 |
| 30000/1001 | 33 ms late | 0.99 | none | 89.103486 | 89.103486 |
| 30000/1001 | 50 ms late | 1.50 | 55, 55 of 150 | 89.103486 | 62.545175 |
| 30000/1001 | 83 ms late | 2.49 | 15, 15 of 150 | 89.103486 | 83.531984 |
| 60000/1001 | 17 ms late | 1.02 | none | 86.095282 | 86.095282 |
| 60000/1001 | 25 ms late | 1.50 | 95, 95 of 300 | 86.095282 | 72.114746 |
| 60000/1001 | 42 ms late | 2.52 | 60, 59 of 300 | 86.095282 | 79.927340 |

At 24 frames a second three intervals are 125 ms, so a frame's time in whole
milliseconds is at most a third of a millisecond off, and 62 and 63 ms are
each half a millisecond from one and a half intervals: the filter dropped no
frame at 62 ms and one at 63. On the host of the GPU check, the `linux/amd64`
programs gave the same 13 means with the changed command, and both scorers
gave the mean of "before" for each of the 13, to within 0.000002. Since the
second change the command gives the mean of "before" for each of the 13, on
both architectures (test P).

The copies of group L, made with `-c copy` from the seven late references and
the seven late encodes of the table:

- The video stream alone in Matroska. The file starts with its video, the
  filter drops and repeats nothing, and each of the 21 comparisons gave the
  mean of "Neither late".
- Both streams in MP4. The copy keeps the times in whole milliseconds and the
  delay: the filter dropped and repeated as many frames as for the Matroska
  file, but for one frame more repeated at 24000/1001 and 21 ms, and the means
  with a late reference or a late encode were those of the table.

Since the second change each of the 42 comparisons of group L gives the mean
of "Neither late" (test P).

A file that starts late as a whole, video first, is not of this kind: in group
S the filter dropped and repeated nothing at any of the four offsets, in any
container.

A third command was run beside the two for every comparison of test K: the
changed command with `setpts=PTS-STARTPTS` before each `fps` filter, which
counts a stream's times from its own first frame. It gave the mean of "Neither
late" for every comparison of groups H, L and M, and the mean of the changed
command for every other comparison that was scored, the four of 216 pixels in
width with one thread. It became the worker's command with the second change:
test P.

**Pairs that the worker scores on the CPU in the scorer's place.** The scorer
compares the frames of the two files in their order and repeats and drops
none. With **Local (GPU if available)** on a worker with a usable GPU, the
worker therefore scores a pair with the command above, and the other pairs of
the measurement on the GPU, in two cases:

- Before the run, when the worker's check refuses the pair. Its part on frame
  times, `vmafNativeFrameTimes`, reads ffprobe's three values of the table
  above. It takes a file whose two rates are the same to within half a frame
  over the file's frames (5,000,000 frames where ffprobe counts none), and a
  pair whose `r_frame_rate` are within 0.000001 of each other and whose
  `nb_frames`, where ffprobe gives both, are equal. 0.000001 frames a second
  is the scorer's own line: it refuses a Matroska file of 19001/317 with an
  MP4 file of 60000/1001 ("Inputs must have the same known frame rate; conform
  them before comparison"), although FFmpeg repeats and drops no frame of
  either.
- While the scorer runs, when it ends with one of its four sentences on a
  pair: the one above, "Comparison presentation timestamps do not align", for
  a frame whose time is more than a quarter of an interval apart in the two
  files, "Comparison inputs have different frame counts", for a file that
  ends before the other, and, since the second change, "Comparison frame
  times do not follow the frame rate", for a file whose frame N is more than a
  quarter of an interval from N intervals after its first frame. The worker
  fetches the encode again and scores the pair once on the CPU.

The fourth sentence is the second change's, in the scorer's source. It refuses
a pair whose two files leave out the same frames, which the other sentences
let through, and a file whose frames lie off its frame rate, as a screen
recording's do, or as those of a file whose frame rate ffprobe reads wrongly
(group RR below). It reads where each frame starts: a file whose last frame
lasts longer than one interval passes it (group EF below). A scorer that was
built before the second change, that of PR #121 among them, scores such a
pair, and the worker takes that score: the scorer has to be built again
(`native/vmaf-gpu/README.md`).

Every other failure of a scorer run ends the measurement as before. Nothing is
scored in the scorer's place for a measurement with a prepared reference or on
a worker whose environment names the scorer for a plan without a local
processing choice: those end with the refusal.

**Test L, 2026-11-14: both GPU backends beside the changed command.** On the
host of test J, with the scorer that test J built (`15c680e0`) and the worker's
code of the first change, bundled as for test J. Each comparison ran through the
worker's check, through the scorer on the NVIDIA GPU (CUDA) and on the AMD GPU
(Vulkan), and through the `linux/amd64` programs of this build with the
changed command. 414 comparisons of 404 pairs, a pair counted as in test K,
once for each model: the 208 of test J, eight of them twice, five of those
with one libvmaf thread the second time; the three of group O; and the 193 of
the 384x216 set, two of them twice. The whole was run twice, and both runs
gave the same counts and the same largest differences:

| Comparisons | The worker's check | The scorer, on each GPU |
|---|---|---|
| 289 | takes the pair | scored, within 0.000005 of FFmpeg's mean over FFmpeg's number of frames |
| 17 | takes the pair | scored otherwise than FFmpeg |
| 6 | takes the pair | ended with "Comparison presentation timestamps do not align" |
| 33 | takes the pair, and the size check refuses it | not scored, as in test J |
| 69 | refuses the pair | not started |

The 289 are 280 different comparisons: the 148 of test J and 132 of the
384x216 set, with references in FFV1 and H.264 in Matroska, MP4 and MPEG-TS
and encodes of every codec and container of group R. The mean of the CUDA
backend was within 0.0000016 of FFmpeg's, and that of the Vulkan backend
within 0.0000006.

The 69 that the check refuses: 30 for the pixel format, 15 of them pairs of
the 384x216 set with a ProRes reference; ten for the colour range; three for
the colour matrix; and 26 for the frame times. Of those 26, 14 have an MP4,
fragmented MP4 or QuickTime file that leaves frames out, the three of group O
among them, and 12 pair a Matroska file of 19001/317 with a file of
60000/1001. FFmpeg scored all 26: the three of group O at 44.015701, 52.963515
and 28.620321, the x86-64 means of the table above.

The six that the scorer ended have a Matroska or MPEG-TS file that leaves
frames out on one side, which the frame rates and the frame count that ffprobe
gives do not show. In the second run, whose code holds that part, the
worker's code named each a refusal of the pair.
FFmpeg scored them at the means of the table of group G: 88.772465, 88.776644
and 32.065287, twice each. Three more pairs, Matroska and MPEG-TS files of 90
frames beside a Matroska file of 150 at 30000/1001 frames a second, passed the
check and ended in the scorer with "Comparison inputs have different frame
counts", which the worker's code named a refusal as well; FFmpeg scored them
over 150 frames, at 53.457753 and 53.390817.

The 17 that the scorer scored otherwise than FFmpeg were what remained between
a GPU score and a **Local CPU** score of one pair after the first change. Since
the second change neither kind remains (test P):

- Five pairs whose two files leave out the same frames, in Matroska, WebM and
  MPEG-TS. The scorer scores the frames that the files hold, and FFmpeg the
  repeated frames as well: 89.189401 over 149 frames beside 89.172066 over 150
  (two pairs), 97.414156 beside 97.390791, and 92.530753 over 47 frames beside
  92.521542 over 148 (two pairs).
- The 12 pairs of group H whose reference, encode or both start their video
  near half an interval late. The scorer counts each file's times from its
  first frame and gave the mean of "Neither late" for each, to within
  0.000002, where FFmpeg gave the means of the table from 67.639228 to
  89.887715.

The first of the two is small in those five pairs, three of which leave out
one frame of 150, and that is no property of such pairs. Group N, run on the
same host after the review of the first change, has pairs that are further
apart: H.264 in Matroska, 384x216, 24 frames a second, with the same frames
left out of the reference and of the encode. ffprobe gives each file 24/1 for
both rates and no frame count, the frames of the two files come at the same
times, and the check and the scorer took each pair:

| Reference and encode | Frames in intervals | CUDA | Vulkan | FFmpeg, the changed command | FFmpeg without the filter |
|---|---|---|---|---|---|
| 3 seconds of `smptebars` with one frame in 24 kept, then 3 seconds of `testsrc2` with every frame; CRF 12 and CRF 40 | 75 in 144 | 79.214309 | 79.214308 | 86.995750 | 79.214308 |
| The same reference, with an encode at CRF 30 | 75 in 144 | 94.473997 | 94.473996 | 96.906092 | 94.473996 |
| As the first, with one frame in six of the still part kept | 84 in 144 | 80.390557 | 80.390556 | 85.598761 | 80.390556 |
| As the first, with `rgbtestsrc` for the still part | 75 in 144 | 78.546108 | 78.546108 | 81.001040 | 78.546108 |
| `testsrc2` with every third frame kept; CRF 12 and CRF 34 | 50 in 148 | 96.320113 | 96.320113 | 91.811458 | 96.320113 |
| `testsrc2` with frames 30 to 89 left out; CRF 12 and CRF 34 | 90 in 150 | 90.645375 | 90.645376 | 90.230321 | 90.645376 |

The scorer gives the mean of FFmpeg without the filter in either chain, over
the frames that the files hold. The changed command counts a frame once for
every interval that it fills, and a repeated frame has no motion against the
frame before it, which is one of the models' features. The GPU score of such a
pair was from 7.78 below the **Local CPU** score to 4.51 above it, and how far
depends on which frames are left out and on what the pictures show. The first
change left that open: the worker started GPU scoring for such a pair, as it
did before that change, when **Local CPU** gave 18.710689 beside the scorer's
92.530753 for one of the five. The second change refuses such a pair in the
scorer, which compares the time of each frame with the time that the frame
rate gives it, and the worker scores the pair on the CPU: test P.

**The reference of a Live measurement.** The Live processor writes its
reference through the filter, in pieces that it joins by stream copy where
there are several, and the scoring command now puts the filter into the
reference's chain once more. In the container of test I, pieces and joined
files were written with the Live processor's arguments at 23.976, 24, 25,
29.97, 30, 50, 59.94 and 60 frames a second, and at 30 from sources of
30000/1001 and of 25: for each of the 20 files the filter took and gave the
same number of frames, dropped and repeated none, and the frames after it were
those before it. Whole Live measurements were run with the second change:
test P.

**Seeing a file that leaves frames out.** The frame rates and the frame count
that ffprobe gives do not show it for a Matroska, WebM or MPEG-TS file. Two
other ways were run on 2026-11-14 in the container of test I, with this
build's programs, on the 588 media files of test K, group N and the Live
reference, 41 of which leave frames out by the times of their packets:

- The `fps` filter alone, at the file's `r_frame_rate`, after
  `setpts=PTS-STARTPTS`, as the command of the second change has them. It
  repeated one frame for each frame left out and dropped none, in each of the
  41, and it dropped and repeated nothing in each of the 547 others: the 484
  files with a frame in every interval whose video starts with the file, and
  the 63 whose video starts more than half a millisecond after the file.
  Without `setpts=PTS-STARTPTS` it dropped or repeated frames in 30 of those
  63. The quality guide gives this way.
- A count of the video packets (`ffprobe -count_packets`) was smaller than the
  file's duration, less the video's delay, times `r_frame_rate`: by the frames
  left out in 39 of the 41, and by 89 for 101 in the two MP4 files of 47
  frames in 148 intervals, whose average frame rate shows them. In the 547
  others it was from 0.91 smaller to 0.06 larger. It reads each file once and
  decodes nothing.

**Test P, 2026-11-14: the second change.** The second change puts
`setpts=PTS-STARTPTS` before each `fps` filter of the command, and gives the
scorer the sentence "Comparison frame times do not follow the frame rate". It
was measured with the command alone, with both GPU scorers beside it, with
whole measurements of the product, with the cloud worker and with Live.

The command. In test I's container, with the `linux/arm64` programs of this
build and four libvmaf threads, each pair was scored with three commands:
that of v1.2.1, without the filter in the reference's chain, that of the first
change, and that of the second. The pairs are those of test K, its group L
among them, and nine new groups of files made from `testsrc2`, at 384x216 but
for group BG; the screen recording of group VR starts with `smptebars`. Each
group was made from one lossless source for each frame rate, so that an encode
is its reference with less quality:

| Group | Comparisons | Pairs |
|---|---|---|
| WB | 7 | VP9 in WebM, 24 and 30000/1001 frames a second, without audio and with Opus audio that starts 21 or 17 ms before the video |
| FL | 3 | H.264 in FLV with AAC audio, whose video starts 21 to 42 ms after the file, beside MP4 and Matroska files |
| HF | 4 | 120 and 120000/1001 frames a second, a reference whose video starts 4 ms late, and an encode of 60 frames a second |
| LG | 3 | 90 seconds at 30000/1001 in Matroska, on time and 17 ms late, and 75 seconds at 25 in MPEG-TS |
| BG | 4 | References of 1920x1080, one of them 17 ms late, and of 3840x2160 in HEVC, with encodes of the same and of a smaller size |
| VR | 7 | Frame times off the frame rate: a screen recording's pattern, 132 frames in 240 intervals of 60 frames a second, in MP4 and Matroska; and every frame moved by up to 0.2, 0.4 and 0.6 of an interval, in Matroska |
| CD | 9 | References in HEVC, VP9, AV1, MPEG-2 (program and transport stream) and ProRes; encodes in HEVC, VP9 and AV1 |
| HD | 3 | PQ and HLG, 10 bits, and a PQ reference whose video starts 21 ms late |
| ML | 3 | MP4 files whose video starts 17 or 21 ms after their audio, by an edit list |

Most files whose video starts late were made from a file that starts on time,
with `-itsoffset`. The others were late as the muxer wrote them beside their
audio: an FLV file 21 ms, and the two MPEG-2 references 5 and 10 ms. Each
comparison with a late file was held against the same comparison of the files
that it was made from, its control; for the MPEG-2 references the controls are
copies of their video stream alone. 733 comparisons, a pair counted once for
each model, sorted by the times of their packets as this build's ffprobe
reads them:

| Comparisons | Files | v1.2.1 gave the mean and the frame count of the second change | The first change gave them |
|---|---|---|---|
| 584, 579 of them scored | A frame in every interval, the video starting with the file, in both | 575 | 575 |
| 95 | A frame in every interval in both; the video of one or both starting 4 to 146 ms after the file | 67 | 39 |
| 54 | A file that leaves frames out, or whose frames lie more than a quarter of an interval off its frame rate | 13 | 54 |

- The first row holds 12 to 120 frames a second in MP4, fragmented MP4,
  QuickTime, Matroska, WebM and MPEG-TS, with five models. Five of its
  comparisons have pictures that are too small for their model, and none of
  the three commands gave a score. The other four are the four of group I
  with pictures 216 pixels wide, whose means differ from run to run with four
  threads; with one thread the three commands gave one mean for each.
- Each comparison of the second row gave, with the second change, the mean
  and the frame count of its control. In 47 the reference alone is late:
  v1.2.1 gave each of them that mean, and the first change 19. In 25 the
  encode alone is late and in 23 both: v1.2.1 and the first change gave it for
  11 and for 9 of them, and dropped and repeated frames in the others. The
  late files are Matroska, WebM, FLV, MP4 and MPEG-TS files and an MPEG
  program stream.
- The second change gave the mean of the first for each comparison of the
  third row. v1.2.1 gave another for 41: those whose reference leaves frames
  out, as in test K, and four of group VR, three with the screen recording,
  5.851407 with v1.2.1 and 89.770032 since the first change, and one whose
  frames are moved by up to 0.6 of an interval, 66.433462 and 85.320705.

Both GPU scorers. On the host of test J, from 11:03 to 11:15 and at 11:34,
with a scorer built from the source of the second change and the worker's code
of the second change, bundled as for test L. Each comparison ran through the
worker's check, through both scorers, and through the `linux/amd64` programs of
this build with the command of the second change:

- The 414 comparisons of test L, the 13 of group M, the six of group N and the
  three pairs of files of different lengths: 436. The check refused 69, as in
  test L, and took 367. The size check refused 33 of those before any run, the
  scorer refused 20 and scored 314, 305 different comparisons counted as in
  test L. Each of the 314 means was within 0.000005 of the command's over the
  same frames: the CUDA scorer's within 0.0000016 and the Vulkan scorer's
  within 0.0000006. The scorer refused the 11 pairs whose two files leave out
  the same frames, the five of test L and the six of group N, with the new
  sentence; test L's scorer had scored them. It refused six with "Comparison
  presentation timestamps do not align", as in test L, and the three pairs of
  files of different lengths with "Comparison inputs have different frame
  counts", as test L's scorer did. The worker's code named each of the 20 a
  refusal of the pair, and the command scored each. The 12 pairs of group H
  that test L's scorers had scored otherwise than the command of the first
  change, and nine of group M, are among the 314: the command of the second
  change gave each the mean of "Neither late", as the scorers did.
- The 43 comparisons of the new groups. The check refused seven: three for
  the frame times (the screen recording in MP4, in two pairs, and the encode
  of 60 frames a second beside a reference of 120), the three HDR pairs, and
  the ProRes reference for its pixel format. The scorer refused three with the
  new sentence: the screen recording in Matroska, and the pairs whose frames
  are moved by up to 0.4 and 0.6 of an interval. It scored 33, with references
  in HEVC, VP9, AV1 and MPEG-2, at 120 and 120000/1001 frames a second, of 75
  and 90 seconds and of 3840x2160, and the late WebM, FLV, Matroska and MP4
  files: the CUDA scorer within 0.0000014 of the command, and the Vulkan
  scorer within 0.0000005.
- The 16 pairs of the whole measurements below. The check refused four, the
  scorer refused four, three of them with the new sentence and one with
  "Comparison presentation timestamps do not align", and scored eight, within
  0.0000004 of the command.

Whole measurements. Each of 16 pairs was measured six times as a VMAF
measurement of the product, through its web and worker processes, with the
worker images of the second change: on the Mac (arm64, no GPU) with **Local
(GPU if available)**, which scores on the CPU there (`GPU_RUNTIME_UNAVAILABLE`),
and with **Local CPU**; and on the host of test J with **Local CPU**, twice with
**Local (GPU if available)** and the CUDA scorer, and once with the Vulkan
scorer. Each of the 96 gave the mean of the command to within 0.000001 on the
CPU, or the scorer's on a GPU, and named the processor and the reason:

| Pair | Reference | Encode | Mean | The command of the first change | **Local (GPU if available)** on the host of test J |
|---|---|---|---|---|---|
| e01 | 1920x1080, MP4 | 1280x720, MP4 | 81.694097, and 81.692995 on x86-64 | the same | the GPU |
| e02 | WebM, 21 ms late | MP4 | 87.506782 | 65.744233 | the GPU |
| e03 | WebM | MP4 | 87.506782 | the same | the GPU |
| e04 | FLV, 21 ms late | MP4 | 87.384069 | 65.660688 | the GPU |
| e05 | Matroska, 120 frames a second, 4 ms late | MP4 | 79.892519 | 75.151704 | the GPU |
| e06 | Matroska, 90 seconds, 17 ms late | MP4 | 85.975454 | 76.870278 | the GPU |
| e07 | PQ in Matroska, 21 ms late | PQ, MP4 | 95.006348 | 72.259368 | the CPU, `GPU_PAIR_INPUT` |
| e08 | MP4, 21 ms late by an edit list | MP4 | 87.384069 | the same | the GPU |
| e09 | ProRes, QuickTime | MP4 | 88.724010 | the same | the CPU, `GPU_PAIR_PIXEL_FORMAT` |
| e10 | The screen recording, MP4 | MP4 | 89.770032 | the same | the CPU, `GPU_PAIR_FRAME_TIMES` before the run |
| e11 | Matroska, 120 frames a second | MP4, 60 frames a second | 72.270013 | the same | the CPU, `GPU_PAIR_FRAME_TIMES` before the run |
| e12 | Matroska, frame 50 of 150 left out | MP4, every frame | 88.772465 | the same | the CPU, after "Comparison presentation timestamps do not align" |
| q01 | Matroska, frame 50 of 150 left out | WebM, the same frame left out | 97.390791 | the same | the CPU, after the new sentence |
| q02 | Matroska, 103 of 150 left out | WebM, the same left out | 97.738364 | the same | the CPU, after the new sentence |
| q03 | Matroska, one frame in 24 kept of a part that stands still | WebM, the same | 98.844163 | the same | the CPU, after the new sentence |
| q04 | MP4 | VP9, WebM | 93.926388 | the same | the GPU |

A list of the worker's processes on the host of test J, taken during the
second CUDA run and the Vulkan run, showed for each pair the programs that the
report names: the scorer alone on the GPU for each GPU result, FFmpeg alone
for each pair that the check refused, and the scorer and then FFmpeg for each
pair that the scorer refused.

The cloud worker. The cloud worker (`apps/worker/scripts/vmaf-cloud-worker.mjs`)
ran on the Mac, in the worker image of the second change and in that of its
parent, with a stand-in for the storage and no provider, for the same 16 pairs,
with the manifest that the controller writes for a cloud measurement of the
ordinary method: the reference's size and frame rate from its probe, every
frame, four threads. With the second change, 11 gave the mean of the command
to within 0.000001. The other five ended as they did with the parent: e10,
whose reference has 132 frames in 240 intervals, with
`INPUT_FRAME_COUNT_MISMATCH` before the run, and the four whose reference leaves
frames out with `INCOMPLETE_FRAME_COVERAGE` after it, because the cloud worker
expects as many scored frames as the reference holds. With the parent, five of
the 11 gave the means of the first change: 65.744233 for e02, 65.660688 for
e04, 75.151704 for e05, 76.870278 for e06 and 72.259368 for e07.

Live. Whole Live measurements of 30 seconds, through the web and worker
processes, with the worker image of the second change and with that of its
parent, which holds the first change, on three channels whose output is fMP4
segments of two seconds of one looped source, 320x180 at 30 frames a second:
l1 as FFmpeg's HLS muxer writes them, on a clock of 1/15360 s; l4 the same
video on a clock of milliseconds, its first frame 1000 s and half an interval
after zero, so that the rounding puts its frames on both sides of the interval
borders; and l5 the same on the clock of 1/15360 s, as late, every frame on a
border. Each of the nine measurements gave 783 frames, a mean of 64.227129 and
the same score for each frame, and the six whose alignment was recorded found
an offset of 119 frames over 14 segments. One more run of l1, started while
the worker was still starting, captured 13 segments and gave 723 frames; run
again, it gave the 783. No whole Live measurement ran without the first
change: for that change the references written with the Live processor's
arguments ("The reference of a Live measurement" above) are the measurement.

The Live processor runs two passes over the clip of the encode: one with the
`fps` filter alone and `-an`, whose frames it aligns with the reference, and
the scoring command, which now has `setpts=PTS-STARTPTS` before the same
filter. Both read the clip's video alone. A clip of fMP4 or CMAF segments
holds the video alone, so the clip starts with its video. A clip of MPEG-TS
segments can hold audio as well, since a plan may give a TS muxing audio
streams, but FFmpeg starts an MPEG-TS input at the streams that it reads. In
the worker image of the second change, whose FFmpeg is n8.1.3, an MPEG-TS
clip of 300 frames at 30000/1001 whose video starts 38 ms after its AAC
audio: read alone, its video got the time 0 for its first frame, with
"Correcting start time of Input #0 by 38333 us", and the `fps` filter, with
and without `setpts=PTS-STARTPTS` before it, took 300 frames and gave 300,
dropping and repeating none; read with the audio, its first frame got
0.0383 s. The review of the change ran both passes, with FFmpeg 9.0.2, on 11
MPEG-TS clips whose audio starts with the file: five at 30000/1001 frames a
second, where half an interval is 16.68 ms, whose video starts 15.0, 16.0,
17.0, 18.0 and 27.0 ms after the audio, and six at 30, with exact times and
with times in milliseconds, whose video starts 38.3 ms (two), 50.0, 50.3 (two)
and 50.8 ms after it. In each, each pass took 300 frames and the two held the
same frame at each position; in the seven that were compared with their
decoded frames, each pass held each frame once. So `setpts=PTS-STARTPTS`
changes nothing for Live.

The acceptance scripts, at 12:13 to 12:15 in the worker image of the second
change. `apps/worker/scripts/vmaf-acceptance.sh` now runs the argv that the
image's own builder gives, in place of a copy of the command that had stayed
behind the builder, and passed: 65.146268 for `vmaf_v0.6.1` and 74.027285 for
the default model, `vmaf_v1.0.16_3d0h`, the values that it pins, and its PSNR
checks, with 33.72826 dB. The copy that it held before gave the same values.
`apps/worker/scripts/live-vmaf-acceptance.sh` passed: it found the offset of
37 frames that it knows, with a confidence of 0.988, over four loops, and gave
97.159 over 380 frames.

The filter on the new files. After `setpts=PTS-STARTPTS`, at each file's
`r_frame_rate`, as in "Seeing a file that leaves frames out" above, on the 79
files of the new groups and their controls: it dropped and repeated nothing in
68, the 63 whose frames come at the times of their frame rate, 15 of them
late, and five whose frames are moved by up to 0.2 or 0.4 of an interval. It
repeated 108 frames of each of the four screen recordings, whose 132 frames it
made 240, and 69 and 101 frames of two WebM files that leave frames out, and
it dropped 56 and repeated 57 frames of each of the two whose frames are moved
by up to 0.6. ffprobe gave three MP4 files whose frames are moved by up to 0.2
and 0.4 of an interval an `r_frame_rate` of 30000/1 or 2000/1, and the filter
made 149,989, 149,978 and 9,998 frames of their 150. The worker's code gives
the filter that rate when such a file is the reference: with the first of them
as the reference and a Matroska encode with the same frame times, each of the
three commands scored 150,180 frames, at 12:38 to 12:41. Neither change
touches how the worker reads the rate.

After the review of the change, from 13:27 to 14:26, in the same places: the
three commands in test I's container, and on the host of test J the worker's
code of the second change, bundled as for test L, with both scorers and the
`linux/amd64` command. Three new groups of H.264 files made from `testsrc2` at
384x216, each reference with an encode of the same pictures at less quality:

| Group | Comparisons | Pairs |
|---|---|---|
| RR | 6 | 125 frames at 25 frames a second in Matroska, progressive and interlaced, whose default duration says 20 ms, so that ffprobe gives 50/1 for both rates; and the same files with a default duration of 40 ms |
| HF2 | 6 | 480 frames at 240 frames a second in Matroska, whose times are whole milliseconds, and in MP4 on a clock of 1/15360 s; and 35,965 frames, ten minutes, at 60000/1001 in Matroska and in MP4 |
| EF | 5 | 72 frames at 24 frames a second, each in its interval, whose last frame lasts three intervals, in Matroska and in MP4; and the same files with an ordinary last frame |

A frame rate that is not that of the frames, group RR. A stream copy with
`-r 50` gives a file such a default duration, in its track header, while each
frame keeps its own duration of 40 ms; the default duration of an interlaced
file can be that of a field. "Frame by frame" is FFmpeg without the filter in
either chain:

| Reference and encode | v1.2.1 | The first and the second change | Frame by frame | The scorer of the second change | Test J's scorer |
|---|---|---|---|---|---|
| Both read as 50 | 1.629957 over 250 | 85.892344 over 250 | 87.566334 over 125 | refused with the new sentence | 87.566334 over 125 |
| Both read as 50, interlaced | 1.645563 over 250 | 86.477273 over 250 | 88.148983 over 125 | refused with the new sentence | 88.148983 over 125 |
| Both read as 25 | 87.566334 over 125 | the same | the same | the same | the same |
| Both read as 25, interlaced | 88.148983 over 125 | the same | the same | the same | the same |

The reference read as 50 with the encode read as 25 gave 1.629957 over 250
frames in v1.2.1 and 85.892344 since the first change, and the reference read
as 25 with the encode read as 50 gave 87.566334 over 125 with all three
commands; the check refused both pairs before the run, for their different
rates. Since the first change the filter gives each frame of a file read as
50 twice, in the reference's chain as in the encode's, and the command
compares the same moments; v1.2.1 numbered the reference's frames as they
came, beside an encode whose frames the filter had doubled, and compared
other moments. ffprobe's rates and frame count do not show such a file, and
the worker gives the filter the rate that ffprobe gives, as it does for the
three MP4 files above. The scorer of the second change, which compares the
frames in their order, refuses the first two pairs, because frame N of each
file lies at N/25 s and not at N/50, and the worker scores them on the CPU.
Test J's scorer, which has no such check, scored them frame by frame, 1.67
above the score of **Local CPU**, as did the scorer of the second change
without its new check (below).

High frame rates and long files, group HF2. Each of the three commands gave
80.196152 over 480 frames for the four pairs at 240 frames a second, where a
quarter of an interval is 1.04 ms, and 81.937638 over 35,965 frames for the
two of ten minutes. Both scorers gave the same for the four and for the long
Matroska pair. The check refused the long Matroska reference, of 19001/317,
beside the long MP4 encode, of 60000/1001, before the run, as in test L.

A last frame that lasts longer than one interval, group EF. The last frame
lasts as long as the last packet, which Matroska keeps as the last block's
duration and MP4 as the last sample's. The filter repeats such a frame for
each interval that it lasts, up to the end of the stream:

| Reference | Encode | v1.2.1 | The first and the second change | The scorer, both GPUs |
|---|---|---|---|---|
| Matroska, long last frame | MP4, ordinary | 86.963109 over 72 | 86.846459 over 74 | 86.963109 over 72 |
| Matroska, ordinary | MP4, ordinary | 86.963109 over 72 | the same | the same |
| Matroska, long last frame | Matroska, long last frame | 86.846459 over 74 | the same | 86.963109 over 72 |
| Matroska, ordinary | Matroska, long last frame | 86.846459 over 74 | the same | 86.963109 over 72 |
| MP4, long last frame | MP4, ordinary | 86.963109 over 72 | 86.846459 over 74 | refused before the run |

The encode's long last frame has been repeated since the first commit, and
the reference's since the first change. ffprobe gives a Matroska file of this
kind 24/1 for both rates and no frame count, and the scorer reads where each
frame starts, not how long the last one lasts: the check and the scorer took
the three pairs with such a file, and the scorer scored the 72 frames that
the files hold, 0.116650 above **Local CPU**. In MP4 the long last sample
lowers `avg_frame_rate` to 24000/1027, and the check refused the pair. The
cloud worker, in the worker image of the second change, as for the 16 pairs
above: the pair of the second row gave 86.963109 over 72 frames; those of the
first and the last row ended with `INCOMPLETE_FRAME_COVERAGE`, because the
command scored 74 frames where the cloud worker expects as many as the
reference holds, 72; and the ordinary Matroska reference with an MP4 encode
whose last frame lasts three intervals ended with `INPUT_FRAME_COUNT_MISMATCH`
before the run, because the cloud worker reckons the encode's frames after
the filter from its frame count and its `avg_frame_rate`, 73.94 beside the
reference's 72. In v1.2.1 the command scored 72 frames for the reference of
the first and the last row, and the cloud worker's two checks are those of
v1.2.1.

Over the GPU runs of test P with the scorer of the second change, but those of
the whole measurements, 496 rows, each GPU scored 349 different comparisons: 346
over the frames of **Local CPU**, whose means were within 0.0000016 of the
command's with CUDA (1.575e-06) and within 0.0000006 with Vulkan (5.353e-07),
and the three pairs above with a long last frame in Matroska, over 72 frames
beside 74. The scorer refused 25 different pairs, 16 with the new sentence, six
with "do not align" and three with "different frame counts", and the command
scored each. The 16 pairs of the whole measurements repeat 14 pairs of these
runs, each with the same result, the means equal to 12 decimals, and add two,
which the scorer refused with the new sentence.

The scorer's own tests. A copy of the scorer's source of the second change
without its new check, built with CUDA, Vulkan and the tests on the host of
test J at 13:27, failed one of its 54 CTest tests: `native_runner`, whose run
of a Matroska pair that leaves out the same frame expects the new sentence.
Installed without the tests, that copy scored the first two pairs of group RR
frame by frame, at 14:02. Its `decoder_retention_test`, run by hand with the
file that it reads, failed with "A frame outside its slot was accepted", where
that of the change passed. That test needs a file that is not in the repository,
so CTest ran it only where the build names a directory of such files, and no CI
job did; it alone held the two limits, a quarter of an interval between the
times of the two files and from the frame rate. After the review the test checks
those limits when it is given no file, and CTest runs it so on every build with
the tests (`decoder_frame_time_boundaries`), CI's `cpu-oracle` job included.
Built with CUDA, Vulkan and the tests at 14:23, the scorer after the review
(`1edd7be9`) passed 55 CTest tests of 55, and its decoder test passed without a
file and with it. Two copies of that source, each allowing half an interval in
one of the two limits and built at 14:25 as the CI job builds the scorer,
without a GPU backend, each failed `decoder_frame_time_boundaries` alone of 19
tests, with "A frame outside its slot was accepted" and "Timestamp drift beyond
the original boundary was accepted"; `native_runner` passed with either. The
scorer after the review gave groups RR and EF the results of the scorer of the
second change, on both GPUs, at 14:26: its source differs from that of
`1e4656dd` in a comment of `decoder_pair.hpp` and in the test and its
registration alone. The review of these fixes found that the CI test of the
frame-count sentence, in `tests/runner_test.py`, held its last words alone,
"different frame counts"; it now holds the whole sentence, as the test of the
new sentence does. Built as the CI job builds the scorer, at 14:49 to 14:50, the
source after the review passed 19 tests of 19 with that test; with the
sentence's first words changed in the scorer, to "Compared inputs have different
frame counts", `native_runner` failed alone, and with the earlier test all 19
passed.

Not measured: GPUs of other models or with other drivers; frame rates above
240 and pictures larger than 3840x2160; and a cloud measurement at a
provider, beyond the cloud worker above. The frame-index method has its own
command, which neither change touches: its builder returns before the frame
times are added and refuses a frame rate to conform to, and the unit tests
that hold its filters, without `fps`, pass unchanged.

### libvmaf and its thread count

Test I found a property of libvmaf that is not the scorer's: on arm64, for
pictures of some widths, the score depends on libvmaf's thread count, and with
more than one thread it can differ from run to run. Both libvmaf revisions show
it, that of this build (`f712fa7`) through FFmpeg and that of the scorer
(`74f930d1`).

Pairs of one size, 240 pixels high, 16 frames, `vmaf_v1.0.16_3d0h`, each run
once with one thread and twice with four, with both programs: 77 widths from
160 to 2168, 51 of them 16n+8. On arm64:

- With one thread, the two programs gave the same mean at every width.
- At 58 widths all six runs gave the same mean.
- At 19 widths they did not, and each is 16n+8: 168, 184, 200, 216, 232, 248
  and 264, where the six means were up to 2.12 apart (168x240: 29.773809 with
  one thread, and 30.975052, 28.859289, 29.185052 and 29.030721 with four);
  the eight widths from 280 to 392, where they were up to 0.0017 apart; 408 and
  424, where the runs with four threads were up to 0.000006 and 0.000001 from
  the run with one; and 456 and 472, where one of the four runs with four
  threads differed, by 0.005 and 0.006.
- No width that is not 16n+8 differed, and of the widths that are, neither 440
  nor any from 488 to 2168, 1080 among them.

The five comparisons of test I with such widths were run again with one thread
on both sides, twice: the two programs gave the same mean in all five, and the
same in both runs. One of them, 360x640, gave 47.988198 with one thread in
both programs. With four threads FFmpeg gave 48.575988 in each of the five
runs of test I, and the scorer's CPU reference in four of them, with 48.624643
in the fifth. A sixth run, in the review of PR #121, whose command also wrote
the pictures out, gave 48.099437 from FFmpeg.

For a pair of 216x160 the two programs' features were compared frame by frame,
twice, with four threads: `integer_adm3` differed by up to 0.034 on a frame and
the frame's score by up to 8.2, and CAMBI and motion were equal to the sixth
decimal.

On x86-64 the property did not show. Test J ran the 77 widths on the host of
the GPU check, with the `linux/amd64` programs of this build and the scorer's
CPU reference: all six runs gave the same mean at every width. The five
comparisons of test I gave one mean there with one thread and with four, from
FFmpeg and from both GPU backends. These means are not those of arm64, with one
thread either:

| Pictures | arm64, one thread | x86-64 |
|---|---|---|
| 216x160 | 9.207973 | 13.101292 |
| 216x160, the encode scaled from 128x72 | 11.004659 | 11.067871 |
| 216x160, another pair | 45.319437 | 45.796429 |
| 216x180 | 30.111653 | 30.887768 |
| 360x640 | 47.988198 | 56.274458 |

A pair of 160x216, a width that is not 16n+8, scored 37.944648 on both.

What follows for the product: a measurement compares at the reference's size,
so this concerns a reference of such a width, 360x640 for one, and not the
sizes of the encodes. On an arm64 worker, two measurements of one such pair can
differ, with **Local CPU** as well, because the worker's command sets
`n_threads` to the threads that it allots to the measurement; and the score of
such a pair on an arm64 worker is not its score on an x86-64 worker.

### The score of one pair on arm64 and on x86-64

The programs of this build do not give one score for one pair on both
architectures in every case. Tests I and J ran the same command on the same
files, with the `linux/arm64` programs in a container and with the
`linux/amd64` programs on the host of the GPU check. Of the 102 comparisons
that the worker's rule lets through and both scored:

| Comparisons | Kind | FFmpeg's mean on the two |
|---|---|---|
| 32 | one size, the encode in the reference's pixel format | equal to the sixth decimal in all |
| 38 | the encode is scaled, the comparison has 8 bits | different in all, by 0.003 to 0.26 |
| 15 | the encode is scaled, the comparison has 10 bits | equal in all |
| 6 | one size, the encode's format is converted, 8 bits | equal in the four with a 10-bit encode; different in the two with a 4:2:2 encode, by 0.010 and 0.091 |
| 6 | one size, the encode's format is converted, 10 bits | equal in all |
| 5 | pictures of 216 or 360 pixels in width | different in all, by 0.13 to 7.7 with four threads on arm64: "libvmaf and its thread count" |

With the clip of test J and `vmaf_v1.0.16_3d0h`, with four libvmaf threads on
arm64 and eight on x86-64:

| Reference | Encode | arm64 | x86-64 |
|---|---|---|---|
| 8-bit | 1920x1080 | 89.396735 | 89.396735 |
| 8-bit | 1280x720 | 83.057875 | 83.039229 |
| 8-bit | 960x540 | 76.537530 | 76.531548 |
| 8-bit | 640x360 | 65.656966 | 65.692018 |
| 10-bit | 1920x1080, 10-bit | 91.012434 | 91.012434 |
| 10-bit | 960x540, 10-bit | 78.861772 | 78.861772 |
| 10-bit | 960x540, 8-bit | 77.170642 | 77.170642 |
| 10-bit | 640x360, 8-bit | 66.870929 | 66.870929 |

For the second and the fourth row of the first table the cause is the scale
filter and not libvmaf, and the clip's table fits that: its row of one size and
its rows with the 10-bit reference are equal, and its scaled rows with the
8-bit reference are not. The pictures that the two `ffmpeg` programs make of
one of test I's files have the same MD5 when they are decoded only, when a
320x180 encode is scaled to 640x360 into 10-bit pictures, when a 4:2:2 encode
is converted to 4:2:0 into 10-bit pictures, and when a 10-bit encode is
converted to 8 bits. They differ when the filter scales the encode, or its
chroma, into 8-bit pictures. With `flags=bicubic+accurate_rnd+bitexact` the
scaled 8-bit pictures are the same on both, and they are those that arm64 gives
without these flags: the pictures of x86-64 are the ones that the flags change.
The worker's command does not set them.

For the last row the scale filter cannot be the only cause: four of the five
are pairs of one size in one format, which FFmpeg does not scale, and their
means differ between the architectures with one libvmaf thread as well
("libvmaf and its thread count"). What makes libvmaf give another score for
these widths on arm64 than on x86-64 was not looked for.

The scorer shows the same: on each architecture its CPU reference, with that
architecture's libswscale, gave the mean of that architecture's FFmpeg. For the
product: two scores of one pair from workers of different architectures can
differ by this much, with **Local CPU** on both as well, and a GPU score is the
**Local CPU** score of a worker of its own architecture.

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
- the comparisons of "The GPU scorer and small pictures" and of tests I and J
  ("GPU scoring and libvmaf through FFmpeg"), when the scorer in
  `native/vmaf-gpu` changes what it compares, how it converts a picture or
  what it declares to CAMBI, and also when FFmpeg, libvmaf, the command of a
  **Local CPU** measurement or the FFmpeg libraries that the scorer is built
  against change. The test of `packages/core/src/vmaf/native-comparison.ts`
  holds the worker's rule against the combinations that test I measured. The
  scorer's own test `tests/runner_test.py` fails when a run declares an encode
  to CAMBI, and when a full-range picture is not widened as the scale filter
  widens it. No test of the repository runs the scorer next to FFmpeg's
  libvmaf, and CI has no GPU: tests I and J are repeated by hand;
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
and so are the scripts and the result tables of tests C to J and of "The GPU
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
| 2026-11-13 13:40 to 13:58 | | The results of the first 111 comparisons of test I, on the scores of the changed GPU scorer's CPU reference and of libvmaf through FFmpeg, and of its two runs over 77 widths, were written |
| 2026-11-13 14:23 to 14:28 | | The five comparisons of test I at widths of 16n+8 with one thread, and the features of a 216x160 pair frame by frame |
| 2026-11-13 14:55 and 15:07 | | Ten more comparisons of test I, with 8-bit full-range files that ffprobe names `yuv420p` |
| 2026-11-13 15:12 to 15:27 | | The first run of test J on the host of the GPU check, with the scorer of the first commit of PR #121, and the run over 77 widths on x86-64 |
| 2026-11-13 15:42 | | Ten more comparisons of test I, with full-range pairs of one size: the scorer of the first commit of PR #121 scored one of them 0.42 below FFmpeg |
| 2026-11-13 15:47 to 15:51 | | Every comparison of test I again, with the changed conversion of a full-range picture and with the `fps` filter in FFmpeg's command: the numbers of "Test I" |
| 2026-11-13 15:53 to 16:01 | | Test J again with the changed conversion; it gave the numbers of the run after it |
| 2026-11-13 16:12 to 16:21 | | The scorer as PR #121 merged it, built on the host of the GPU check, and test J with it: the numbers of "Test J", of the 77 widths on x86-64 and of the pairs whose frames are not evenly spaced |
| 2026-11-13 16:59 to 17:14 | | The review of PR #121, in test I's container: the scorer's test with the scorer before the changed conversion and after it, the pictures of the scorer's decoder beside FFmpeg's for 62 pairs, 23 of them with encodes that test I does not hold, and the frame rates that ffprobe gives for interlaced files |
| 2026-11-13 23:57 to 2026-11-14 00:03 | | Test K in test I's container: the command of a **Local CPU** measurement before and after the `fps` filter in the reference's chain, but for its group L |
| 2026-11-14 00:02 to 00:16 | | The first run of test L on the host of the GPU check, and the scorer by itself on 12 pairs of the 384x216 set |
| 2026-11-14 00:26 to 00:36 | | The second run of test L, with the worker's code that names the scorer's refusals of a pair |
| 2026-11-14 00:28 | | Group L of test K: copies of the files whose video starts after their audio |
| 2026-11-14 00:39 to 00:43 | | The `fps` filter alone on the files of group H, in test I's container, and three pairs of files of different lengths on the host of the GPU check |
| 2026-11-14 01:40 | | Group M of test K: the `fps` filter alone, and the command before and after the change, on references whose video starts about one, one and a half, two and a half or three and a half intervals after their audio |
| 2026-11-14 01:52 | | Groups M and N on the host of the GPU check, after the review of PR #122: the worker's check, both scorers, the changed command and FFmpeg without the filter, on the 13 references of group M and on six pairs whose two files leave out the same frames |
| 2026-11-14 02:00 | | References written with the Live processor's arguments through the `fps` filter, in test I's container |
| 2026-11-14 08:24 to 08:28 | | The `fps` filter alone and a count of the video packets on the 588 stored media files, in test I's container |
| 2026-11-14 10:57 to 11:09 | | Test P in test I's container: the three commands on the pairs of test K and of the nine new groups |
| 2026-11-14 11:03 to 11:15 | | Test P on the host of test J: the worker's code, both scorers and the command of the second change on 479 comparisons |
| 2026-11-14 11:29 | | Test P in test I's container: the three commands on the 16 pairs of the whole measurements |
| 2026-11-14 11:32 to 11:47 | | Test P: the 96 whole VOD measurements, on the Mac and on the host of test J |
| 2026-11-14 11:34 | | Test P on the host of test J: both scorers on the 16 pairs of the whole measurements |
| 2026-11-14 12:02 to 12:10 | | Test P: the whole Live measurements, with the worker images of the second change and of its parent |
| 2026-11-14 12:07 to 12:08 | | Test P: the cloud worker, in the worker images of the second change and of its parent |
| 2026-11-14 12:13 to 12:15 | | Test P: `vmaf-acceptance.sh` and `live-vmaf-acceptance.sh` in the worker image of the second change |
| 2026-11-14 12:16 | | The filter after `setpts=PTS-STARTPTS` on the 588 stored media files and 76 files of the new groups, in test I's container |
| 2026-11-14 12:22 to 12:41 | | Test P in test I's container: the controls of the late files, and a reference whose `r_frame_rate` is 30000/1 |
| 2026-11-14 12:54 | | The filter after `setpts=PTS-STARTPTS` on the other three files of the new groups and their controls, in test I's container |
| 2026-11-14 13:27 to 13:29 | | Test P on the host of test J: the scorer of the second change without its new check, built with its tests, and the decoder test of each by hand |
| 2026-11-14 14:00 to 14:10 | | Test P after the review, in test I's container: the three commands on groups RR, HF2 and EF |
| 2026-11-14 14:01 to 14:10 | | Test P after the review on the host of test J: the worker's code, both scorers and the command on groups RR, HF2 and EF, and both scorers without the new check on group RR |
| 2026-11-14 14:11 to 14:12 | | Test P after the review: the cloud worker on four pairs of group EF, and an MPEG-TS clip with audio, in the worker image of the second change; the clip again at 14:25, for its log |
| 2026-11-14 14:22 to 14:26 | | The scorer after the review built with its tests on the host of test J, two copies with a wider frame-time limit built as CI builds the scorer, and groups RR and EF with that scorer and with test J's |
| 2026-11-14 14:49 to 14:50 | | Three builds of the scorer after the review as CI builds it, on the host of test J: with a runner test that holds the whole frame-count sentence, and with the first words of that sentence changed in the scorer, with that test and with the earlier one |

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

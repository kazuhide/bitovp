import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const emojiFont = "ADD --chmod=0644 --checksum=sha256:de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551 https://raw.githubusercontent.com/google/fonts/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf /usr/local/share/fonts/bitovp/NotoEmoji-wght.ttf";
const emojiLicense = "ADD --chmod=0644 --checksum=sha256:500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b https://raw.githubusercontent.com/google/fonts/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/OFL.txt /usr/local/share/licenses/noto-emoji/OFL.txt";
const cjkFont = "ADD --chmod=0644 --checksum=sha256:68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5 https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf /usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf";
const cjkLicense = "ADD --chmod=0644 --checksum=sha256:6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2 https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE /usr/local/share/fonts/bitovp/OFL.txt";

for (const name of ["Dockerfile", "Dockerfile.web"]) {
  const source = readFileSync(new URL("../" + name, import.meta.url), "utf8");
  test(name + " supplies the same pinned monochrome emoji font and separate OFL license", () => {
    assert.equal(source.split("\n").filter((line) => line === emojiFont).length, 1);
    assert.equal(source.split("\n").filter((line) => line === emojiLicense).length, 1);
    assert.ok(!source.includes("NotoColorEmoji"));
  });
  test(name + " gives the existing fontconfig provider standard discovery and caches the installed fonts", () => {
    const runtime = source.slice(source.lastIndexOf("FROM node:"));
    const install = runtime.split("&&").find((part) => part.includes("apt-get install"));
    assert.ok(install && /\bfontconfig\b/.test(install));
    assert.match(runtime, /fc-cache\s+-f\s+\/usr\/local\/share\/fonts\/bitovp/);
    assert.ok(runtime.indexOf("fc-cache") > runtime.indexOf(emojiFont));
    assert.ok(!runtime.includes("FONTCONFIG_FILE"));
  });
  test(name + " retains the exact existing CJK bytes, license and primary editing font path", () => {
    assert.equal(source.split("\n").filter((line) => line === cjkFont).length, 1);
    assert.equal(source.split("\n").filter((line) => line === cjkLicense).length, 1);
    assert.ok(source.includes("ENV EDITING_FONT_PATH=/usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf"));
  });
}

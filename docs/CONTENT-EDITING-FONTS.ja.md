# 編集用フォントと単色emoji fallback

字幕の原文・訳・時刻・行分割・word offsetを変えず、描画側が持つglyphを補う。主フォントは既存のNoto Sans CJK JPのままで、既存OTFとOFLのcommit/SHAとEDITING_FONT_PATHは維持する。

追加候補はGoogle公式[monochrome Noto Emojiの案内](https://github.com/googlefonts/noto-emoji#monochrome-font)から辿れる[Google Fonts metadata](https://github.com/google/fonts/blob/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/METADATA.pb)に対応する、Noto Emoji variable font。font原本はcommit `b979dba422e445492b0eb9951ac52ee0b4d648c3`の`NotoEmoji[wght].ttf`を変更せず使う。配布[OFL.txt](https://github.com/google/fonts/blob/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/OFL.txt)を既存CJKのlicenseとは別のpathへ置く。

| 原本 | SHA256 | 配備先 |
|---|---|---|
| Noto Emoji（単色variable TTF） | `de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551` | `/usr/local/share/fonts/bitovp/NotoEmoji-wght.ttf` |
| Noto Emoji OFL1.1 | `500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b` | `/usr/local/share/licenses/noto-emoji/OFL.txt` |
| 既存CJK（変更なし） | `68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5` | `/usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf` |

公的原本のcmap静的解析では、🙂 U+1F642は既存CJKでglyphId0、新Noto EmojiでglyphId961。新TTFの該当glyfは254bytes/5contours/非空bboxで、COLR/CPAL/CBDT/CBLC/sbix/SVGのcolor tableを持たない。これはマッピングとoutlineの存在確認で、実際のフォント選択やglyph rasterizationの合格とは分ける。全Unicode/emoji sequenceの網羅を保証しない。

旧immutable imageの限定probeでは、libassがfontconfig providerを選ぶ一方で標準configを読めずfallbackへ進み、🙂のfallback glyphを見付けられないログが残った。fc-match、/etc/fonts/fonts.confとconf.dも存在しなかった。動的libfontconfig.soがないことは、static provider実装がない証明とはしない。

この根拠に基づき、worker/webの既存runtime apt installへ[Debian標準fontconfig package](https://packages.debian.org/bookworm/fontconfig)を加え、固定font設置後にfc-cacheを作る。このpackageはfontconfig-configへ依存し、font discoveryとcache/matching用のコマンドを提供する。独自XMLやFONTCONFIG_FILE、rendererのfontsdir copyロジックは増やさない。ASSの主フォントとCJK bytesは保持し、標準font discoveryから不足glyphを得る。新imageの実fontselect/PNGは元native比較と分けて確認し、その成功前にglyph描画の修正完了とは扱わない。

browser Canvasは既存の組織認証付きfont GETでCJKを読み、そのclient OS/browserのfallbackも利用する。Docker内のfont追加を、browserへ同じemoji fontを配布した結果と呼ばない。C06の受入は元text・行数・UTF16 offset・表示内容で、異なる描画器のantialias pixel完全一致ではない。

チェック入口: `rtk proxy node --test scripts/editing-fonts.test.mjs`。これは固定配布行/別OFL/既存CJK保持の静的回帰で、実Docker buildや描画検証の代用ではない。新font imageの実結果は、font未追加の旧/新renderer計測結果へ混ぜない。

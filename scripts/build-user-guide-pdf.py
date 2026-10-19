# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "fonttools==4.67.0",
#   "markdown-it-py==4.2.0",
#   "pillow==13.0.0",
#   "reportlab==5.0.1",
# ]
# ///
"""Build the Japanese user guide: uv run scripts/build-user-guide-pdf.py.

The first build downloads the pinned, OFL-licensed Noto Sans JP font into the
user cache. Application credentials and services are not used.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import os
import re
from datetime import date
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import urlopen

from fontTools.ttLib import TTFont as SourceFont
from fontTools.varLib.instancer import instantiateVariableFont
from markdown_it import MarkdownIt
from PIL import Image as RasterImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    HRFlowable,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents


ROOT = Path(__file__).resolve().parents[1]
FONT_REVISION = "47d54ca1ebb14fd864695f1d39dc734f39017c33"
FONT_BASE = f"https://raw.githubusercontent.com/google/fonts/{FONT_REVISION}/ofl/notosansjp"
FONT_FILES = {
    "NotoSansJP-variable.ttf": (
        "NotoSansJP%5Bwght%5D.ttf",
        "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f",
    ),
    "OFL.txt": (
        "OFL.txt",
        "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
    ),
}
INK = colors.HexColor("#172421")
GREEN = colors.HexColor("#14654f")
MUTED = colors.HexColor("#54605b")
RULE = colors.HexColor("#d9e2dd")
PALE = colors.HexColor("#f3f7f4")
PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN = 18 * mm
CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN

# Crops retain the original screenshot pixels and emphasize the content area.
SCREENSHOT_CROPS = {
    "vod-settings.png": (265, 230, 800, 830),
    "vod-job.png": (245, 55, 1425, 990),
    "live-settings.png": (265, 110, 805, 940),
    "live-monitoring.png": (245, 55, 1425, 990),
    "dashboard.png": (245, 90, 1425, 960),
    "quality.png": (245, 55, 1425, 990),
}


def prepare_fonts(directory: Path) -> set[int]:
    directory.mkdir(parents=True, exist_ok=True)
    for name, (remote, expected) in FONT_FILES.items():
        path = directory / name
        if path.exists():
            data = path.read_bytes()
        else:
            with urlopen(f"{FONT_BASE}/{remote}", timeout=30) as response:
                data = response.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            raise ValueError(f"Font download exceeds the size limit: {name}")
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Font checksum mismatch: {name}")
        if not path.exists():
            path.write_bytes(data)

    variable = directory / "NotoSansJP-variable.ttf"
    for suffix, weight, alias in [("Regular", 400, "JP"), ("SemiBold", 600, "JP-Bold")]:
        font = SourceFont(variable, recalcTimestamp=False)
        instantiateVariableFont(font, {"wght": weight}, inplace=True, updateFontNames=True)
        path = directory / f"NotoSansJP-{suffix}.ttf"
        font.save(path)
        pdfmetrics.registerFont(TTFont(alias, str(path)))
        font.close()
    pdfmetrics.registerFontFamily("JP", normal="JP", bold="JP-Bold", italic="JP", boldItalic="JP-Bold")
    font = SourceFont(variable)
    codepoints = set(font.getBestCmap())
    font.close()
    return codepoints


def styles() -> dict[str, ParagraphStyle]:
    body = ParagraphStyle(
        "Body", fontName="JP", fontSize=9.5, leading=16.3,
        wordWrap="CJK", alignment=TA_LEFT, textColor=INK,
        spaceAfter=8, allowWidows=0, allowOrphans=0,
    )
    return {
        "body": body,
        "chapter": ParagraphStyle(
            "Chapter", parent=body, fontName="JP-Bold", fontSize=18,
            leading=26, textColor=GREEN, spaceAfter=18, keepWithNext=True,
        ),
        "section": ParagraphStyle(
            "Section", parent=body, fontName="JP-Bold", fontSize=12,
            leading=19, spaceBefore=13, spaceAfter=7, keepWithNext=True,
        ),
        "subsection": ParagraphStyle(
            "Subsection", parent=body, fontName="JP-Bold", fontSize=10,
            leading=17, spaceBefore=8, spaceAfter=5, keepWithNext=True,
        ),
        "list": ParagraphStyle(
            "List", parent=body, leftIndent=15, bulletIndent=0,
            bulletFontName="JP", bulletFontSize=9.5, spaceAfter=5,
        ),
        "cell": ParagraphStyle("Cell", parent=body, fontSize=8.5, leading=13.6, spaceAfter=0),
        "headcell": ParagraphStyle(
            "HeadCell", parent=body, fontName="JP-Bold", fontSize=8.5,
            leading=13.6, textColor=colors.white, spaceAfter=0,
        ),
        "caption": ParagraphStyle("Caption", parent=body, fontSize=8, leading=13, textColor=MUTED),
        "code": ParagraphStyle(
            "Code", parent=body, fontSize=8, leading=12.8, backColor=PALE,
            borderPadding=9, spaceBefore=7, spaceAfter=12,
        ),
        "toc": ParagraphStyle(
            "TOC", parent=body, fontSize=10, leading=21,
            rightIndent=25, spaceBefore=0, spaceAfter=1,
        ),
    }


class Screenshot(Flowable):
    def __init__(self, path: Path):
        super().__init__()
        self.path = path
        self.hAlign = "CENTER"
        with RasterImage.open(path) as image:
            self.pixels = image.size
        self.crop = SCREENSHOT_CROPS.get(path.name, (0, 0, *self.pixels))
        x, y, width, height = self.crop
        if x < 0 or y < 0 or x + width > self.pixels[0] or y + height > self.pixels[1]:
            raise ValueError(f"Screenshot crop lies outside the image: {path.name}")

    def wrap(self, available_width, available_height):
        self.scale = min(available_width / self.crop[2], 520 / self.crop[3])
        self.width = self.crop[2] * self.scale
        self.height = self.crop[3] * self.scale
        return self.width, self.height

    def draw(self):
        x, y, width, height = self.crop
        self.canv.saveState()
        clip = self.canv.beginPath()
        clip.rect(0, 0, self.width, self.height)
        self.canv.clipPath(clip, stroke=0, fill=0)
        self.canv.drawImage(
            str(self.path), -x * self.scale,
            -(self.pixels[1] - y - height) * self.scale,
            width=self.pixels[0] * self.scale, height=self.pixels[1] * self.scale,
            mask="auto",
        )
        self.canv.restoreState()
        self.canv.setStrokeColor(RULE)
        self.canv.setLineWidth(0.5)
        self.canv.rect(0, 0, self.width, self.height)


class Guide(BaseDocTemplate):
    def __init__(self, output: Path, edition: str, paragraph_styles):
        super().__init__(
            str(output), pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
            topMargin=23 * mm, bottomMargin=22 * mm,
            title="bitovp ユーザーガイド", author="bitovp",
            subject="Bitmovin エンコーダー用 GUI の利用手順",
            creator="bitovp documentation",
        )
        self.edition = edition
        self.paragraph_styles = paragraph_styles
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates(PageTemplate(id="guide", frames=frame, onPage=self.decorate))

    def decorate(self, canvas, document):
        canvas.saveState()
        if document.page > 1:
            canvas.setFont("JP", 8)
            canvas.setFillColor(MUTED)
            canvas.drawString(MARGIN, PAGE_HEIGHT - 13 * mm, "bitovp  /  ユーザーガイド")
            canvas.setStrokeColor(RULE)
            canvas.setLineWidth(0.4)
            canvas.line(MARGIN, PAGE_HEIGHT - 16 * mm, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 16 * mm)
            canvas.drawString(MARGIN, 12 * mm, self.edition)
            canvas.drawRightString(PAGE_WIDTH - MARGIN, 12 * mm, str(document.page))
        else:
            canvas.showOutline()
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if not isinstance(flowable, Paragraph):
            return
        if flowable.style.name not in {"Chapter", "Section"}:
            return
        text = flowable.getPlainText()
        key = "heading-" + hashlib.sha256(text.encode()).hexdigest()[:16]
        level = 0 if flowable.style.name == "Chapter" else 1
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(text, key, level=level, closed=level == 0)
        if level == 0:
            self.notify("TOCEntry", (0, text, self.page, key))


def inline_markup(children, source: Path) -> str:
    result = []
    for token in children or []:
        kind = token.type
        if kind == "text":
            result.append(html.escape(token.content))
        elif kind == "code_inline":
            result.append(f'<font color="#14654f">{html.escape(token.content)}</font>')
        elif kind in {"strong_open", "strong_close"}:
            result.append("<b>" if kind.endswith("open") else "</b>")
        elif kind in {"em_open", "em_close"}:
            result.append("<i>" if kind.endswith("open") else "</i>")
        elif kind == "link_open":
            href = token.attrGet("href") or ""
            if not urlparse(href).scheme:
                if href.startswith("#"):
                    raise ValueError("Use chapter names instead of Markdown fragment links")
                path = (source.parent / href).resolve()
                if not path.is_relative_to(ROOT):
                    raise ValueError("Document link lies outside the repository")
                href = "https://github.com/kazuhide/bitovp/blob/main/" + quote(path.relative_to(ROOT).as_posix())
            if urlparse(href).scheme not in {"https", "http"}:
                raise ValueError("Unsupported document link scheme")
            result.append(f'<a href="{html.escape(href, quote=True)}" color="#14654f"><u>')
        elif kind == "link_close":
            result.append("</u></a>")
        elif kind in {"softbreak", "hardbreak"}:
            result.append(" " if kind == "softbreak" else "<br/>")
        elif kind == "image":
            raise ValueError("Images must occupy their own paragraph")
        else:
            raise ValueError(f"Unsupported inline Markdown: {kind}")
    return "".join(result)


def render_markdown(text: str, source: Path, paragraph_styles) -> list:
    tokens = MarkdownIt("commonmark").enable("table").parse(text)
    story = []
    lists = []
    pending_bullet = None
    index = 0
    while index < len(tokens):
        token = tokens[index]
        kind = token.type
        if kind == "heading_open":
            level = int(token.tag[1:])
            content = tokens[index + 1]
            if level == 2:
                story.append(PageBreak())
            if level > 1:
                style = paragraph_styles["chapter" if level == 2 else "section" if level == 3 else "subsection"]
                story.append(Paragraph(inline_markup(content.children, source), style))
            index += 3
            continue
        if kind in {"bullet_list_open", "ordered_list_open"}:
            lists.append(None if kind == "bullet_list_open" else int(token.attrGet("start") or 1))
        elif kind in {"bullet_list_close", "ordered_list_close"}:
            lists.pop()
            story.append(Spacer(1, 4))
        elif kind == "list_item_open":
            pending_bullet = "•" if lists[-1] is None else f"{lists[-1]}."
            if lists[-1] is not None:
                lists[-1] += 1
        elif kind == "paragraph_open":
            content = tokens[index + 1]
            children = content.children or []
            if len(children) == 1 and children[0].type == "image":
                image = children[0]
                path = (source.parent / (image.attrGet("src") or "")).resolve()
                if not path.is_relative_to(ROOT) or path.suffix.lower() != ".png":
                    raise ValueError("Screenshot must be a PNG inside the repository")
                caption = html.escape(image.content)
                next_index = index + 3
                if next_index + 2 < len(tokens) and tokens[next_index].type == "paragraph_open":
                    following = tokens[next_index + 1]
                    if following.content.startswith("図"):
                        caption = inline_markup(following.children, source)
                        next_index += 3
                full_size = "https://kazuhide.github.io/bitovp/screenshots/ja/" + quote(path.name)
                story.append(Spacer(1, 8))
                story.append(KeepTogether([
                    Screenshot(path), Spacer(1, 6),
                    Paragraph(f'{caption} <a href="{full_size}" color="#14654f"><u>原寸の画像</u></a>', paragraph_styles["caption"]),
                ]))
                story.append(Spacer(1, 6))
                pending_bullet = None
                index = next_index
                continue
            else:
                style = paragraph_styles["list"] if lists else paragraph_styles["body"]
                story.append(Paragraph(inline_markup(children, source), style, bulletText=pending_bullet))
            pending_bullet = None
            index += 3
            continue
        elif kind == "fence":
            lines = token.content.rstrip().splitlines()
            body = "<br/>".join(html.escape(line).replace(" ", "&#160;") for line in lines)
            story.append(Paragraph(body, paragraph_styles["code"]))
        elif kind == "table_open":
            rows = []
            row = None
            header = False
            index += 1
            while tokens[index].type != "table_close":
                cell = tokens[index]
                if cell.type == "thead_open":
                    header = True
                elif cell.type == "thead_close":
                    header = False
                elif cell.type == "tr_open":
                    row = []
                elif cell.type == "inline" and row is not None:
                    style = paragraph_styles["headcell" if header else "cell"]
                    row.append(Paragraph(inline_markup(cell.children, source), style))
                elif cell.type == "tr_close":
                    rows.append(row)
                    row = None
                index += 1
            columns = len(rows[0])
            ratios = {2: [0.29, 0.71], 3: [0.25, 0.29, 0.46], 4: [0.21, 0.26, 0.16, 0.37]}.get(columns)
            if ratios is None or any(len(row) != columns for row in rows):
                raise ValueError("Guide tables must have 2, 3 or 4 consistent columns")
            table = Table(rows, colWidths=[CONTENT_WIDTH * ratio for ratio in ratios], repeatRows=1, hAlign="LEFT", splitByRow=1, splitInRow=1, spaceBefore=5, spaceAfter=12)
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), GREEN),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("LINEBELOW", (0, 0), (-1, 0), 0.5, GREEN),
                ("LINEBELOW", (0, 1), (-1, -1), 0.3, RULE),
            ]))
            story.append(table)
        elif kind == "hr":
            story.append(HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=8, spaceAfter=12))
        elif kind not in {"list_item_close", "blockquote_open", "blockquote_close"}:
            raise ValueError(f"Unsupported block Markdown: {kind}")
        index += 1
    return story


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "docs/user-guide/USER-GUIDE.ja.md")
    parser.add_argument("--output", type=Path, default=ROOT / "output/pdf/bitovp-user-guide-ja.pdf")
    parser.add_argument("--font-directory", type=Path, default=Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "bitovp/pdf-fonts")
    parser.add_argument("--edition", default=date.today().strftime("%Y年%m月版"))
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    output = args.output.resolve()
    if output == source:
        parser.error("Output must differ from the Markdown source")
    text = source.read_text(encoding="utf-8")
    codepoints = prepare_fonts(args.font_directory)
    missing = sorted({character for character in text if not character.isspace() and ord(character) not in codepoints})
    if missing:
        raise ValueError(f"Source contains unsupported font characters: {missing}")
    paragraph_styles = styles()
    output.parent.mkdir(parents=True, exist_ok=True)
    document = Guide(output, args.edition, paragraph_styles)
    cover_title = ParagraphStyle("CoverTitle", parent=paragraph_styles["body"], fontName="JP-Bold", fontSize=26, leading=38, spaceAfter=20)
    cover_brand = ParagraphStyle("CoverBrand", parent=cover_title, fontSize=38, leading=48, textColor=GREEN, spaceAfter=25)
    cover_subtitle = ParagraphStyle("CoverSubtitle", parent=paragraph_styles["section"])
    contents_title = ParagraphStyle("ContentsTitle", parent=paragraph_styles["chapter"])
    story = [
        Spacer(1, 40 * mm), Paragraph("bitovp", cover_brand),
        HRFlowable(width=48 * mm, thickness=2, color=GREEN, hAlign="LEFT", spaceAfter=22),
        Paragraph("ユーザーガイド", cover_title),
        Paragraph("Bitmovin エンコーダー用 GUI", cover_subtitle),
        Spacer(1, 12 * mm),
        Paragraph("VOD・Live の設定と運用、画質評価、ライブラリ、共通設定", paragraph_styles["body"]),
        Paragraph(html.escape(args.edition), paragraph_styles["body"]),
        Spacer(1, 22 * mm),
        Paragraph('紹介ページ・操作デモ：<a href="https://kazuhide.github.io/bitovp/ja/" color="#14654f"><u>kazuhide.github.io/bitovp/ja/</u></a>', paragraph_styles["body"]),
        PageBreak(), Paragraph("目次", contents_title),
    ]
    toc = TableOfContents()
    toc.levelStyles = [paragraph_styles["toc"]]
    toc.dotsMinLevel = 0
    story.append(toc)
    story.extend(render_markdown(text, source, paragraph_styles))

    def canvas_factory(*arguments, **keywords):
        keywords["lang"] = "ja-JP"
        return Canvas(*arguments, **keywords)

    document.multiBuild(story, canvasmaker=canvas_factory)
    print(f"Built {output}: {document.page} pages, {output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()

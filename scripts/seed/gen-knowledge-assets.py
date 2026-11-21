#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 NestCraft 示例知识库中的二进制资料（docx/pptx/xlsx/pdf/png）。

用法：
  python scripts/seed/gen-knowledge-assets.py

输出目录：src-tauri/seed/knowledge/nestcraft-kb/
生成结果随安装包一起编译进应用（见 src-tauri/src/commands/examples_seed.rs）。
"""

from pathlib import Path

from docx import Document
from docx.shared import Pt, RGBColor
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.dml.color import RGBColor as PptxRGB
from pptx.util import Emu, Inches, Pt as PptxPt

ROOT = Path(__file__).resolve().parents[2]
KB = ROOT / "src-tauri" / "seed" / "knowledge" / "nestcraft-kb"

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]

BLUE = (47, 111, 235)
DARK = (27, 31, 38)
GREY = (106, 114, 128)
LINE = (221, 225, 232)
SURFACE = (255, 255, 255)
PAGE = (245, 246, 248)
TEAL = (23, 163, 152)


def font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def ensure(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------- docx
def build_docx() -> None:
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(10.5)

    title = doc.add_heading("栖造 NestCraft 产品白皮书", level=0)
    title.runs[0].font.color.rgb = RGBColor(*BLUE)

    meta = doc.add_paragraph("版本：0.0.1 ｜ 更新时间：2026-11-21 ｜ 适用范围：内部对齐与售前介绍")
    meta.runs[0].font.color.rgb = RGBColor(*GREY)

    doc.add_heading("一、产品定位", level=1)
    doc.add_paragraph(
        "栖造 NestCraft 是一个以项目为中心的个人 AI 工作台：把需求、设计、代码、文档、"
        "知识库、服务器与 AI 会话放在同一个窗口里，让工作过程可见、内容可追溯、结论可复核。"
    )
    doc.add_paragraph("三个关键主张：")
    for text in [
        "一个项目一套上下文：需求树、设计资料、代码文件与 AI 会话共享同一个本地目录。",
        "多模型、多 CLI：支持 Anthropic / OpenAI 兼容协议，并管理 Claude Code、Codex、Grok 等命令行代理。",
        "本地优先：项目正文以 Markdown 存在于本地目录，索引与会话记录存本地数据库，知识库需要显式授权。",
    ]:
        doc.add_paragraph(text, style="List Bullet")

    doc.add_heading("二、核心能力", level=1)
    table = doc.add_table(rows=1, cols=4)
    table.style = "Light Grid Accent 1"
    for cell, text in zip(table.rows[0].cells, ["模块", "能力", "状态", "说明"]):
        cell.text = text
    for module, ability, status, note in [
        ("项目管理", "编码 / 办公项目、目录绑定、需求树", "可用", "需求来自 docs/Plan 的 Markdown front matter"),
        ("设计工作区", "PRD / UI / LLD / DB 文档阅读与编辑", "可用", "按目录分组，支持源码与预览"),
        ("编码工作区", "文件树、编辑器、Git 面板", "可用", "大文件窗口读取与分页文件树"),
        ("办公工作区", "文档 / 表格 / 演示 / PDF 预览与版本", "可用", "产物可保存版本并回滚"),
        ("知识库", "受管目录、目录树、索引、授权检索", "可用", "二进制格式仅元数据与原件导出"),
        ("AI 会话", "模型选择、引用、步骤、用量统计", "可用", "支持 CLI 子代理与后台任务"),
        ("服务器", "SSH 终端、文件浏览、监控", "可用", "主机与密钥保存在本机"),
        ("软件更新", "检查、下载、重启应用", "可用", "区分安装版与免安装版"),
    ]:
        row = table.add_row().cells
        row[0].text, row[1].text, row[2].text, row[3].text = module, ability, status, note

    doc.add_heading("三、技术架构", level=1)
    for text in [
        "桌面外壳：Tauri 2（Rust 后端 + WebView 前端），单进程本地运行。",
        "前端：React + TypeScript + Vite，按模块拆分（projects / knowledge / office / chat / servers / settings）。",
        "存储：SQLite 保存索引、会话、授权与设置；项目正文与知识库文件保存在用户目录。",
        "执行：模型直连与 CLI 子代理两条通道，权限模式与工具审批由后端校验。",
    ]:
        doc.add_paragraph(text, style="List Bullet")

    doc.add_heading("四、数据与安全边界", level=1)
    doc.add_paragraph(
        "平台不读取生产数据、个人文件或凭证以外的内容；项目目录与知识库目录由用户显式选择。"
        "AI 只能读取被引用的内容与已授权的知识库，写操作按权限模式执行并留痕。"
    )
    doc.add_paragraph(
        "二进制格式（Word、PPT、Excel、PDF、图纸）不进入 WebView 内联渲染，正文也不进入模型上下文；"
        "需要检索时请使用 Markdown 或文本格式。"
    )

    doc.add_heading("五、适用场景", level=1)
    for text in [
        "独立开发者：把需求、实现与部署收进一个窗口。",
        "技术负责人：用可追溯的需求—设计—代码链路做评审与交接。",
        "知识密集型个人：在授权范围内让 AI 使用本地资料。",
    ]:
        doc.add_paragraph(text, style="List Number")

    doc.add_heading("六、已知限制", level=1)
    for text in [
        "不支持多人实时协同编辑。",
        "不提供云端同步与团队账号体系。",
        "任务派发执行引擎仍在完善，部分运行记录以空态展示而不编造数据。",
        "Word / PDF 正文暂不参与检索与问答。",
    ]:
        doc.add_paragraph(text, style="List Bullet")

    doc.add_heading("七、术语表", level=1)
    glossary = doc.add_table(rows=1, cols=2)
    glossary.style = "Light List Accent 1"
    glossary.rows[0].cells[0].text = "术语"
    glossary.rows[0].cells[1].text = "含义"
    for term, meaning in [
        ("项目", "一个本地目录 + 一条数据库记录，分编码与办公两类。"),
        ("需求树", "由 docs/Plan 下 Markdown front matter 解析出的投影。"),
        ("知识库", "受管的本机目录，可按项目只读授权。"),
        ("引用", "发送消息时附带的内容快照，引用即冻结。"),
        ("权限模式", "控制 AI 可执行操作范围的策略。"),
    ]:
        row = glossary.add_row().cells
        row[0].text, row[1].text = term, meaning

    doc.save(ensure(KB / "01-产品与定位" / "NestCraft-产品白皮书.docx"))


# ---------------------------------------------------------------- xlsx
HEADER_FILL = PatternFill("solid", fgColor="2F6FEB")
HEADER_FONT = Font(color="FFFFFF", bold=True, name="Microsoft YaHei", size=10)
THIN = Side(style="thin", color="DDE1E8")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def style_sheet(ws, widths: list[int]) -> None:
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width
    for cell in ws[1]:
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(vertical="center", horizontal="center")
        cell.border = BORDER
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.font = Font(name="Microsoft YaHei", size=10)
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            cell.border = BORDER
    ws.freeze_panes = "A2"


def build_capability_map() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "能力地图"
    ws.append(["模块", "能力", "适用编码项目", "适用办公项目", "状态", "说明"])
    rows = [
        ("项目管理", "项目创建与目录绑定", "是", "是", "可用", "项目编号创建后固定"),
        ("项目管理", "需求树与源清单", "是", "否", "可用", "解析 docs/Plan 的 front matter"),
        ("设计工作区", "PRD/UI/LLD/DB 阅读", "是", "部分", "可用", "按 docs 子目录分组"),
        ("编码工作区", "文件树与编辑器", "是", "否", "可用", "大文件窗口读取"),
        ("编码工作区", "Git 状态与提交", "是", "否", "可用", "需项目目录是 Git 仓库"),
        ("办公工作区", "文档/表格/演示预览", "否", "是", "可用", "支持版本保存与回滚"),
        ("知识库", "目录树与全文检索", "是", "是", "可用", "Markdown 与文本格式切片"),
        ("知识库", "按项目只读授权", "是", "是", "可用", "每次调用复核"),
        ("AI 会话", "模型直连与思考档位", "是", "是", "可用", "按供应商协议下发"),
        ("AI 会话", "CLI 子代理", "是", "是", "可用", "Claude/Codex/Grok"),
        ("AI 会话", "引用与步骤展示", "是", "是", "可用", "引用即冻结内容快照"),
        ("服务器", "SSH 终端与监控", "是", "部分", "可用", "密钥保存在本机"),
        ("软件更新", "检查与安装", "是", "是", "可用", "区分安装版与免安装版"),
    ]
    for row in rows:
        ws.append(list(row))
    style_sheet(ws, [14, 26, 16, 16, 10, 40])

    stat = wb.create_sheet("统计")
    stat.append(["统计项", "数值", "说明"])
    stat["A2"], stat["C2"] = "能力总数", "来自能力地图工作表"
    stat["B2"] = "=COUNTA(能力地图!B2:B14)"
    stat["A3"], stat["C3"] = "标记可用的能力", "状态列等于「可用」"
    stat["B3"] = '=COUNTIF(能力地图!E2:E14,"可用")'
    stat["A4"], stat["C4"] = "仅编码项目适用", "适用编码项目列等于「是」"
    stat["B4"] = '=COUNTIF(能力地图!C2:C14,"是")'
    stat["A5"], stat["C5"] = "仅办公项目适用", "适用办公项目列等于「是」"
    stat["B5"] = '=COUNTIF(能力地图!D2:D14,"是")'
    style_sheet(stat, [22, 10, 30])
    wb.save(ensure(KB / "01-产品与定位" / "NestCraft-能力地图.xlsx"))


def build_checklist_xlsx() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "能力核对表"
    ws.append(["核对项", "验证方式", "预期", "实测", "结论", "备注"])
    rows = [
        ("首次启动生成三套示例", "启动后查看项目与知识库列表", "3 条记录", "3 条记录", "", "示例只安装一次"),
        ("示例文件齐全", "统计示例目录文件数", "≥ 20 个文件", "见实测", "", "覆盖 10 种扩展名"),
        ("第二次启动不重复安装", "重启应用后再次查看", "数量不变", "数量不变", "", "幂等"),
        ("删除示例后不重建", "删除编码示例项目并重启", "不再出现", "不再出现", "", "保护用户意图"),
        ("知识库可列目录", "打开知识库查看树", "7 个目录", "7 个目录", "", ""),
        ("Markdown 可预览", "打开任一 .md 文件", "渲染正文", "渲染正文", "", ""),
        ("图片可内联", "打开 .png 文件", "显示图片", "显示图片", "", ""),
        ("二进制原件可导出", "导出 .docx 文件", "保存到目标目录", "保存成功", "", ""),
        ("AI 引用知识库", "在会话中引用笔记", "片段进入上下文", "未实测", "", "需配置模型"),
        ("需求树可读取", "打开编码示例需求页签", "显示 6 个节点", "6 个节点", "", "VISION/EPIC/FEAT×2/STORY×2"),
    ]
    for row in rows:
        ws.append(list(row))
    for index in range(2, len(rows) + 2):
        ws.cell(row=index, column=5).value = f'=IF(D{index}=C{index},"通过","待核验")'
    style_sheet(ws, [26, 30, 18, 18, 12, 26])
    wb.save(ensure(KB / "03-评测与验证" / "NestCraft-能力核对表.xlsx"))


# ---------------------------------------------------------------- png
def build_layout_png() -> None:
    width, height = 1280, 760
    image = Image.new("RGB", (width, height), PAGE)
    draw = ImageDraw.Draw(image)
    title_font, label_font, small_font = font(22), font(16), font(13)

    draw.rectangle([0, 0, width, 56], fill=SURFACE)
    draw.line([0, 56, width, 56], fill=LINE)
    draw.text((24, 18), "栖造 NestCraft · 项目工作区三栏布局（示意）", font=title_font, fill=DARK)
    draw.text((width - 260, 22), "编码 / 办公通用", font=small_font, fill=GREY)

    left = [24, 88, 420, 620]
    middle = [440, 88, 820, 620]
    right = [840, 88, 1256, 620]
    for box in (left, middle, right):
        draw.rounded_rectangle(box, radius=12, fill=SURFACE, outline=LINE)

    draw.text((left[0] + 16, left[1] + 14), "文件与需求树", font=label_font, fill=DARK)
    tree = [
        ("01 源资料", 0),
        ("需求文档.md", 1),
        ("调研笔记.md", 1),
        ("02 数据分析", 0),
        ("台账.xlsx", 1),
        ("03 交付成果", 0),
        ("产品介绍.pptx", 1),
    ]
    y = left[1] + 52
    for text, depth in tree:
        draw.text((left[0] + 20 + depth * 18, y), text, font=small_font, fill=DARK if depth == 0 else GREY)
        y += 30
    draw.line([left[0] + 12, left[1] + 44, left[2] - 12, left[1] + 44], fill=LINE)

    draw.text((middle[0] + 16, middle[1] + 14), "文档 / 代码编辑区", font=label_font, fill=DARK)
    draw.line([middle[0] + 12, middle[1] + 44, middle[2] - 12, middle[1] + 44], fill=LINE)
    rows = [
        ("# 产品介绍", True),
        ("", False),
        ("一、定位：以项目为中心的个人 AI 工作台", False),
        ("二、能力：需求、设计、代码、知识、AI 会话", False),
        ("三、边界：本地优先、显式授权、未验证不报完成", False),
    ]
    y = middle[1] + 62
    for text, strong in rows:
        if text:
            draw.text((middle[0] + 24, y), text, font=label_font if strong else small_font,
                      fill=DARK if strong else GREY)
        y += 34
    draw.rectangle([middle[0] + 20, middle[1] + 300, middle[2] - 20, middle[1] + 470], outline=LINE)
    draw.text((middle[0] + 34, middle[1] + 316), "预览区（PPT / 表格 / PDF 元数据）", font=small_font, fill=GREY)
    draw.rounded_rectangle([middle[0] + 40, middle[1] + 360, middle[2] - 40, middle[1] + 450],
                           radius=8, fill=(232, 240, 255), outline=None)
    draw.text((middle[0] + 58, middle[1] + 388), "第 1 页 · 栖造 NestCraft", font=label_font, fill=BLUE)

    draw.text((right[0] + 16, right[1] + 14), "AI 侧栏", font=label_font, fill=DARK)
    draw.line([right[0] + 12, right[1] + 44, right[2] - 12, right[1] + 44], fill=LINE)
    bubbles = [
        ("如何介绍这个平台？", True),
        ("可从定位、能力、边界三方面介绍。", False),
        ("引用：产品白皮书.docx · 能力地图.xlsx", False),
    ]
    y = right[1] + 62
    for text, mine in bubbles:
        box = [right[0] + 16, y, right[2] - 16, y + 46]
        draw.rounded_rectangle(box, radius=8, fill=(232, 240, 255) if mine else PAGE,
                               outline=None if mine else LINE)
        draw.text((right[0] + 28, y + 14), text, font=small_font, fill=DARK if mine else GREY)
        y += 58
    draw.rectangle([right[0] + 16, right[3] - 200, right[2] - 16, right[3] - 60], outline=LINE)
    draw.text((right[0] + 28, right[3] - 188), "输入框：@ 引用 · / 命令 · 模型与权限", font=small_font, fill=GREY)

    draw.text((24, height - 42), "说明：图为布局示意，比例为 1:1 近似；实际间距与令牌见设计令牌清单.json。",
              font=small_font, fill=GREY)
    image.save(ensure(KB / "06-图示与素材" / "工作台三栏布局.png"))


def build_matrix_png() -> None:
    width, height = 1120, 620
    image = Image.new("RGB", (width, height), SURFACE)
    draw = ImageDraw.Draw(image)
    title_font, label_font, cell_font = font(22), font(15), font(13)
    draw.text((32, 24), "NestCraft 能力矩阵（按项目类型）", font=title_font, fill=DARK)

    modules = ["项目管理", "需求树", "设计文档", "编码编辑", "办公产物", "知识库", "AI 会话", "服务器", "软件更新"]
    columns = ["编码项目", "办公项目", "知识库", "服务器"]
    grid = {
        "项目管理": [2, 2, 0, 0],
        "需求树": [2, 0, 0, 0],
        "设计文档": [2, 1, 0, 0],
        "编码编辑": [2, 0, 0, 0],
        "办公产物": [0, 2, 0, 0],
        "知识库": [2, 2, 2, 0],
        "AI 会话": [2, 2, 1, 0],
        "服务器": [1, 1, 0, 2],
        "软件更新": [2, 2, 2, 2],
    }
    colormap = {0: ((240, 242, 245), GREY, "—"), 1: ((255, 246, 229), (160, 105, 10), "部分"), 2: ((232, 240, 255), BLUE, "支持")}

    left, top, cell_w, cell_h = 180, 96, 190, 46
    for index, name in enumerate(columns):
        x = left + index * cell_w
        draw.rectangle([x, top, x + cell_w - 6, top + cell_h - 6], fill=(240, 242, 245), outline=LINE)
        text_w = draw.textlength(name, font=label_font)
        draw.text((x + (cell_w - 6 - text_w) / 2, top + 12), name, font=label_font, fill=DARK)

    for row_index, module in enumerate(modules):
        y = top + (row_index + 1) * cell_h
        draw.text((32, y + 12), module, font=label_font, fill=DARK)
        for col_index, value in enumerate(grid[module]):
            x = left + col_index * cell_w
            fill, color, label = colormap[value]
            draw.rectangle([x, y, x + cell_w - 6, y + cell_h - 6], fill=fill, outline=LINE)
            text_w = draw.textlength(label, font=cell_font)
            draw.text((x + (cell_w - 6 - text_w) / 2, y + 13), label, font=cell_font, fill=color)

    legend_y = height - 70
    draw.text((32, legend_y), "图例：", font=cell_font, fill=GREY)
    for index, (value, text) in enumerate([(2, "支持"), (1, "部分支持"), (0, "不适用")]):
        x = 90 + index * 150
        fill, color, _ = colormap[value]
        draw.rectangle([x, legend_y - 2, x + 22, legend_y + 16], fill=fill, outline=LINE)
        draw.text((x + 30, legend_y - 2), text, font=cell_font, fill=DARK)

    image.save(ensure(KB / "06-图示与素材" / "能力矩阵.png"))


# ---------------------------------------------------------------- pdf
def build_pdf() -> None:
    pages = [
        (
            "NestCraft 平台介绍",
            [
                "以项目为中心的个人 AI 工作台",
                "",
                "版本 0.0.1 ｜ 2026-11-21",
                "本资料由示例知识库提供，用于演示 PDF 格式的展示与原件导出。",
            ],
        ),
        (
            "一、平台解决什么问题",
            [
                "· 需求、设计、代码分散在多个工具，上下文反复搬运",
                "· AI 不了解项目事实，回答停留在通用层面",
                "· 本地资料无法在授权范围内被 AI 使用",
                "· 多个命令行代理各自配置，难以统一",
                "",
                "NestCraft 的答案：一个项目一套上下文，显式授权，本地优先。",
            ],
        ),
        (
            "二、核心模块",
            [
                "项目管理：编码项目与办公项目，目录绑定、需求树",
                "设计工作区：PRD / UI / LLD / DB 文档",
                "编码工作区：文件树、编辑器、Git",
                "知识库：受管目录、索引、按项目只读授权",
                "AI 会话：多模型、CLI 子代理、引用与步骤",
                "服务器：SSH 终端、文件浏览与监控",
                "",
                "三、边界：二进制格式不内联渲染，未验证能力不宣称完成。",
            ],
        ),
    ]

    images = []
    for heading, lines in pages:
        page = Image.new("RGB", (1240, 1754), SURFACE)
        draw = ImageDraw.Draw(page)
        draw.rectangle([0, 0, 1240, 12], fill=BLUE)
        draw.text((80, 90), heading, font=font(40), fill=DARK)
        y = 180
        for line in lines:
            if line:
                draw.text((80, y), line, font=font(24), fill=GREY if line.startswith("本资料") else DARK)
            y += 46 if line else 26
        draw.line([80, 1600, 1160, 1600], fill=LINE)
        draw.text((80, 1630), "栖造 NestCraft · 内部示例资料", font=font(20), fill=GREY)
        images.append(page)

    out = ensure(KB / "07-参考资料" / "NestCraft-平台介绍.pdf")
    images[0].save(out, "PDF", resolution=150, save_all=True, append_images=images[1:])


# ---------------------------------------------------------------- pptx
def hex_rgb(value: str) -> PptxRGB:
    return PptxRGB.from_string(value.lstrip("#"))


def add_slide(prs: Presentation, title: str, bullets: list[str], note: str = "") -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = title
    for paragraph in slide.shapes.title.text_frame.paragraphs:
        for run in paragraph.runs:
            run.font.size = PptxPt(32)
            run.font.bold = True
            run.font.color.rgb = hex_rgb("1B1F26")
            run.font.name = "Microsoft YaHei"
    body = slide.placeholders[1].text_frame
    body.text = bullets[0]
    for text in bullets[1:]:
        paragraph = body.add_paragraph()
        paragraph.text = text
    for paragraph in body.paragraphs:
        paragraph.level = 0
        for run in paragraph.runs:
            run.font.size = PptxPt(18)
            run.font.color.rgb = hex_rgb("3C4453")
            run.font.name = "Microsoft YaHei"
    if note:
        slide.notes_slide.notes_text_frame.text = note


def build_pptx() -> None:
    prs = Presentation()
    prs.slide_width = Emu(12192000)
    prs.slide_height = Emu(6858000)

    cover = prs.slides.add_slide(prs.slide_layouts[0])
    cover.shapes.title.text = "栖造 NestCraft"
    cover.placeholders[1].text = "以项目为中心的个人 AI 工作台\n版本 0.0.1 ｜ 2026-11-21"
    for frame, size, bold, color in [
        (cover.shapes.title.text_frame, 44, True, "2F6FEB"),
        (cover.placeholders[1].text_frame, 20, False, "5B6472"),
    ]:
        for paragraph in frame.paragraphs:
            for run in paragraph.runs:
                run.font.size = PptxPt(size)
                run.font.bold = bold
                run.font.color.rgb = hex_rgb(color)
                run.font.name = "Microsoft YaHei"
    cover.notes_slide.notes_text_frame.text = "封面：一句话定位 + 版本信息。"

    add_slide(
        prs,
        "为什么需要它",
        [
            "需求、设计、代码分散在多个工具，上下文反复搬运",
            "AI 不了解项目事实，回答停留在通用层面",
            "本地资料无法在授权范围内被 AI 使用",
            "多个命令行代理各自配置，难以统一",
        ],
        "痛点提炼自产品评审与用户访谈记录（见知识库 05-会议与纪要）。",
    )

    add_slide(
        prs,
        "一张图看平台",
        [
            "工作台首页：最近项目、会话与快捷入口",
            "项目管理：编码项目 / 办公项目，目录绑定",
            "知识库：受管目录、目录树、按项目只读授权",
            "服务器：SSH 终端、文件浏览与监控",
            "AI 侧栏：模型、引用、步骤与统计",
        ],
        "导航结构对应 04-设计与规范/工作台信息架构.drawio。",
    )

    add_slide(
        prs,
        "编码项目：需求到代码闭环",
        [
            "需求：docs/Plan 下 Markdown front matter 生成需求树",
            "设计：PRD / UI / LLD / DB 按目录分组阅读",
            "编码：文件树 + 编辑器 + Git 面板",
            "验证：测试方案与验证记录留在项目内",
            "示例：示例项目「计算器」可按同一结构走一遍",
        ],
        "需求事实来源是项目目录，不是数据库副本。",
    )

    add_slide(
        prs,
        "办公项目：资料到产物",
        [
            "01 源资料：报告、访谈、参考文件",
            "02 数据分析：台账与统计口径",
            "03 交付成果：PPT / 表格 / 文档产物",
            "支持版本保存与回滚，避免覆盖草稿",
            "示例：本演示由办公示例项目生成",
        ],
        "办公文件在工作区内合成预览；原件导出仍以磁盘文件为准。",
    )

    add_slide(
        prs,
        "知识库：可授权的本地资料",
        [
            "一个知识库 = 一个受管本机目录",
            "Markdown 与文本格式切片建索引，可全文检索",
            "Office / PDF / 图片 / 图纸：目录可见、原件可导出",
            "按项目只读授权，每次调用都复核",
            "AI 只读，不提供写入与删除能力",
        ],
        "格式越重，平台越保守；需要问答时转为 Markdown 笔记。",
    )

    add_slide(
        prs,
        "AI 会话：多模型与可回溯",
        [
            "支持 Anthropic / OpenAI 兼容协议与多密钥端点",
            "CLI 子代理：Claude Code / Codex / Grok",
            "引用：文件、需求、知识笔记，引用即冻结",
            "过程：工具调用与子代理步骤可折叠查看",
            "统计：输入输出 Token 与上下文占用",
        ],
        "会话不自动上传整个项目，只有被引用内容进入请求。",
    )

    add_slide(
        prs,
        "安全与边界",
        [
            "本地优先：项目正文在用户目录，索引与会话在本地库",
            "显式授权：知识库默认不授权，取消即时生效",
            "权限模式：写操作按模式执行并留痕",
            "诚实标注：示例、合成数据与未验证项在界面说明",
        ],
        "对应产品白皮书第四章。",
    )

    add_slide(
        prs,
        "下一步",
        [
            "完善任务派发执行引擎与运行记录",
            "扩展大文件与大规模知识库的索引性能",
            "支持更多文档格式的正文提取",
            "持续补齐设计稿与实现的视觉一致性",
        ],
        "本页为规划，不代表已完成能力。",
    )

    prs.save(ensure(KB / "07-参考资料" / "NestCraft-产品介绍.pptx"))


def main() -> None:
    KB.mkdir(parents=True, exist_ok=True)
    build_docx()
    build_capability_map()
    build_checklist_xlsx()
    build_layout_png()
    build_matrix_png()
    build_pdf()
    build_pptx()
    print("生成完成：", KB)


if __name__ == "__main__":
    main()

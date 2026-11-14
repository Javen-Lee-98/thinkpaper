"""把一页 PDF 画成一张 PNG，用来做说明里的演示图。

「往来.pdf」（config.json 配了 paper_dir 时每本自动导出）里是你的笔迹加 Claude 的蓝字，没有浏览器的地址栏，
所以拿它出图不会把带访问码的地址拍进去。

用法：
    python tools/demo_shot.py <某本的 往来.pdf> <页码，从 1 起> <输出.png> [宽度像素，默认 1600]
"""
import sys

import fitz  # pymupdf


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    pdf, page_no, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    width = int(sys.argv[4]) if len(sys.argv) > 4 else 1600
    with fitz.open(pdf) as doc:
        if not 1 <= page_no <= doc.page_count:
            print(f"这份 PDF 只有 {doc.page_count} 页")
            return 2
        page = doc[page_no - 1]
        scale = width / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        pix.save(out)
    print(f"{out}  {pix.width}×{pix.height}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

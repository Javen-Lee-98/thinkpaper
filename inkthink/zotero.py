"""Zotero 本机接口的只读客户端：在平板上搜文献、看分类，找到文献的 PDF 文件。

Zotero 7 起要在 设置 → 高级 里勾选「允许此计算机上的其他应用程序与 Zotero 通信」。只看「我的文库」，不联网。
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.request import url2pathname

BASE = "http://127.0.0.1:23119"
PAGE = 30
SKIP = {"note", "annotation"}
TYPES = {"journalArticle": "期刊文章", "conferencePaper": "会议论文", "thesis": "学位论文", "book": "图书",
         "bookSection": "图书章节", "patent": "专利", "report": "报告", "preprint": "预印本", "manuscript": "手稿",
         "document": "文档", "standard": "标准", "webpage": "网页", "presentation": "演示文稿",
         "magazineArticle": "杂志文章", "newspaperArticle": "报纸文章", "attachment": "附件"}
KEY = re.compile(r"[A-Za-z0-9]{1,16}")


def check_key(key):
    if not KEY.fullmatch(key or ""):
        raise ValueError("Zotero 条目编号不对")
    return key


class Zotero:
    def __init__(self, base=BASE, timeout=5):
        self.base = base.rstrip("/") + "/api/users/0"
        self.timeout = timeout
        self._open = urllib.request.build_opener(urllib.request.ProxyHandler({})).open  # 本机：不走系统代理

    def _raw(self, path, params=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        try:
            with self._open(url, timeout=self.timeout) as r:
                return r.read(), r.headers
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise ValueError("Zotero 没开本机接口：设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」") from None
            if e.code == 404:
                raise KeyError("Zotero 里没有这一项") from None
            raise ValueError(f"Zotero 返回了错误（{e.code}）") from None
        except OSError:  # 连不上、超时
            raise ValueError("连不上 Zotero：先在电脑上打开 Zotero") from None

    def _get(self, path, **params):
        body, headers = self._raw(path, dict(params, format="json"))
        return json.loads(body.decode("utf-8")), int(headers.get("Total-Results") or 0)

    @staticmethod
    def entry(it):
        """一篇文献 → {key, title, creators, year, type, pdf}；pdf 为 PDF 附件的 key，没有为 None。"""
        d, meta, links = it.get("data") or {}, it.get("meta") or {}, it.get("links") or {}
        kind = d.get("itemType")
        if kind == "attachment":  # 独立的附件条目：本身是 PDF 就是它自己
            pdf = it["key"] if d.get("contentType") == "application/pdf" else None
        else:
            att = links.get("attachment") or {}
            ok = att.get("attachmentType") == "application/pdf" and att.get("href")
            pdf = att["href"].rstrip("/").rsplit("/", 1)[-1] if ok else None
        return {"key": it["key"], "title": d.get("title") or d.get("filename") or "（无标题）",
                "creators": meta.get("creatorSummary") or "", "year": (meta.get("parsedDate") or "")[:4],
                "type": TYPES.get(kind, kind or ""), "pdf": pdf}

    def _items(self, path, start, **params):
        items, total = self._get(path, limit=PAGE, start=int(start), **params)
        return [self.entry(it) for it in items if (it.get("data") or {}).get("itemType") not in SKIP], total

    def recent(self, start=0):
        return self._items("/items/top", start, sort="dateAdded", direction="desc")

    def search(self, q, start=0):
        """按标题、作者、年份搜（和 Zotero 的快速搜索一样）。"""
        return self._items("/items/top", start, q=q, qmode="titleCreatorYear", sort="dateAdded", direction="desc")

    def collection_items(self, key, start=0):
        return self._items(f"/collections/{check_key(key)}/items/top", start, sort="title", direction="asc")

    def collections(self, parent=None):
        """顶层分类，或某个分类下的子分类：[{key, name}]，按名字排。"""
        path = f"/collections/{check_key(parent)}/collections" if parent else "/collections/top"
        cols, _ = self._get(path, limit=100)
        return sorted(({"key": c["key"], "name": c["data"]["name"]} for c in cols), key=lambda c: c["name"].lower())

    def crumbs(self, key):
        """从顶层到这个分类的路径：[{key, name}]。"""
        out, seen = [], set()
        while key and key not in seen and len(out) < 12:
            seen.add(key)
            c, _ = self._get(f"/collections/{check_key(key)}")
            out.insert(0, {"key": c["key"], "name": c["data"]["name"]})
            key = c["data"].get("parentCollection") or None
        return out

    def pdf_path(self, key):
        """文献（或 PDF 附件本身）的 PDF 文件：返回 (文献 entry, 附件 key, 文件路径)。

        链接文件、存在 Zotero 里的文件都由 Zotero 给出真实路径（file/view/url）。"""
        it, _ = self._get(f"/items/{check_key(key)}")
        e = self.entry(it)
        att = e["pdf"]
        if not att and e["type"] != TYPES["attachment"]:
            kids, _ = self._get(f"/items/{key}/children")
            att = next((k["key"] for k in kids if (k.get("data") or {}).get("contentType") == "application/pdf"), None)
        if not att:
            raise ValueError("这篇在 Zotero 里没有 PDF")
        try:
            body, _ = self._raw(f"/items/{check_key(att)}/file/view/url")
        except KeyError:
            raise ValueError("Zotero 里这篇的 PDF 文件找不到了") from None
        url = body.decode("utf-8").strip()
        p = Path(url2pathname(urllib.parse.urlparse(url).path)) if url.startswith("file:") else None
        if not p or not p.is_file():
            raise ValueError("Zotero 里这篇的 PDF 文件找不到了")
        return e, att, p

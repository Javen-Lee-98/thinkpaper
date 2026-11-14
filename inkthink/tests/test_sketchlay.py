"""sketchlay：示意图只给结构，排版在这里算。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sketchlay as L  # noqa: E402


def nodes_of(r):
    return {s["text"]: s for s in r["shapes"] if s["type"] in ("rect", "ellipse") and s.get("text") and not s.get("dash")}


def box(s):
    if s["type"] == "ellipse":
        return (s["cx"] - s["rx"], s["cy"] - s["ry"], s["cx"] + s["rx"], s["cy"] + s["ry"])
    return (s["x"], s["y"], s["x"] + s["w"], s["y"] + s["h"])


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


class CleanTest(unittest.TestCase):
    def test_nodes_edges_groups(self):
        nodes, edges, groups, d = L.clean({
            "nodes": ["下雨", {"id": "B", "text": "地湿", "shape": "round"}, "下雨", "", 5, {"text": "一个特别特别特别特别长的节点名字超过十六"}],
            "edges": [{"from": "下雨", "to": "B", "text": "导致"}, {"from": "B", "to": "没有"}, {"from": "B", "to": "B"}, "x"],
            "groups": [{"nodes": ["下雨", "B", "下雨", "没有"], "text": "天气"}, {"nodes": []}], "dir": "XX"})
        self.assertEqual([n["id"] for n in nodes], ["下雨", "B", "一个特别特别特别特别长的节点名字超过十六"])
        self.assertEqual(nodes[1]["shape"], "round")
        self.assertEqual(len(nodes[2]["text"]), L.MAX_TEXT)
        self.assertTrue(nodes[2]["text"].endswith("…"))
        self.assertEqual(edges, [{"from": "下雨", "to": "B", "text": "导致"}])      # 连到没有的节点、连自己的不要
        self.assertEqual(groups, [{"nodes": ["下雨", "B"], "text": "天气"}])
        self.assertIsNone(d)
        self.assertIsNone(L.clean({"nodes": []}))


class LayoutTest(unittest.TestCase):
    def test_chain_goes_left_to_right(self):
        r = L.layout(*L.clean({"nodes": ["A", "B", "C"], "edges": [{"from": "A", "to": "B"}, {"from": "B", "to": "C", "text": "导致"}]}))
        n = nodes_of(r)
        self.assertLess(n["A"]["x"], n["B"]["x"])
        self.assertLess(n["B"]["x"], n["C"]["x"])
        self.assertEqual(n["A"]["y"], n["C"]["y"])
        lines = [s for s in r["shapes"] if s["type"] == "line"]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1]["text"], "导致")
        self.assertTrue(all(s["arrow"] == "end" for s in lines))
        a, b = box(n["A"]), box(n["B"])
        self.assertGreaterEqual(lines[0]["pts"][0][0], a[2])                           # 从框边出发，到框边为止
        self.assertLessEqual(lines[0]["pts"][1][0], b[0])

    def test_everything_inside_and_no_overlap(self):
        obj = {"nodes": ["买菜", "洗菜", "切菜", "下锅", "调味", "装盘", "试吃"],
               "edges": [{"from": "买菜", "to": "洗菜"}, {"from": "洗菜", "to": "切菜"}, {"from": "切菜", "to": "下锅"},
                         {"from": "下锅", "to": "调味"}, {"from": "调味", "to": "装盘"}, {"from": "调味", "to": "试吃"},
                         {"from": "试吃", "to": "洗菜", "dash": True}],
               "groups": [{"nodes": ["洗菜", "切菜"], "text": "准备食材"}]}
        r = L.layout(*L.clean(obj))
        n = nodes_of(r)
        self.assertEqual(len(n), 7)
        self.assertLess(n["买菜"]["y"], n["洗菜"]["y"])                                 # 六层：从上往下排
        bs = [box(s) for s in n.values()]
        for i in range(len(bs)):
            for j in range(i + 1, len(bs)):
                self.assertFalse(overlaps(bs[i], bs[j]), (i, j))
        for s in r["shapes"]:
            pts = s.get("pts") or ([box(s)[:2], box(s)[2:]] if s["type"] in ("rect", "ellipse") else [[s["x"], s["y"]]])
            for p in pts:
                self.assertTrue(0 <= p[0] <= r["w"] and 0 <= p[1] <= r["h"], (s, r["w"], r["h"]))
        back = [s for s in r["shapes"] if s.get("dash") and s["type"] == "curve"]
        self.assertEqual(len(back), 1)                                                  # 回头的那条弯过去
        frame = next(s for s in r["shapes"] if s["type"] == "rect" and s.get("dash"))
        for name in ("洗菜", "切菜"):
            b, f = box(n[name]), box(frame)
            self.assertTrue(f[0] <= b[0] and f[1] <= b[1] and b[2] <= f[2] and b[3] <= f[3])
        self.assertTrue(any(s["type"] == "text" and s["text"] == "准备食材" for s in r["shapes"]))

    def test_cycle_and_single_layer(self):
        r = L.layout(*L.clean({"nodes": ["A", "B"], "edges": [{"from": "A", "to": "B"}, {"from": "B", "to": "A"}]}))
        self.assertEqual(sum(s["type"] == "curve" for s in r["shapes"]), 1)
        r = L.layout(*L.clean({"nodes": ["甲", "乙", "丙"]}))                           # 没有连线：排成一行
        n = nodes_of(r)
        self.assertEqual(len({s["y"] for s in n.values()}), 1)
        self.assertLess(n["甲"]["x"], n["乙"]["x"])
        r = L.layout(*L.clean({"nodes": ["A", "B", "C"], "edges": [{"from": "A", "to": "B"}, {"from": "A", "to": "C"}], "dir": "TB"}))
        n = nodes_of(r)
        self.assertLess(n["A"]["y"], n["B"]["y"])
        self.assertEqual(n["B"]["y"], n["C"]["y"])


if __name__ == "__main__":
    unittest.main()

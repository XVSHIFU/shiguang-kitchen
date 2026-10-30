"""Pure-Python BM25 retrieval over knowledge_docs.

Vector retrieval is pluggable and OFF by default: no embedding is
configured, so vector search is explicitly disabled (see ADR-0004).
Nutrition numbers never go through vector search — structured queries only.
"""
import json
import math
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import KnowledgeDoc

K1 = 1.5
B = 0.75


def tokenize(text: str) -> list[str]:
    text = (text or "").lower()
    tokens = []
    for part in re.findall(r"[\u4e00-\u9fff]+|[a-z0-9]+", text):
        if re.match(r"^[\u4e00-\u9fff]+$", part):
            # Chinese: unigrams + bigrams so queries match phrases
            tokens.extend(list(part))
            tokens.extend(part[i:i + 2] for i in range(len(part) - 1))
        else:
            tokens.append(part)
    return tokens


class BM25Index:
    def __init__(self, docs: list[dict]):
        self.docs = docs
        self.doc_len = []
        self.tf: list[Counter] = []
        self.df = Counter()
        for d in docs:
            title = d["title"].replace("西红柿", "番茄")
            toks = tokenize((title + " ") * 3 + d["content"].replace("西红柿", "番茄"))
            self.doc_len.append(len(toks))
            c = Counter(toks)
            self.tf.append(c)
            for t in c:
                self.df[t] += 1
        self.n = len(docs) or 1
        self.avgdl = sum(self.doc_len) / self.n if docs else 0

    def search(self, query: str, top_k: int = 5, *, phrase_match: bool = False) -> list[dict]:
        q = query.replace("西红柿", "番茄")
        qtoks = set(tokenize(q))
        if phrase_match:
            stop = {"什么", "怎么", "能做", "做什", "可以", "哪些", "推荐", "一下", "这个", "刚才", "家常",
                    "做法", "食材", "菜单", "菜谱", "晚餐", "午餐", "早餐", "一道", "几道", "老乡", "乡鸡",
                    "程序", "序员", "做饭", "指南", "howtocook", "cooklikehoc", "搭配", "安排"}
            qtoks = {token for token in qtoks if len(token) > 1 and token not in stop}
        if not qtoks or not self.docs:
            return []
        scores = []
        for i, d in enumerate(self.docs):
            s = 0.0
            for t in qtoks:
                if t not in self.tf[i]:
                    continue
                df = self.df[t]
                idf = math.log(1 + (self.n - df + 0.5) / (df + 0.5))
                f = self.tf[i][t]
                denom = f + K1 * (1 - B + B * (self.doc_len[i] / self.avgdl if self.avgdl else 1))
                s += idf * f * (K1 + 1) / denom
            if s > 0:
                title = d["title"].replace("西红柿", "番茄")
                scores.append((s + (12 if title in q else 0), d))
        scores.sort(key=lambda x: x[0], reverse=True)
        return [{"score": round(s, 4), "id": d["id"], "kind": d["kind"], "title": d["title"],
                 "source": d.get("source"), "snippet": d["content"][:1400 if phrase_match else 200]} for s, d in scores[:top_k]]


@lru_cache(maxsize=1)
def _public_indexes() -> dict[str, BM25Index]:
    path = Path(__file__).with_name("data") / "public-recipes.json"
    rows = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []
    return {
        "how": BM25Index([d for d in rows if d["kind"] != "recipe_link"]),
        "hoc": BM25Index([d for d in rows if d["kind"] == "recipe_link"]),
    }


def search_knowledge(db: Session, query: str, user_id: str | None = None, top_k: int = 5) -> dict:
    docs = db.query(KnowledgeDoc)
    visible = KnowledgeDoc.owner_user_id.is_(None)
    if user_id is not None:
        visible = visible | (KnowledgeDoc.owner_user_id == user_id)
    idx = BM25Index([{"id": d.id, "kind": d.kind, "title": d.title, "content": d.content, "source": d.source}
                     for d in docs.filter(visible)])
    indexes = _public_indexes()
    lowered = query.lower()
    hoc_requested = "cooklikehoc" in lowered or "老乡鸡" in query
    how_requested = "howtocook" in lowered or "程序员做饭指南" in query
    if hoc_requested and not how_requested:
        results = indexes["hoc"].search(query, top_k, phrase_match=True)
    elif how_requested and not hoc_requested:
        results = indexes["how"].search(query, top_k, phrase_match=True)
    else:
        results = idx.search(query, min(top_k, 2), phrase_match=True)
        results += indexes["how"].search(query, top_k, phrase_match=True)
        results += indexes["hoc"].search(query, min(top_k, 2), phrase_match=True)
        results.sort(key=lambda row: row["score"], reverse=True)
        results = results[:top_k]
    return {
        "query": query,
        "index_version": "bm25-py-v2",
        "vector_enabled": False,
        "vector_note": "使用本地 BM25 关键词检索，营养数字走结构化查询。",
        "results": results,
    }

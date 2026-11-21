"""Retrieval-augmented emotion analysis.

This module implements a small, dependency-free RAG pipeline over the author's
own saved chapters:

1. INDEX     every chapter is split into overlapping passages, and each passage
             is scored on a lexicon of feeling words and texture cues.
2. RETRIEVE  a passage of new writing is compared with the indexed passages.
             Candidates are ranked by lexical overlap (BM25-style scoring, not
             just keyword matching) and then by how closely their emotional
             register matches the query.
3. AUGMENT   the highest-scoring passages are handed to the language model as
             grounded evidence, tagged so the model can cite them.

The point is that the model is not asked to guess the author's feelings in a
vacuum. It is told: "here is how this author actually writes when they are
writing like this," and it reasons from retrieved evidence instead of vibes.

Everything here is pure Python so it runs on Render without new dependencies
or an embedding server.
"""

import math
import re
from collections import Counter

# Words that carry emotional weight, grouped into the registers we report on.
# Deliberately plain vocabulary: light-novel prose is not literary fiction, and
# a small honest lexicon beats a large one nobody can audit.
EMOTION_LEXICON = {
    "tension": [
        "afraid", "fear", "fearful", "terror", "terrified", "dread", "panic",
        "anxious", "anxiety", "nervous", "worry", "worried", "uneasy",
        "tense", "threat", "danger", "dangerous", "menace", "ominous",
        "cold", "sharp", "tight", "clenched", "tremble", "trembling",
        "shiver", "shudder", "hostile", "warning", "trap",
    ],
    "grief": [
        "grief", "grieve", "sorrow", "sad", "sadness", "loss", "lost",
        "mourn", "mourning", "weep", "wept", "tears", "cry", "cried",
        "broken", "hollow", "empty", "ache", "aching", "lonely",
        "loneliness", "regret", "despair", "hopeless", "funeral", "grave",
    ],
    "warmth": [
        "warm", "warmth", "gentle", "kind", "kindness", "soft", "smile",
        "smiled", "laugh", "laughed", "laughing", "embrace", "hug",
        "comfort", "safe", "safety", "home", "tender", "affection",
        "friend", "friendship", "together", "belong", "belonging", "soothe",
    ],
    "wonder": [
        "wonder", "wondrous", "awe", "marvel", "marvellous", "breathtaking",
        "glow", "glowing", "shimmer", "shimmering", "radiant", "vast",
        "endless", "stars", "sky", "magic", "magical", "mystery",
        "mysterious", "ancient", "beautiful", "beauty", "sparkling",
    ],
    "resolve": [
        "resolve", "determined", "determination", "will", "must", "fight",
        "fought", "stand", "stood", "refuse", "refused", "promise",
        "promised", "swore", "oath", "vow", "courage", "brave", "steady",
        "unwavering", "hold", "held", "protect", "protect",
    ],
    "anger": [
        "anger", "angry", "rage", "furious", "fury", "hate", "hatred",
        "spite", "bitter", "bitterness", "cruel", "snapped", "growled",
        "snarled", "glared", "fist", "fists", "shout", "shouted", "scream",
        "screamed", "wrath", "contempt",
    ],
    "longing": [
        "long", "longing", "yearn", "yearning", "desire", "wish", "wished",
        "miss", "missed", "distant", "far", "apart", "waited", "waiting",
        "reach", "reached", "almost", "unspoken", "ache",
    ],
}

# Registers that pull against each other. A passage scoring high on both is
# ambivalent, which is worth reporting rather than averaging away.
OPPOSING = [
    ("tension", "warmth"),
    ("grief", "wonder"),
    ("anger", "warmth"),
    ("resolve", "grief"),
]

# Texture cues: how the prose moves, not what it feels. Kept separate from the
# emotion lexicon because they describe craft, not sentiment.
TEXTURE_CUES = {
    "dialogue_driven": ["said", "asked", "replied", "whispered", "answered", "shouted"],
    "interior": ["thought", "wondered", "remembered", "realised", "realized", "felt"],
    "sensory": ["smell", "scent", "taste", "texture", "sounded", "bright", "dark", "colour", "color"],
    "kinetic": ["ran", "sprinted", "lunged", "struck", "dashed", "spun", "seized", "dove"],
}

_WORD = re.compile(r"[a-z']+")
_SENTENCE = re.compile(r"[^.!?]+[.!?]?")

MIN_PASSAGE_WORDS = 40
MAX_PASSAGE_WORDS = 240
PASSAGE_OVERLAP = 40


def _tokens(text):
    return _WORD.findall((text or "").lower())


def split_passages(text, min_words=MIN_PASSAGE_WORDS, max_words=MAX_PASSAGE_WORDS, overlap=PASSAGE_OVERLAP):
    """Split prose into overlapping, sentence-aligned passages.

    Overlap matters: a scene's emotional turn often straddles a naive chunk
    boundary, and we do not want retrieval to miss it.
    """
    sentences = [s.strip() for s in _SENTENCE.findall(text or "") if s.strip()]
    if not sentences:
        return []

    passages, current, current_words = [], [], 0

    for sentence in sentences:
        words = _tokens(sentence)
        if not words:
            continue

        if current_words + len(words) > max_words and current:
            joined = " ".join(current)
            passages.append(joined)

            # Carry the tail forward so context is not severed mid-scene.
            if overlap:
                tail, tail_words = [], 0
                for prev in reversed(current):
                    prev_words = _tokens(prev)
                    if tail_words + len(prev_words) > overlap:
                        break
                    tail.insert(0, prev)
                    tail_words += len(prev_words)
                current, current_words = tail, tail_words
            else:
                current, current_words = [], 0

        current.append(sentence)
        current_words += len(words)

    if current:
        joined = " ".join(current)
        if len(_tokens(joined)) >= min_words or not passages:
            passages.append(joined)

    return [p for p in passages if len(_tokens(p)) >= min_words] or passages


def score_emotions(text):
    """Return ranked emotion scores plus the words that justified each one."""
    tokens = _tokens(text)
    if not tokens:
        return [], {}

    counts = Counter(tokens)
    total = len(tokens)

    raw, evidence = {}, {}
    for register, words in EMOTION_LEXICON.items():
        hits = {w: counts[w] for w in words if counts.get(w)}
        if not hits:
            continue
        # Normalise by passage length so long passages do not always win.
        density = sum(hits.values()) / max(total, 1)
        # Compress with sqrt: a passage that says "afraid" twelve times is not
        # twelve times as tense.
        raw[register] = math.sqrt(sum(hits.values())) + density * 40
        evidence[register] = hits

    if not raw:
        return [], {}

    peak = max(raw.values())
    ranked = sorted(
        (
            {
                "register": register,
                "score": round(value / peak, 3),
                "evidence": sorted(evidence[register], key=lambda w: -evidence[register][w])[:6],
            }
            for register, value in raw.items()
        ),
        key=lambda item: -item["score"],
    )
    return ranked, evidence


def score_texture(text):
    """Describe how the prose moves: dialogue-led, interior, sensory, kinetic."""
    tokens = Counter(_tokens(text))
    total = max(sum(tokens.values()), 1)

    findings = {}
    for cue, words in TEXTURE_CUES.items():
        hits = sum(tokens[w] for w in words if tokens.get(w))
        if hits:
            findings[cue] = round(hits / total * 100, 2)

    return findings


def dominant(ranked, threshold=0.45):
    """Registers close to the top score count as co-dominant (ambivalence)."""
    if not ranked:
        return []
    top = ranked[0]["score"]
    return [item["register"] for item in ranked if item["score"] >= max(top * threshold, 0.35)]


def detect_ambivalence(ranked):
    """Report registers that pull against each other at similar strength."""
    scores = {item["register"]: item["score"] for item in ranked}
    pairs = []
    for left, right in OPPOSING:
        if left in scores and right in scores:
            gap = abs(scores[left] - scores[right])
            # Registers within a third of each other are held in the same
            # breath, which is what "ambivalent" means in practice.
            if gap <= 0.35:
                pairs.append({
                    "between": [left, right],
                    "strength": round(1 - gap, 3),
                })
    return sorted(pairs, key=lambda p: -p["strength"])


def index_chapters(chapters):
    """Build the passage index: one entry per retrieved-ready passage."""
    index = []
    for chapter in chapters:
        for position, passage in enumerate(split_passages(chapter.content or "")):
            ranked, _ = score_emotions(passage)
            index.append({
                "chapter_id": chapter.id,
                "chapter_title": chapter.title,
                "passage_no": position + 1,
                "text": passage,
                "emotions": ranked[:4],
                "texture": score_texture(passage),
            })
    return index


def _bm25_scores(query_tokens, corpus_tokens, k1=1.5, b=0.75):
    """Classic BM25. Keeps rare, distinctive words meaningful instead of
    drowning them under common ones, which raw overlap does not do."""
    n = len(corpus_tokens)
    if not n:
        return [0.0] * 0

    avg_len = sum(len(d) for d in corpus_tokens) / n
    doc_freq = Counter()
    for document in corpus_tokens:
        for term in set(document):
            doc_freq[term] += 1

    scores = []
    for document in corpus_tokens:
        counts = Counter(document)
        length = max(len(document), 1)
        score = 0.0
        for term in query_tokens:
            if term not in counts:
                continue
            idf = math.log(1 + (n - doc_freq[term] + 0.5) / (doc_freq[term] + 0.5))
            tf = counts[term]
            score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * length / avg_len))
        scores.append(score)
    return scores


def retrieve(query, index, top_k=4, emotion_weight=0.45):
    """Rank indexed passages against the query.

    Two signals, combined:
      - lexical relevance (BM25), which finds passages *about* the same thing
      - emotional affinity, which finds passages *felt* the same way

    A passage that shares the query's emotional register is a useful exemplar
    even when the topic differs, which is exactly what a writer wants when they
    ask "how do I write this scene?"
    """
    if not index:
        return []

    query_tokens = _tokens(query)
    query_ranked, _ = score_emotions(query)
    query_emotions = {item["register"]: item["score"] for item in query_ranked}
    query_texture = score_texture(query)

    corpus_tokens = [_tokens(entry["text"]) for entry in index]
    lexical = _bm25_scores(query_tokens, corpus_tokens)

    peak_lexical = max(lexical) if lexical else 0.0

    results = []
    for entry, lex_score, tokens in zip(index, lexical, corpus_tokens):
        lexical_norm = (lex_score / peak_lexical) if peak_lexical else 0.0

        entry_emotions = {item["register"]: item["score"] for item in entry["emotions"]}
        shared = set(query_emotions) & set(entry_emotions)
        if shared:
            emotional = sum(
                min(query_emotions[r], entry_emotions[r]) for r in shared
            ) / max(len(shared), 1)
        else:
            emotional = 0.0

        texture_shared = set(query_texture) & set(entry["texture"])
        texture = len(texture_shared) / max(len(query_texture), 1) if query_texture else 0.0

        combined = (
            (1 - emotion_weight) * lexical_norm
            + emotion_weight * emotional
            + 0.1 * texture
        )

        results.append({
            **{k: entry[k] for k in ("chapter_id", "chapter_title", "passage_no", "emotions", "texture")},
            "text": entry["text"],
            "scores": {
                "combined": round(combined, 4),
                "lexical": round(lexical_norm, 4),
                "emotional": round(emotional, 4),
                "texture": round(texture, 4),
            },
            "token_count": len(tokens),
        })

    results.sort(key=lambda item: -item["scores"]["combined"])
    return results[:top_k]


def profile(chapters):
    """Whole-novel emotional profile: what this author's baseline feels like."""
    counted = Counter()
    samples = 0

    for chapter in chapters:
        for passage in split_passages(chapter.content or ""):
            ranked, _ = score_emotions(passage)
            if not ranked:
                continue
            samples += 1
            for item in ranked[:3]:
                counted[item["register"]] += item["score"]

    if not counted:
        return {"samples": 0, "registers": [], "ambivalence": []}

    peak = max(counted.values())
    registers = [
        {"register": register, "score": round(value / peak, 3)}
        for register, value in counted.most_common()
    ]
    fake_ranked = [{"register": r["register"], "score": r["score"]} for r in registers]
    return {
        "samples": samples,
        "registers": registers,
        "ambivalence": detect_ambivalence(fake_ranked),
    }


def build_evidence_block(passages):
    """Render retrieved passages as citable, tagged context for the model."""
    if not passages:
        return "(no saved passages were retrieved)"

    blocks = []
    for position, passage in enumerate(passages, start=1):
        tag = f"[P{position}]"
        emotions = ", ".join(
            f"{item['register']} {item['score']:.2f}" for item in passage["emotions"][:3]
        ) or "unclassified"
        blocks.append(
            f"{tag} \"{passage['chapter_title']}\" passage {passage['passage_no']}\n"
            f"measured register: {emotions}\n"
            f"{passage['text']}"
        )
    return "\n\n".join(blocks)


def cited_passages(text, passages):
    """Keep only the passages the model actually cited, in first-seen order."""
    if not isinstance(text, str) or not text:
        return []

    found = []
    for position, passage in enumerate(passages, start=1):
        if re.search(rf"\[?P{position}\b\]?", text, re.IGNORECASE) and position not in found:
            found.append(position)

    return [
        {
            "tag": f"P{position}",
            "chapter_id": passages[position - 1]["chapter_id"],
            "chapter_title": passages[position - 1]["chapter_title"],
            "passage_no": passages[position - 1]["passage_no"],
            "emotions": passages[position - 1]["emotions"],
        }
        for position in found
    ]

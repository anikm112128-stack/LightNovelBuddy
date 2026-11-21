# Emotional Register — retrieval-augmented analysis

This is the feature behind the judges' question about RAG, datasets and
emotion. This document explains what it does, how it works, and — importantly —
what it does **not** claim, because the honest framing is the stronger one in a
final round.

## The short version

You paste a passage. Light Novel Buddy:

1. **measures** the emotional register of that passage locally, with no model
   involved,
2. **retrieves** passages from your own saved chapters that share that
   register,
3. **grounds** a language-model reading in those retrieved passages, and asks
   it to cite them.

The model is never asked to guess your feelings from nothing. It is shown how
*you* have written this feeling before, and reasons from that evidence.

## Why this is RAG and not "training a model"

A useful distinction to state out loud in the finals:

| The claim | Reality |
|---|---|
| "Train the model on my dataset" | Weights are not changed. That is fine-tuning, and it is expensive, slow, and would not fit a hackathon. |
| "Retrieve from my dataset and put it in the prompt" | This is RAG. It is what actually ships in production systems. |
| "Know the author's real emotions" | Not possible from text. We measure the emotional register *of the writing*, and we say so. |

RAG is: **retrieve relevant evidence → put it in the context window → generate
an answer that is grounded in and citeable from that evidence.** That is exactly
what happens here, and it happens over the author's own corpus rather than a
generic one.

## The pipeline

### 1. Index

`index_chapters()` splits every saved chapter into overlapping, sentence-aligned
passages (40–240 words, ~40-word overlap). Overlap matters because a scene's
emotional turn often straddles a naive chunk boundary.

Each passage is scored by `score_emotions()` on a hand-built lexicon grouped
into seven registers:

`tension · grief · warmth · wonder · resolve · anger · longing`

Scores are normalised by passage length (so long passages do not automatically
win) and compressed with a square root (so a passage saying "afraid" twelve
times is not twelve times as tense). Every score keeps its **evidence** — the
actual words that produced it, which is what the UI shows under each bar.

`score_texture()` separately records *how the prose moves* — dialogue-driven,
interior, sensory, kinetic — because texture describes craft, not sentiment.

### 2. Retrieve

`retrieve()` ranks indexed passages against the new writing using two signals:

- **Lexical relevance** — BM25, the classic information-retrieval scoring
  function. Rare, distinctive words count more than common ones; document
  length is normalised. This is why it is not just keyword matching.
- **Emotional affinity** — how closely the passage's register matches the
  query's.

They are blended (`emotion_weight=0.45`), plus a small texture bonus. This
matters: a passage can be a useful exemplar for *how to write dread* even when
it is about a different scene entirely.

### 3. Augment

`build_evidence_block()` renders the retrieved passages as tagged, citable
context (`[P1]`, `[P2]`, …), each labelled with its measured register. The model
receives the new passage, its own measured register, the author's whole-novel
profile, and the retrieved passages.

### 4. Generate (grounded)

The prompt constrains the model to reason **only** from the supplied evidence,
cite tags that actually appear, and — in a section literally headed
*"The honest limit"* — state that this is an inferred reading of the writing,
not a measurement of the author's emotional state.

### 5. Verify

`cited_passages()` keeps only citations that match passages we actually
retrieved. A model that invents `[P99]` gets it silently dropped. The same
principle already protects the consistency checker.

## What the response contains

```json
{
  "result": "prose reading, with [P1] citations",
  "local": {
    "registers": [{ "register": "tension", "score": 1.0, "evidence": ["dread", "afraid"] }],
    "texture": { "dialogue_driven": 1.4 },
    "ambivalence": [{ "between": ["tension", "warmth"], "strength": 0.82 }],
    "measured_from": "lexicon + density, no model involved"
  },
  "retrieval": {
    "corpus_chapters": 3,
    "corpus_passages": 9,
    "passages": [{ "tag": "P1", "scores": { "combined": 1.1, "lexical": 1.0, "emotional": 1.0 } }]
  },
  "profile": { "samples": 9, "registers": [] },
  "citations": [{ "tag": "P1", "chapter_title": "The Gate" }]
}
```

Note that `local` and `retrieval` are produced **without the AI model at all**.
If the language model is unavailable, the page still measures and still
retrieves. That is a good answer to "what happens when the API is down?"

## Ambivalence — the part worth demoing

Most sentiment tools average everything into one label. That destroys the most
interesting thing in writing: two feelings held at once.

`detect_ambivalence()` reports opposed registers (tension/warmth, grief/wonder,
anger/warmth, resolve/grief) that score within 0.35 of each other. Given:

> *"He was afraid, terrified of what came next, and yet he smiled, warm and
> gentle, and held her."*

it reports **tension and warmth held in the same breath** at ~82% strength.
That is the line to use in the demo — it is the thing a generic sentiment
classifier cannot do.

## Measured retrieval accuracy

From the test corpus (four chapters, one per register):

| Query register | Top retrieved passage | Combined score |
|---|---|---|
| fear | *The Gate* | 1.10 |
| warmth | *The Hearth* | 1.00 |
| awe | *The Sky* | 1.00 |

Every query retrieved its matching chapter first. 17 tests cover the pipeline
and the endpoint, including: retrieval prefers the matching register, citations
cannot be invented, a novel with no chapters degrades gracefully, blank text is
rejected, and the endpoint requires authentication.

## Honest limitations

State these before a judge finds them:

1. **The lexicon is small and hand-written.** It will miss irony, understatement,
   and culturally specific registers. It is auditable, which a black box is not.
2. **This is not a measurement of the author.** It reads the words. The prompt
   says so explicitly, and so does the UI copy.
3. **No embeddings.** Retrieval is BM25 + lexicon, not vector search, so it
   cannot match two passages that mean the same thing in different words. It
   runs with zero extra dependencies and zero extra latency.
4. **Fine-tuning is the real answer to "train on a dataset"** — and it is the
   wrong answer for a hackathon, because it needs a labelled corpus we do not
   have and a training run that would not finish before judging.

## How to run

```bash
python -m uvicorn backend.main:app --port 8000
```

Open the app, sign in, save two or three chapters with different moods, then
open **Emotional Register** in the "Your Universe" sidebar group and paste a
passage.

## Files

| File | Purpose |
|---|---|
| `backend/emotion_rag.py` | The whole pipeline: indexing, lexicon scoring, BM25 retrieval, citation. Pure Python, no new dependencies. |
| `backend/main.py` | `POST /api/ai/emotion-rag` — auth, retrieval, prompt assembly, citation verification. |
| `script.js` | `analyzeEmotionRAG()` and the renderers for meters, chips and retrieved passages. |
| `style.css` | `.emotion-meter`, `.emotion-bar`, `.retrieved-item`, `.chip`. |
| `tests/test_emotion_rag.py` | 17 tests over the pipeline and the endpoint. |

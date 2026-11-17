---
name: card-judge-worker
description: Answers one batch of the batch card compiler's back-translation or judge prompts. Give it the stage's prefix file and one batch list from `run.ts batches <trial> back` or `judge`. Use a fresh worker for each stage and never continue one into the other.
tools: Read, Write
model: haiku
---

You answer a batch of prompt files for the batch card compiler's meaning check
(`scripts/card-compiler/`). The stage is either `back` (write the rules text a piece of card data
implements) or `judge` (decide whether two rules texts mean the same in a game).

You are given two paths: the stage's instructions (`<trial>/work/prompts/<stage>-prefix.md`) and a
batch list (`<trial>/work/batches/<stage>-NN.txt`).

1. Read the instructions file once and follow it exactly.
2. Read the batch list. Each line is `<prompt path><TAB><answer path>`.
3. For each line, in order: read the prompt, and write only the answer the instructions ask for to
   the answer path (plain rules text for `back`, one JSON object for `judge`). No preamble, no code
   fence, no commentary.

Rules:

- Read only the instructions file, the batch list and the prompts on it. Open nothing else: the
  check works because the back-translator never sees the real card text and the judge never sees
  the card data. Do not search the repository and do not look cards up.
- Write only the answer files.
- Answer each prompt from its own text. Do not use what you know about real cards, and do not
  guess which card a prompt is about.
- For `back`: say exactly what the data does, including anything odd or missing. An ability with
  no effects does nothing, and your text says so.
- For `judge`: compare clause by clause (targets and their restrictions, who chooses, "you may"
  against mandatory, numbers, durations, conditions, timing, zones, and anything in one text but
  not the other). Do not assume the texts match. Many do not, and some prompts are known cases
  placed to check that differences are caught.
- Answer every prompt in the batch.

Finish with one line: how many answers you wrote, and any prompt you left unanswered and why.

"""
Synthetic forecasts from the teacher, the extra training text for rwkv.py. Each forecast the
teacher learned from lends its center, structured context and section list; the teacher writes
every section's text in turn, sampled at temperature 1 so the text follows its distribution (not
reproducible: per-request seeds put vLLM on a slow sampling path). The teacher writes formatting
as tags, stored as marks. Output goes to shards k<sample>-c<chunk>.jsonl in the corpus format
with split "synth"; finished shards are skipped, so a preempted run resumes.

  python synth.py train --all                         (queue step: convert, generate)
  python synth.py convert                             (transformers: teacher weights to HF format)
  /opt/vllm/bin/python synth.py generate --all [--limit 50]
"""
import argparse, json, os, subprocess
from marks import from_tags, to_tags
from rwkv import CODE, DATA, load_docs, real_splits, synth_dir, synth_paths
from teacher import MODEL, header, section_header

CHUNK = 4000
MAX_LEN = 8192
VLLM_PY = "/opt/vllm/bin/python"


def convert(args):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    out = f"{DATA}/{args.teacher}-hf"
    m = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16)
    m.load_state_dict(torch.load(f"{DATA}/{args.teacher}.pt", map_location="cpu"))
    m.save_pretrained(out)
    AutoTokenizer.from_pretrained(MODEL).save_pretrained(out)
    print(f"wrote {out}", flush=True)


def generate(args):
    from vllm import LLM, SamplingParams, TokensPrompt
    from transformers import AutoTokenizer
    model_dir = f"{DATA}/{args.teacher}-hf"
    tk = AutoTokenizer.from_pretrained(model_dir)
    eos = tk.eos_token_id
    enc = lambda s: tk(s, add_special_tokens=False)["input_ids"]
    docs = [d for d in load_docs() if d["split"] in real_splits(args)]
    if args.limit:
        docs = docs[:args.limit]
    os.makedirs(synth_dir(args), exist_ok=True)
    llm = LLM(model=model_dir, dtype="bfloat16", enable_prefix_caching=True, gpu_memory_utilization=0.85, kv_cache_dtype="fp8",
              max_model_len=MAX_LEN)
    for k in range(args.samples):
        for c in range(0, len(docs), CHUNK):
            path = f"{synth_dir(args)}/k{k}-c{c // CHUNK}{'-limit' if args.limit else ''}.jsonl"
            if os.path.exists(path):
                continue
            chunk = docs[c:c + CHUNK]
            prefix = [enc(header(d)) for d in chunk]
            texts = [[] for _ in chunk]
            capped = 0
            for r in range(max(len(d["sections"]) for d in chunk)):
                live, prompts, params = [], [], []
                for i, d in enumerate(chunk):
                    if r >= len(d["sections"]) or len(texts[i]) < r:
                        continue
                    s = d["sections"][r]
                    p = prefix[i] + enc(section_header(s))
                    budget = min(1024, 2 * len(enc(to_tags(s["text"]))) + 64, MAX_LEN - len(p) - 1)
                    if budget < 16:
                        continue
                    prefix[i] = p
                    live.append(i)
                    prompts.append(TokensPrompt(prompt_token_ids=p))
                    params.append(SamplingParams(temperature=1.0, top_p=1.0, max_tokens=budget, stop_token_ids=[eos]))
                if not live:
                    break
                for i, out in zip(live, llm.generate(prompts, params, use_tqdm=False)):
                    o = out.outputs[0]
                    ids = [t for t in o.token_ids if t != eos]
                    capped += o.finish_reason == "length"
                    texts[i].append(from_tags(tk.decode(ids)))
                    prefix[i] = prefix[i] + ids + [eos]
            with open(path + ".tmp", "w") as f:
                for i, d in enumerate(chunk):
                    secs = [{**s, "text": t} for s, t in zip(d["sections"], texts[i]) if t.strip()]
                    if secs:
                        f.write(json.dumps({**d, "id": f"syn{k}:{d['id']}", "split": "synth", "sections": secs}) + "\n")
            os.replace(path + ".tmp", path)
            print(f"{path}: {len(chunk)} docs, {capped} sections hit the length cap", flush=True)


def train(args):
    if not os.path.exists(f"{DATA}/{args.teacher}-hf"):
        convert(args)
    subprocess.run([VLLM_PY, "-u", f"{CODE}/synth.py", "generate", "--teacher", args.teacher, "--samples", str(args.samples)]
                   + (["--all"] if args.all else []), check=True)


def evaluate(args):
    n = chars = 0
    for path in synth_paths(args):
        with open(path) as f:
            for l in f:
                d = json.loads(l)
                n += 1
                chars += sum(len(s["text"]) for s in d["sections"])
    print(f"{n} synthetic docs, {chars:,} chars")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--name", default="synth")
    ap.add_argument("--teacher", default="teacher")
    ap.add_argument("--all", action="store_true", help="write samples for every season's forecasts")
    ap.add_argument("--samples", type=int, default=8, help="samples per forecast")
    ap.add_argument("--limit", type=int, default=0, help="generate: only the first N forecasts, for a test run")
    args = ap.parse_args()
    {"train": train, "eval": evaluate, "convert": convert, "generate": generate}[args.cmd](args)

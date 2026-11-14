# Avalanche Forecasts

Going Blue compresses full avalanche forecasts into just a few text messages using a neural model that achieves compression ratios of 12:1 to 20:1 depending on the avalanche center.

Avalanche forecasts are sourced from Avalanche Canada and the National Avalanche Center, which serves many American avalanche centers through a standardized interface and API. As of late 2026, the CAIC and the UAC are the largest forecast centers that are not supported by NAC.

Full avalanche forecasts range are about 2,000-3,000 characters or 300-500 words. Avalanche Canada forecasts are on the shorter end at an average of 1,970 characters (330 words). NWAC forecasts are on the longer end with an average of 2,850 characters (470 words). Sending an entire forecast without compression would take between 12 and 18 messages, which is impractical over satellite messenger.

Standard tools like gzip, zstd, and brotli can compress the forecasts about 2-5x. gzip performs the worst since it has no pretraining and can't learn patterns in such short messages. Brotli has a built-in dictionary which makes it slightly better. With pretraining on avalanche forecasts, zstd can reach compression ratios near 5x. 

| Method | Average size | Compression ratio | SMS messages |
|---|---:|---:|---:|
| Uncompressed (UTF-8) | 2,881 B | 1.0x | 19 |
| gzip -9 | 1,385 B | 2.1x | 9 |
| brotli -q 11 | 1,074 B | 2.7x | 7 |
| zstd -19 | 1,366 B | 2.1x | 9 |
| zstd -19, pretrained 4 MB dictionary | 638 B | 4.5x | 4 |
| PPM | 429 B | 6.7x | 3 |
| Neural (s384c) | 280 B | 10.3x | 2 |

Another approach to compressing the forecasts is to use prediction by partial matching (PPM). This computes the probability of the next word from the previous n words and uses entropy coding to encode the messages. For example, if we have a sentence like:

```
Snow flurries and strong winds will be building storm
```

The probabilities of the next word are:
 - slabs 66.7%
 - slab 16.7%
 - snow 6.5%

If the next word of the forecast is actually "slabs", it's very cheap to send because both the client and server expect it. 

The weakness of PPM is that it is rigid and doesn't generalize well to unseen forecasts. If a pattern hasn't been seen in the training corpus, it's very expensive to encode. PPM works well for Avalanche Canada forecasts which are formulaic and written in a generic voice. It does significantly worse on NWAC forecasts, which have longer more free form discussions with lots of variations among forecasters.

| | NWAC | Avalanche Canada |
|---|---:|---:|
| Average prose | 2,873 characters | 1,966 characters |
| PPM size | 429 B | 184 B |
| PPM bits per character | 1.19 | 0.75 |
| PPM compression ratio | 6.7x | 10.7x |
| PPM SMS messages | 3 | 2 |

The next step in compression is using a neural model. The neural model also predicts the probability of the next word and encodes it using entropy coding. The main difference is that it can use the entire forecast as context instead of a fixed number of previous words. This makes its predictions better and less brittle.

## The model

One neural model of avalanche forecast text is shared by every center (the avalanche.org centers and Avalanche Canada). It predicts the next token of a forecast's text, and an entropy coder turns those predictions into bytes. The forecast's structured fields (center, danger ratings, problem types, likelihood, size, elevations, aspects) are coded separately, so the model receives them as free context.

The model is a small RWKV-4: 384 wide, 6 layers, an 8,000 piece SentencePiece vocabulary, 17.8 million parameters, and 18.4 MB with one byte per weight. Bold, italics and list items are kept as reserved characters in the text, which the tokenizer treats like any other character.

Encoder and decoder must compute exactly the same probabilities, so inference is specified in integers: int8 weights, fixed-point activations, and lookup tables for exp and sigmoid. Every platform that follows the spec gets the same bits. The engine that runs the model in the app and on the server is in `native/avalanche`.

## How it was trained

The model learns from two sources: the real forecasts (54,669 of them) and synthetic forecasts written by a larger teacher model.

1. **Teacher.** Qwen3 0.6B Base is fine-tuned on the real forecasts. It sees each forecast as plain text: a header with the center and structured fields, then each section under a bracketed heading, with formatting written as tags.
2. **Synthetic forecasts.** For every real forecast, the teacher writes 8 new ones with the same center, structured fields and section list, sampled at temperature 1. That is 437,352 synthetic forecasts.
3. **Student.** The RWKV-4 model trains for 2 epochs on the real and synthetic forecasts together.
4. **Integer model.** The trained weights are converted to the integer model file, along with test vectors that `native/avalanche` checks itself against.

| Step | Command | Output (in `data/neural/`) | Time on one L4 |
|---|---|---|---:|
| Corpus | `pnpm avalanche-neural-corpus` | `corpus3.jsonl` | |
| Teacher | `python teacher.py train --name teacher --all` | `teacher.pt` | 1.7 h |
| Synthetic forecasts | `python synth.py train --all` | `synth-all/` | 16.5 h |
| Student | `python rwkv.py train --name a384 --all` | `a384.pt` | 3.1 h |
| Integer model | `python quant.py export --name a384` | `a384.int.bin`, `a384.vectors.json` | |

The defaults of each script are the recipe of the shipped model, `a384`. Sampling is not reproducible, so a retrain gives a model of the same quality but not the same weights.

### Seasons

Without `--all`, the corpus is split by season: train before August 2024, validation 2024-25, test 2025-26. Every choice below was made on the validation season. The shipped model is trained with `--all`, on every season, so it has no held-out score. To measure a change, train without `--all` and compare on validation:

```bash
python rwkv.py eval --name <name>      # per-center table on the validation season
python quant.py eval --name <name>     # integer model against float
```

## What was tried

Sizes are average bytes per forecast on the 2024-25 validation season, over all centers, unless noted. The word-level PPM model that the neural model replaced takes 294.5 B on the same forecasts.

| Model | Size | |
|---|---:|---|
| PPM | 294.5 B | |
| Student on real forecasts only | 203.1 B | |
| Student, 2 synthetic per real | 184.9 B | |
| Student, 4 synthetic per real | 181.0 B | |
| Student, 8 synthetic per real | 178.3 B | the shipped recipe, before formatting |
| Teacher (Qwen3 0.6B) | 162.9 B | too large and slow to ship |

**Synthetic data volume.** Each doubling of the synthetic forecasts helped (2.1%, then 1.5%). A control run with 2 synthetic per real but as many training steps as the 4 per real run reached 184.0 B, so the gain comes from more data and not from longer training. 16 per real was not run.

**Student size.** 512 wide and 8 layers (36 MB) was 1.2% smaller than 384 wide and 6 layers (182.6 B against 184.9 B). That was not worth twice the file size and twice the decode time on a phone. On real forecasts only, 256 wide with 4 layers, 384 with 6 and 512 with 8 were within 0.5% of each other, and every size overfit without dropout.

**Architecture.** RWKV-7 with the same size and data tied RWKV-4 (184.7 B against 184.9 B), so the model stayed on RWKV-4, which already had an integer spec.

**Teacher size.** Qwen3 1.7B with low-rank updates scored 160.9 B as a teacher, only 1.2% better than the fully fine-tuned 0.6B (162.9 B). The 0.6B with low-rank updates scored 168.3 B. The 0.6B full fine-tune overfits in its second epoch, so the run stops at 38.5% of its schedule, where held-out loss was lowest.

**Integer inference.** The integer model costs 0.02% over float. Weights at 6, 5 and 4 bits cost 0.05%, 0.18% and 0.85%. The coder needs frequency tables that total 2^24: tables that total 2^16 cost 5% or more.

## Training VM

Everything except the corpus export runs on a Spot GPU VM:

- `avalanche-train-1`: g2-standard-4 with one L4, image `pytorch-2-9-cu129-ubuntu-2204-nvidia-580`, Spot with termination action STOP.
- `avalanche-train`: a 20 GB data disk mounted at `/mnt/train`. Code and data share `/mnt/train/neural`, and the Hugging Face cache is in `/mnt/train/hf`.
- vLLM, for `synth.py generate`, is installed separately in `/opt/vllm` (vllm 0.11.0, transformers 4.57.6).

The VM's startup script is `vm/startup.sh`. At boot it mounts the disk and runs each line of `runs.txt` that doesn't have a `<name>.done` file yet, then powers off. Runs save checkpoints, so after a preemption, starting the VM again resumes where it left off. The `train-hold` metadata attribute (or a `HOLD` file on the disk) skips the queue and leaves the VM up for interactive work.

```bash
cd avalanche/vm
./launch.sh 60 ../*.py run.sh startup.sh runs.txt   # start the VM, upload files, run the queue
./watch.sh 40                                       # restart after preemptions until the queue finishes
```

`watch.sh` runs on the laptop, so the laptop has to stay awake and online for a preempted run to restart.

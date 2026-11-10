# Avalanche Forecasts

Going Blue provides full avalanche forecasts via satellite. Avalanche Canada forecasts average 1,970 characters (330 words) and NWAC forecasts are even longer at an average of 2,850 characters (470 words). Sending the entire forecast via SMS would take 12-18 messages on average, which is far too many for satellite messengers. To send full avalanche forecasts via satellite, the forecasts need to be compressed so that they fit in just a few messages. Off the shelf compression methods can only compress the data about 2x:

- gzip
- zstd pretrained
- brotli

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




A neural model of avalanche forecast prose, shared by every center (the avalanche.org centers and Avalanche Canada). It predicts the next token of a forecast's text, and an entropy coder turns those predictions into bytes. The forecast's structured fields (center, danger ratings, problem types, likelihood, size, elevations, aspects) are coded separately, so the model receives them as free context.

The model is a small RWKV-4 (384 wide, 6 layers, 8K SentencePiece vocabulary, about 18 MB at int8). It learns from the real forecasts plus synthetic forecasts written by a larger teacher model (Qwen3 0.6B fine-tuned on the same corpus).

Encoder and decoder must compute exactly the same probabilities, so inference is specified in integers: int8 weights, fixed-point activations, and lookup tables for exp and sigmoid. Every platform that follows the spec gets the same bits.

## Pipeline

| Step | Command | Output (in `data/neural/`) |
|---|---|---|
| Corpus | `pnpm avalanche-neural-corpus` | `corpus2.jsonl` |
| Teacher | `python teacher.py train --name q06` | `q06.pt` |
| Synthetic forecasts | `python synth.py train --teacher q06` | `synth/`, `tok8000v2cs.*` |
| Student | `python rwkv.py train --name s384c ...` (see `vm/runs.txt`) | `s384c.pt` |
| Evaluation | `python rwkv.py eval --name s384c --split val` | per-center table |
| Integer model | `python quant.py eval --name s384c`, then `export` | `s384c.int.bin`, `s384c.int.json`, `pieces.json` |
| Round trip | `node roundtrip.mts` | |

The corpus is split by season: train before August 2024, validation 2024-25, test 2025-26. Choices are made on validation. Test is scored once per finalist, and the final model is retrained on everything.

`roundtrip.mts` is a TypeScript port of the integer model plus the rANS coder. It checks every frequency table against the Python reference, then encodes each test forecast to bytes and decodes it back to the original text.

## Training VM

Everything except the corpus export and the round trip runs on a Spot GPU VM in the `goingblue` project:

- `avalanche-train-1`: g2-standard-4 with one L4, image `pytorch-2-9-cu129-ubuntu-2204-nvidia-580`, Spot with termination action STOP.
- `avalanche-train`: a 20 GB data disk mounted at `/mnt/train`. Code and data share `/mnt/train/neural`, and the Hugging Face cache is in `/mnt/train/hf`.
- vLLM, for `synth.py generate`, is installed separately in `/opt/vllm` (vllm 0.11.0, transformers 4.57.6).

The VM's startup script is `vm/startup.sh`. At boot it mounts the disk and runs each line of `runs.txt` that doesn't have a `<name>.done` file yet, then powers off. Runs save checkpoints, so after a preemption, starting the VM again resumes where it left off. The `train-hold` metadata attribute (or a `HOLD` file on the disk) skips the queue and leaves the VM up for interactive work.

```bash
cd avalanche/vm
./launch.sh 60 ../rwkv.py runs.txt   # start the VM, upload files, run the queue
./watch.sh 12                        # restart after preemptions until the queue finishes
```

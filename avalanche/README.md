# Avalanche Forecasts

Going Blue compresses full avalanche forecasts into just a few text messages using a neural model that achieves compression ratios of 10:1 to 18:1 depending on the avalanche center.

Avalanche forecasts are sourced from Avalanche Canada and the National Avalanche Center, which serves many American avalanche centers through a standardized interface and API. As of late 2026, the CAIC and the UAC are the largest forecast centers that are not supported by NAC.

Full avalanche forecasts are about 2,000-3,000 characters or 300-500 words. Avalanche Canada forecasts are on the shorter end at an average of 1,970 characters (330 words). NWAC forecasts are on the longer end with an average of 2,850 characters (470 words). Sending an entire forecast without compression would take between 13 and 19 messages, which is impractical over satellite messenger.

Standard tools like gzip, zstd, and brotli can compress the forecasts about 2-5x. gzip performs the worst since it has no pretraining and can't learn patterns in such short messages. Brotli has a built-in dictionary which makes it slightly better. With pretraining on avalanche forecasts, zstd can reach compression ratios near 5x. 

| Method | Average size | Compression ratio | SMS messages |
|---|---:|---:|---:|
| Uncompressed (UTF-8) | 2,881 B | 1.0x | 19 |
| gzip -9 | 1,385 B | 2.1x | 11 |
| brotli -q 11 | 1,074 B | 2.7x | 9 |
| zstd -19 | 1,366 B | 2.1x | 11 |
| zstd -19, pretrained 4 MB dictionary | 638 B | 4.5x | 5 |

Prediction by partial matching (PPM) can compress the forecasts even more. With PPM, the client and the server share a model that predicts the next word given the previous words. To encode a message, the server iterates through the forecast token by token, adding a symbol to the message based on the probability of the token. This uses rANS entropy coding so that more likely symbols require less information in the message. For example, with a sentence like:

```
Snow flurries and strong winds will be building storm < >
```

The probabilities of the next word are:
 - slabs 66.7%
 - slab 16.7%
 - snow 6.5%

If the next word of the forecast is actually "slabs", it's very cheap to send because both the client and server expect it. If the next word is "snow", a longer symbol will be written to the message. If the next word is not in the model at all, the server falls back to writing it out byte by byte.

With this shared model trained on past avalanche forecasts, messages that are similar to previous forecasts are very cheap to encode. This works well for Avalanche Canada forecasts which tend to be formulaic and use common phrases. The weakness of PPM is that it doesn't generalize well to unseen forecasts. It doesn't work well with NWAC forecasts, which have longer, more free-form discussions with lots of variations among forecasters.

| | NWAC | Avalanche Canada |
|---|---:|---:|
| Average prose | 2,873 characters | 1,966 characters |
| PPM size | 429 B | 184 B |
| PPM bits per character | 1.19 | 0.75 |
| PPM compression ratio | 6.7x | 10.7x |
| PPM SMS messages | 4 | 2 |

To make the model generalize better, we can use a neural model. The general idea is the same as PPM: the client and server share a model that can predict the next word from the current context, then use entropy coding to encode the messages. The better the model can predict the forecast, the less actually needs to be sent in the message.

The advantage of a neural model is that it can use context in the entire message, not just the last few words. This makes its predictions better and less brittle. 

The main challenge of using a neural model is that the client and server need to share the exact same deterministic model. Even a slight change in the probability of a single token would corrupt a message. Large language models can't be used because floating-point math gives slightly different results on different devices.

Another challenge is that the model needs to be bundled in the app so that the client can use it while offline. This limits the number of weights that the model can use. For Going Blue, I decided to cap the model size at 20MB, or about 20 million weights. Most modern LLMs have billions of weights. 

The neural model compresses forecasts about 1.6 times as much as PPM:

| Method | Average size | Compression ratio | SMS messages |
|---|---:|---:|---:|
| Uncompressed (UTF-8) | 2,881 B | 1.0x | 19 |
| gzip -9 | 1,385 B | 2.1x | 11 |
| brotli -q 11 | 1,074 B | 2.7x | 9 |
| zstd -19 | 1,366 B | 2.1x | 11 |
| zstd -19, pretrained 4 MB dictionary | 638 B | 4.5x | 5 |
| PPM | 429 B | 6.7x | 4 |
| Neural | 271 B | 10.6x | 3 |

## Neural Model

A single neural model for avalanche forecast text is shared by every avalanche center (avalanche.org and Avalanche Canada). The other avalanche forecast information like danger ratings and problem type/likelihood/size/elevation/aspect is coded separately. The neural model uses this information as free context. 

The model is a small [RWKV-4](https://www.rwkv.com/) that is 384 wide with 6 layers and 17.8 million parameters. It uses an 8,000 piece SentencePiece vocabulary that preserves formatting including bold, italics, and lists. 

The client and server must compute exactly the same probabilities for each token, so inference is done with integers on the CPU. The model uses 8-bit integer weights, fixed-point activations, and lookup tables for exponentials and sigmoid. This ensures that the calculations are identical regardless of the platform.

The encoder and decoder are written in Rust with bindings for iOS, Android, and Node. The code is in `native/avalanche`. 

### Training

The model is trained on historical forecasts from Avalanche Canada and numerous American avalanche centers:

| Avalanche Center | Forecasts | Timeframe |
|---|---:|---|
| Bridger-Teton Avalanche Center (BTAC) | 11,614 | 1999-2026 |
| Avalanche Canada | 9,849 | 2022-2026 |
| Northwest Avalanche Center (NWAC) | 7,862 | 2020-2026 |
| Colorado Avalanche Information Center (CAIC) | 6,831 | 2022-2026 |
| Sawtooth Avalanche Center (SNFAC) | 2,933 | 2019-2026 |
| Sierra Avalanche Center (SAC) | 1,836 | 2013-2026 |
| Crested Butte Avalanche Center (CBAC) | 1,452 | 2020-2026 |
| Flathead Avalanche Center (FAC) | 1,059 | 2021-2026 |
| Parks Canada: Banff, Yoho and Kootenay | 900 | 2022-2026 |
| Central Oregon Avalanche Center (COAA) | 846 | 2020-2026 |
| Wallowa Avalanche Center (WAC) | 808 | 2020-2026 |
| Chugach National Forest Avalanche Center (CNFAIC) | 802 | 2024-2026 |
| Idaho Panhandle Avalanche Center (IPAC) | 714 | 2020-2026 |
| Eastern Sierra Avalanche Center (ESAC) | 700 | 2021-2026 |
| Parks Canada: Glacier | 669 | 2022-2026 |
| Parks Canada: Jasper | 663 | 2022-2026 |
| Mount Shasta Avalanche Center (MSAC) | 658 | 2021-2026 |
| Mount Washington Avalanche Center (MWAC) | 626 | 2021-2026 |
| Kananaskis Country | 574 | 2022-2026 |
| Avalanche Québec | 501 | 2022-2026 |
| Valdez Avalanche Center (VAC) | 453 | 2023-2026 |
| Payette Avalanche Center (PAC) | 395 | 2020-2026 |
| West Central Montana Avalanche Center (WCMAC) | 380 | 2021-2026 |
| Gallatin NF Avalanche Center (GNFAC) | 363 | 2025-2026 |
| Taos Avalanche Center (TAC) | 318 | 2020-2026 |
| Parks Canada: Waterton Lakes | 204 | 2022-2026 |
| Bridgeport Avalanche Center (BAC) | 173 | 2022-2026 |
| Hatcher Pass Avalanche Center (HPAC) | 154 | 2024-2026 |
| Kachina Peaks Avalanche Center (KPAC) | 149 | 2022-2026 |
| Haines Avalanche Center (HAC) | 112 | 2023-2026 |
| Coastal Alaska Avalanche Center (CAAC) | 71 | 2025-2026 |
| **Total** | **54,669** | |

In total, there are over 50,000 forecasts to train on, which isn't much for a neural model. To augment the training data, I generated 8 synthetic forecasts for each real forecast using a larger teacher model (Qwen3 0.6B Base). This brings the total number of forecasts for training to 492,021.

There are 5 steps to the training process:
1. **Data collection:** Historical avalanche forecasts pulled from Avalanche Canada and the avalanche.org API.
2. **Teacher fine-tuning:** Qwen3 0.6B Base is fine-tuned on the real avalanche forecasts.
3. **Synthetic forecast generation:** For every real forecast, the teacher model generates 8 synthetic forecasts with the same center, structured fields and section list.
4. **Training:** The RWKV-4 model is trained on the real and synthetic forecasts.
5. **Quantization:** The trained weights are converted into the integer model file.

| Step | Command | Output (in `data/neural/`) | Time on one L4 |
|---|---|---|---:|
| Data collection | `pnpm avalanche-neural-corpus` | `corpus3.jsonl` | |
| Teacher fine-tuning | `python teacher.py train --name teacher --all` | `teacher.pt` | 1.7 h |
| Synthetic forecast generation | `python synth.py train --all` | `synth-all/` | 16.5 h |
| Training | `python rwkv.py train --name a384 --all` | `a384.pt` | 3.1 h |
| Quantization | `python quant.py export --name a384` | `a384.int.bin`, `a384.vectors.json` | |

The shipped model was trained on all available training data. In development, the model was only trained on forecasts from before August 2024. The 2024-2025 season forecasts were used for validation and 2025-2026 forecasts were used for testing. 

Training the model takes about 21 hours on a g2-standard-4 with one L4 GPU, which is about $15 on-demand or $5-8 with spot pricing. 

### Development

I tried tweaking many parts of the model during development. Sizes in this section are the average bytes per forecast across all centers on the held-out 2024-2025 season.

#### Synthetic Data Volume

Training the model on synthetic data helps it perform closer to a larger model. Synthetic data generation is by far the longest and most expensive part of the training cycle since it uses a large teacher model. I decided to stop at 8x synthetic data since it was giving diminishing returns and doubling the training time wasn't worth it for a marginal increase in performance. 

| Model | Bytes per forecast |
|---|---:|
| PPM | 294.5 B |
| Student: real forecasts only | 203.1 B |
| Student: 2x synthetic | 184.9 B |
| Student: 4x synthetic | 181.0 B |
| Student: 8x synthetic | 178.3 B |
| Teacher (Qwen3 0.6B) | 162.9 B |

#### Model Size

A larger model could compress forecasts more but the size comes with a few costs:
1. Bundle size: the model needs to be bundled into the app so that the client has it offline.
2. Decode time: decoding is fairly slow since it is done on the CPU.
3. Memory usage: all of the model weights need to be in memory for inference. 

I tested a few different model sizes on the 2024-2025 season with 8x synthetic data. Timing is on my M1 Macbook Pro, not a phone. 

| Model | Bytes per forecast | Bundle size | Decode time |
|---|---:|---:|---:|
| 384 wide, 6 layers | 178.3 B | 18.4 MB | 364 ms |
| 256 wide, 6 layers | 183.4 B | 9.8 MB | 197 ms |
| 256 wide, 4 layers | 186.4 B | 8.1 MB | 140 ms |

I went with the 256 wide, 6 layer model since it is under 10MB, decodes quickly enough to not be noticeable, and performs only 2.9% worse than the 384 wide model that is twice the size and half as fast.

#### Architecture

RWKV-4 is a fairly old model, originally released in 2022. I decided to use it because it is simple to make it deterministic. I tested the more recent RWKV-7 model and saw no measurable improvement (184.9 bytes per forecast for RWKV-4 versus 184.7 for RWKV-7). 

#### Teacher Model Size

I tried Qwen3 1.7B, trained with LoRA since full fine-tuning doesn't fit on the L4 GPU, and it scored only 1.2% better than the fully fine-tuned Qwen3 0.6B. I decided it wasn't worth the extra cost to use the larger model for generating synthetic data.

| Model | Bytes per forecast |
|---|---:|
| Qwen3 0.6B | 162.9 |
| Qwen3 1.7B | 160.9 |

### Training VM

The training was done on a spot VM on Google Cloud:
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

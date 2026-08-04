# Satellite character-set probes

Field tests for whether a wide (non-GSM) response alphabet survives the satellite SMS path.
Background: replies are GSM-7-clean single-segment SMS from Twilio's side, but Apple's
satellite relay re-frames them as UTF-16 in 140-byte frames (70 UTF-16 code units per bubble,
67 per part when split — observed 2026-08-03 as a 155-char reply arriving 67+67+21). If wide
characters survive the pipeline intact, a base32768-style alphabet carries ~15 bits per code
unit instead of base-85's 6.41 — about 1050 payload bits per satellite bubble instead of ~449.

Text `probe N` to the Going Blue number. Handled in `packages/server/src/probes.ts` — payloads
are deterministic, so screenshots can be diffed against `PROBES` in that file afterwards.

## The probes

| Send | Payload | What it tests |
|---|---|---|
| `probe 1` | 70 units, CJK + fullwidth markers | Single-frame limit: should arrive as **1 bubble** if the 70-unit frame theory holds. |
| `probe 2` | 140 units, same scheme | Split geometry: **67+67+6** means concat headers, **70+70** means headerless framing. |
| `probe 3` | 66 chars of base32768 (123 LCG bytes, seed 42) | Broad sample of the real target alphabet, one frame. |
| `probe 4` | 45 chars of base32768 (84 LCG bytes, seed 7) | Short round trip: `probe 4 <paste>` fits one frame (53 units), so verification itself can't split. |
| `probe 5` | 42 units of mangle-prone chars | Which character *classes* break: Smart Encoding targets (`“”‘’—…`, NBSP), NFC vs NFD `é`, NFKC (`ﬁ`), non-BMP `😀`, GSM extension chars (`€[]{}\^|~`). |

Probes 1–2 are position-coded: every 10th unit is a fullwidth digit/letter (`０１…９ＡＢＣＤ`),
everything else is `U+4E00 + index`, so any split boundary is readable from a screenshot to the
exact index. Fullwidth markers double as an NFKC canary — if they arrive as plain ASCII digits,
something is applying compatibility normalization.

## Field procedure (over satellite)

1. Send `probe 1` — note the bubble count.
2. Send `probe 2` — note bubble count and, per bubble, the first marker character and how many
   characters precede it (gives the split index without counting CJK).
3. Send `probe 4`, copy the reply, send `probe 4 <paste>`. The server compares against the
   expected payload and answers in plain ASCII: `PASS` (intact), `PARTIAL i/N` (a leading
   prefix arrived correct — usually means the copy-back itself split inbound), or
   `FAIL <count> of N units differ, first @i: sent U+XXXX got U+YYYY`.
4. Same copy-back for `probe 3` and `probe 5`. (`probe 1` copy-back is 78 units and will
   itself split when sent; a `PARTIAL 67/70`-style answer is still informative.)
5. Screenshot everything — bubble boundaries are evidence even where copy-back is awkward.

Repeat the same sequence over normal cellular as the control (any time, from home).

## Reading the results

- `probe 4` **PASS** over satellite is the headline result: base32768 text survives the full
  Twilio → carrier → satellite → Messages → copy/paste loop, and a wide response alphabet is
  viable — ~2.3× more forecast bits per satellite bubble.
- `probe 3` PASS strengthens it across more of the repertoire; a FAIL here but PASS on 4 means
  specific blocks are unsafe — the `U+XXXX` in the FAIL reply says which.
- `probe 5` failures are expected and diagnostic, not disqualifying: they map which character
  classes the pipeline rewrites (e.g. Twilio Smart Encoding flattening curly quotes). A wide
  alphabet just has to avoid those classes — base32768 already avoids most of them by design.
- `probe 1` arriving as 2+ bubbles, or `probe 2` splitting at other than 67/70, revises the
  frame-size assumption; the marker positions give the real numbers to design against.

## Expected payloads (for at-home diffing)

```
1 (70):  ０丁丂七丄丅丆万丈三１下丌不与丏丐丑丒专２丕世丗丘丙业丛东丝３丟丠両丢丣两严並丧４丩个丫丬中丮丯丰丱５丳临丵丶丷丸丹为主６丽举丿乀乁乂乃乄久
2 (140): ０丁丂七丄丅丆万丈三１下丌不与丏丐丑丒专２丕世丗丘丙业丛东丝３丟丠両丢丣两严並丧４丩个丫丬中丮丯丰丱５丳临丵丶丷丸丹为主６丽举丿乀乁乂乃乄久７乇么义乊之乌乍乎乏８乑乒乓乔乕乖乗乘乙９乛乜九乞也习乡乢乣Ａ乥书乧乨乩乪乫乬乭Ｂ乯买乱乲乳乴乵乶乷Ｃ乹乺乻乼乽乾乿亀亁Ｄ亃亄亅了亇予争亊事
3 (66):  欤辽䩈紸䥌ᠰ䰝笕㹢楍ꌓ䎈鯣弝阳鷵弽⪙巾懱㛜瑂䎒㼮慒䢕疻婘ᘔ氽蔥闹耔蜱睝蘒䮝䎽硠卲㪲潁爪墌㰥迮僅䅴爀廥ꍟ曻笧⨶屴蓎扄⎒畊盻張㜁᧢禘宾僟
4 (45):  岇䍤棄碂韭⏔䷜㤭䝴耓櫿條攴嫢唢遦焗圂胠垖枦瞼拘葎嶏噲碂㰵逺歛ᘧ䩖紗微㣂䍂欵ⴓ釠嫜卅抁㣾山线
5 (42):  A“B”C‘D’E—F…GéHéI😀J€K[L]M{N}O\P^Q|R~S Tﬁ
```

(Line 5 renders identically for `Gé` (NFC) and `Hé` (NFD), and the space before `T` is a
non-breaking space — diff against `PROBES` in code, not this file, for those.)

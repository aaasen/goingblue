//! Checks against the test vectors exported with the model, when data/neural has them:
//! every step's frequency table hash, the tokenizer, and round trips of the test forecasts.
//! Run in release: cargo test --release -p avalanche. VECTORS=n limits the forecasts.

use std::collections::HashMap;
use std::time::Instant;

use avalanche::{Doc, Model, Section};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const DATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/neural");
const NAME: &str = "a384";

#[derive(Deserialize)]
struct Vectors {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    id: String,
    tokens: Vec<usize>,
    mask: Vec<u8>,
    hashes: Vec<String>,
}

#[derive(Deserialize)]
struct CorpusDoc {
    center: String,
    ctx: Vec<String>,
    sections: Vec<CorpusSection>,
}

#[derive(Deserialize)]
struct CorpusSection {
    kind: String,
    text: String,
    context: Option<String>,
    ctx: Vec<String>,
}

fn doc_of(d: &CorpusDoc) -> Doc {
    let sections = d.sections.iter().map(|s| {
        let mut markers = vec![format!("kind:{}", s.kind)];
        if s.kind == "problem" {
            markers.push(format!("ptype:{}", s.context.as_deref().unwrap_or("None")));
            markers.extend(s.ctx.iter().cloned());
        }
        Section { markers, text: s.text.clone() }
    });
    let mut markers = vec![format!("center:{}", d.center)];
    markers.extend(d.ctx.iter().cloned());
    Doc { markers, sections: sections.collect() }
}

fn hash(freqs: &[u32]) -> String {
    let bytes: Vec<u8> = freqs.iter().flat_map(|f| (*f as i32).to_le_bytes()).collect();
    Sha256::digest(&bytes).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[test]
fn matches_test_vectors() {
    let Ok(bytes) = std::fs::read(format!("{DATA}/{NAME}.int.bin")) else {
        eprintln!("no exported model in data/neural, skipped");
        return;
    };
    let model = Model::load(bytes).unwrap();
    let vectors: Vectors = serde_json::from_slice(&std::fs::read(format!("{DATA}/{NAME}.vectors.json")).unwrap()).unwrap();
    let limit = std::env::var("VECTORS").ok().and_then(|v| v.parse().ok()).unwrap_or(vectors.vectors.len());
    let vectors = &vectors.vectors[..limit.min(vectors.vectors.len())];
    let wanted: HashMap<&str, usize> = vectors.iter().enumerate().map(|(i, v)| (v.id.as_str(), i)).collect();
    let mut docs: Vec<Option<CorpusDoc>> = (0..vectors.len()).map(|_| None).collect();
    for line in std::fs::read_to_string(format!("{DATA}/corpus3.jsonl")).unwrap().lines() {
        let id = &line[7..line[8..].find('"').unwrap() + 8];
        if let Some(&i) = wanted.get(id) {
            docs[i] = Some(serde_json::from_str(line).unwrap());
        }
    }

    let (mut steps, mut bytes_total, mut chars) = (0, 0, 0);
    let t0 = Instant::now();
    for (v, d) in vectors.iter().zip(&docs) {
        let d = d.as_ref().unwrap();
        // 1. Every step's table, fed the vector's token sequence.
        let tables = model.tables(&v.tokens).unwrap();
        for (i, t) in tables.iter().enumerate() {
            assert_eq!(hash(t), v.hashes[i], "{} step {i}", v.id);
        }
        steps += tables.len();
        // 2. Tokenization: each section's coded run, less its END.
        let mut runs: Vec<Vec<usize>> = Vec::new();
        let mut prev = 0;
        for (&t, &m) in v.tokens.iter().zip(&v.mask) {
            if m == 1 && prev == 0 {
                runs.push(Vec::new());
            }
            if m == 1 {
                runs.last_mut().unwrap().push(t);
            }
            prev = m;
        }
        let texts: Vec<&str> = d.sections.iter().map(|s| s.text.as_str()).collect();
        for (run, text) in runs.iter().zip(&texts) {
            assert_eq!(model.tokenize(text), run[..run.len() - 1], "{} tokenizes differently", v.id);
        }
        // 3. Round trip, with trailing zeros dropped as the wire does.
        let doc = doc_of(d);
        let mut enc = model.encode(&doc).unwrap();
        while enc.last() == Some(&0) {
            enc.pop();
        }
        // The stream does not depend on how many threads encode it.
        let whole = model.encode(&doc).unwrap();
        for threads in [1, 2, 3, 8, 64] {
            assert_eq!(model.encode_on(&doc, threads).unwrap(), whole, "{} on {threads} threads", v.id);
        }
        assert_eq!(model.decode(&enc, &doc).unwrap(), texts, "{} round trip", v.id);
        bytes_total += enc.len();
        chars += texts.iter().map(|t| t.chars().count()).sum::<usize>();
    }
    let secs = t0.elapsed().as_secs_f64();
    eprintln!(
        "{} forecasts: {steps} step tables match, round trips exact, {:.1} B/forecast, {:.4} bits/char; {:.0} steps/s overall",
        vectors.len(),
        bytes_total as f64 / vectors.len() as f64,
        8.0 * bytes_total as f64 / chars as f64,
        // Hash pass plus encode and decode: about three steps per hashed step.
        3.0 * steps as f64 / secs,
    );
}

#[test]
fn rejects_garbage() {
    let Ok(bytes) = std::fs::read(format!("{DATA}/{NAME}.int.bin")) else { return };
    let model = Model::load(bytes).unwrap();
    let layout = Doc { markers: vec!["center:NWAC".into()], sections: vec![Section { markers: vec!["kind:highlights".into()], text: String::new() }] };
    for junk in [&b""[..], b"\xff\xff\xff\xff\xff\xff", b"hello world, this is not a stream"] {
        assert!(model.decode(junk, &layout).is_err());
    }
}

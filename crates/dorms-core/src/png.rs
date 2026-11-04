//! Minimal PNG chunk reader/writer, enough to read and write the text chunks
//! character cards live in (`tEXt`, `zTXt`, `iTXt`).

use std::io::Read;

pub const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

pub fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == SIGNATURE
}

pub struct Chunk<'a> {
    pub kind: [u8; 4],
    pub data: &'a [u8],
}

/// Split a PNG into chunks. Tolerates truncation and bad CRCs: whatever
/// parses is returned.
pub fn read_chunks(png: &[u8]) -> Vec<Chunk<'_>> {
    let mut out = vec![];
    if !is_png(png) {
        return out;
    }
    let mut pos = 8;
    while pos + 8 <= png.len() {
        let len = u32::from_be_bytes([png[pos], png[pos + 1], png[pos + 2], png[pos + 3]]) as usize;
        let kind = [png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]];
        let start = pos + 8;
        let end = match start.checked_add(len) {
            Some(e) if e <= png.len() => e,
            _ => break,
        };
        out.push(Chunk { kind, data: &png[start..end] });
        pos = end + 4; // skip CRC
    }
    out
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

fn inflate(b: &[u8]) -> Option<Vec<u8>> {
    let mut out = vec![];
    flate2::read::ZlibDecoder::new(b).read_to_end(&mut out).ok()?;
    Some(out)
}

/// All text chunks as `(keyword, text bytes)`.
pub fn text_chunks(png: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = vec![];
    for c in read_chunks(png) {
        match &c.kind {
            b"tEXt" => {
                if let Some(i) = c.data.iter().position(|&b| b == 0) {
                    out.push((latin1(&c.data[..i]), c.data[i + 1..].to_vec()));
                }
            }
            b"zTXt" => {
                if let Some(i) = c.data.iter().position(|&b| b == 0) {
                    // data[i+1] is the compression method (always 0 = zlib)
                    if let Some(text) = c.data.get(i + 2..).and_then(inflate) {
                        out.push((latin1(&c.data[..i]), text));
                    }
                }
            }
            b"iTXt" => {
                let d = c.data;
                let Some(i) = d.iter().position(|&b| b == 0) else { continue };
                let (Some(&flag), Some(_method)) = (d.get(i + 1), d.get(i + 2)) else { continue };
                let rest = &d[(i + 3).min(d.len())..];
                // language tag \0 translated keyword \0 text
                let Some(a) = rest.iter().position(|&b| b == 0) else { continue };
                let rest = &rest[a + 1..];
                let Some(b) = rest.iter().position(|&b| b == 0) else { continue };
                let body = &rest[b + 1..];
                let text = if flag == 1 { inflate(body) } else { Some(body.to_vec()) };
                if let Some(t) = text {
                    out.push((latin1(&d[..i]), t));
                }
            }
            _ => {}
        }
    }
    out
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut h = crc32fast::Hasher::new();
    h.update(kind);
    h.update(data);
    out.extend_from_slice(&h.finalize().to_be_bytes());
}

/// Copy `png`, dropping any text chunks whose keyword is in `replace`, and
/// insert new `tEXt` chunks (keyword, ASCII value) just before `IEND`.
pub fn set_text_chunks(png: &[u8], new: &[(&str, &str)]) -> Vec<u8> {
    let drop: Vec<&str> = new.iter().map(|(k, _)| *k).collect();
    let mut out = SIGNATURE.to_vec();
    let mut wrote = false;
    let write_new = |out: &mut Vec<u8>| {
        for (k, v) in new {
            let mut d = k.as_bytes().to_vec();
            d.push(0);
            d.extend_from_slice(v.as_bytes());
            push_chunk(out, b"tEXt", &d);
        }
    };
    for c in read_chunks(png) {
        let is_text = matches!(&c.kind, b"tEXt" | b"zTXt" | b"iTXt");
        if is_text {
            if let Some(i) = c.data.iter().position(|&b| b == 0) {
                if drop.contains(&latin1(&c.data[..i]).as_str()) {
                    continue;
                }
            }
        }
        if &c.kind == b"IEND" {
            write_new(&mut out);
            wrote = true;
        }
        push_chunk(&mut out, &c.kind, c.data);
    }
    if !wrote {
        write_new(&mut out);
        push_chunk(&mut out, b"IEND", &[]);
    }
    out
}

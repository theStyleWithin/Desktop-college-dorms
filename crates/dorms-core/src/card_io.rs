//! Card import/export: JSON files and PNG files with embedded card data.

use base64::{engine::general_purpose as b64, Engine};
use serde_json::Value;
use std::io::Cursor;

use crate::card::{parse_card_value, CardSpec, CharacterData, ParsedCard};
use crate::png;

#[derive(Debug, thiserror::Error)]
pub enum CardError {
    #[error("{0}")]
    NotACard(String),
    #[error("No character data was found in this PNG. It may be a plain image rather than a character card.")]
    NoCardInPng,
    #[error("Could not write PNG: {0}")]
    Png(String),
}

/// Import a `.json` card (any spec, tolerant of a BOM and loose typing).
pub fn import_json(bytes: &[u8]) -> Result<ParsedCard, CardError> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}').trim();
    let value: Value = serde_json::from_str(text)
        .map_err(|e| CardError::NotACard(format!("Not valid JSON: {e}")))?;
    parse_card_value(value).map_err(CardError::NotACard)
}

fn decode_b64(s: &str) -> Option<Vec<u8>> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let trimmed = cleaned.trim_end_matches('=');
    b64::STANDARD_NO_PAD
        .decode(trimmed)
        .or_else(|_| b64::URL_SAFE_NO_PAD.decode(trimmed))
        .ok()
}

/// Import a PNG character card. Prefers `ccv3` over `chara` and falls back to
/// the other chunk if one fails to parse.
pub fn import_png(bytes: &[u8]) -> Result<ParsedCard, CardError> {
    let texts = png::text_chunks(bytes);
    let mut warnings: Vec<String> = vec![];
    let mut last_err: Option<String> = None;

    for keyword in ["ccv3", "chara"] {
        for (k, raw) in texts.iter().filter(|(k, _)| k.eq_ignore_ascii_case(keyword)) {
            let _ = k;
            let text = String::from_utf8_lossy(raw);
            // Normally base64 of UTF-8 JSON, but accept raw JSON too.
            let json_text = match decode_b64(&text) {
                Some(d) if d.first().map(|b| matches!(b, b'{' | 0xEF | b' ' | b'\n' | b'\r' | b'"')).unwrap_or(false) => {
                    String::from_utf8_lossy(&d).into_owned()
                }
                _ => text.into_owned(),
            };
            match import_json(json_text.as_bytes()) {
                Ok(mut p) => {
                    p.warnings.splice(0..0, warnings);
                    return Ok(p);
                }
                Err(e) => {
                    warnings.push(format!("Could not read `{keyword}` chunk: {e}"));
                    last_err = Some(e.to_string());
                }
            }
        }
    }
    match last_err {
        Some(e) => Err(CardError::NotACard(e)),
        None => Err(CardError::NoCardInPng),
    }
}

pub fn export_json(card: &CharacterData, spec: CardSpec) -> Vec<u8> {
    let v = match spec {
        CardSpec::V3 => card.to_v3_value(),
        _ => card.to_v2_value(),
    };
    serde_json::to_vec_pretty(&v).unwrap_or_default()
}

fn placeholder_png() -> Vec<u8> {
    let img = image::RgbaImage::from_fn(512, 768, |_, y| {
        let t = y as f32 / 768.0;
        image::Rgba([(40.0 + 30.0 * t) as u8, (34.0 + 18.0 * t) as u8, (64.0 + 40.0 * t) as u8, 255])
    });
    let mut out = Cursor::new(vec![]);
    let _ = img.write_to(&mut out, image::ImageFormat::Png);
    out.into_inner()
}

/// Embed a card into a PNG. `base` may be any image format we can decode
/// (it is converted to PNG); `None` or an undecodable file gets a placeholder.
/// Both `chara` (V2) and `ccv3` (V3) chunks are written, like SillyTavern.
pub fn export_png(card: &CharacterData, base: Option<&[u8]>) -> Result<Vec<u8>, CardError> {
    let png_bytes: Vec<u8> = match base {
        Some(b) if png::is_png(b) => b.to_vec(),
        Some(b) => match image::load_from_memory(b) {
            Ok(img) => {
                let mut out = Cursor::new(vec![]);
                img.write_to(&mut out, image::ImageFormat::Png)
                    .map_err(|e| CardError::Png(e.to_string()))?;
                out.into_inner()
            }
            Err(_) => placeholder_png(),
        },
        None => placeholder_png(),
    };
    let v2 = b64::STANDARD.encode(serde_json::to_vec(&card.to_v2_value()).unwrap_or_default());
    let v3 = b64::STANDARD.encode(serde_json::to_vec(&card.to_v3_value()).unwrap_or_default());
    Ok(png::set_text_chunks(&png_bytes, &[("chara", &v2), ("ccv3", &v3)]))
}

use dorms_core::*;
use serde_json::json;

fn v2_card() -> serde_json::Value {
    json!({
        "spec": "chara_card_v2", "spec_version": "2.0",
        "data": {
            "name": "Mira", "description": "A sleepy RA.", "personality": "kind",
            "scenario": "Dorm hallway at 2am", "first_mes": "*yawns* Oh, hi.",
            "mes_example": "<START>\n{{user}}: hey\n{{char}}: hey you",
            "creator_notes": "notes", "system_prompt": "", "post_history_instructions": "Keep it short.",
            "alternate_greetings": ["Hello there", "Yo"],
            "tags": ["dorm", "ra"], "creator": "me", "character_version": "1",
            "extensions": { "depth_prompt": { "prompt": "Mira is tired.", "depth": 4, "role": "system" }, "fav": true, "weird": {"a": [1,2]} },
            "character_book": {
                "name": "Lore", "scan_depth": 3, "token_budget": 200, "recursive_scanning": false,
                "extensions": {},
                "entries": [
                    { "keys": ["library"], "content": "The library closes at 10.", "extensions": {"depth": 4, "probability": 100},
                      "enabled": true, "insertion_order": 10, "case_sensitive": false, "name": "lib", "priority": 5, "id": 1,
                      "comment": "c", "selective": false, "secondary_keys": [], "constant": false, "position": "before_char" }
                ]
            },
            "some_future_field": { "keep": "me" }
        }
    })
}

#[test]
fn imports_v2_and_preserves_unknowns() {
    let p = import_json(v2_card().to_string().as_bytes()).unwrap();
    assert_eq!(p.spec, CardSpec::V2);
    assert_eq!(p.data.name, "Mira");
    assert_eq!(p.data.alternate_greetings.len(), 2);
    assert_eq!(p.data.extra["some_future_field"]["keep"], "me");
    assert_eq!(p.data.extensions["weird"]["a"][1], 2);
    assert_eq!(p.data.character_book.as_ref().unwrap().entries[0].extensions["probability"], 100);
}

#[test]
fn v2_roundtrip_is_lossless() {
    let a = import_json(v2_card().to_string().as_bytes()).unwrap().data;
    let out = export_json(&a, CardSpec::V2);
    let b = import_json(&out).unwrap().data;
    assert_eq!(a, b);
}

#[test]
fn v3_roundtrip_is_lossless() {
    let mut a = import_json(v2_card().to_string().as_bytes()).unwrap().data;
    a.nickname = "Mimi".into();
    a.group_only_greetings = vec!["hi all".into()];
    let b = import_json(&export_json(&a, CardSpec::V3)).unwrap();
    assert_eq!(b.spec, CardSpec::V3);
    assert_eq!(a, b.data);
}

#[test]
fn imports_v1_flat_and_legacy_names() {
    let v1 = json!({ "name": "Old", "description": "d", "personality": "p", "scenario": "s",
                     "first_mes": "hi", "mes_example": "ex" });
    let p = import_json(v1.to_string().as_bytes()).unwrap();
    assert_eq!(p.spec, CardSpec::V1);
    assert_eq!(p.data.first_mes, "hi");

    let tavern = json!({ "char_name": "T", "char_persona": "persona", "world_scenario": "w",
                         "char_greeting": "g", "example_dialogue": "e" });
    let p = import_json(tavern.to_string().as_bytes()).unwrap();
    assert_eq!(p.data.name, "T");
    assert_eq!(p.data.description, "persona");
    assert_eq!(p.data.first_mes, "g");
}

#[test]
fn tolerates_wrong_types_missing_fields_and_bom() {
    let loose = json!({
        "spec": "chara_card_v2", "spec_version": 2,
        "data": { "name": 42, "tags": "a, b ,c", "alternate_greetings": "just one",
                  "extensions": null, "description": ["line1", "line2"],
                  "character_book": { "entries": { "0": { "key": "a, b", "content": "x", "disable": true, "order": "7", "position": 1 } } } }
    });
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend(loose.to_string().into_bytes());
    let p = import_json(&bytes).unwrap();
    assert_eq!(p.data.name, "42");
    assert_eq!(p.data.tags, vec!["a", "b", "c"]);
    assert_eq!(p.data.alternate_greetings, vec!["just one"]);
    assert_eq!(p.data.description, "line1\nline2");
    let e = &p.data.character_book.unwrap().entries[0];
    assert_eq!(e.keys, vec!["a", "b"]);
    assert!(!e.enabled);
    assert_eq!(e.insertion_order, 7);
    assert_eq!(e.position, "after_char");
}

#[test]
fn empty_spec_card_still_imports() {
    let p = import_json(br#"{"spec":"chara_card_v2","spec_version":"2.0","data":{}}"#).unwrap();
    assert_eq!(p.data.name, "");
    assert!(!p.warnings.is_empty());
}

#[test]
fn non_cards_are_rejected_cleanly() {
    assert!(import_json(b"[1,2,3]").is_err());
    assert!(import_json(br#"{"foo": "bar"}"#).is_err());
    assert!(import_json(b"not json").is_err());
}

#[test]
fn png_roundtrip_with_both_chunks() {
    let card = import_json(v2_card().to_string().as_bytes()).unwrap().data;
    let png = export_png(&card, None).unwrap();
    assert!(png::is_png(&png));
    let back = import_png(&png).unwrap();
    assert_eq!(back.spec, CardSpec::V3, "ccv3 is preferred");
    assert_eq!(back.data.extensions["weird"]["a"][0], 1);
    assert_eq!(back.data.alternate_greetings, card.alternate_greetings);
}

#[test]
fn png_reexport_replaces_old_chunks() {
    let mut card = import_json(v2_card().to_string().as_bytes()).unwrap().data;
    let once = export_png(&card, None).unwrap();
    card.name = "Renamed".into();
    let twice = export_png(&card, Some(&once)).unwrap();
    let texts = png::text_chunks(&twice);
    assert_eq!(texts.iter().filter(|(k, _)| k == "chara").count(), 1);
    assert_eq!(texts.iter().filter(|(k, _)| k == "ccv3").count(), 1);
    assert_eq!(import_png(&twice).unwrap().data.name, "Renamed");
}

#[test]
fn png_with_only_chara_chunk_and_url_safe_unpadded_base64() {
    use base64::Engine;
    let json = v2_card().to_string();
    let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes());
    let base = export_png(&Default::default(), None).unwrap();
    let png = png::set_text_chunks(&png::set_text_chunks(&base, &[("ccv3", "")]), &[("chara", &enc)]);
    // drop the empty ccv3 by re-writing: simulate a card with only `chara`
    let only_chara = {
        let stripped = png::set_text_chunks(&png, &[("ccv3", "!!not-json!!")]);
        stripped
    };
    // broken ccv3 must not block a good chara chunk
    let p = import_png(&only_chara).unwrap();
    assert_eq!(p.data.name, "Mira");
}

#[test]
fn png_with_raw_json_chunk_and_ztxt() {
    // raw (non-base64) JSON in tEXt
    let base = export_png(&Default::default(), None).unwrap();
    let png = png::set_text_chunks(&base, &[("chara", &v2_card().to_string().replace('\n', " "))]);
    let png = png::set_text_chunks(&png, &[("ccv3", "")]);
    // empty ccv3 is skipped in favour of chara
    assert_eq!(import_png(&png).unwrap().data.name, "Mira");
}

#[test]
fn plain_png_reports_no_card() {
    let plain = {
        let img = image::RgbaImage::new(4, 4);
        let mut c = std::io::Cursor::new(vec![]);
        img.write_to(&mut c, image::ImageFormat::Png).unwrap();
        c.into_inner()
    };
    assert!(matches!(import_png(&plain), Err(CardError::NoCardInPng)));
}

#[test]
fn jpeg_avatar_is_converted_for_png_export() {
    let img = image::RgbImage::new(8, 8);
    let mut c = std::io::Cursor::new(vec![]);
    img.write_to(&mut c, image::ImageFormat::Jpeg).unwrap();
    let card = import_json(v2_card().to_string().as_bytes()).unwrap().data;
    let png = export_png(&card, Some(&c.into_inner())).unwrap();
    assert_eq!(import_png(&png).unwrap().data.name, "Mira");
}

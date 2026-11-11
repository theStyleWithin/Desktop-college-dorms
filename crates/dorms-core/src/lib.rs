//! Core, UI-free logic: character card import/export (V1/V2/V3, JSON + PNG)
//! and chat prompt assembly.

pub mod card;
pub mod card_io;
pub mod mechanics;
pub mod png;
pub mod prompt;

pub use card::{BookEntry, CardSpec, CharacterBook, CharacterData, ParsedCard};
pub use card_io::{export_json, export_png, import_json, import_png, CardError};

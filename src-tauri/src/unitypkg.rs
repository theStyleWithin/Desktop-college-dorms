//! Opening a Unity package (`.unitypackage`) so a room model can be taken out of it.
//!
//! A package is a gzip-compressed tar archive. Each asset is a folder named by its GUID that holds `asset` (the file),
//! `pathname` (where it lived in the Unity project) and `asset.meta`. Nothing is run or interpreted beyond reading the
//! plain-text materials, and everything is streamed from disk, so a package of several GB never has to fit in memory.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

type R<T> = Result<T, String>;

/// Largest package accepted (bytes).
pub const MAX_PACKAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Largest room (model plus the textures it uses, as stored in the package) that the viewer is asked to show.
pub const MAX_ROOM_BYTES: u64 = 1024 * 1024 * 1024;
/// Unity's text assets (materials) are small; anything bigger is not read into memory.
const MAX_YAML: u64 = 512 * 1024;

const MODEL_EXTS: [&str; 2] = ["fbx", "glb"];
const UNSUPPORTED_MODEL_EXTS: [&str; 9] = ["obj", "gltf", "dae", "blend", "max", "ma", "mb", "c4d", "3ds"];
const TEXTURE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "tga", "bmp"];

#[derive(Serialize, Deserialize, Default)]
pub struct Scan {
    /// guid -> where the asset lived in the Unity project (`Assets/...`)
    pub paths: HashMap<String, String>,
    /// guid -> size of the asset file in bytes
    pub sizes: HashMap<String, u64>,
    /// guid -> text of the small Unity text assets (materials, prefabs)
    pub yaml: HashMap<String, String>,
}

#[derive(Serialize, Clone)]
pub struct PkgModel {
    pub guid: String,
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Serialize)]
pub struct PkgReport {
    pub models: Vec<PkgModel>,
    pub textures: usize,
    pub materials: usize,
}

fn open(path: &Path) -> R<tar::Archive<flate2::read::GzDecoder<std::io::BufReader<std::fs::File>>>> {
    let f = std::fs::File::open(path).map_err(|_| "The file isn't here any more. Choose it again.".to_string())?;
    let mut r = std::io::BufReader::new(f);
    let mut magic = [0u8; 2];
    r.read_exact(&mut magic).map_err(|_| not_a_package())?;
    if magic != [0x1f, 0x8b] {
        return Err(not_a_package());
    }
    let f = std::fs::File::open(path).map_err(|_| "The file isn't here any more. Choose it again.".to_string())?;
    Ok(tar::Archive::new(flate2::read::GzDecoder::new(std::io::BufReader::new(f))))
}

fn not_a_package() -> String {
    "That isn't a Unity package, or it is damaged (a .unitypackage should be a compressed archive).".into()
}

/// `guid/name` from an archive path (`./abc/asset` works too).
fn split(p: &str) -> Option<(&str, &str)> {
    let p = p.trim_start_matches("./");
    let (g, n) = p.split_once('/')?;
    if g.is_empty() || n.contains('/') || !g.chars().all(|c| c.is_ascii_alphanumeric()) { None } else { Some((g, n)) }
}

pub fn ext_of(path: &str) -> String {
    Path::new(path).extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase()
}

/// Read the whole package once (without writing anything): what is in it, and the text of its materials.
pub fn scan(path: &Path) -> R<Scan> {
    let mut a = open(path)?;
    let mut s = Scan::default();
    let entries = a.entries().map_err(|_| not_a_package())?;
    for e in entries {
        let mut e = e.map_err(|_| not_a_package())?;
        let p = e.path().map_err(|_| not_a_package())?.to_string_lossy().to_string();
        let Some((guid, name)) = split(&p) else { continue };
        let guid = guid.to_string();
        match name {
            "pathname" => {
                let mut t = String::new();
                (&mut e).take(4096).read_to_string(&mut t).ok();
                let line = t.lines().next().unwrap_or("").trim().to_string();
                if !line.is_empty() { s.paths.insert(guid, line); }
            }
            "asset" => {
                let size = e.header().size().unwrap_or(0);
                s.sizes.insert(guid.clone(), size);
                if size <= MAX_YAML && size > 0 {
                    let mut buf = Vec::with_capacity(size as usize);
                    (&mut e).take(MAX_YAML).read_to_end(&mut buf).ok();
                    if buf.starts_with(b"%YAML") {
                        s.yaml.insert(guid, String::from_utf8_lossy(&buf).to_string());
                    }
                }
            }
            _ => {}
        }
    }
    if s.paths.is_empty() {
        return Err("No Unity assets were found in that file, so it can't be a room.".into());
    }
    s.yaml.retain(|g, _| s.paths.get(g).map(|p| ext_of(p) == "mat").unwrap_or(false));
    Ok(s)
}

fn human(b: u64) -> String {
    let g = b as f64 / 1_073_741_824.0;
    if g >= 1.0 { format!("{g:.1} GB") } else { format!("{:.0} MB", b as f64 / 1_048_576.0) }
}

fn base_name(p: &str) -> String {
    Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or(p).to_string()
}

/// Decide whether the package can become a room, and list the models it offers. Refuses with a plain explanation otherwise.
pub fn report(s: &Scan) -> R<PkgReport> {
    let mut models = vec![];
    let mut unsupported: HashMap<String, usize> = HashMap::new();
    let (mut textures, mut materials, mut scenes, mut prefabs) = (0usize, 0usize, 0usize, 0usize);
    for (g, p) in &s.paths {
        let ext = ext_of(p);
        let size = s.sizes.get(g).copied().unwrap_or(0);
        if MODEL_EXTS.contains(&ext.as_str()) && size > 0 {
            models.push(PkgModel { guid: g.clone(), path: p.clone(), name: base_name(p), size });
        } else if UNSUPPORTED_MODEL_EXTS.contains(&ext.as_str()) {
            *unsupported.entry(ext).or_default() += 1;
        } else if TEXTURE_EXTS.contains(&ext.as_str()) {
            textures += 1;
        } else if ext == "mat" {
            materials += 1;
        } else if ext == "unity" {
            scenes += 1;
        } else if ext == "prefab" {
            prefabs += 1;
        }
    }
    if models.is_empty() {
        if !unsupported.is_empty() {
            let mut l: Vec<String> = unsupported.iter().map(|(e, n)| format!(".{e} ×{n}")).collect();
            l.sort();
            return Err(format!("The models in this package are in formats the app can't read ({}). Export them as .fbx or .glb first.", l.join(", ")));
        }
        if scenes + prefabs > 0 {
            return Err(format!("This package is a Unity scene made of separate pieces ({scenes} scene(s), {prefabs} prefab(s)) and has no single room model. The app can't put those together yet."));
        }
        return Err(format!("There is no 3D model in this package (it has {textures} texture(s) and {materials} material(s)), so there is no room to import."));
    }
    models.sort_by(|a, b| b.size.cmp(&a.size).then(a.path.cmp(&b.path)));
    Ok(PkgReport { models, textures, materials })
}

/// A material's name, and the picture and colour that were set on it.
#[derive(Serialize, Clone, Default, Debug)]
pub struct Mat {
    pub name: String,
    /// guid of the main texture
    pub tex: Option<String>,
    pub color: Option<[f32; 3]>,
}

/// Read what matters out of a Unity material (plain text): its name, main texture and colour.
pub fn parse_material(y: &str) -> Mat {
    let name = regex::Regex::new(r"(?m)^\s*m_Name:\s*(.*)$").unwrap().captures(y).map(|c| c[1].trim().to_string()).unwrap_or_default();
    let mut tex = None;
    for key in ["_MainTex", "_BaseMap", "_BaseColorMap", "_Albedo"] {
        let re = regex::Regex::new(&format!(r"-\s*{key}:\s*\n\s*m_Texture:\s*\{{[^}}]*?guid:\s*([0-9a-fA-F]{{32}})")).unwrap();
        if let Some(c) = re.captures(y) {
            tex = Some(c[1].to_lowercase());
            break;
        }
    }
    let mut color = None;
    for key in ["_BaseColor", "_Color"] {
        let re = regex::Regex::new(&format!(r"-\s*{key}:\s*\{{r:\s*([-\d.eE]+),\s*g:\s*([-\d.eE]+),\s*b:\s*([-\d.eE]+)")).unwrap();
        if let Some(c) = re.captures(y) {
            let p = |i: usize| c[i].parse::<f32>().unwrap_or(1.0).clamp(0.0, 1.0);
            color = Some([p(1), p(2), p(3)]);
            break;
        }
    }
    Mat { name, tex, color }
}

#[derive(Serialize)]
pub struct Extracted {
    /// where the model was written, and its type (`fbx` or `glb`)
    pub model: String,
    pub model_ext: String,
    pub model_name: String,
    /// the materials of the package and where each one's picture was written (absolute path, type)
    pub materials: Vec<ExMat>,
    pub notes: Vec<String>,
}

#[derive(Serialize)]
pub struct ExMat {
    pub name: String,
    pub tex: Option<String>,
    pub tex_ext: Option<String>,
    pub color: Option<[f32; 3]>,
}

/// Write the chosen model and the textures its materials use into `dir`, refusing a room that is too big for the viewer.
pub fn extract(pkg: &Path, s: &Scan, model_guid: &str, dir: &Path, free: u64) -> R<Extracted> {
    let mp = s.paths.get(model_guid).ok_or("That model isn't in the package.")?.clone();
    let model_ext = ext_of(&mp);
    if !MODEL_EXTS.contains(&model_ext.as_str()) {
        return Err("That model can't be used.".into());
    }
    let mats: Vec<Mat> = s.yaml.values().map(|y| parse_material(y)).filter(|m| !m.name.is_empty()).collect();
    // only the pictures that materials use, in formats that can be read
    let mut want: HashMap<String, String> = HashMap::new();
    let mut notes = vec![];
    for m in &mats {
        if let Some(g) = &m.tex {
            match s.paths.get(g) {
                Some(p) if TEXTURE_EXTS.contains(&ext_of(p).as_str()) => { want.insert(g.clone(), ext_of(p)); }
                Some(p) => notes.push(format!("{} was left out (its picture type isn't supported).", base_name(p))),
                None => {}
            }
        }
    }
    let msize = s.sizes.get(model_guid).copied().unwrap_or(0);
    let total = msize + want.keys().map(|g| s.sizes.get(g).copied().unwrap_or(0)).sum::<u64>();
    if total > MAX_ROOM_BYTES {
        return Err(format!("This room is too big for the 3D viewer: the model is {} and its pictures add {} (about {} at most is supported). Try a smaller room.", human(msize), human(total - msize), human(MAX_ROOM_BYTES)));
    }
    if free > 0 && free < total + 200 * 1024 * 1024 {
        return Err(format!("There isn't enough free space to unpack this room: it needs about {} and this device has {} free. Free some space, or try a smaller room.", human(total + 200 * 1024 * 1024), human(free)));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let model_file = dir.join(format!("model.{model_ext}"));
    let mut a = open(pkg)?;
    let mut found_model = false;
    for e in a.entries().map_err(|_| not_a_package())? {
        let mut e = e.map_err(|_| not_a_package())?;
        let p = e.path().map_err(|_| not_a_package())?.to_string_lossy().to_string();
        let Some((guid, name)) = split(&p) else { continue };
        if name != "asset" { continue; }
        if guid == model_guid {
            let mut f = std::fs::File::create(&model_file).map_err(|e| format!("Couldn't save the model (is the disk full?): {e}"))?;
            std::io::copy(&mut e, &mut f).map_err(|e| format!("Couldn't save the model (is the disk full?): {e}"))?;
            found_model = true;
        } else if let Some(ext) = want.get(guid) {
            let mut f = std::fs::File::create(dir.join(format!("tex-{guid}.{ext}"))).map_err(|e| e.to_string())?;
            std::io::copy(&mut e, &mut f).map_err(|e| format!("Couldn't save a picture (is the disk full?): {e}"))?;
        }
    }
    if !found_model {
        return Err("The model couldn't be found in the package.".into());
    }
    let materials = mats.into_iter().map(|m| {
        let (tex, tex_ext) = match &m.tex {
            Some(g) if want.contains_key(g) => (Some(dir.join(format!("tex-{g}.{}", want[g])).to_string_lossy().to_string()), Some(want[g].clone())),
            _ => (None, None),
        };
        ExMat { name: m.name, tex, tex_ext, color: m.color }
    }).collect();
    Ok(Extracted { model: model_file.to_string_lossy().to_string(), model_ext, model_name: base_name(&mp), materials, notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_unity_material() {
        let y = "%YAML 1.1\nMaterial:\n  m_Name: Wall\n  m_SavedProperties:\n    m_TexEnvs:\n    - _BumpMap:\n        m_Texture: {fileID: 2800000, guid: 11111111111111111111111111111111, type: 3}\n    - _MainTex:\n        m_Texture: {fileID: 2800000, guid: 0123456789abcdef0123456789ABCDEF, type: 3}\n    m_Colors:\n    - _Color: {r: 0.5, g: 0.25, b: 1, a: 1}\n";
        let m = parse_material(y);
        assert_eq!(m.name, "Wall");
        assert_eq!(m.tex.as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(m.color, Some([0.5, 0.25, 1.0]));
    }

    #[test]
    fn archive_paths_are_split_into_guid_and_name() {
        assert_eq!(split("abc123/asset"), Some(("abc123", "asset")));
        assert_eq!(split("./abc123/pathname"), Some(("abc123", "pathname")));
        assert_eq!(split("../x/asset"), None);
        assert_eq!(split("abc/def/asset"), None);
    }

    /// Writes a package like Unity does: one folder per asset (`asset`, `asset.meta`, `pathname`).
    fn make_package(path: &Path, assets: &[(&str, &str, Vec<u8>)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(f, flate2::Compression::fast()));
        for (guid, pathname, data) in assets {
            for (name, bytes) in [("asset", data.clone()), ("asset.meta", b"fileFormatVersion: 2\n".to_vec()), ("pathname", format!("{pathname}\n00\n").into_bytes())] {
                let mut h = tar::Header::new_gnu();
                h.set_size(bytes.len() as u64);
                h.set_mode(0o644);
                h.set_cksum();
                b.append_data(&mut h, format!("{guid}/{name}"), &bytes[..]).unwrap();
            }
        }
        b.into_inner().unwrap().finish().unwrap();
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("dorms-unitypkg-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_real_package_is_scanned_and_its_room_unpacked_with_the_pictures_its_materials_use() {
        let d = temp("ok");
        let (room, tex, other, mat) = ("a".repeat(32), "b".repeat(32), "c".repeat(32), "d".repeat(32));
        let yaml = format!("%YAML 1.1\nMaterial:\n  m_Name: Floor\n  m_SavedProperties:\n    m_TexEnvs:\n    - _MainTex:\n        m_Texture: {{fileID: 2800000, guid: {tex}, type: 3}}\n    m_Colors:\n    - _Color: {{r: 1, g: 0.5, b: 0.25, a: 1}}\n");
        let pkg = d.join("room.unitypackage");
        make_package(&pkg, &[
            (&room, "Assets/Room/Room.glb", b"glTFroom".to_vec()),
            (&tex, "Assets/Room/Floor.png", b"pngdata".to_vec()),
            (&other, "Assets/Room/Unused.png", b"unused".to_vec()),
            (&mat, "Assets/Room/Floor.mat", yaml.into_bytes()),
            (&"e".repeat(32), "Assets/Props/Lamp.fbx", b"Kaydara FBX Binary  \0lamp-is-smaller".to_vec()),
        ]);
        let s = scan(&pkg).unwrap();
        let rep = report(&s).unwrap();
        assert_eq!(rep.models.len(), 2, "the room and the lamp are offered");
        assert_eq!(rep.models[0].name, "Lamp.fbx", "biggest first");
        assert_eq!((rep.textures, rep.materials), (2, 1));
        let out = d.join("out");
        let ex = extract(&pkg, &s, &room, &out, 0).unwrap();
        assert_eq!(ex.model_ext, "glb");
        assert_eq!(std::fs::read(&ex.model).unwrap(), b"glTFroom");
        assert_eq!(ex.materials.len(), 1);
        assert_eq!(ex.materials[0].name, "Floor");
        assert_eq!(ex.materials[0].color, Some([1.0, 0.5, 0.25]));
        let tex_file = ex.materials[0].tex.clone().expect("the picture the material uses");
        assert_eq!(std::fs::read(&tex_file).unwrap(), b"pngdata");
        assert!(!out.join(format!("tex-{other}.png")).exists(), "pictures no material uses are not unpacked");
        // too big for the viewer, and not enough free space
        let mut huge = scan(&pkg).unwrap();
        huge.sizes.insert(room.clone(), 2 * 1024 * 1024 * 1024);
        assert!(extract(&pkg, &huge, &room, &d.join("o2"), 0).err().unwrap().contains("too big"));
        assert!(extract(&pkg, &s, &room, &d.join("o3"), 1024).err().unwrap().contains("enough free space"));
        assert!(!d.join("o3").exists(), "nothing is written when it is refused");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn files_that_are_not_packages_are_refused() {
        let d = temp("bad");
        let plain = d.join("plain.unitypackage");
        std::fs::write(&plain, b"just some text").unwrap();
        assert!(scan(&plain).err().unwrap().contains("isn't a Unity package"));
        let gz_not_tar = d.join("gz.unitypackage");
        let mut enc = flate2::write::GzEncoder::new(std::fs::File::create(&gz_not_tar).unwrap(), flate2::Compression::fast());
        std::io::Write::write_all(&mut enc, &[7u8; 2000]).unwrap();
        enc.finish().unwrap();
        assert!(scan(&gz_not_tar).is_err());
        let empty = d.join("empty.unitypackage");
        make_package(&empty, &[]);
        assert!(scan(&empty).err().unwrap().contains("No Unity assets"));
        assert!(scan(&d.join("missing")).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_package_with_no_model_is_refused_with_a_reason() {
        let mk = |paths: &[(&str, &str)]| {
            let mut s = Scan::default();
            for (i, (p, _)) in paths.iter().enumerate() { s.paths.insert(format!("g{i}"), p.to_string()); s.sizes.insert(format!("g{i}"), 100); }
            s
        };
        let e = report(&mk(&[("Assets/a.blend", ""), ("Assets/b.max", ""), ("Assets/t.png", "")])).err().unwrap();
        assert!(e.contains(".blend") && e.contains(".max"), "{e}");
        let e = report(&mk(&[("Assets/Room.unity", ""), ("Assets/Prop.prefab", "")])).err().unwrap();
        assert!(e.contains("scene"), "{e}");
        let e = report(&mk(&[("Assets/t.png", ""), ("Assets/m.mat", "")])).err().unwrap();
        assert!(e.contains("no 3D model"), "{e}");
        let ok = report(&mk(&[("Assets/Room/room.fbx", ""), ("Assets/t.png", "")])).unwrap();
        assert_eq!(ok.models.len(), 1);
        assert_eq!(ok.textures, 1);
    }
}

//! Turns any picture into an emoji or a sticker. Whatever size or shape a PNG, JPG, WebP or GIF comes in, it is shrunk to fit (never stretched or
//! enlarged), an emoji is placed on a square see-through canvas so it sits properly in a line of text, and an animated GIF stays animated:
//! each frame is shrunk, and if the result is still heavier than an emoji or sticker may be, frames are thinned out and then the picture is made
//! smaller until it fits. A picture that is already small enough is kept exactly as it is.

use std::io::Cursor;

use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::{self, FilterType};
use image::{AnimationDecoder, Delay, DynamicImage, ExtendedColorType, Frame, ImageDecoder, ImageEncoder, ImageFormat, Limits, RgbaImage};

type R<T> = Result<T, String>;

/// The longest side an emoji / sticker is made to (in pixels), and the most bytes the result may take.
pub const EMOJI_SIDE: u32 = 128;
pub const STICKER_SIDE: u32 = 320;
pub const EMOJI_BYTES: usize = 512 * 1024;
pub const STICKER_BYTES: usize = 3 * 1024 * 1024;
/// The biggest file that is looked at, and the biggest picture (a decompression bomb stays small on disk and huge in memory).
pub const MAX_INPUT_BYTES: usize = 40 * 1024 * 1024;
const MAX_SIDE: u32 = 16_384;
const MAX_PIXELS: u64 = 100_000_000;
/// An animation keeps at most this many frames (thinned evenly when it has more), and at least this many when it is being made lighter.
const MAX_FRAMES: usize = 400;
const MIN_FRAMES: usize = 6;
const MIN_SIDE: u32 = 48;

fn not_a_picture() -> String { "Emoji and stickers are pictures: PNG, JPG, WebP or GIF.".into() }

fn to_png(img: &RgbaImage) -> R<Vec<u8>> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Best, PngFilter::Adaptive)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(|e| format!("Couldn't make that picture into a PNG: {e}"))?;
    Ok(out)
}

/// The size a picture is shrunk to: it fits inside `side` by `side`, keeps its shape and is never enlarged.
pub fn fit(w: u32, h: u32, side: u32) -> (u32, u32) {
    if w <= side && h <= side { return (w.max(1), h.max(1)); }
    let k = f64::min(side as f64 / w as f64, side as f64 / h as f64);
    (((w as f64 * k).round() as u32).max(1), ((h as f64 * k).round() as u32).max(1))
}

/// A picture shrunk to fit, and (for an emoji) centred on a see-through square so every emoji has the same shape.
fn shrink(img: &RgbaImage, side: u32, square: bool) -> RgbaImage {
    let (nw, nh) = fit(img.width(), img.height(), side);
    let small = if (nw, nh) == (img.width(), img.height()) { img.clone() } else { imageops::resize(img, nw, nh, FilterType::CatmullRom) };
    if !square || nw == nh { return small; }
    let s = nw.max(nh);
    let mut canvas = RgbaImage::new(s, s);
    imageops::overlay(&mut canvas, &small, ((s - nw) / 2) as i64, ((s - nh) / 2) as i64);
    canvas
}

fn check_size(w: u32, h: u32) -> R<()> {
    if w == 0 || h == 0 { return Err(not_a_picture()); }
    if w > MAX_SIDE || h > MAX_SIDE || (w as u64) * (h as u64) > MAX_PIXELS { return Err(format!("That picture is far too large to read ({w} × {h} pixels).")); }
    Ok(())
}

/// Makes `bytes` (any size of PNG, JPG, WebP or GIF) into an emoji (`kind` "emoji") or a sticker. Returns the new file's bytes and its ending (`png` or `gif`).
pub fn to_emoji(bytes: &[u8], kind: &str) -> R<(Vec<u8>, &'static str)> {
    if bytes.is_empty() { return Err(not_a_picture()); }
    if bytes.len() > MAX_INPUT_BYTES { return Err(format!("That file is too big to read ({} MB at most).", MAX_INPUT_BYTES / 1024 / 1024)); }
    let (side, cap, square) = if kind == "emoji" { (EMOJI_SIDE, EMOJI_BYTES, true) } else { (STICKER_SIDE, STICKER_BYTES, false) };
    let fmt = image::guess_format(bytes).map_err(|_| not_a_picture())?;
    if !matches!(fmt, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif) { return Err(not_a_picture()); }

    if fmt == ImageFormat::Gif {
        let dec = GifDecoder::new(Cursor::new(bytes)).map_err(|_| "That GIF is damaged.".to_string())?;
        let (w, h) = dec.dimensions();
        check_size(w, h)?;
        // already fine: a small enough GIF is kept exactly as it is (animation and all)
        let ok_shape = if square { w == h } else { true };
        if w <= side && h <= side && ok_shape && bytes.len() <= cap { return Ok((bytes.to_vec(), "gif")); }
        return animated(bytes, side, cap, square);
    }

    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), fmt);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let img: DynamicImage = reader.decode().map_err(|e| format!("That picture can't be read ({e})."))?;
    check_size(img.width(), img.height())?;
    let rgba = img.to_rgba8();
    // already fine: a small enough PNG of the right shape is kept exactly as it is
    let ok_shape = if square { rgba.width() == rgba.height() } else { true };
    if fmt == ImageFormat::Png && rgba.width() <= side && rgba.height() <= side && ok_shape && bytes.len() <= cap { return Ok((bytes.to_vec(), "png")); }
    let mut s = side;
    loop {
        let out = to_png(&shrink(&rgba, s, square))?;
        if out.len() <= cap { return Ok((out, "png")); }
        if s <= MIN_SIDE { return Err("That picture is too detailed to make small enough. Try a simpler one.".into()); }
        s = (s * 3 / 4).max(MIN_SIDE);
    }
}

/// An animated GIF: every frame shrunk, then lightened (fewer frames, then smaller) until it fits.
fn animated(bytes: &[u8], side: u32, cap: usize, square: bool) -> R<(Vec<u8>, &'static str)> {
    let dec = || GifDecoder::new(Cursor::new(bytes)).map_err(|_| "That GIF is damaged.".to_string());
    // first look: how many frames (each is dropped as soon as it is counted, so a long GIF doesn't fill the memory)
    let count = dec()?.into_frames().take_while(|f| f.is_ok()).count();
    if count == 0 { return Err("That GIF is damaged.".into()); }
    let stride = count.div_ceil(MAX_FRAMES);
    // second look: keep every `stride`-th frame, shrunk, with the waiting time of the frames that were left out added to it
    let mut frames: Vec<(RgbaImage, u32)> = Vec::new();
    let (mut skipped_ms, mut seen) = (0u32, 0usize);
    for f in dec()?.into_frames() {
        let f = f.map_err(|_| "That GIF is damaged.".to_string())?;
        let (n, d) = f.delay().numer_denom_ms();
        let ms = if d == 0 { 100 } else { (n / d).max(1) };
        if seen % stride == 0 {
            if seen > 0 && !frames.is_empty() { let last = frames.len() - 1; frames[last].1 += skipped_ms; }
            skipped_ms = 0;
            frames.push((shrink(&f.into_buffer(), side, square), ms));
        } else { skipped_ms += ms; }
        seen += 1;
    }
    if let Some(last) = frames.last_mut() { last.1 += skipped_ms; }
    if frames.len() == 1 { return Ok((to_png(&frames[0].0)?, "png")); }   // a "GIF" with one picture in it is just a picture
    loop {
        let out = encode_gif(&frames)?;
        if out.len() <= cap { return Ok((out, "gif")); }
        if frames.len() > MIN_FRAMES * 2 {
            // every second frame goes, and its waiting time is added to the one before it
            frames = frames.chunks(2).map(|c| (c[0].0.clone(), c.iter().map(|x| x.1).sum())).collect();
        } else if frames[0].0.width().max(frames[0].0.height()) > MIN_SIDE {
            frames = frames.into_iter().map(|(im, ms)| (shrink(&im, (im.width().max(im.height()) * 3 / 4).max(MIN_SIDE), square), ms)).collect();
        } else {
            return Err("That animation is too long or too detailed to make small enough. Try a shorter one.".into());
        }
    }
}

fn encode_gif(frames: &[(RgbaImage, u32)]) -> R<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = GifEncoder::new_with_speed(&mut out, 10);
        enc.set_repeat(Repeat::Infinite).map_err(|e| e.to_string())?;
        for (im, ms) in frames {
            // browsers treat a frame under 20 ms as 100 ms, so shorter waits are raised to 20
            let f = Frame::from_parts(im.clone(), 0, 0, Delay::from_numer_denom_ms((*ms).max(20), 1));
            enc.encode_frame(f).map_err(|e| format!("Couldn't make that animation small: {e}"))?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_of(img: &RgbaImage) -> Vec<u8> { to_png(img).unwrap() }
    fn gradient(w: u32, h: u32) -> RgbaImage { RgbaImage::from_fn(w, h, |x, y| image::Rgba([(x * 255 / w) as u8, (y * 255 / h) as u8, 120, 255])) }
    fn noise(w: u32, h: u32, seed: u32) -> RgbaImage {
        let mut s = seed.wrapping_mul(2654435761).wrapping_add(1);
        RgbaImage::from_fn(w, h, |_, _| { s ^= s << 13; s ^= s >> 17; s ^= s << 5; image::Rgba([(s & 255) as u8, ((s >> 8) & 255) as u8, ((s >> 16) & 255) as u8, 255]) })
    }
    fn gif_of(frames: &[RgbaImage], ms: u32) -> Vec<u8> {
        let mut out = Vec::new();
        { let mut e = GifEncoder::new_with_speed(&mut out, 10); e.set_repeat(Repeat::Infinite).unwrap(); for f in frames { e.encode_frame(Frame::from_parts(f.clone(), 0, 0, Delay::from_numer_denom_ms(ms, 1))).unwrap(); } }
        out
    }
    fn dims(bytes: &[u8]) -> (u32, u32) { let i = image::load_from_memory(bytes).unwrap(); (i.width(), i.height()) }
    fn frame_count(bytes: &[u8]) -> usize { GifDecoder::new(Cursor::new(bytes)).unwrap().into_frames().count() }

    #[test]
    fn a_big_picture_becomes_a_small_square_emoji() {
        let (b, ext) = to_emoji(&png_of(&gradient(2400, 1800)), "emoji").unwrap();
        assert_eq!(ext, "png");
        assert_eq!(dims(&b), (128, 128), "a 4:3 picture is shrunk to fit and centred on a square");
        let img = image::load_from_memory(&b).unwrap().to_rgba8();
        assert_eq!(img.get_pixel(64, 2)[3], 0, "the empty strip at the top is see-through");
        assert!(img.get_pixel(64, 64)[3] == 255, "the picture is in the middle");
        assert!(b.len() <= EMOJI_BYTES);
    }

    #[test]
    fn a_picture_is_never_stretched_or_enlarged() {
        assert_eq!(fit(400, 100, 128), (128, 32));
        assert_eq!(fit(100, 400, 128), (32, 128));
        assert_eq!(fit(20, 30, 128), (20, 30), "a small one is not enlarged");
        let (b, _) = to_emoji(&png_of(&gradient(40, 30)), "emoji").unwrap();
        assert_eq!(dims(&b), (40, 40), "small and not square: only given a square to sit on");
    }

    #[test]
    fn a_picture_that_is_already_fine_is_kept_exactly() {
        let small = png_of(&gradient(32, 32));
        let (b, ext) = to_emoji(&small, "emoji").unwrap();
        assert_eq!((b, ext), (small, "png"));
        let g = gif_of(&[gradient(40, 40), noise(40, 40, 1), gradient(40, 40)], 80);
        let (b, ext) = to_emoji(&g, "emoji").unwrap();
        assert_eq!((b, ext), (g, "gif"), "an animation that is small enough is not touched");
    }

    #[test]
    fn jpg_and_webp_become_png() {
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 80).encode_image(&DynamicImage::ImageRgba8(gradient(900, 900)).to_rgb8()).unwrap();
        let (b, ext) = to_emoji(&jpg, "emoji").unwrap();
        assert_eq!((ext, dims(&b)), ("png", (128, 128)));
    }

    #[test]
    fn a_big_animated_gif_stays_animated_and_small() {
        let frames: Vec<RgbaImage> = (0..20).map(|i| { let mut f = gradient(500, 300); for x in 0..500 { f.put_pixel(x, (i * 14) % 300, image::Rgba([255, 255, 255, 255])); } f }).collect();
        let g = gif_of(&frames, 60);
        let (b, ext) = to_emoji(&g, "emoji").unwrap();
        assert_eq!(ext, "gif");
        assert_eq!(dims(&b), (128, 128));
        assert_eq!(frame_count(&b), 20, "every frame is kept when it fits");
        assert!(b.len() <= EMOJI_BYTES);
    }

    #[test]
    fn a_heavy_animation_is_lightened_until_it_fits() {
        let frames: Vec<RgbaImage> = (0..150).map(|i| noise(200, 200, i)).collect();
        let g = gif_of(&frames, 50);
        let (b, ext) = to_emoji(&g, "emoji").unwrap();
        assert_eq!(ext, "gif");
        assert!(b.len() <= EMOJI_BYTES, "{} bytes", b.len());
        let n = frame_count(&b);
        assert!((2..150).contains(&n), "frames were thinned out but it still moves ({n})");
    }

    #[test]
    fn a_single_frame_gif_is_just_a_picture() {
        let g = gif_of(&[gradient(600, 600)], 100);
        let (b, ext) = to_emoji(&g, "emoji").unwrap();
        assert_eq!((ext, dims(&b)), ("png", (128, 128)));
    }

    #[test]
    fn a_sticker_is_bigger_and_keeps_its_shape() {
        let (b, ext) = to_emoji(&png_of(&gradient(1000, 500)), "sticker").unwrap();
        assert_eq!((ext, dims(&b)), ("png", (320, 160)));
    }

    #[test]
    fn things_that_are_not_pictures_are_refused() {
        for bad in [&b""[..], b"hello", b"{\"a\":1}", b"%PDF-1.7 ...", &vec![7u8; 5000][..], b"<svg xmlns='http://www.w3.org/2000/svg'/>"] {
            assert!(to_emoji(bad, "emoji").unwrap_err().contains("pictures"), "{:?}", &bad[..bad.len().min(8)]);
        }
        assert!(to_emoji(&vec![0u8; MAX_INPUT_BYTES + 1], "emoji").unwrap_err().contains("too big"));
        // a PNG that claims to be enormous is refused before anything is allocated for it
        let mut fake = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        fake.extend_from_slice(&60000u32.to_be_bytes()); fake.extend_from_slice(&60000u32.to_be_bytes()); fake.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        assert!(to_emoji(&fake, "emoji").is_err());
    }

    #[test]
    fn even_a_noisy_animation_is_lightened_to_fit() {
        let g = gif_of(&(0..30).map(|i| noise(128, 128, i)).collect::<Vec<_>>(), 40);
        assert!(to_emoji(&g, "emoji").is_ok(), "even a noisy one is lightened to fit");
    }
}

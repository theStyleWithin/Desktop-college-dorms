//! Keeping moving backdrops light. A big animated GIF is expensive to show: every frame is decoded, and the whole window is redrawn
//! for each one. So a GIF used as a backdrop is made smaller and a little slower when it is added (the original on your disk is untouched),
//! and a still picture of its first frame is kept for the small places and for when the app is in the background.

use std::io::Cursor;

use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
use image::{imageops, AnimationDecoder, Delay, DynamicImage, Frame, ImageFormat, RgbaImage};

#[derive(Clone, Copy, Debug)]
pub struct GifLimits {
    /// The longest side, in pixels.
    pub max_side: u32,
    /// Width times height.
    pub max_pixels: u32,
    /// Frames closer together than this are merged (125 ms is 8 pictures a second).
    pub min_delay_ms: u32,
    pub max_frames: usize,
}

/// What a backdrop is allowed to be: about 854 by 480, eight pictures a second, 60 frames at most.
pub const BACKDROP: GifLimits = GifLimits { max_side: 854, max_pixels: 410_000, min_delay_ms: 125, max_frames: 60 };

pub struct Optimized {
    /// The lighter GIF, or `None` when the one given is already light enough.
    pub gif: Option<Vec<u8>>,
    /// The first frame, as a PNG, at the lighter size.
    pub still_png: Vec<u8>,
    pub from: (u32, u32, usize),
    pub to: (u32, u32, usize),
}

fn target_size(w: u32, h: u32, lim: &GifLimits) -> (u32, u32) {
    let side = (lim.max_side as f64 / w.max(h) as f64).min(1.0);
    let area = (lim.max_pixels as f64 / (w as f64 * h as f64)).sqrt().min(1.0);
    let s = side.min(area);
    (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1))
}

fn png_of(im: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(im.clone()).write_to(&mut out, ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Makes a GIF light enough to sit behind a chat. Frames are read one at a time, so a long GIF never has to be held whole in memory.
pub fn optimize_gif(bytes: &[u8], lim: &GifLimits) -> Result<Optimized, String> {
    let dec = GifDecoder::new(Cursor::new(bytes)).map_err(|e| format!("That isn't a GIF the app can read: {e}"))?;
    let (w, h) = image::ImageDecoder::dimensions(&dec);
    let (tw, th) = target_size(w, h, lim);
    let shrink = (tw, th) != (w, h);
    let mut kept: Vec<(RgbaImage, u32)> = vec![];
    let mut still: Option<RgbaImage> = None;
    let (mut total, mut slow_ok) = (0usize, true);
    for fr in dec.into_frames() {
        let fr = fr.map_err(|e| format!("A frame of that GIF is damaged: {e}"))?;
        total += 1;
        if total > 5000 {
            return Err("That GIF has too many frames (5,000 at most).".into());
        }
        let (n, d) = fr.delay().numer_denom_ms();
        let ms = (n as f64 / d.max(1) as f64).round().max(10.0) as u32;
        slow_ok &= ms >= lim.min_delay_ms;
        // a picture that is still on screen for less than the minimum takes the time of the frames after it instead
        if let Some(last) = kept.last_mut().filter(|l| l.1 < lim.min_delay_ms) {
            last.1 += ms;
            continue;
        }
        let buf = fr.into_buffer();
        let small = if shrink { imageops::resize(&buf, tw, th, imageops::FilterType::Triangle) } else { buf };
        if still.is_none() {
            still = Some(small.clone());
        }
        kept.push((small, ms));
    }
    let still = still.ok_or("That GIF has no pictures in it.")?;
    let from = (w, h, total);
    // too many frames: keep every k-th one and give it the time of the ones dropped
    if kept.len() > lim.max_frames {
        let k = kept.len().div_ceil(lim.max_frames);
        let mut thin: Vec<(RgbaImage, u32)> = vec![];
        for (i, (im, d)) in kept.into_iter().enumerate() {
            if i % k == 0 { thin.push((im, d)); } else if let Some(l) = thin.last_mut() { l.1 += d; }
        }
        kept = thin;
        slow_ok = false;
    }
    let light_enough = !shrink && slow_ok && total <= lim.max_frames;
    let still_png = png_of(&still)?;
    if light_enough {
        return Ok(Optimized { gif: None, still_png, from, to: from });
    }
    let to = (tw, th, kept.len());
    let mut out = Vec::new();
    {
        let mut enc = GifEncoder::new_with_speed(&mut out, 12);
        enc.set_repeat(Repeat::Infinite).map_err(|e| e.to_string())?;
        for (im, ms) in kept {
            enc.encode_frame(Frame::from_parts(im, 0, 0, Delay::from_numer_denom_ms(ms, 1))).map_err(|e| e.to_string())?;
        }
    }
    Ok(Optimized { gif: Some(out), still_png, from, to })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(w: u32, h: u32, frames: u32, ms: u32) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = GifEncoder::new(&mut out);
            enc.set_repeat(Repeat::Infinite).unwrap();
            for f in 0..frames {
                let im = RgbaImage::from_fn(w, h, |x, y| image::Rgba([((x + f * 7) % 256) as u8, (y % 256) as u8, (f * 20 % 256) as u8, 255]));
                enc.encode_frame(Frame::from_parts(im, 0, 0, Delay::from_numer_denom_ms(ms, 1))).unwrap();
            }
        }
        out
    }

    #[test]
    fn a_big_fast_gif_is_made_smaller_and_slower() {
        let src = make(400, 200, 20, 20);
        let lim = GifLimits { max_side: 100, max_pixels: 100_000, min_delay_ms: 100, max_frames: 120 };
        let o = optimize_gif(&src, &lim).unwrap();
        let gif = o.gif.expect("it had to be changed");
        assert_eq!(o.from, (400, 200, 20));
        assert_eq!((o.to.0, o.to.1), (100, 50), "shrunk, keeping its shape");
        assert!(o.to.2 <= 4, "20 frames of 20 ms became a few of 100 ms: {}", o.to.2);
        assert!(gif.len() < src.len());
        // what came out is a GIF of the new size, running for about as long as before
        let back = GifDecoder::new(Cursor::new(&gif)).unwrap().into_frames().collect_frames().unwrap();
        assert_eq!(back[0].buffer().dimensions(), (100, 50));
        let ms: u32 = back.iter().map(|f| { let (n, d) = f.delay().numer_denom_ms(); n / d.max(1) }).sum();
        assert!((300..=520).contains(&ms), "total time {ms} ms is about the original 400 ms");
        assert!(back[..back.len() - 1].iter().all(|f| { let (n, d) = f.delay().numer_denom_ms(); n / d.max(1) >= 100 }), "every picture but the last stays on screen at least 100 ms, the first too");
        let still = image::load_from_memory(&o.still_png).unwrap();
        assert_eq!((still.width(), still.height()), (100, 50));
    }

    #[test]
    fn a_light_gif_is_left_exactly_as_it_is() {
        let src = make(64, 32, 6, 200);
        let o = optimize_gif(&src, &BACKDROP).unwrap();
        assert!(o.gif.is_none(), "small, slow and short enough already");
        assert!(!o.still_png.is_empty());
    }

    #[test]
    fn too_many_frames_are_thinned_and_rubbish_is_refused() {
        let src = make(32, 16, 60, 100);
        let lim = GifLimits { max_side: 1024, max_pixels: 600_000, min_delay_ms: 100, max_frames: 20 };
        let o = optimize_gif(&src, &lim).unwrap();
        assert!(o.gif.is_some() && o.to.2 <= 20, "{:?}", o.to);
        assert!(optimize_gif(b"not a gif at all", &BACKDROP).is_err());
    }
}

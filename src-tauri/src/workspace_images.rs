//! Bounded, read-only image previews. Raster originals never reach the webview:
//! one decoded image is re-encoded without metadata or animation. SVG is a
//! deliberately small static subset and must only be displayed as an image.
mod svg;
mod webp;

use crate::tr;
use image::{
    AnimationDecoder, DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits,
};
use serde::Serialize;
use std::{
    io::{self, Cursor, Write},
    path::Path,
    sync::Mutex,
};

pub(super) const MAX_INPUT_BYTES: usize = 10 * 1024 * 1024;
pub(super) const MAX_EDGE: u32 = 8192;
pub(super) const MAX_PIXELS: u64 = 16_000_000;
pub(super) const MAX_DECODE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 20 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 1024;
// Acquire before reading input, not after allocating one input per waiting job.
static DECODE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    mime: &'static str,
    source_format: &'static str,
    width: u32,
    height: u32,
    first_frame_only: bool,
}

pub(crate) fn recognizes(bytes: &[u8]) -> bool {
    raster_format(bytes).is_some() || svg::recognizes(bytes)
}

fn raster_format(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes).ok().filter(|format| {
        matches!(
            format,
            ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
        )
    })
}

pub(crate) fn read(root: &Path, path: &str, version: &str) -> Result<Vec<u8>, String> {
    let _guard = DECODE_LOCK
        .try_lock()
        .map_err(|_| tr!("Another image is still decoding; try again shortly"))?;
    let bytes = crate::workspace_files::read_bounded(root, path, version, MAX_INPUT_BYTES)?;
    decode(&bytes)
}

pub(super) fn dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(tr!(
            "Images cannot exceed 8192 px on a side or 16 million pixels"
        ));
    }
    Ok(())
}

fn decode(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err(tr!("The image size must be between 1 byte and 10 MiB"));
    }
    let Some(format) = raster_format(bytes) else {
        let (width, height, bytes) = svg::normalize(bytes)?;
        let metadata = Metadata {
            mime: "image/svg+xml",
            source_format: "svg",
            width,
            height,
            first_frame_only: false,
        };
        let mut output = envelope(&metadata)?;
        output.extend_from_slice(&bytes);
        return Ok(output);
    };
    let animated_png = format == ImageFormat::Png && png_animation(bytes)?;
    let (mut image, first_frame_only) = if format == ImageFormat::WebP {
        webp::decode(bytes)?
    } else if animated_png {
        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_EDGE);
        limits.max_image_height = Some(MAX_EDGE);
        limits.max_alloc = Some(MAX_DECODE_BYTES);
        let mut decoder =
            image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), limits.clone())
                .map_err(image_error)?;
        let (width, height) = decoder.dimensions();
        dimensions(width, height)?;
        // APNG keeps compositing buffers internally and clones the first result.
        // Reserve that returned RGBA image in addition to its internal limits.
        limits
            .reserve(u64::from(width) * u64::from(height) * 4)
            .map_err(image_error)?;
        decoder.set_limits(limits).map_err(image_error)?;
        let orientation = decoder.orientation().map_err(image_error)?;
        let first = decoder
            .apng()
            .map_err(image_error)?
            .into_frames()
            .next()
            .ok_or(tr!("The APNG has no frame to preview"))?
            .map_err(image_error)?;
        let mut image = DynamicImage::ImageRgba8(first.into_buffer());
        image.apply_orientation(orientation);
        (image, true)
    } else {
        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_EDGE);
        limits.max_image_height = Some(MAX_EDGE);
        limits.max_alloc = Some(MAX_DECODE_BYTES);
        let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
        reader.limits(limits.clone());
        let mut decoder = reader.into_decoder().map_err(image_error)?;
        let (width, height) = decoder.dimensions();
        dimensions(width, height)?;
        // from_decoder does not reserve the output buffer from the budget.
        limits.reserve(decoder.total_bytes()).map_err(image_error)?;
        decoder.set_limits(limits).map_err(image_error)?;
        let orientation = decoder.orientation().map_err(image_error)?;
        let mut image = DynamicImage::from_decoder(decoder).map_err(image_error)?;
        image.apply_orientation(orientation);
        (image, format == ImageFormat::Gif)
    };
    // Keep encoder input to 8-bit channels; both old and converted buffers are
    // independently bounded. Decoder max_alloc is best-effort, not an OS quota.
    if image.color().bits_per_pixel() > 32 {
        image = DynamicImage::ImageRgba8(image.into_rgba8());
    }
    let metadata = Metadata {
        mime: "image/png",
        source_format: match format {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Gif => "gif",
            ImageFormat::WebP => "webp",
            _ => unreachable!(),
        },
        width: image.width(),
        height: image.height(),
        first_frame_only,
    };
    let output = envelope(&metadata)?;
    let limit = output
        .len()
        .checked_add(MAX_OUTPUT_BYTES)
        .ok_or(tr!("The image preview size overflowed"))?;
    let mut writer = CappedWriter {
        bytes: output,
        limit,
    };
    image::codecs::png::PngEncoder::new(&mut writer)
        .write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .map_err(image_error)?;
    Ok(writer.bytes)
}

fn image_error(error: image::ImageError) -> String {
    tr!(
        "The image is corrupt, unsupported or over the decode limit: {{error}}",
        error = error
    )
}

fn envelope(metadata: &Metadata) -> Result<Vec<u8>, String> {
    let header = serde_json::to_vec(metadata)
        .map_err(|_| tr!("Cannot encode the image preview information"))?;
    if header.len() > MAX_HEADER_BYTES {
        return Err(tr!("The image preview information exceeds the limit"));
    }
    let mut result = Vec::with_capacity(8 + header.len());
    result.extend_from_slice(b"SBI1");
    result.extend_from_slice(&(header.len() as u32).to_le_bytes());
    result.extend_from_slice(&header);
    Ok(result)
}

struct CappedWriter {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for CappedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other(tr!(
                "The encoded image preview exceeds 20 MiB"
            )));
        }
        let needed = self.bytes.len() + bytes.len();
        if needed > self.bytes.capacity() {
            let capacity = needed
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.limit);
            self.bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .map_err(|_| {
                    io::Error::other(tr!("Not enough memory to encode the image preview"))
                })?;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn png_animation(bytes: &[u8]) -> Result<bool, String> {
    let mut offset = 8usize;
    let mut animated = false;
    let mut count = 0;
    while offset < bytes.len() {
        count += 1;
        if count > 100_000 || bytes.len() - offset < 12 {
            return Err(tr!("The PNG chunks are corrupt"));
        }
        let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|n| n.checked_add(size))
            .filter(|end| *end <= bytes.len())
            .ok_or(tr!("The PNG chunks are corrupt"))?;
        let kind = &bytes[offset + 4..offset + 8];
        animated |= kind == b"acTL";
        if kind == b"IEND" {
            if size != 0 || end != bytes.len() {
                return Err(tr!("The end of the PNG is corrupt"));
            }
            return Ok(animated);
        }
        offset = end;
    }
    Err(tr!("The PNG is missing its end chunk"))
}

#[cfg(test)]
mod tests {
    /// Canonical path without the Windows `\\?\` verbatim prefix.
    fn real_path(path: &std::path::Path) -> std::path::PathBuf {
        let path = path.canonicalize().unwrap();
        #[cfg(windows)]
        if let Some(rest) = path.to_string_lossy().strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return std::path::PathBuf::from(rest);
            }
        }
        path
    }

    use super::*;
    use image::GenericImageView;
    static READ_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn picture(format: ImageFormat) -> Vec<u8> {
        if format == ImageFormat::WebP {
            return include_bytes!("workspace_images/fixtures/red-3x2-lossy.webp").to_vec();
        }
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(3, 2)
            .write_to(&mut bytes, format)
            .unwrap();
        bytes.into_inner()
    }
    fn unpack(bytes: &[u8]) -> (serde_json::Value, &[u8]) {
        assert_eq!(&bytes[..4], b"SBI1");
        let n = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        (
            serde_json::from_slice(&bytes[8..8 + n]).unwrap(),
            &bytes[8 + n..],
        )
    }
    #[test]
    fn raster_formats_are_canonical_static_png() {
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::Gif,
            ImageFormat::WebP,
        ] {
            let source = picture(format);
            assert!(recognizes(&source));
            let response = decode(&source).unwrap();
            let (header, payload) = unpack(&response);
            assert_eq!(header["mime"], "image/png");
            assert_eq!(header["width"], 3);
            assert_eq!(header["height"], 2);
            assert_eq!(image::guess_format(payload).unwrap(), ImageFormat::Png);
            assert!(!png_animation(payload).unwrap());
            assert_eq!(
                image::load_from_memory(payload).unwrap().dimensions(),
                (3, 2)
            );
        }
    }
    #[test]
    fn rejects_bad_input_and_dimensions() {
        for bytes in [
            &b""[..],
            &b"not an image"[..],
            &picture(ImageFormat::Png)[..20],
        ] {
            assert!(decode(bytes).is_err());
        }
        assert!(decode(&vec![0; MAX_INPUT_BYTES + 1]).is_err());
        for (w, h) in [(0, 1), (1, 0), (8193, 1), (1, 8193), (8192, 8192)] {
            assert!(dimensions(w, h).is_err());
        }
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(8193, 1)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        assert!(decode(bytes.get_ref()).is_err());
    }
    #[test]
    fn encoded_writer_checks_before_growth() {
        let mut writer = CappedWriter {
            bytes: vec![1],
            limit: 3,
        };
        writer.write_all(&[2, 3]).unwrap();
        assert!(writer.write_all(&[4]).is_err());
        assert_eq!(writer.bytes, [1, 2, 3]);
    }
    #[test]
    fn gif_returns_only_first_frame() {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            for color in [[255, 0, 0, 255], [0, 255, 0, 255]] {
                encoder
                    .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                        2,
                        2,
                        image::Rgba(color),
                    )))
                    .unwrap();
            }
        }
        let response = decode(&bytes).unwrap();
        let (header, payload) = unpack(&response);
        assert_eq!(header["firstFrameOnly"], true);
        assert_eq!(
            image::load_from_memory(payload)
                .unwrap()
                .to_rgba8()
                .get_pixel(0, 0)
                .0,
            [255, 0, 0, 255]
        );
    }
    #[test]
    fn gif_small_canvas_does_not_hide_unbounded_first_frame() {
        // A valid 1x1 GIF with a two-color global palette and one image block.
        let mut bytes = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b".to_vec();
        assert!(decode(&bytes).is_ok());
        // Keep the logical screen tiny while advertising a 65535x65535 frame.
        // This must fail at the frame allocation budget, before LZW decoding.
        bytes[24..28].copy_from_slice(&[0xff; 4]);
        let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(decoder.dimensions(), (1, 1));
        assert!(decode(&bytes)
            .unwrap_err()
            .contains("Memory limit exceeded"));
    }
    #[test]
    fn apng_skips_default_thumbnail_and_returns_first_animation_frame() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_animated(2, 0).unwrap();
            encoder.set_sep_def_img(true).unwrap();
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[0, 0, 255, 255]).unwrap();
            writer.write_image_data(&[255, 0, 0, 255]).unwrap();
            writer.write_image_data(&[0, 255, 0, 255]).unwrap();
            writer.finish().unwrap();
        }
        let response = decode(&bytes).unwrap();
        let (header, payload) = unpack(&response);
        assert_eq!(header["firstFrameOnly"], true);
        assert_eq!(
            image::load_from_memory(payload)
                .unwrap()
                .to_rgba8()
                .get_pixel(0, 0)
                .0,
            [255, 0, 0, 255]
        );
        assert!(!png_animation(payload).unwrap());
    }
    #[test]
    fn apng_small_canvas_rejects_out_of_bounds_frame_control() {
        for (width, height, x_offset, y_offset) in [
            (u32::MAX, u32::MAX, 0_u32, 0_u32),
            (1, 1, 1, 0),
            (1, 1, 0, 1),
        ] {
            let mut bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().unwrap();
                // Raw chunks retain valid CRCs but deliberately bypass the
                // encoder's frame-bound validation. The default image is not
                // an animation frame; the malicious fcTL follows its IDAT.
                writer
                    .write_chunk(png::chunk::acTL, &[0, 0, 0, 1, 0, 0, 0, 0])
                    .unwrap();
                writer.write_image_data(&[0, 0, 255, 255]).unwrap();
                let mut control = [0_u8; 26];
                control[4..8].copy_from_slice(&width.to_be_bytes());
                control[8..12].copy_from_slice(&height.to_be_bytes());
                control[12..16].copy_from_slice(&x_offset.to_be_bytes());
                control[16..20].copy_from_slice(&y_offset.to_be_bytes());
                writer.write_chunk(png::chunk::fcTL, &control).unwrap();
                writer.finish().unwrap();
            }
            assert!(png_animation(&bytes).unwrap());
            // Assert the bounds error, rather than a later missing-frame error.
            assert!(decode(&bytes)
                .unwrap_err()
                .contains("Sub frame is out-of-bounds"));
        }
    }
    #[test]
    fn concurrent_preview_fails_fast_before_reading() {
        let _test_guard = READ_TEST_LOCK.lock().unwrap();
        let _decode_guard = DECODE_LOCK.lock().unwrap();
        assert!(
            read(Path::new("/does-not-exist"), "image.png", &"0".repeat(64))
                .unwrap_err()
                .contains("still decoding")
        );
    }
    #[test]
    fn svg_payload_uses_separate_mime() {
        let source = br#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>"#;
        let response = decode(source).unwrap();
        let (header, payload) = unpack(&response);
        assert_eq!(header["mime"], "image/svg+xml");
        assert_eq!(header["sourceFormat"], "svg");
        assert_eq!(payload, source);
    }
    #[test]
    fn safe_read_checks_revision_size_and_paths() {
        let _test_guard = READ_TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        // Real path: macOS temp lives under the /var symlink, which safe
        // reads (correctly) refuse to traverse.
        let directory = real_path(temp.path());
        let directory = directory.as_path();
        let path = directory.join("image.png");
        std::fs::write(&path, picture(ImageFormat::Png)).unwrap();
        let info = crate::workspace_files::inspect(directory, "image.png").unwrap();
        assert_eq!(info.kind, crate::models::WorkspaceFileKind::Image);
        assert!(read(directory, "image.png", &info.version).is_ok());
        assert!(read(directory, "../image.png", &info.version).is_err());
        std::fs::write(&path, picture(ImageFormat::Jpeg)).unwrap();
        assert!(read(directory, "image.png", &info.version).is_err());
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_INPUT_BYTES as u64 + 1).unwrap();
        // Windows refuses to share a file another handle is still writing.
        drop(file);
        let info = crate::workspace_files::inspect(directory, "image.png").unwrap();
        assert!(read(directory, "image.png", &info.version).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_and_hardlink_reads() {
        let _test_guard = READ_TEST_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let directory = real_path(temp.path());
        let directory = directory.as_path();
        let source = directory.join("image.png");
        std::fs::write(&source, picture(ImageFormat::Png)).unwrap();
        let info = crate::workspace_files::inspect(directory, "image.png").unwrap();
        std::os::unix::fs::symlink(&source, directory.join("link.png")).unwrap();
        assert!(read(directory, "link.png", &info.version).is_err());
        std::fs::hard_link(source, directory.join("hard.png")).unwrap();
        assert!(read(directory, "hard.png", &info.version).is_err());
    }
}

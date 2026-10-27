//! Validate every encoded dimension before invoking the WebP decoder. In image
//! 0.25 the generic WebP wrapper does not forward allocation limits, and VP8X
//! canvas dimensions alone do not constrain an inconsistent VP8 bitstream.
use super::{dimensions, MAX_DECODE_BYTES};
use crate::tr;
use image::{metadata::Orientation, DynamicImage};
use std::io::Cursor;

fn invalid() -> String {
    tr!("The WebP chunks are corrupt or the frame sizes do not match")
}

fn unsupported_compression() -> String {
    tr!("Lossless WebP and losslessly compressed transparency are not supported yet; only lossy VP8 WebP is previewed")
}
const MAX_CHUNKS: usize = 4096;
const MAX_FRAMES: usize = 512;

pub(super) fn decode(bytes: &[u8]) -> Result<(DynamicImage, bool), String> {
    let animated = preflight(bytes)?;
    let mut decoder = image_webp::WebPDecoder::new(Cursor::new(bytes))
        .map_err(|e| tr!("Cannot decode the WebP image: {{error}}", error = e))?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    let size = decoder
        .output_buffer_size()
        .filter(|size| *size as u64 <= MAX_DECODE_BYTES)
        .ok_or(tr!("The WebP decode buffer exceeds the limit"))?;
    decoder.set_memory_limit((MAX_DECODE_BYTES - size as u64) as usize);
    let orientation = decoder
        .exif_metadata()
        .map_err(|e| tr!("The WebP metadata is corrupt: {{error}}", error = e))?
        .as_deref()
        .and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms);
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(size)
        .map_err(|_| tr!("Not enough memory to decode the WebP image"))?;
    pixels.resize(size, 0);
    decoder
        .read_image(&mut pixels)
        .map_err(|e| tr!("Cannot decode the WebP image: {{error}}", error = e))?;
    let mut image = if decoder.has_alpha() {
        DynamicImage::ImageRgba8(
            image::RgbaImage::from_raw(width, height, pixels).ok_or_else(invalid)?,
        )
    } else {
        DynamicImage::ImageRgb8(
            image::RgbImage::from_raw(width, height, pixels).ok_or_else(invalid)?,
        )
    };
    image.apply_orientation(orientation);
    Ok((image, animated))
}

struct Chunk<'a> {
    kind: &'a [u8],
    data: &'a [u8],
}
fn chunks<'a>(bytes: &'a [u8], count: &mut usize) -> Result<Vec<Chunk<'a>>, String> {
    let mut offset = 0usize;
    let mut result = Vec::new();
    while offset < bytes.len() {
        *count += 1;
        if *count > MAX_CHUNKS || bytes.len() - offset < 8 {
            return Err(invalid());
        }
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        let padded_end = end
            .checked_add(size & 1)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        result.push(Chunk {
            kind: &bytes[offset..offset + 4],
            data: &bytes[start..end],
        });
        offset = padded_end;
    }
    Ok(result)
}
fn u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn bitstream_size(chunk: &Chunk<'_>) -> Result<(u32, u32), String> {
    let data = chunk.data;
    let result = if chunk.kind == b"VP8 " {
        if data.len() < 10 || data[0] & 1 != 0 || &data[3..6] != b"\x9d\x01\x2a" {
            return Err(invalid());
        }
        if (u24(&data[..3]) >> 5) as usize > data.len() - 10 {
            return Err(invalid());
        }
        (
            u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3fff),
            u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3fff),
        )
    } else if chunk.kind == b"VP8L" {
        // image-webp 0.2.4's lossless Huffman-group allocation is not limited
        // by set_memory_limit or pixel count. Never enter that decoder.
        return Err(unsupported_compression());
    } else {
        return Err(invalid());
    };
    dimensions(result.0, result.1)?;
    Ok(result)
}

fn alpha(data: &[u8], size: (u32, u32)) -> Result<(), String> {
    let header = *data.first().ok_or_else(invalid)?;
    if header & 3 != 0 {
        return Err(unsupported_compression());
    }
    if header & 0xc0 != 0
        || ((header >> 4) & 3) > 1
        || data.len() as u64 != 1 + u64::from(size.0) * u64::from(size.1)
    {
        return Err(invalid());
    }
    Ok(())
}

fn preflight(bytes: &[u8]) -> Result<bool, String> {
    if bytes.len() < 20
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WEBP"
        || u64::from(u32::from_le_bytes(bytes[4..8].try_into().unwrap())) + 8 != bytes.len() as u64
    {
        return Err(invalid());
    }
    let mut count = 0;
    let all = chunks(&bytes[12..], &mut count)?;
    let first = all.first().ok_or_else(invalid)?;
    let extended = first.kind == b"VP8X";
    let (canvas, animated) = if extended {
        if first.data.len() != 10 {
            return Err(invalid());
        }
        let size = (u24(&first.data[4..7]) + 1, u24(&first.data[7..10]) + 1);
        dimensions(size.0, size.1)?;
        (size, first.data[0] & 2 != 0)
    } else {
        (bitstream_size(first)?, false)
    };
    let mut streams = 0;
    let mut frames = 0;
    let mut animation_headers = 0;
    let mut extended_headers = 0;
    let mut alpha_chunks = 0;
    for (index, chunk) in all.iter().enumerate() {
        match chunk.kind {
            b"VP8X" => {
                extended_headers += 1;
                if extended_headers > 1 || !extended {
                    return Err(invalid());
                }
            }
            b"VP8 " | b"VP8L" => {
                streams += 1;
                if animated || streams > 1 || bitstream_size(chunk)? != canvas {
                    return Err(invalid());
                }
            }
            b"ALPH" => {
                alpha_chunks += 1;
                if alpha_chunks > 1 || animated || !extended {
                    return Err(invalid());
                }
                alpha(chunk.data, canvas)?;
                if all.get(index + 1).is_none_or(|next| next.kind != b"VP8 ") {
                    return Err(invalid());
                }
            }
            b"ANIM" => {
                animation_headers += 1;
                if !animated || animation_headers > 1 || chunk.data.len() != 6 {
                    return Err(invalid());
                }
            }
            b"ANMF" => {
                frames += 1;
                if !animated || frames > MAX_FRAMES || chunk.data.len() < 16 {
                    return Err(invalid());
                }
                let data = chunk.data;
                let x = u24(&data[..3]) * 2;
                let y = u24(&data[3..6]) * 2;
                let size = (u24(&data[6..9]) + 1, u24(&data[9..12]) + 1);
                dimensions(size.0, size.1)?;
                if x + size.0 > canvas.0 || y + size.1 > canvas.1 {
                    return Err(invalid());
                }
                let subchunks = chunks(&data[16..], &mut count)?;
                // The pinned decoder reads the chunk immediately after ALPH as
                // VP8 without verifying its FourCC. Match its exact read order;
                // accepting unknown/interspersed chunks would bypass preflight.
                let stream = match subchunks.as_slice() {
                    [stream] => stream,
                    [transparency, stream] if transparency.kind == b"ALPH" => {
                        alpha(transparency.data, size)?;
                        stream
                    }
                    _ => return Err(invalid()),
                };
                if bitstream_size(stream)? != size {
                    return Err(invalid());
                }
            }
            _ => {}
        }
    }
    if (animated && (frames == 0 || animation_headers != 1)) || (!animated && streams != 1) {
        return Err(invalid());
    }
    Ok(animated)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = kind.to_vec();
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            bytes.push(0);
        }
        bytes
    }
    fn riff(chunks: Vec<Vec<u8>>) -> Vec<u8> {
        let data: Vec<u8> = chunks.into_iter().flatten().collect();
        let mut result = b"RIFF".to_vec();
        result.extend_from_slice(&(data.len() as u32 + 4).to_le_bytes());
        result.extend_from_slice(b"WEBP");
        result.extend(data);
        result
    }
    fn lossy(width: u32, height: u32) -> Vec<u8> {
        let mut result = vec![0, 0, 0, 0x9d, 1, 0x2a];
        result.extend_from_slice(&(width as u16).to_le_bytes());
        result.extend_from_slice(&(height as u16).to_le_bytes());
        result
    }
    #[test]
    fn rejects_mismatched_and_huge_bitstreams_before_decode() {
        let vp8x = chunk(b"VP8X", &[0; 10]);
        assert!(preflight(&riff(vec![vp8x.clone(), chunk(b"VP8 ", &lossy(2, 1))])).is_err());
        assert!(preflight(&riff(vec![chunk(b"VP8 ", &lossy(8193, 1))])).is_err());
        assert!(preflight(&riff(vec![vp8x, chunk(b"VP8 ", &lossy(1, 1))])).is_ok());
        let vp8 = [0, 0, 0, 0x9d, 1, 0x2a, 0xff, 0x3f, 0xff, 0x3f];
        assert!(preflight(&riff(vec![chunk(b"VP8 ", &vp8)])).is_err());
    }
    #[test]
    fn rejects_truncated_oversized_and_duplicate_chunks() {
        let stream = chunk(b"VP8 ", &lossy(1, 1));
        let bytes = riff(vec![stream.clone()]);
        for length in 0..bytes.len() {
            assert!(preflight(&bytes[..length]).is_err());
        }
        assert!(preflight(&riff(vec![stream.clone(), stream])).is_err());
        let mut bad = bytes;
        bad[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(preflight(&bad).is_err());
    }
    #[test]
    fn animation_frame_bounds_and_embedded_size_are_checked() {
        let mut header = [0; 10];
        header[0] = 2;
        let mut frame = vec![0; 16];
        frame.extend(chunk(b"VP8 ", &lossy(1, 1)));
        let good = riff(vec![
            chunk(b"VP8X", &header),
            chunk(b"ANIM", &[0; 6]),
            chunk(b"ANMF", &frame),
        ]);
        assert_eq!(preflight(&good), Ok(true));
        frame[0] = 1;
        assert!(preflight(&riff(vec![
            chunk(b"VP8X", &header),
            chunk(b"ANIM", &[0; 6]),
            chunk(b"ANMF", &frame)
        ]))
        .is_err());
    }
    #[test]
    fn animated_webp_decodes_only_first_frame() {
        let mut frames = Vec::new();
        for encoded in [
            include_bytes!("fixtures/red-3x2-lossy.webp"),
            include_bytes!("fixtures/green-3x2-lossy.webp"),
        ] {
            assert_eq!(&encoded[12..16], b"VP8 ");
            let mut frame = vec![0; 16];
            frame[6] = 2;
            frame[9] = 1;
            frame[12] = 20;
            frame[15] = 2;
            frame.extend_from_slice(&encoded[12..]);
            frames.push(chunk(b"ANMF", &frame));
        }
        let mut header = [0; 10];
        header[0] = 2;
        header[4] = 2;
        header[7] = 1;
        let bytes = riff(vec![
            chunk(b"VP8X", &header),
            chunk(b"ANIM", &[0; 6]),
            frames.remove(0),
            frames.remove(0),
        ]);
        let (image, animated) = decode(&bytes).unwrap();
        assert!(animated);
        let pixel = image.to_rgba8().get_pixel(0, 0).0;
        assert!(pixel[0] > 240 && pixel[1] < 10 && pixel[2] < 10);
    }
    #[test]
    fn rejects_all_lossless_entry_points_before_entropy_decoding() {
        // Tiny dimensions do not bound image-webp's lossless Huffman groups.
        let hostile = [0x2f, 0, 0, 0, 0, 0xff, 0xff, 0xff];
        assert_eq!(
            decode(&riff(vec![chunk(b"VP8L", &hostile)])).unwrap_err(),
            unsupported_compression()
        );
        let mut header = [0; 10];
        header[0] = 16;
        assert_eq!(
            preflight(&riff(vec![
                chunk(b"VP8X", &header),
                chunk(b"ALPH", &[1, 0xff]),
                chunk(b"VP8 ", &lossy(1, 1))
            ]))
            .unwrap_err(),
            unsupported_compression()
        );
        header[0] = 2 | 16;
        for subchunks in [
            vec![chunk(b"VP8L", &hostile)],
            vec![chunk(b"ALPH", &[1, 0xff]), chunk(b"VP8 ", &lossy(1, 1))],
        ] {
            let mut frame = vec![0; 16];
            frame.extend(subchunks.into_iter().flatten());
            assert_eq!(
                preflight(&riff(vec![
                    chunk(b"VP8X", &header),
                    chunk(b"ANIM", &[0; 6]),
                    chunk(b"ANMF", &frame)
                ]))
                .unwrap_err(),
                unsupported_compression()
            );
        }
        assert!(alpha(&[0, 255], (1, 1)).is_ok());
        assert!(alpha(&[0], (1, 1)).is_err());
    }
    #[test]
    fn alpha_then_unknown_chunk_cannot_bypass_vp8_dimension_preflight() {
        let mut header = [0; 10];
        header[0] = 2 | 16;
        let mut frame = vec![0; 16];
        frame.extend(chunk(b"ALPH", &[0, 255]));
        frame.extend(chunk(b"JUNK", &lossy(16383, 16383)));
        frame.extend(chunk(b"VP8 ", &lossy(1, 1)));
        assert!(preflight(&riff(vec![
            chunk(b"VP8X", &header),
            chunk(b"ANIM", &[0; 6]),
            chunk(b"ANMF", &frame)
        ]))
        .is_err());
        header[0] = 16;
        assert!(preflight(&riff(vec![
            chunk(b"VP8X", &header),
            chunk(b"ALPH", &[0, 255]),
            chunk(b"JUNK", &lossy(16383, 16383)),
            chunk(b"VP8 ", &lossy(1, 1))
        ]))
        .is_err());
        let mut frame = vec![0; 16];
        frame.extend(chunk(b"ALPH", &[0, 255]));
        frame.extend(chunk(b"VP8 ", &lossy(1, 1)));
        frame.extend(chunk(b"JUNK", &[]));
        header[0] = 2 | 16;
        assert!(preflight(&riff(vec![
            chunk(b"VP8X", &header),
            chunk(b"ANIM", &[0; 6]),
            chunk(b"ANMF", &frame)
        ]))
        .is_err());
    }
}

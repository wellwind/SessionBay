//! Reject unsupported SVG rather than strip it and silently change the image.
//! No URL references, CSS, scripts, reusable subtrees or offscreen effects are
//! admitted. The resulting bytes are only suitable for an <img>, never DOM HTML.
use crate::tr;
use quick_xml::{
    events::{BytesStart, Event},
    Reader, Writer, XmlVersion,
};

const MAX_BYTES: usize = 512 * 1024;
const MAX_ELEMENTS: usize = 4096;
const MAX_DEPTH: usize = 32;
const MAX_ATTRIBUTE_BYTES: usize = 64 * 1024;
const MAX_NUMBERS: usize = 50_000;
fn invalid() -> String {
    tr!("SVG only supports limited static graphics, without scripts, styles, external resources, references or animation")
}

pub(super) fn recognizes(bytes: &[u8]) -> bool {
    // The inspect sample can end within UTF-8; only the valid prefix is needed
    // to recognize an opening root element, not to validate the entire file.
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).unwrap_or("")
        }
        Err(_) => return false,
    };
    let mut reader = Reader::from_str(text.trim_start_matches('\u{feff}'));
    for _ in 0..128 {
        match reader.read_event() {
            Ok(Event::Start(element) | Event::Empty(element)) => {
                return element.name().into_inner() == "svg"
            }
            Ok(Event::Decl(_) | Event::Comment(_) | Event::DocType(_)) => {}
            Ok(Event::Text(text)) if text.trim().is_empty() => {}
            _ => return false,
        }
    }
    false
}

pub(super) fn validate(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() > MAX_BYTES {
        return Err(tr!("SVG files cannot exceed 512 KiB"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| tr!("SVG files must use UTF-8"))?;
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(invalid());
    }
    let mut reader = Reader::from_str(text.trim_start_matches('\u{feff}'));
    reader.config_mut().check_comments = true;
    let mut depth = 0usize;
    let mut elements = 0usize;
    let mut numbers = 0usize;
    let mut root_seen = false;
    let mut declared = false;
    let mut size = None;
    loop {
        let event = reader.read_event().map_err(|_| invalid())?;
        let is_empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                elements += 1;
                if elements > MAX_ELEMENTS || depth >= MAX_DEPTH {
                    return Err(tr!("The SVG structure exceeds the preview limit"));
                }
                let is_root = depth == 0;
                if is_root {
                    if root_seen {
                        return Err(invalid());
                    }
                    root_seen = true;
                }
                let root_size = element_attributes(&element, is_root, &mut numbers)?;
                if is_root {
                    size = root_size;
                }
                if !is_empty {
                    depth += 1;
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or_else(invalid)?;
            }
            Event::Decl(declaration) => {
                if root_seen || declared || declaration.version().map_err(|_| invalid())? != "1.0" {
                    return Err(invalid());
                }
                declared = true;
                if let Some(encoding) = declaration.encoding() {
                    if !encoding
                        .map_err(|_| invalid())?
                        .eq_ignore_ascii_case("utf-8")
                    {
                        return Err(invalid());
                    }
                }
            }
            Event::Text(text) => {
                if depth == 0 && !text.trim().is_empty() {
                    return Err(invalid());
                }
            }
            Event::CData(_) => {
                if depth == 0 {
                    return Err(invalid());
                }
            }
            Event::GeneralRef(reference) => {
                if depth == 0 {
                    return Err(invalid());
                }
                if reference
                    .resolve_char_ref()
                    .map_err(|_| invalid())?
                    .is_none()
                    && !matches!(reference.as_ref(), "amp" | "lt" | "gt" | "apos" | "quot")
                {
                    return Err(invalid());
                }
            }
            Event::Comment(_) => {}
            Event::Eof => break,
            _ => return Err(invalid()),
        }
    }
    if depth != 0 || !root_seen {
        return Err(invalid());
    }
    size.ok_or_else(|| tr!("SVG files need an explicit positive width/height (px) or a viewBox"))
}

pub(super) fn normalize(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let (width, height) = validate(bytes)?;
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut reader = Reader::from_str(text.trim_start_matches('\u{feff}'));
    let mut writer = Writer::new(Vec::with_capacity(bytes.len()));
    let mut root = false;
    loop {
        let event = reader.read_event().map_err(|_| invalid())?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) if !root => {
                root = true;
                let mut normalized = BytesStart::new("svg");
                for attribute in element.attributes() {
                    let attribute = attribute.map_err(|_| invalid())?;
                    if !matches!(attribute.key.into_inner(), "width" | "height") {
                        normalized.push_attribute(attribute);
                    }
                }
                let width = width.to_string();
                let height = height.to_string();
                normalized.push_attribute(("width", width.as_str()));
                normalized.push_attribute(("height", height.as_str()));
                writer
                    .write_event(if empty {
                        Event::Empty(normalized)
                    } else {
                        Event::Start(normalized)
                    })
                    .map_err(|_| invalid())?;
            }
            Event::Eof => break,
            event => writer.write_event(event).map_err(|_| invalid())?,
        }
        if writer.get_ref().len() > MAX_BYTES {
            return Err(tr!("The SVG exceeds 512 KiB after normalization"));
        }
    }
    Ok((width, height, writer.into_inner()))
}

fn element_attributes(
    element: &BytesStart<'_>,
    root: bool,
    numbers: &mut usize,
) -> Result<Option<(u32, u32)>, String> {
    let name = element.name();
    let name = name.into_inner();
    if (root && name != "svg")
        || (!root
            && !matches!(
                name,
                "g" | "path"
                    | "rect"
                    | "circle"
                    | "ellipse"
                    | "line"
                    | "polyline"
                    | "polygon"
                    | "text"
                    | "tspan"
                    | "title"
                    | "desc"
            ))
    {
        return Err(invalid());
    }
    let mut namespace = false;
    let mut width = None;
    let mut height = None;
    let mut view_box = None;
    for (index, attribute) in element.attributes().enumerate() {
        if index >= 32 {
            return Err(tr!("The SVG has too many attributes"));
        }
        let attribute = attribute.map_err(|_| invalid())?;
        let key = attribute.key.into_inner();
        if attribute.value.len() > MAX_ATTRIBUTE_BYTES {
            return Err(tr!("An SVG attribute exceeds the limit"));
        }
        let value = attribute
            .normalized_value(XmlVersion::Explicit1_0)
            .map_err(|_| invalid())?;
        let value = value.trim();
        match key {
            "xmlns" if root => {
                if value != "http://www.w3.org/2000/svg" {
                    return Err(invalid());
                }
                namespace = true;
            }
            "width" | "height" => {
                let number = length(value)?;
                if root {
                    if key == "width" {
                        width = Some(number);
                    } else {
                        height = Some(number);
                    }
                }
            }
            "viewBox" if root => {
                let parsed = numeric_list(value, "", numbers)?;
                if parsed.len() != 4 || parsed[2] <= 0.0 || parsed[3] <= 0.0 {
                    return Err(invalid());
                }
                view_box = Some((parsed[2], parsed[3]));
            }
            "version" if root => {
                if value != "1.1" && value != "1.0" {
                    return Err(invalid());
                }
            }
            "preserveAspectRatio" if root => {
                if value.len() > 40
                    || !value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b' ')
                {
                    return Err(invalid());
                }
            }
            "id" => {
                if value.len() > 128
                    || !value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                {
                    return Err(invalid());
                }
            }
            "fill" | "stroke" | "color" => {
                if !color(value) {
                    return Err(invalid());
                }
            }
            "d" if name == "path" => {
                numeric_list(value, "MmZzLlHhVvCcSsQqTtAa", numbers)?;
            }
            "points" if matches!(name, "polyline" | "polygon") => {
                numeric_list(value, "", numbers)?;
            }
            "transform" => {
                transform(value, numbers)?;
            }
            "x" | "y" | "x1" | "y1" | "x2" | "y2" | "cx" | "cy" | "r" | "rx" | "ry" | "dx"
            | "dy" | "stroke-width" | "stroke-miterlimit" | "stroke-dashoffset" | "font-size"
            | "letter-spacing" | "word-spacing" | "textLength" => {
                length(value)?;
            }
            "opacity" | "fill-opacity" | "stroke-opacity" => {
                let n = length(value)?;
                if !(0.0..=1.0).contains(&n) {
                    return Err(invalid());
                }
            }
            "stroke-dasharray" => {
                if value != "none" {
                    numeric_list(value, "", numbers)?;
                }
            }
            "fill-rule" | "clip-rule" => {
                if !matches!(value, "nonzero" | "evenodd") {
                    return Err(invalid());
                }
            }
            "stroke-linecap" => {
                if !matches!(value, "butt" | "round" | "square") {
                    return Err(invalid());
                }
            }
            "stroke-linejoin" => {
                if !matches!(value, "miter" | "round" | "bevel") {
                    return Err(invalid());
                }
            }
            "font-family" => {
                if value.len() > 128
                    || !value
                        .chars()
                        .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | ','))
                {
                    return Err(invalid());
                }
            }
            "font-weight" => {
                if !matches!(
                    value,
                    "normal"
                        | "bold"
                        | "100"
                        | "200"
                        | "300"
                        | "400"
                        | "500"
                        | "600"
                        | "700"
                        | "800"
                        | "900"
                ) {
                    return Err(invalid());
                }
            }
            "font-style" => {
                if !matches!(value, "normal" | "italic" | "oblique") {
                    return Err(invalid());
                }
            }
            "text-anchor" => {
                if !matches!(value, "start" | "middle" | "end") {
                    return Err(invalid());
                }
            }
            "dominant-baseline" => {
                if !matches!(
                    value,
                    "auto" | "middle" | "central" | "hanging" | "alphabetic"
                ) {
                    return Err(invalid());
                }
            }
            "vector-effect" => {
                if !matches!(value, "none" | "non-scaling-stroke") {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    if !root {
        return Ok(None);
    }
    if !namespace {
        return Err(tr!("SVG files must declare the standard SVG namespace"));
    }
    let (width, height) = match (width, height, view_box) {
        (Some(w), Some(h), _) => (w, h),
        (None, None, Some(size)) => size,
        _ => {
            return Err(tr!(
                "SVG files need an explicit width/height (px) or a viewBox"
            ))
        }
    };
    if width <= 0.0
        || height <= 0.0
        || width > f64::from(super::MAX_EDGE)
        || height > f64::from(super::MAX_EDGE)
    {
        return Err(tr!("The SVG dimensions exceed the limit"));
    }
    let size = (width.ceil() as u32, height.ceil() as u32);
    super::dimensions(size.0, size.1)?;
    Ok(Some(size))
}

fn length(value: &str) -> Result<f64, String> {
    let number: f64 = value
        .strip_suffix("px")
        .unwrap_or(value)
        .parse()
        .map_err(|_| invalid())?;
    if !number.is_finite() || number.abs() > 1_000_000.0 {
        return Err(invalid());
    }
    Ok(number)
}

fn color(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    if value.bytes().all(|b| b.is_ascii_alphabetic()) {
        return true;
    }
    for prefix in ["rgb(", "rgba(", "hsl(", "hsla("] {
        if let Some(body) = value.strip_prefix(prefix).and_then(|s| s.strip_suffix(')')) {
            return body.bytes().all(|b| {
                b.is_ascii_digit() || matches!(b, b'.' | b',' | b' ' | b'%' | b'+' | b'-' | b'/')
            });
        }
    }
    false
}

fn numeric_list(value: &str, commands: &str, total: &mut usize) -> Result<Vec<f64>, String> {
    let bytes = value.as_bytes();
    let mut offset = 0;
    let mut result = Vec::new();
    while offset < bytes.len() {
        let byte = bytes[offset];
        if byte.is_ascii_whitespace() || byte == b',' || commands.as_bytes().contains(&byte) {
            offset += 1;
            continue;
        }
        let start = offset;
        if matches!(byte, b'+' | b'-') {
            offset += 1;
        }
        let mut digits = 0;
        while offset < bytes.len() && bytes[offset].is_ascii_digit() {
            digits += 1;
            offset += 1;
        }
        if offset < bytes.len() && bytes[offset] == b'.' {
            offset += 1;
            while offset < bytes.len() && bytes[offset].is_ascii_digit() {
                digits += 1;
                offset += 1;
            }
        }
        if digits == 0 {
            return Err(invalid());
        }
        if offset < bytes.len() && matches!(bytes[offset], b'e' | b'E') {
            offset += 1;
            if offset < bytes.len() && matches!(bytes[offset], b'+' | b'-') {
                offset += 1;
            }
            let exponent_start = offset;
            while offset < bytes.len() && bytes[offset].is_ascii_digit() {
                offset += 1;
            }
            if offset == exponent_start {
                return Err(invalid());
            }
        }
        result.push(length(&value[start..offset])?);
        *total += 1;
        if *total > MAX_NUMBERS {
            return Err(tr!("The SVG path is too complex"));
        }
    }
    Ok(result)
}

fn transform(mut value: &str, numbers: &mut usize) -> Result<(), String> {
    while !value.trim().is_empty() {
        value = value.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        let open = value.find('(').ok_or_else(invalid)?;
        let name = value[..open].trim();
        let rest = &value[open + 1..];
        let close = rest.find(')').ok_or_else(invalid)?;
        let args = numeric_list(&rest[..close], "", numbers)?;
        if !match name {
            "matrix" => args.len() == 6,
            "translate" | "scale" => (1..=2).contains(&args.len()),
            "rotate" => matches!(args.len(), 1 | 3),
            "skewX" | "skewY" => args.len() == 1,
            _ => false,
        } {
            return Err(invalid());
        }
        value = &rest[close + 1..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn svg(body: &str) -> String {
        format!(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10">{body}</svg>"#)
    }
    #[test]
    fn accepts_simple_static_geometry_and_declaration() {
        let body = r##"<g transform="translate(1,2)"><path d="M0 0L10 1e0Z" fill="#f00"/><text x="1" y="2">A &amp; B &#65;</text></g>"##;
        let text = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>{}", svg(body));
        assert!(recognizes(text.as_bytes()));
        assert_eq!(validate(text.as_bytes()), Ok((20, 10)));
        assert_eq!(
            validate(br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#),
            Ok((1, 1))
        );
    }
    #[test]
    fn rejects_active_external_recursive_and_expensive_features() {
        for body in [
            r#"<script>alert(1)</script>"#,
            r#"<rect onload="alert(1)"/>"#,
            r#"<image href="file:///etc/passwd"/>"#,
            r#"<image href="data:image/png;base64,A"/>"#,
            r##"<use href="#x"/>"##,
            r#"<style>@import 'https://example.com'</style>"#,
            r#"<rect style="fill:red"/>"#,
            r#"<foreignObject/>"#,
            r#"<animate/>"#,
            r#"<filter/>"#,
            r#"<mask/>"#,
            r#"<pattern/>"#,
            r#"<rect fill="url(#x)"/>"#,
            r#"<g xmlns="http://www.w3.org/1999/xhtml"/>"#,
            r##"<g xlink:href="#x"/>"##,
            r#"<path d="M0 0L1e999 0"/>"#,
            r#"<rect width="NaN"/>"#,
            r#"<rect width="1" width="2"/>"#,
        ] {
            assert!(validate(svg(body).as_bytes()).is_err(), "accepted {body}");
        }
    }
    #[test]
    fn rejects_dtd_processing_instructions_invalid_xml_and_sizes() {
        for text in [
            format!("<!DOCTYPE svg [<!ENTITY x 'test'>]>{}", svg("&x;")),
            format!("<?xml-stylesheet href='file:///x'?>{}", svg("")),
            format!("{}{}", svg(""), svg("")),
            svg("<g>"),
            svg("&unknown;"),
            svg("</g>"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="8193" height="1"/>"#.into(),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="8192" height="8192"/>"#.into(),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"/>"#.into(),
        ] {
            assert!(validate(text.as_bytes()).is_err(), "accepted {text}");
        }
        assert!(validate(&vec![b' '; MAX_BYTES + 1]).is_err());
        assert!(validate(
            svg(&format!(
                "{}{}",
                "<g>".repeat(MAX_DEPTH),
                "</g>".repeat(MAX_DEPTH)
            ))
            .as_bytes()
        )
        .is_err());
        assert!(validate(svg(&"<rect/>".repeat(MAX_ELEMENTS)).as_bytes()).is_err());
    }
    #[test]
    fn recognition_is_content_based() {
        assert!(!recognizes(b"plain text named image.svg"));
        assert!(!recognizes(b"<html><svg/></html>"));
        assert!(recognizes(
            format!("<!-- comment -->{}", svg("")).as_bytes()
        ));
        assert!(recognizes(format!("\u{feff}{}", svg("")).as_bytes()));
    }
    #[test]
    fn normalization_adds_explicit_integer_intrinsic_dimensions() {
        let (width, height, bytes) =
            normalize(svg("<rect width=\"20\" height=\"10\"/>").as_bytes()).unwrap();
        assert_eq!((width, height), (20, 10));
        let normalized = std::str::from_utf8(&bytes).unwrap();
        assert!(normalized.contains("width=\"20\" height=\"10\""));
        assert_eq!(validate(&bytes), Ok((20, 10)));
        let (_, _, bytes) =
            normalize(br#"<svg xmlns="http://www.w3.org/2000/svg" width="2.1" height="3.1"/>"#)
                .unwrap();
        assert!(std::str::from_utf8(&bytes)
            .unwrap()
            .contains("width=\"3\" height=\"4\""));
    }
}

//! Catalog and image transport tests use only synthetic, temporary fixtures.
use image::{DynamicImage, ImageFormat};
use sessionbay_lib::{models::WorkspaceFileKind, service::Service};
use std::{fs, io::Cursor};

#[test]
fn image_transport_is_catalog_scoped_content_sniffed_and_read_only() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("synthetic-project");
    fs::create_dir(&root).unwrap();
    let service = Service::open(base.join("app")).unwrap();
    let project = service
        .catalog
        .add_project(root.to_str().unwrap(), None)
        .unwrap();
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(4, 3)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    let path = root.join("actually-an-image.txt");
    fs::write(&path, bytes.get_ref()).unwrap();
    let before = fs::metadata(&path).unwrap().modified().unwrap();
    let info = service
        .inspect_workspace_file(&project.id, "actually-an-image.txt")
        .unwrap();
    assert_eq!(info.kind, WorkspaceFileKind::Image);
    let response = service
        .read_workspace_image(&project.id, &info.path, &info.version)
        .unwrap();
    assert_eq!(&response[..4], b"SBI1");
    let header_len = u32::from_le_bytes(response[4..8].try_into().unwrap()) as usize;
    let header: serde_json::Value = serde_json::from_slice(&response[8..8 + header_len]).unwrap();
    assert_eq!(header["width"], 4);
    assert_eq!(header["height"], 3);
    assert_eq!(header["mime"], "image/png");
    assert_eq!(fs::read(&path).unwrap(), *bytes.get_ref());
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
    assert!(service
        .read_workspace_image("not-a-project", &info.path, &info.version)
        .is_err());
    assert!(service
        .read_workspace_image(&project.id, "../actually-an-image.txt", &info.version)
        .is_err());
    fs::write(root.join("not-an-image.png"), "plain UTF-8 text").unwrap();
    assert_eq!(
        service
            .inspect_workspace_file(&project.id, "not-an-image.png")
            .unwrap()
            .kind,
        WorkspaceFileKind::Text
    );
    fs::write(
        root.join("a.svg"),
        br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"/>"#,
    )
    .unwrap();
    let svg = service
        .inspect_workspace_file(&project.id, "a.svg")
        .unwrap();
    assert_eq!(svg.kind, WorkspaceFileKind::Image);
    let response = service
        .read_workspace_image(&project.id, &svg.path, &svg.version)
        .unwrap();
    let header_len = u32::from_le_bytes(response[4..8].try_into().unwrap()) as usize;
    let normalized = std::str::from_utf8(&response[8 + header_len..]).unwrap();
    assert!(normalized.contains("width=\"20\" height=\"10\""));
}

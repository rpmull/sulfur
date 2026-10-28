// The web build (../../dist) compressed into the service: one executable, no
// resource folder, each text asset stored once as gzip and served as it is.
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn mime(name: &str) -> (&'static str, bool) {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" => ("text/html; charset=utf-8", true),
        "js" | "mjs" | "cjs" => ("text/javascript; charset=utf-8", true),
        "css" => ("text/css; charset=utf-8", true),
        "json" | "map" => ("application/json", true),
        "svg" => ("image/svg+xml", true),
        "txt" | "md" => ("text/plain; charset=utf-8", true),
        "wasm" => ("application/wasm", true),
        "ttf" | "otf" => ("font/ttf", true),
        "ico" => ("image/x-icon", true),
        "woff" => ("font/woff", false),
        "woff2" => ("font/woff2", false),
        "png" => ("image/png", false),
        "jpg" | "jpeg" => ("image/jpeg", false),
        "gif" => ("image/gif", false),
        "webp" => ("image/webp", false),
        _ => ("application/octet-stream", false),
    }
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            println!("cargo:rerun-if-changed={}", p.display());
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = std::env::var_os("SULFUR_DIST").map(PathBuf::from).unwrap_or_else(|| manifest.join("../../dist"));
    println!("cargo:rerun-if-env-changed=SULFUR_DIST");
    println!("cargo:rerun-if-changed={}", dist.display());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let blobs = out_dir.join("assets");
    let _ = fs::remove_dir_all(&blobs);
    fs::create_dir_all(&blobs).unwrap();
    let mut files = Vec::new();
    walk(&dist, &mut files);
    let mut rows: Vec<(String, String)> = Vec::new();
    for (i, file) in files.iter().enumerate() {
        let rel = file.strip_prefix(&dist).unwrap().to_string_lossy().replace('\\', "/");
        // source maps, prebuilt .gz copies and fonts the webview never asks for stay out
        if rel.ends_with(".map") || rel.ends_with(".gz") || rel.ends_with(".woff") || (rel.starts_with("vendor/fonts/") && rel.ends_with(".ttf")) {
            continue;
        }
        println!("cargo:rerun-if-changed={}", file.display());
        let data = fs::read(file).unwrap();
        let (kind, compress) = mime(&rel);
        let blob = blobs.join(format!("{i}.bin"));
        let gz = compress && data.len() > 256;
        if gz {
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
            enc.write_all(&data).unwrap();
            fs::write(&blob, enc.finish().unwrap()).unwrap();
        } else {
            fs::write(&blob, &data).unwrap();
        }
        rows.push((
            rel.clone(),
            format!("({rel:?}, {kind:?}, {gz}, include_bytes!(concat!(env!(\"OUT_DIR\"), \"/assets/{i}.bin\")))"),
        ));
    }
    rows.sort();
    let table = rows.iter().map(|(_, r)| format!("    {r},\n")).collect::<String>();
    fs::write(
        out_dir.join("assets.rs"),
        format!("/// path, content type, gzip-compressed, bytes; sorted by path\npub static ASSETS: &[(&str, &str, bool, &[u8])] = &[\n{table}];\n"),
    )
    .unwrap();
}

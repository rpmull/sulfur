//! A VS Code extension package converted to Sulfur's: themes, icon themes,
//! languages, TextMate grammars, snippets and keybindings declared as Sulfur
//! reads them; a language client's server run natively; extension code kept
//! for Sulfur's VS Code bridge.
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    sync::OnceLock,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::util::{fail, locale_compare, Fail, Res};

fn tables() -> &'static Value {
    static T: OnceLock<Value> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(include_str!("../../../assets/vsx-tables.json")).expect("vsx tables"))
}

fn list(x: &Value) -> Vec<Value> {
    match x {
        Value::Null => vec![],
        Value::Array(a) => a.clone(),
        v => vec![v.clone()],
    }
}

fn text(x: &Value) -> String {
    x.as_str().unwrap_or("").to_owned()
}

/// JavaScript's truthiness, for the manifest's optional fields
fn truthy(x: &Value) -> bool {
    match x {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn clean_id(x: &str) -> String {
    let lower = x.to_lowercase();
    let mut out = String::new();
    let mut run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c) {
            out.push(c);
            run = false;
        } else if !run {
            out.push('-');
            run = true;
        }
    }
    out
}

fn stringify(x: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(x).unwrap_or_default())
}

pub fn posix_dirname(p: &str) -> String {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => t[..i].to_owned(),
        None => ".".into(),
    }
}

pub fn posix_basename(p: &str) -> String {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_owned()
}

pub fn posix_extname(p: &str) -> String {
    let base = posix_basename(p);
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_owned(),
        _ => String::new(),
    }
}

fn posix_normalize(p: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|l| *l != "..") {
                    stack.pop();
                } else {
                    stack.push("..");
                }
            }
            x => stack.push(x),
        }
    }
    if stack.is_empty() {
        ".".into()
    } else {
        stack.join("/")
    }
}

/// a package-relative path, refused when absolute, drive-named or climbing out
pub fn clean_rel(base: &str, rel: &str) -> Res<String> {
    let rel = rel.replace('\\', "/");
    if rel.starts_with('/') || rel.contains(':') || rel.contains('\0') {
        return fail(format!("unsafe package path: {rel}"));
    }
    let name = posix_normalize(&if base.is_empty() { rel.clone() } else { format!("{base}/{rel}") });
    if name == "." || name == ".." || name.starts_with("../") {
        return fail(format!("unsafe package path: {rel}"));
    }
    Ok(name)
}

/// JSON with comments and trailing commas, as VS Code's own files are written
pub fn parse_jsonc(raw: &str) -> Option<Value> {
    let b: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    let mut pending_comma = false;
    let mut held = String::new();
    while i < b.len() {
        let c = b[i];
        if c == '"' {
            if pending_comma {
                out.push(',');
                pending_comma = false;
            }
            out.push_str(&held);
            held.clear();
            out.push(c);
            i += 1;
            while i < b.len() {
                out.push(b[i]);
                if b[i] == '\\' && i + 1 < b.len() {
                    out.push(b[i + 1]);
                    i += 2;
                    continue;
                }
                if b[i] == '"' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == '/' && b.get(i + 1) == Some(&'/') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && b.get(i + 1) == Some(&'*') {
            i += 2;
            while i < b.len() && !(b[i] == '*' && b.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == ',' {
            if pending_comma {
                out.push(',');
                out.push_str(&held);
                held.clear();
            }
            pending_comma = true;
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            if pending_comma {
                held.push(c);
            } else {
                out.push(c);
            }
            i += 1;
            continue;
        }
        if pending_comma {
            if c != '}' && c != ']' {
                out.push(',');
            }
            pending_comma = false;
            out.push_str(&held);
            held.clear();
        }
        out.push(c);
        i += 1;
    }
    if pending_comma {
        out.push(',');
    }
    serde_json::from_str(&out).ok()
}

// --- XML property lists, read without resolving any external resource ------------------------

#[derive(Debug)]
enum Node {
    El(String, Vec<Node>),
    Text(String),
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';').filter(|e| *e <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_xml(src: &str) -> Res<Vec<Node>> {
    let bad = || Fail::new("invalid XML", 400);
    let mut stack: Vec<(String, Vec<Node>)> = vec![(String::new(), vec![])];
    let mut i = 0;
    let b = src.as_bytes();
    while i < b.len() {
        if b[i] != b'<' {
            let end = src[i..].find('<').map(|e| i + e).unwrap_or(b.len());
            stack.last_mut().ok_or_else(bad)?.1.push(Node::Text(decode_entities(&src[i..end])));
            i = end;
            continue;
        }
        let rest = &src[i..];
        if rest.starts_with("<?") {
            i += rest.find("?>").ok_or_else(bad)? + 2;
        } else if rest.starts_with("<!--") {
            i += rest.find("-->").ok_or_else(bad)? + 3;
        } else if rest.starts_with("<![CDATA[") {
            let end = rest.find("]]>").ok_or_else(bad)?;
            stack.last_mut().ok_or_else(bad)?.1.push(Node::Text(rest[9..end].to_owned()));
            i += end + 3;
        } else if rest.starts_with("<!") {
            let mut depth = 0;
            let mut j = 0;
            for (k, c) in rest.char_indices() {
                match c {
                    '[' => depth += 1,
                    ']' => depth -= 1,
                    '>' if depth <= 0 => {
                        j = k;
                        break;
                    }
                    _ => {}
                }
            }
            if j == 0 {
                return Err(bad());
            }
            i += j + 1;
        } else if rest.starts_with("</") {
            let end = rest.find('>').ok_or_else(bad)?;
            let name = rest[2..end].trim();
            let (open, children) = stack.pop().ok_or_else(bad)?;
            if open != name || stack.is_empty() {
                return Err(bad());
            }
            stack.last_mut().ok_or_else(bad)?.1.push(Node::El(open, children));
            i += end + 1;
        } else {
            let mut end = None;
            let mut quote = None;
            for (k, c) in rest.char_indices().skip(1) {
                match (quote, c) {
                    (None, '"' | '\'') => quote = Some(c),
                    (Some(q), c) if c == q => quote = None,
                    (None, '>') => {
                        end = Some(k);
                        break;
                    }
                    _ => {}
                }
            }
            let end = end.ok_or_else(bad)?;
            let inner = &rest[1..end];
            let closed = inner.ends_with('/');
            let inner = inner.trim_end_matches('/');
            let name = inner.split(|c: char| c.is_whitespace()).next().unwrap_or("").to_owned();
            if name.is_empty() {
                return Err(bad());
            }
            if closed {
                stack.last_mut().ok_or_else(bad)?.1.push(Node::El(name, vec![]));
            } else {
                stack.push((name, vec![]));
            }
            i += end + 1;
        }
    }
    if stack.len() != 1 {
        return Err(bad());
    }
    Ok(stack.pop().map(|s| s.1).unwrap_or_default())
}

fn plist_value(node: Option<&Node>) -> Res<Value> {
    let Some(Node::El(name, children)) = node else { return fail("invalid property list") };
    let elements: Vec<&Node> = children.iter().filter(|c| matches!(c, Node::El(..))).collect();
    let content = || {
        children
            .iter()
            .filter_map(|c| match c {
                Node::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<String>()
    };
    Ok(match name.as_str() {
        "plist" => return plist_value(elements.first().copied()),
        "dict" => {
            let mut out = Map::new();
            let mut i = 0;
            while i < elements.len() {
                if let Node::El(k, kc) = elements[i] {
                    if k == "key" {
                        let key: String = kc
                            .iter()
                            .filter_map(|c| match c {
                                Node::Text(t) => Some(t.as_str()),
                                _ => None,
                            })
                            .collect();
                        i += 1;
                        out.insert(key, plist_value(elements.get(i).copied())?);
                    }
                }
                i += 1;
            }
            Value::Object(out)
        }
        "array" => Value::Array(elements.iter().map(|e| plist_value(Some(e))).collect::<Res<_>>()?),
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "integer" | "real" => {
            let t = content();
            let t = t.trim();
            match t.parse::<i64>() {
                Ok(n) => json!(n),
                Err(_) => t.parse::<f64>().ok().and_then(|f| serde_json::Number::from_f64(f)).map(Value::Number).unwrap_or(Value::Null),
            }
        }
        _ => Value::String(content()),
    })
}

/// a package file as data: JSON with comments, or an XML property list
pub fn parse_data(name: &str, data: &[u8]) -> Res<Value> {
    let raw = String::from_utf8_lossy(data);
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    if !raw.trim_start().starts_with('<') {
        return parse_jsonc(raw).ok_or_else(|| Fail::new(format!("{name}: invalid JSON"), 400));
    }
    let nodes = parse_xml(raw).map_err(|_| Fail::new(format!("{name}: invalid XML"), 400))?;
    let root = nodes
        .iter()
        .find(|n| matches!(n, Node::El(n, _) if n == "plist"))
        .or_else(|| nodes.iter().find(|n| matches!(n, Node::El(..))));
    plist_value(root)
}

pub struct Package {
    pub files: HashMap<String, Vec<u8>>,
    index: HashMap<String, String>,
    pub manifest: Value,
    nls: Value,
}

impl Package {
    pub fn read(&self, rel: &str) -> Res<&[u8]> {
        self.index
            .get(&rel.to_lowercase())
            .and_then(|n| self.files.get(n))
            .map(Vec::as_slice)
            .ok_or_else(|| Fail::new(format!("{rel} isn't in the package"), 400))
    }
    pub fn get(&self, rel: &str) -> Res<Value> {
        parse_data(rel, self.read(rel)?)
    }
    pub fn localize(&self, v: &Value) -> String {
        let s = text(v);
        if s.len() >= 2 && s.starts_with('%') && s.ends_with('%') {
            let key = &s[1..s.len() - 1];
            let entry = &self.nls[key];
            if let Some(m) = entry["message"].as_str().filter(|m| !m.is_empty()) {
                return m.to_owned();
            }
            if let Some(m) = entry.as_str().filter(|m| !m.is_empty()) {
                return m.to_owned();
            }
        }
        s
    }
}

/// a .vsix's extension/ folder, bounded at 32 MiB a file and 256 MiB in all
pub fn open(data: &[u8]) -> Res<Package> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|_| Fail::new("not an extension package", 400))?;
    let mut files = HashMap::new();
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|_| Fail::new("not an extension package", 400))?;
        let name = f.name().replace('\\', "/");
        if !name.starts_with("extension/") || name.ends_with('/') {
            continue;
        }
        let rel = clean_rel("", &name[10..])?;
        if !seen.insert(rel.to_lowercase()) {
            return fail(format!("duplicate package path: {rel}"));
        }
        total += f.size();
        if f.size() > 32 << 20 || total > 256 << 20 {
            return fail("extension package exceeds the unpacked size limit");
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        (&mut f).take((32 << 20) + 1).read_to_end(&mut buf).map_err(|_| Fail::new("not an extension package", 400))?;
        if buf.len() > 32 << 20 {
            return fail("extension package exceeds the unpacked size limit");
        }
        files.insert(rel, buf);
    }
    let index = files.keys().map(|n| (n.to_lowercase(), n.clone())).collect();
    let mut pkg = Package { files, index, manifest: Value::Null, nls: json!({}) };
    pkg.manifest = pkg.get("package.json")?;
    pkg.nls = pkg.get("package.nls.json").unwrap_or_else(|_| json!({}));
    Ok(pkg)
}

const DECLARED: &[(&str, &str)] = &[
    ("themes", "theme"),
    ("iconThemes", "iconTheme"),
    ("languages", "language"),
    ("grammars", "grammar"),
    ("snippets", "snippets"),
    ("keybindings", "keybindings"),
];

/// what an extension would convert to, read from its manifest alone
pub fn plan(manifest: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let c = &manifest["contributes"];
    for (key, kind) in DECLARED {
        let n = list(&c[*key]).len();
        if n > 0 {
            out.push(json!({
                "kind": kind,
                "status": if *key == "keybindings" { "partial" } else { "converted" },
                "name": format!("{n} {kind}"),
            }));
        }
    }
    let code = truthy(&manifest["browser"]) || truthy(&manifest["main"]);
    if code {
        let browser = truthy(&manifest["browser"]);
        out.push(json!({
            "kind": "code",
            "status": "partial",
            "name": if browser { "web build" } else { "Node extension" },
            "detail": if browser {
                "Browser host with CommonJS and ESM module resolution"
            } else {
                "Separate Node.js process with Node APIs and the VS Code bridge; unsupported APIs are reported"
            },
        }));
    }
    if let Some(obj) = c.as_object() {
        for k in obj.keys() {
            if DECLARED.iter().any(|(d, _)| d == k) || k == "configuration" || k == "configurationDefaults" {
                continue;
            }
            out.push(json!({
                "kind": k,
                "status": if code { "partial" } else { "skipped" },
                "name": k,
                "detail": tables()["vsxUnsupported"][k].as_str().unwrap_or("This contribution requires extension API support"),
            }));
        }
    }
    out
}

pub struct Options {
    pub commands: Vec<String>,
    pub prefer_node: bool,
}

pub struct Converted {
    pub id: String,
    pub manifest: Value,
    pub files: Map<String, Value>,
    pub binary: Map<String, Value>,
    pub report: Vec<Value>,
}

impl Converted {
    pub fn to_json(self) -> Value {
        let mut out = json!({ "id": self.id, "manifest": self.manifest, "files": self.files });
        if !self.binary.is_empty() {
            out["binary"] = Value::Object(self.binary);
        }
        out["report"] = Value::Array(self.report);
        out
    }
}

struct Languages {
    order: Vec<String>,
    map: HashMap<String, Map<String, Value>>,
}

impl Languages {
    fn get(&mut self, id: &str) -> &mut Map<String, Value> {
        if !self.map.contains_key(id) {
            let known = &tables()["vscodeLanguages"][id];
            let split = |i: usize| -> Vec<Value> {
                known[i].as_str().unwrap_or("").split(' ').filter(|s| !s.is_empty()).map(|s| json!(s)).collect()
            };
            let mut m = Map::new();
            m.insert("id".into(), json!(id));
            m.insert("extensions".into(), Value::Array(split(0)));
            m.insert("filenames".into(), Value::Array(split(1)));
            self.order.push(id.to_owned());
            self.map.insert(id.to_owned(), m);
        }
        self.map.get_mut(id).expect("present")
    }
    fn strings(&mut self, id: &str, key: &str) -> Vec<String> {
        self.get(id)[key].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
    }
}

fn uniq(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|x| seen.insert(x.clone())).collect()
}

fn hex_color(v: &Value) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$").unwrap());
    v.as_str().filter(|s| re.is_match(s)).map(str::to_owned)
}

struct ThemeData {
    colors: Map<String, Value>,
    token_colors: Vec<Value>,
}

fn theme_data(pkg: &Package, rel: &str, seen: &mut Vec<String>) -> Res<ThemeData> {
    if seen.iter().any(|s| s == rel) || seen.len() >= 12 {
        return fail("theme include cycle");
    }
    seen.push(rel.to_owned());
    let t = pkg.get(rel)?;
    let dir = posix_dirname(rel);
    let parent = match t["include"].as_str() {
        Some(inc) if !inc.is_empty() => theme_data(pkg, &clean_rel(&dir, inc)?, seen)?,
        _ => ThemeData { colors: Map::new(), token_colors: vec![] },
    };
    let mut rules = if truthy(&t["tokenColors"]) { t["tokenColors"].clone() } else if truthy(&t["settings"]) { t["settings"].clone() } else { json!([]) };
    if let Some(r) = rules.as_str() {
        rules = pkg.get(&clean_rel(&dir, r)?)?;
    }
    let global = list(&t["settings"])
        .into_iter()
        .find(|s| s.get("scope").is_none_or(|x| !truthy(x)))
        .map(|s| s["settings"].clone())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let mut colors = parent.colors;
    if let Some(own) = t["colors"].as_object() {
        for (k, v) in own {
            colors.insert(k.clone(), v.clone());
        }
    }
    if truthy(&global["background"]) {
        colors.insert("editor.background".into(), global["background"].clone());
    }
    if truthy(&global["foreground"]) {
        colors.insert("editor.foreground".into(), global["foreground"].clone());
    }
    let mut token_colors = parent.token_colors;
    token_colors.extend(list(&rules));
    Ok(ThemeData { colors, token_colors })
}

fn match_scope(rules: &[Value], scope: &str) -> Res<Map<String, Value>> {
    let mut best = Map::new();
    let mut score: i64 = -1;
    for r in rules {
        let scopes: Vec<Value> = match &r["scope"] {
            Value::Array(a) => a.clone(),
            Value::String(s) => s.split(',').map(|x| json!(x)).collect(),
            v if !truthy(v) => vec![json!("")],
            _ => return fail("theme scope is not text"),
        };
        for s in scopes {
            let Some(s) = s.as_str() else { return fail("theme scope is not text") };
            let token = s.trim();
            if (scope == token || scope.starts_with(&format!("{token}."))) && token.len() as i64 >= score {
                if let Some(set) = r["settings"].as_object() {
                    for (k, v) in set {
                        best.insert(k.clone(), v.clone());
                    }
                }
                score = token.len() as i64;
            }
        }
    }
    Ok(best)
}

static CODE_RE: OnceLock<[Regex; 7]> = OnceLock::new();
fn code_re() -> &'static [Regex; 7] {
    CODE_RE.get_or_init(|| {
        [
            Regex::new(r#"["'`]([^"'`\n]+)["'`]"#).unwrap(),
            Regex::new(r"(^|/)(test|tests|example|examples|\.github)/|\.map$|node_modules/(vscode-languageclient|vscode-jsonrpc)").unwrap(),
            Regex::new(r"(?i)server|language.?server|langserver|clangd|terraform-ls|lua-language-server").unwrap(),
            Regex::new(r#"language\s*:\s*["']([^"']+)["']"#).unwrap(),
            Regex::new(r#"([A-Za-z0-9_$]+)\s*=\s*[A-Za-z0-9_$.]*asAbsolutePath\(\s*["']([^"']+)["']\s*\)"#).unwrap(),
            Regex::new(r#"([A-Za-z0-9_$]+)\s*:\s*[A-Za-z0-9_$.]*asAbsolutePath\(\s*["']([^"']+)["']\s*\)"#).unwrap(),
            Regex::new(r"([A-Za-z0-9_$]+)\s*:\s*([A-Za-z0-9_$]+)\s*[,}]").unwrap(),
        ]
    })
}

pub fn convert(data: &[u8], source: Value, options: &Options) -> Res<Converted> {
    let pkg = open(data)?;
    let m = &pkg.manifest;
    let c = &m["contributes"];
    let mut files = Map::new();
    let mut binary = Map::new();
    let mut contributes = Map::new();
    let mut report: Vec<Value> = Vec::new();
    let mut source = source.as_object().cloned().unwrap_or_default();
    for (key, from) in [("namespace", "publisher"), ("name", "name"), ("version", "version")] {
        if !truthy(source.get(key).unwrap_or(&Value::Null)) {
            source.insert(key.into(), m[from].clone());
        }
    }
    let ns = source.get("namespace").and_then(Value::as_str).unwrap_or("").to_owned();
    let name = source.get("name").and_then(Value::as_str).unwrap_or("").to_owned();
    if ns.is_empty() || name.is_empty() {
        return fail("package.json names no publisher and name");
    }
    let id = format!("vsx.{}.{}", clean_id(&ns), clean_id(&name));
    let mut langs = Languages { order: vec![], map: HashMap::new() };
    let mut total = 0usize;
    let add = |report: &mut Vec<Value>, kind: &str, status: &str, name: &str, detail: &str| {
        let mut r = json!({ "kind": kind, "status": status, "name": name });
        if !detail.is_empty() {
            r["detail"] = json!(detail);
        }
        report.push(r);
    };
    let ext_re = Regex::new(r"(?i)\.(tmlanguage\.json|tmlanguage|tmtheme|json|plist|code-snippets)$").unwrap();
    let mut write = |files: &mut Map<String, Value>, folder: &str, name: &str, value: &Value| -> Res<String> {
        let data = stringify(value);
        total += data.len();
        if total > 14 << 20 {
            return fail("the converted extension would be over 14MB");
        }
        let stem = clean_id(&ext_re.replace(&posix_basename(name), ""));
        let mut file = format!("{folder}/{stem}.json");
        let mut n = 1;
        while files.contains_key(&file) {
            n += 1;
            file = format!("{folder}/{stem}-{n}.json");
        }
        files.insert(file.clone(), Value::String(data));
        Ok(file)
    };

    for l in list(&c["languages"]) {
        let Some(lid) = l["id"].as_str().filter(|s| !s.is_empty()) else { continue };
        let mut exts = langs.strings(lid, "extensions");
        exts.extend(list(&l["extensions"]).iter().filter_map(Value::as_str).map(|s| s.trim_start_matches('.').to_lowercase()));
        let mut names = langs.strings(lid, "filenames");
        names.extend(list(&l["filenames"]).iter().filter_map(Value::as_str).map(str::to_lowercase));
        let e = langs.get(lid);
        e.insert("extensions".into(), json!(uniq(exts)));
        e.insert("filenames".into(), json!(uniq(names)));
        if truthy(&l["aliases"]) {
            e.insert("aliases".into(), l["aliases"].clone());
        }
        let mut detail = if l["filenamePatterns"].as_array().is_some_and(|a| !a.is_empty()) { "filename patterns not used".to_owned() } else { String::new() };
        if let Some(cfg_path) = l["configuration"].as_str().filter(|s| !s.is_empty()) {
            match clean_rel("", cfg_path).and_then(|p| pkg.get(&p)) {
                Ok(cfg) => {
                    if truthy(&cfg["comments"]) {
                        let mut comments = cfg["comments"].as_object().cloned().unwrap_or_default();
                        let line = &cfg["comments"]["lineComment"];
                        let line = if line.is_object() { line["comment"].clone() } else { line.clone() };
                        if line.is_null() {
                            comments.remove("lineComment");
                        } else {
                            comments.insert("lineComment".into(), line);
                        }
                        e.insert("comments".into(), Value::Object(comments));
                    }
                    for key in ["brackets", "autoClosingPairs"] {
                        if let Some(pairs) = cfg[key].as_array() {
                            let v: Vec<Value> = pairs
                                .iter()
                                .map(|v| if v.is_array() { v.clone() } else { json!([v["open"], v["close"]]) })
                                .filter(|v| v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
                                .collect();
                            e.insert(key.into(), Value::Array(v));
                        }
                    }
                    let unsupported: Vec<&str> = ["indentationRules", "onEnterRules", "wordPattern", "folding"]
                        .into_iter()
                        .filter(|k| truthy(&cfg[*k]))
                        .collect();
                    if !unsupported.is_empty() {
                        detail = format!("{} not used", unsupported.join(", "));
                    }
                }
                Err(e) => detail = e.message,
            }
        }
        let shown = l["aliases"][0].as_str().filter(|s| !s.is_empty()).unwrap_or(lid).to_owned();
        add(&mut report, "language", if detail.is_empty() { "converted" } else { "partial" }, &shown, &detail);
    }

    for g in list(&c["grammars"]) {
        let scope = text(&g["scopeName"]);
        let done = (|| -> Res<()> {
            let path = text(&g["path"]);
            if path.is_empty() || scope.is_empty() {
                return fail("no scopeName or path");
            }
            let grammar = pkg.get(&clean_rel("", &path)?)?;
            if !truthy(&grammar["patterns"]) && !truthy(&grammar["repository"]) {
                return fail("not a TextMate grammar");
            }
            let file = write(&mut files, "syntaxes", &path, &grammar)?;
            let mut entry = g.as_object().cloned().unwrap_or_default();
            entry.insert("path".into(), json!(file));
            contributes.entry("grammars").or_insert_with(|| json!([])).as_array_mut().expect("array").push(Value::Object(entry));
            if let Some(lang) = g["language"].as_str().filter(|s| !s.is_empty()) {
                langs.get(lang);
            }
            let inject = truthy(&g["injectTo"]);
            let lang = g["language"].as_str().filter(|s| !s.is_empty()).unwrap_or("included scopes");
            add(
                &mut report,
                "grammar",
                if inject { "partial" } else { "converted" },
                &scope,
                &if inject { "injection rules require host support".into() } else { format!("for {lang}") },
            );
            Ok(())
        })();
        if let Err(e) = done {
            add(&mut report, "grammar", "skipped", &scope, &e.message);
        }
    }

    for t in list(&c["themes"]) {
        let done = (|| -> Res<()> {
            let path = clean_rel("", &text(&t["path"]))?;
            let data = theme_data(&pkg, &path, &mut vec![])?;
            let mut vars = Map::new();
            for row in tables()["themeVars"].as_array().into_iter().flatten() {
                let row = row.as_array().expect("table row");
                let key = row[0].as_str().unwrap_or("");
                if let Some(v) = row[1..].iter().find_map(|n| hex_color(data.colors.get(n.as_str().unwrap_or("")).unwrap_or(&Value::Null))) {
                    vars.insert(key.into(), json!(v));
                }
            }
            for row in tables()["themeTokens"].as_array().into_iter().flatten() {
                let row = row.as_array().expect("table row");
                let key = row[0].as_str().unwrap_or("");
                for s in &row[1..] {
                    if let Some(v) = hex_color(match_scope(&data.token_colors, s.as_str().unwrap_or(""))?.get("foreground").unwrap_or(&Value::Null)) {
                        vars.insert(key.into(), json!(v));
                        break;
                    }
                }
            }
            if let Some(style) = match_scope(&data.token_colors, "comment.line")?.get("fontStyle") {
                let italic = style.as_str().is_some_and(|s| s.contains("italic"));
                vars.insert("--hl-cmt-style".into(), json!(if italic { "italic" } else { "normal" }));
            }
            if let Some(shadow) = hex_color(data.colors.get("widget.shadow").unwrap_or(&Value::Null)) {
                vars.insert("--ide-shadow".into(), json!(format!("0 0 8px 2px {shadow}")));
            }
            let mut label = pkg.localize(&t["label"]);
            if label.is_empty() {
                label = text(&t["id"]);
            }
            if label.is_empty() {
                label = posix_basename(&text(&t["path"]));
            }
            let kind = match t["uiTheme"].as_str().unwrap_or("") {
                "vs" => "light",
                "hc-black" => "hc-dark",
                "hc-light" => "hc-light",
                _ => "dark",
            };
            let file = write(&mut files, "themes", &text(&t["path"]), &json!({ "label": label, "type": kind, "vars": vars }))?;
            let tid = if truthy(&t["id"]) { text(&t["id"]) } else { label.clone() };
            contributes.entry("themes").or_insert_with(|| json!([])).as_array_mut().expect("array").push(json!({
                "id": clean_id(&tid),
                "label": label,
                "uiTheme": kind,
                "path": file,
            }));
            add(&mut report, "theme", "converted", &label, "");
            Ok(())
        })();
        if let Err(e) = done {
            add(&mut report, "theme", "skipped", &pkg.localize(&t["label"]), &e.message);
        }
    }

    let data_url = |base: &str, rel: &str| -> Res<String> {
        let name = clean_rel(base, rel)?;
        let mime = tables()["mimeOf"][posix_extname(&name).to_lowercase()].as_str().unwrap_or("application/octet-stream");
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(pkg.read(&name)?)))
    };
    for t in list(&c["iconThemes"]) {
        let done = (|| -> Res<()> {
            let raw_path = text(&t["path"]);
            let th = pkg.get(&clean_rel("", &raw_path)?)?;
            let base = posix_dirname(&raw_path);
            let mut used = HashSet::new();
            // the definitions some mapping names, wherever it is
            fn collect(v: &Value, used: &mut HashSet<String>) {
                match v {
                    Value::String(s) => {
                        used.insert(s.clone());
                    }
                    Value::Array(a) => a.iter().for_each(|x| collect(x, used)),
                    Value::Object(o) => {
                        for (k, x) in o {
                            if k != "iconDefinitions" && k != "fonts" {
                                collect(x, used);
                            }
                        }
                    }
                    _ => {}
                }
            }
            collect(&th, &mut used);
            let mut defs = Map::new();
            let mut missing = 0;
            let first_font = th["fonts"][0]["id"].as_str().unwrap_or("").to_owned();
            for (key, v) in th["iconDefinitions"].as_object().into_iter().flatten() {
                if !used.contains(key) {
                    continue;
                }
                let made = (|| -> Res<Option<Value>> {
                    if truthy(&v["iconPath"]) {
                        return Ok(Some(json!({ "src": data_url(&base, &text(&v["iconPath"]))? })));
                    }
                    if let Some(fc) = v["fontCharacter"].as_str().filter(|s| !s.is_empty()) {
                        let ch = fc
                            .strip_prefix('\\')
                            .filter(|h| h.chars().all(|c| c.is_ascii_hexdigit()) && !h.is_empty())
                            .and_then(|h| u32::from_str_radix(h, 16).ok())
                            .and_then(char::from_u32)
                            .map(String::from)
                            .unwrap_or_else(|| fc.to_owned());
                        let mut d = Map::new();
                        d.insert("char".into(), json!(ch));
                        if truthy(&v["fontColor"]) {
                            d.insert("color".into(), v["fontColor"].clone());
                        }
                        let font = if truthy(&v["fontId"]) { v["fontId"].clone() } else { json!(first_font) };
                        d.insert("font".into(), font);
                        if truthy(&v["fontSize"]) {
                            d.insert("size".into(), v["fontSize"].clone());
                        }
                        return Ok(Some(Value::Object(d)));
                    }
                    Ok(None)
                })();
                match made {
                    Ok(Some(d)) => {
                        defs.insert(key.clone(), d);
                    }
                    Ok(None) => {}
                    Err(_) => missing += 1,
                }
            }
            let mut fonts = Map::new();
            for font in th["fonts"].as_array().into_iter().flatten() {
                let src = &font["src"][0];
                if let Some(p) = src["path"].as_str().filter(|s| !s.is_empty()) {
                    let mut f = Map::new();
                    f.insert("src".into(), json!(data_url(&base, p)?));
                    for (k, v) in [("format", &src["format"]), ("weight", &font["weight"]), ("style", &font["style"]), ("size", &font["size"])] {
                        if !v.is_null() {
                            f.insert(k.into(), v.clone());
                        }
                    }
                    fonts.insert(font["id"].as_str().unwrap_or("undefined").to_owned(), Value::Object(f));
                }
            }
            let mut mappings = |obj: &Value| -> Map<String, Value> {
                let mut out = Map::new();
                for key in [
                    "file", "folder", "folderExpanded", "rootFolder", "rootFolderExpanded", "fileExtensions", "fileNames",
                    "folderNames", "folderNamesExpanded", "rootFolderNames", "rootFolderNamesExpanded",
                ] {
                    let v = &obj[key];
                    if !truthy(v) {
                        continue;
                    }
                    let mapped = match v {
                        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.to_lowercase(), x.clone())).collect()),
                        Value::Array(a) => Value::Object(a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect()),
                        other => other.clone(),
                    };
                    out.insert(key.into(), mapped);
                }
                for (lid, icon) in obj["languageIds"].as_object().into_iter().flatten() {
                    out.entry("languageExtensions").or_insert_with(|| json!({}))[lid] = icon.clone();
                    let exts = langs.strings(lid, "extensions");
                    let names = langs.strings(lid, "filenames");
                    let fe = out.entry("fileExtensions").or_insert_with(|| json!({}));
                    for ext in exts {
                        if !truthy(&fe[&ext]) {
                            fe[&ext] = icon.clone();
                        }
                    }
                    let fnm = out.entry("fileNames").or_insert_with(|| json!({}));
                    for n in names {
                        if !truthy(&fnm[&n]) {
                            fnm[&n] = icon.clone();
                        }
                    }
                }
                out
            };
            let mut out = mappings(&th);
            let light = mappings(if th["light"].is_object() { &th["light"] } else { &Value::Null });
            let mut label = pkg.localize(&t["label"]);
            if label.is_empty() {
                label = text(&t["id"]);
            }
            out.insert("light".into(), Value::Object(light));
            out.insert("label".into(), json!(label));
            out.insert("defs".into(), Value::Object(defs));
            out.insert("fonts".into(), Value::Object(fonts));
            if truthy(&th["hidesExplorerArrows"]) {
                out.insert("hidesExplorerArrows".into(), json!(true));
            }
            let file = write(&mut files, "icons", &raw_path, &Value::Object(out))?;
            let tid = if truthy(&t["id"]) { text(&t["id"]) } else { label.clone() };
            contributes.entry("iconThemes").or_insert_with(|| json!([])).as_array_mut().expect("array").push(json!({
                "id": clean_id(&tid),
                "label": label,
                "path": file,
            }));
            let detail = if missing > 0 { format!("{missing} missing icons") } else { String::new() };
            add(&mut report, "iconTheme", if missing > 0 { "partial" } else { "converted" }, &label, &detail);
            Ok(())
        })();
        if let Err(e) = done {
            add(&mut report, "iconTheme", "skipped", &pkg.localize(&t["label"]), &e.message);
        }
    }

    for snippet in list(&c["snippets"]) {
        let path = text(&snippet["path"]);
        let done = (|| -> Res<()> {
            let raw = pkg.get(&clean_rel("", &path)?)?;
            let mut values = Vec::new();
            let mut ids: Vec<String> = list(&snippet["language"]).iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned).collect();
            let entries: Vec<(String, Value)> = match &raw {
                Value::Object(o) => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                Value::Array(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
                _ => vec![],
            };
            for (sname, v) in entries {
                if !v.is_object() {
                    return fail("a snippet isn't an object");
                }
                let prefix: Vec<Value> = list(&v["prefix"]).into_iter().filter(Value::is_string).collect();
                let body = match &v["body"] {
                    Value::Array(a) => Some(
                        a.iter()
                            .map(|x| match x {
                                Value::String(s) => s.clone(),
                                Value::Null => String::new(),
                                other => other.to_string(),
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ),
                    Value::String(s) => Some(s.clone()),
                    _ => None,
                };
                let Some(body) = body.filter(|_| !prefix.is_empty()) else { continue };
                let scope: Vec<String> = text(&v["scope"]).split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
                let mut entry = json!({ "name": sname, "prefix": prefix, "body": body });
                if truthy(&v["description"]) {
                    entry["description"] = v["description"].clone();
                }
                if !scope.is_empty() {
                    entry["scope"] = json!(scope);
                }
                values.push(entry);
                for sid in scope {
                    if !ids.contains(&sid) {
                        ids.push(sid);
                    }
                }
            }
            let exts = uniq(ids.iter().flat_map(|i| langs.strings(i, "extensions")).collect::<Vec<_>>());
            let names = uniq(ids.iter().flat_map(|i| langs.strings(i, "filenames")).collect::<Vec<_>>());
            let count = values.len();
            let file = write(&mut files, "snippets", &path, &Value::Array(values))?;
            contributes.entry("snippets").or_insert_with(|| json!([])).as_array_mut().expect("array").push(json!({
                "language": ids.first().cloned().unwrap_or_default(),
                "languages": ids,
                "path": file,
                "extensions": exts,
                "filenames": names,
            }));
            add(&mut report, "snippets", "converted", &path, &format!("{count} snippets"));
            Ok(())
        })();
        if let Err(e) = done {
            add(&mut report, "snippets", "skipped", &path, &e.message);
        }
    }

    let resolve_entry = |name: &str| -> Res<String> {
        if name.is_empty() {
            return Ok(String::new());
        }
        for s in [name.to_owned(), format!("{name}.js"), format!("{name}.cjs"), format!("{name}.mjs"), format!("{name}/index.js")] {
            let p = clean_rel("", &s)?;
            if pkg.files.contains_key(&p) {
                return Ok(p);
            }
        }
        Ok(String::new())
    };
    let browser = resolve_entry(&text(&m["browser"]))?;
    let node = resolve_entry(&text(&m["main"]))?;
    let mut entry = if options.prefer_node {
        if node.is_empty() { browser.clone() } else { node.clone() }
    } else if browser.is_empty() {
        node.clone()
    } else {
        browser.clone()
    };
    let mut runtime = if !browser.is_empty() && entry == browser { "browser" } else if !node.is_empty() { "bun" } else { "" };
    // a language client's server runs natively: such clients mostly only wire up
    // a server and use VS Code APIs beyond Sulfur's extension bridge
    let client_code = if node.is_empty() { String::new() } else { String::from_utf8_lossy(pkg.read(&node)?).into_owned() };
    let re = code_re();
    let uses_client = truthy(&m["dependencies"]["vscode-languageclient"])
        || truthy(&m["devDependencies"]["vscode-languageclient"])
        || client_code.contains("LanguageClient");
    if uses_client {
        let mut strings = HashSet::new();
        for cap in re[0].captures_iter(&client_code) {
            let s = &cap[1];
            strings.insert(s.strip_prefix("./").unwrap_or(s).to_owned());
            for part in s.split('/') {
                strings.insert(part.to_owned());
            }
        }
        let (mut best, mut score, mut native) = (String::new(), 0i32, false);
        let mut rels: Vec<&String> = pkg.files.keys().collect();
        rels.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for rel in rels {
            if *rel == node || re[1].is_match(rel) {
                continue;
            }
            let base = posix_basename(rel);
            let ext = posix_extname(&base);
            let is_native = ext == ".exe" || (ext.is_empty() && rel.contains("/bin/"));
            if !is_native && !(rel.ends_with(".js") || rel.ends_with(".cjs") || rel.ends_with(".mjs")) {
                continue;
            }
            let value = (if re[2].is_match(&base) { 4 } else { 0 })
                + (if posix_dirname(rel).to_lowercase().contains("server") { 3 } else { 0 })
                + (if strings.contains(rel.as_str()) { 6 } else if strings.contains(&base) { 3 } else { 0 })
                + (if is_native { 2 } else { 0 })
                - (if rel.contains("node_modules/") { 2 } else { 0 });
            if value >= 5 && value > score {
                best = rel.clone();
                score = value;
                native = is_native;
            }
        }
        let mut served: Vec<String> = Vec::new();
        for v in m["activationEvents"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            if let Some(l) = v.strip_prefix("onLanguage:") {
                served.push(l.to_owned());
            }
        }
        served.extend(list(&c["languages"]).iter().filter_map(|v| v["id"].as_str()).map(str::to_owned));
        served.extend(re[3].captures_iter(&client_code).map(|cap| cap[1].to_owned()));
        let served = uniq(served);
        let exts = uniq(served.iter().flat_map(|i| langs.strings(i, "extensions")).collect::<Vec<_>>());
        let fnames = uniq(served.iter().flat_map(|i| langs.strings(i, "filenames")).collect::<Vec<_>>());
        if !best.is_empty() && (!exts.is_empty() || !fnames.is_empty()) {
            let stdio = native || (client_code.contains("TransportKind.stdio") && !client_code.contains("TransportKind.ipc"));
            let mut settings = Map::new();
            for cfg in list(&c["configuration"]) {
                for (key, v) in cfg["properties"].as_object().into_iter().flatten() {
                    let Some(default) = v.as_object().and_then(|o| o.get("default")) else { continue };
                    fn set(at: &mut Map<String, Value>, parts: &[&str], value: Value) {
                        if let [last] = parts {
                            at.insert((*last).to_owned(), value);
                        } else if let Value::Object(next) = at.entry(parts[0].to_owned()).or_insert_with(|| json!({})) {
                            set(next, &parts[1..], value);
                        }
                    }
                    set(&mut settings, &key.split('.').collect::<Vec<_>>(), default.clone());
                }
            }
            let mut init = Map::new();
            let mut paths = HashMap::new();
            for cap in re[4].captures_iter(&client_code) {
                paths.insert(cap[1].to_owned(), format!("${{extensionPath}}/{}", cap[2].trim_start_matches("./")));
            }
            for cap in re[5].captures_iter(&client_code) {
                init.insert(cap[1].to_owned(), json!(format!("${{extensionPath}}/{}", cap[2].trim_start_matches("./"))));
            }
            for cap in re[6].captures_iter(&client_code) {
                if let Some(p) = paths.get(&cap[2]) {
                    init.insert(cap[1].to_owned(), json!(p));
                }
            }
            let mut ids = Map::new();
            for i in &served {
                for e in langs.strings(i, "extensions") {
                    ids.insert(e, json!(i));
                }
            }
            let mut sname = pkg.localize(&m["displayName"]);
            if sname.is_empty() {
                sname = text(&m["name"]);
            }
            contributes.insert(
                "languageServers".into(),
                json!([{
                    "name": sname,
                    "runtime": if native { "binary" } else { "node" },
                    "transport": if stdio { "stdio" } else { "ipc" },
                    "entry": format!("extension/{best}"),
                    "args": if !native && stdio { json!(["--stdio"]) } else { json!([]) },
                    "languages": served,
                    "extensions": exts,
                    "filenames": fnames,
                    "languageIds": ids,
                    "settings": settings,
                    "initializationOptions": init,
                }]),
            );
            add(&mut report, "languageServer", "partial", &best, "Native LSP bridge; client middleware is not translated");
            if !truthy(&c["customEditors"])
                && !truthy(&c["views"])
                && !client_code.contains("createWebviewPanel")
                && !client_code.contains("registerWebviewViewProvider")
            {
                entry.clear();
                runtime = "";
            }
        }
    }

    let mut defaults = c["configurationDefaults"].as_object().cloned().unwrap_or_default();
    for cfg in list(&c["configuration"]) {
        for (key, v) in cfg["properties"].as_object().into_iter().flatten() {
            if let Some(d) = v.as_object().and_then(|o| o.get("default")) {
                defaults.insert(key.clone(), d.clone());
            }
        }
    }
    if !entry.is_empty() {
        let mut bytes = 0usize;
        let mut rels: Vec<(&String, &Vec<u8>)> = pkg.files.iter().collect();
        rels.sort_by(|a, b| {
            if *a.0 == entry {
                std::cmp::Ordering::Less
            } else if *b.0 == entry {
                std::cmp::Ordering::Greater
            } else {
                locale_compare(a.0, b.0)
            }
        });
        let skip = Regex::new(r"(?i)\.map$|(^|/)(test|tests|__tests__|\.github|\.vscode)/").unwrap();
        for (rel, data) in rels {
            if skip.is_match(rel) {
                continue;
            }
            bytes += data.len();
            if bytes > 96 << 20 {
                return fail("extension runtime exceeds 96 MiB");
            }
            let target = format!("vscode/{rel}");
            match std::str::from_utf8(data) {
                Ok(s) if !data.contains(&0) => {
                    files.insert(target, json!(s));
                }
                _ => {
                    binary.insert(target, json!(STANDARD.encode(data)));
                }
            }
        }
        if runtime == "bun" {
            files.insert("vscode/node_modules/vscode/index.js".into(), json!("module.exports = globalThis.__sulfurVSCode;\n"));
            files.insert(
                "vscode/node_modules/vscode/package.json".into(),
                json!(stringify(&json!({ "name": "vscode", "version": "1.95.0", "type": "commonjs", "main": "index.js" }))),
            );
        }
        contributes.insert(
            "commands".into(),
            Value::Array(
                list(&c["commands"])
                    .into_iter()
                    .map(|cmd| {
                        let mut o = cmd.as_object().cloned().unwrap_or_default();
                        o.insert("title".into(), json!(pkg.localize(&cmd["title"])));
                        o.insert("category".into(), json!(pkg.localize(&cmd["category"])));
                        Value::Object(o)
                    })
                    .collect(),
            ),
        );
        contributes.insert(
            "customEditors".into(),
            Value::Array(
                list(&c["customEditors"])
                    .into_iter()
                    .map(|e| {
                        let mut o = json!({ "viewType": e["viewType"], "displayName": pkg.localize(&e["displayName"]) });
                        if !e["priority"].is_null() {
                            o["priority"] = e["priority"].clone();
                        }
                        o["filenamePatterns"] = Value::Array(
                            list(&e["selector"]).iter().map(|s| s["filenamePattern"].clone()).filter(truthy).collect(),
                        );
                        o
                    })
                    .collect(),
            ),
        );
        let mut containers = HashMap::new();
        for group in c["viewsContainers"].as_object().into_iter().flat_map(|o| o.values()) {
            for v in list(group) {
                containers.insert(text(&v["id"]), pkg.localize(&v["title"]));
            }
        }
        let mut views = Vec::new();
        for (container, vs) in c["views"].as_object().into_iter().flatten() {
            for v in list(vs) {
                let mut o = v.as_object().cloned().unwrap_or_default();
                o.insert("name".into(), json!(pkg.localize(&v["name"])));
                o.insert("container".into(), json!(container));
                let title = containers.get(container).filter(|t| !t.is_empty()).cloned().unwrap_or_else(|| container.clone());
                o.insert("containerTitle".into(), json!(title));
                views.push(Value::Object(o));
            }
        }
        contributes.insert("views".into(), Value::Array(views));
        let node_ext = runtime == "bun";
        add(
            &mut report,
            "code",
            "partial",
            if node_ext { "Node extension" } else { "web build" },
            if node_ext {
                "Runs in a separate Node.js process with local filesystem and process access; VS Code API gaps are reported"
            } else {
                "CommonJS and ES modules resolve within the package; vscode uses Sulfur’s bridge"
            },
        );
    }
    let commands: HashSet<&str> = options.commands.iter().map(String::as_str).collect();
    let own: HashSet<String> = list(&c["commands"]).iter().filter_map(|x| x["command"].as_str()).map(str::to_owned).collect();
    for k in list(&c["keybindings"]) {
        let key = text(&k["key"]);
        let cmd = text(&k["command"]);
        let bare = cmd.strip_prefix('-').unwrap_or(&cmd);
        if !key.is_empty() && (commands.contains(bare) || (!entry.is_empty() && own.contains(bare))) {
            let mut b = json!({ "command": k["command"], "key": key.to_lowercase() });
            if truthy(&k["mac"]) {
                b["mac"] = json!(text(&k["mac"]).to_lowercase());
            }
            if truthy(&k["args"]) {
                b["args"] = k["args"].clone();
            }
            b["own"] = json!(own.contains(bare));
            contributes.entry("keybindings").or_insert_with(|| json!([])).as_array_mut().expect("array").push(b);
        }
    }
    if truthy(&c["keybindings"]) {
        add(&mut report, "keybindings", "partial", "keybindings", "Mapped built-in and extension commands; VS Code when-clause expressions are not translated");
    }
    if truthy(&c["configuration"]) {
        contributes.insert("configuration".into(), Value::Array(list(&c["configuration"])));
        add(&mut report, "settings", "partial", "settings", "Defaults preserved; VS Code-specific configuration scope rules are not translated");
    }
    if !langs.order.is_empty() {
        let order = langs.order.clone();
        contributes.insert("languages".into(), Value::Array(order.iter().map(|i| Value::Object(langs.get(i).clone())).collect()));
    }
    let mut handled = vec!["languages", "grammars", "themes", "iconThemes", "snippets", "keybindings", "configuration", "configurationDefaults"];
    if !entry.is_empty() {
        handled.extend(["commands", "views", "viewsContainers", "customEditors"]);
    }
    for key in c.as_object().into_iter().flat_map(|o| o.keys()) {
        if !handled.contains(&key.as_str()) {
            let detail = tables()["vsxUnsupported"][key].as_str().unwrap_or("This contribution is not implemented by the VS Code bridge");
            add(&mut report, key, "skipped", key, detail);
        }
    }
    let version = source.get("version").cloned().unwrap_or(Value::Null);
    let mut sulfur = json!({ "declarative": entry.is_empty(), "converted": Value::Object(source.clone()), "report": report });
    if !entry.is_empty() {
        sulfur["vscode"] = json!({ "root": "vscode", "id": format!("{ns}.{name}"), "defaults": defaults, "runtime": runtime });
    }
    let mut display = pkg.localize(&m["displayName"]);
    if display.is_empty() {
        display = name.clone();
    }
    let mut manifest = json!({
        "name": id,
        "displayName": display,
        "version": version,
        "description": pkg.localize(&m["description"]),
        "publisher": ns,
        "contributes": contributes,
        "sulfur": sulfur,
    });
    if truthy(&m["extensionDependencies"]) {
        manifest["extensionDependencies"] = m["extensionDependencies"].clone();
    }
    if !entry.is_empty() {
        manifest["main"] = json!(format!("vscode/{entry}"));
    }
    files.insert("package.json".into(), json!(stringify(&manifest)));
    let lines: Vec<String> = report
        .iter()
        .map(|r| format!("- {}: {} — {}. {}", text(&r["kind"]), text(&r["status"]), text(&r["name"]), text(&r["detail"])))
        .collect();
    files.insert(
        "README.md".into(),
        json!(format!(
            "# {display}\n\nConverted from {ns}.{name} {}.\n\n{}",
            version.as_str().map(str::to_owned).unwrap_or_else(|| version.to_string()),
            lines.join("\n")
        )),
    );
    Ok(Converted { id, manifest, files, binary, report })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip(files: &Map<String, Value>) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(&mut out);
        for (name, text) in files {
            w.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(text.as_str().unwrap().as_bytes()).unwrap();
        }
        w.finish().unwrap();
        out.into_inner()
    }

    fn fixtures() -> Vec<Value> {
        let raw = include_str!("../../../tests/fixtures/legacy-vsix.json");
        serde_json::from_str::<Vec<Value>>(raw).unwrap()
    }

    fn run(fixture: &Value) -> Res<Converted> {
        let opts = Options { commands: vec!["editor.action.copyLinesDownAction".into(), "workbench.action.openRecent".into()], prefer_node: false };
        convert(&zip(fixture["files"].as_object().unwrap()), json!({}), &opts)
    }

    fn data(r: &Converted, entry: &Value) -> Value {
        serde_json::from_str(r.files[entry["path"].as_str().unwrap()].as_str().unwrap()).unwrap()
    }

    #[test]
    fn themes_keep_includes_plists_token_colors_and_safe_colors() {
        let f = fixtures();
        let r = run(&f[0]).unwrap();
        assert_eq!(r.manifest["displayName"], "Night and Day");
        let themes = r.manifest["contributes"]["themes"].as_array().unwrap();
        assert_eq!(themes.len(), 2);
        let night = data(&r, &themes[0]);
        let day = data(&r, &themes[1]);
        for (k, v) in [
            ("--ide-bg", "#000000"),
            ("--ide-side", "#111111aa"),
            ("--ide-fg", "#eeeeee"),
            ("--hl-kw", "#ff00ff"),
            ("--hl-str", "#00ff00"),
            ("--hl-title", "#0000ff"),
            ("--hl-cmt", "#777777"),
            ("--hl-cmt-style", "normal"),
        ] {
            assert_eq!(night["vars"][k], v, "{k}");
        }
        assert!(night["vars"].get("--ide-button").is_none());
        assert_eq!(day["type"], "light");
        assert_eq!(day["vars"]["--ide-bg"], "#ffffff");
        assert_eq!(day["vars"]["--hl-kw"], "#aa0000");
        let statuses: Vec<&str> = r.report.iter().filter(|x| x["kind"] == "theme").map(|x| x["status"].as_str().unwrap()).collect();
        assert_eq!(statuses, ["converted", "converted", "skipped"]);
    }

    #[test]
    fn icon_themes_survive_missing_icons() {
        let r = run(&fixtures()[1]).unwrap();
        let theme = data(&r, &r.manifest["contributes"]["iconThemes"][0]);
        assert!(theme["defs"].get("_unused").is_none());
        assert!(theme["defs"]["_file"]["src"].as_str().unwrap().starts_with("data:image/svg+xml;base64,"));
        assert_eq!(theme["defs"]["_ts"]["char"], "\u{E001}");
        assert_eq!(theme["defs"]["_ts"]["color"], "#3178c6");
        assert_eq!(theme["defs"]["_ts"]["font"], "glyphs");
        assert_eq!(theme["fonts"]["glyphs"]["size"], "150%");
        assert_eq!(theme["fileExtensions"]["ts"], "_ts");
        assert_eq!(theme["languageExtensions"]["lua"], "_ts");
        assert_eq!(theme["light"]["fileNames"]["makefile"], "_folder");
    }

    #[test]
    fn grammars_and_snippets_keep_language_configuration() {
        let r = run(&fixtures()[2]).unwrap();
        let c = &r.manifest["contributes"];
        let demo = c["languages"].as_array().unwrap().iter().find(|l| l["id"] == "demo").unwrap();
        assert_eq!(demo["extensions"], json!(["demo", "dm"]));
        assert_eq!(demo["filenames"], json!(["demofile"]));
        assert_eq!(demo["comments"], json!({ "lineComment": "--", "blockComment": ["{-", "-}"] }));
        assert_eq!(demo["brackets"], json!([["{", "}"], ["(", ")"]]));
        assert_eq!(demo["autoClosingPairs"], json!([["\"", "\""]]));
        let grammar = c["grammars"].as_array().unwrap().iter().find(|g| g["language"] == "demo").unwrap();
        assert_eq!(data(&r, grammar)["patterns"][0]["match"], "\\b(let|in)\\b");
        let snippets = data(&r, &c["snippets"][0]);
        assert_eq!(snippets.as_array().unwrap().len(), 2);
        let let_ = snippets.as_array().unwrap().iter().find(|s| s["name"] == "Let").unwrap();
        assert_eq!(let_["body"], "let ${1:x} = $0\nin");
        assert_eq!(let_["prefix"], json!(["let", "lt"]));
        let exts = c["snippets"][1]["extensions"].as_array().unwrap();
        assert!(exts.contains(&json!("js")) && exts.contains(&json!("ts")));
    }

    #[test]
    fn language_servers_stay_separate_from_node_extensions() {
        let f = fixtures();
        let r = run(&f[4]).unwrap();
        let s = &r.manifest["contributes"]["languageServers"][0];
        assert_eq!(s["entry"], "extension/dist/languageserver.js");
        assert_eq!(s["runtime"], "node");
        assert_eq!(s["transport"], "ipc");
        assert_eq!(s["args"], json!([]));
        assert_eq!(s["languages"], json!(["demo", "yaml"]));
        assert_eq!(s["settings"], json!({ "demo": { "format": { "enable": true }, "trace": { "server": "off" } } }));
        assert_eq!(s["initializationOptions"]["icons"], "${extensionPath}/media/icons");
        assert_eq!(s["initializationOptions"]["l10nPath"], "${extensionPath}/dist/l10n");
        assert_eq!(r.manifest["sulfur"]["declarative"], true);
        let native = run(&f[5]).unwrap();
        let n = &native.manifest["contributes"]["languageServers"][0];
        assert_eq!(n["entry"], "extension/server/bin/lua-language-server.exe");
        assert_eq!(n["runtime"], "binary");
        assert_eq!(n["args"], json!([]));
    }

    #[test]
    fn node_extensions_with_dependencies_and_own_commands_convert() {
        let f = fixtures();
        let r = run(&f[3]).unwrap();
        assert_eq!(r.manifest["sulfur"]["vscode"]["runtime"], "bun");
        assert_eq!(r.manifest["main"], "vscode/out/extension.js");
        assert!(r.files["vscode/node_modules/vscode/index.js"].as_str().unwrap().contains("__sulfurVSCode"));
        let cmds: Vec<&str> = r.manifest["contributes"]["keybindings"].as_array().unwrap().iter().map(|k| k["command"].as_str().unwrap()).collect();
        assert_eq!(cmds, ["editor.action.copyLinesDownAction", "-workbench.action.openRecent", "ext.go"]);
        assert_eq!(r.manifest["sulfur"]["vscode"]["defaults"]["ext.a"], 1);
        let bad = run(f.last().unwrap()).unwrap();
        assert!(bad.report.iter().all(|x| x["status"] == "skipped"));
        assert!(convert(b"bad", json!({}), &Options { commands: vec![], prefer_node: false }).is_err());
        assert!(run(&f[f.len() - 2]).is_err());
    }

    #[test]
    fn plists_decode_entities_booleans_arrays_and_numbers() {
        let v = parse_data(
            "grammar.plist",
            br#"<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x"><plist><dict><key>text</key><string>a &amp; b</string><key>on</key><true/><key>n</key><integer>3</integer><key>a</key><array><string>x</string></array></dict></plist>"#,
        )
        .unwrap();
        assert_eq!(v, json!({ "text": "a & b", "on": true, "n": 3, "a": ["x"] }));
    }

    #[test]
    fn jsonc_takes_comments_and_trailing_commas() {
        assert_eq!(
            parse_jsonc("{\n // c\n \"a\": [1, 2,], /* x */ \"b\": \"//not\",\n}").unwrap(),
            json!({ "a": [1, 2], "b": "//not" })
        );
        assert_eq!(clean_rel("./themes", "../icons/a.svg").unwrap(), "icons/a.svg");
        assert!(clean_rel("", "../x").is_err());
        assert!(clean_rel("", "c:/x").is_err());
    }
}

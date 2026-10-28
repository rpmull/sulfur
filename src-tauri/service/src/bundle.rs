//! A web extension's modules joined into the one CommonJS file Sulfur's
//! extension frame runs, `vscode` left to the frame's bridge. Most web builds
//! already are one file and pass through untouched; the rest have their
//! package-local requires (and plain ES module syntax) resolved here. Package
//! code is only read, never run.
use std::{collections::BTreeMap, sync::OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde_json::{json, Value};

use crate::{
    util::{fail, Res},
    vsix::{posix_dirname, Converted},
};

fn require_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\brequire\s*\(\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*\)"#).unwrap())
}

fn esm_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?m)^[ \t]*(?:import\s*(?:[\w$*{]|["'])|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))"#).unwrap()
    })
}

fn normalize(p: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            x => stack.push(x),
        }
    }
    stack.join("/")
}

struct Pkg<'a> {
    files: &'a serde_json::Map<String, Value>,
    binary: &'a serde_json::Map<String, Value>,
}

impl Pkg<'_> {
    fn has(&self, p: &str) -> bool {
        self.files.contains_key(p) || self.binary.contains_key(p)
    }
    fn text(&self, p: &str) -> Option<String> {
        self.files.get(p).and_then(Value::as_str).map(str::to_owned).or_else(|| {
            let b = STANDARD.decode(self.binary.get(p)?.as_str()?).ok()?;
            String::from_utf8(b).ok()
        })
    }
    fn file(&self, base: &str) -> Option<String> {
        for c in [base.to_owned(), format!("{base}.js"), format!("{base}.cjs"), format!("{base}.mjs"), format!("{base}.json")] {
            if self.has(&c) {
                return Some(c);
            }
        }
        self.dir(base)
    }
    fn dir(&self, base: &str) -> Option<String> {
        if let Some(pkg) = self.text(&format!("{base}/package.json")).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            for key in ["browser", "module", "main"] {
                if let Some(m) = pkg[key].as_str().filter(|m| !m.is_empty()) {
                    let target = normalize(&format!("{base}/{m}"));
                    for c in [target.clone(), format!("{target}.js"), format!("{target}/index.js")] {
                        if self.has(&c) {
                            return Some(c);
                        }
                    }
                }
            }
        }
        ["index.js", "index.cjs", "index.json"].iter().map(|i| format!("{base}/{i}")).find(|c| self.has(c))
    }
    /// a specifier from module `from`, as Node finds it inside the package
    fn resolve(&self, from: &str, spec: &str, root: &str) -> Option<String> {
        if spec == "vscode" {
            return None;
        }
        let dir = posix_dirname(from);
        if spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == ".." {
            let target = normalize(&format!("{dir}/{spec}"));
            return target.starts_with(root).then(|| self.file(&target)).flatten();
        }
        let mut at = dir;
        loop {
            if let Some(found) = self.file(&format!("{at}/node_modules/{spec}")) {
                return Some(found);
            }
            if at == root || !at.contains('/') {
                return None;
            }
            at = posix_dirname(&at);
        }
    }
}

/// plain ES module syntax as CommonJS: imports as requires, exports set at the end
pub fn esm_to_cjs(src: &str) -> Res<String> {
    static RES: OnceLock<[Regex; 9]> = OnceLock::new();
    let re = RES.get_or_init(|| {
        [
            Regex::new(r#"^\s*import\s+(?:"([^"]+)"|'([^']+)')\s*;?\s*$"#).unwrap(),
            Regex::new(r#"^\s*import\s+([\w$]+)\s*,\s*(\{[^}]*\}|\*\s+as\s+[\w$]+)\s+from\s+(?:"([^"]+)"|'([^']+)')\s*;?\s*$"#).unwrap(),
            Regex::new(r#"^\s*import\s+(\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+(?:"([^"]+)"|'([^']+)')\s*;?\s*$"#).unwrap(),
            Regex::new(r#"^\s*export\s+\*\s+from\s+(?:"([^"]+)"|'([^']+)')\s*;?\s*$"#).unwrap(),
            Regex::new(r#"^\s*export\s+(\{[^}]*\})\s+from\s+(?:"([^"]+)"|'([^']+)')\s*;?\s*$"#).unwrap(),
            Regex::new(r#"^\s*export\s+(\{[^}]*\})\s*;?\s*$"#).unwrap(),
            Regex::new(r"^(\s*)export\s+default\s+(async\s+function\b|function\b|class\b)\s*\*?\s*([\w$]*)").unwrap(),
            Regex::new(r"^(\s*)export\s+default\s+").unwrap(),
            Regex::new(r"^(\s*)export\s+((?:async\s+)?function\s*\*?|class|const|let|var)\s+([\w$]+)").unwrap(),
        ]
    });
    if src.contains("import.meta") {
        return fail("This web extension uses import.meta, which needs its own bundled build");
    }
    let spec = |c: &regex::Captures, a: usize, b: usize| c.get(a).or_else(|| c.get(b)).map(|m| m.as_str().to_owned()).unwrap_or_default();
    let names = |braces: &str| -> Vec<(String, String)> {
        braces
            .trim_matches(|c| c == '{' || c == '}')
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                let mut parts = s.split_whitespace();
                let first = parts.next().unwrap_or("").to_owned();
                match (parts.next(), parts.next()) {
                    (Some("as"), Some(alias)) => (first, alias.to_owned()),
                    _ => (first.clone(), first),
                }
            })
            .collect()
    };
    let binding = |clause: &str, from: &str| -> String {
        let req = format!("require({})", json!(from));
        if let Some(ns) = clause.strip_prefix('*') {
            let name = ns.trim().trim_start_matches("as").trim();
            format!("const {name} = {req};")
        } else if clause.starts_with('{') {
            let fields: Vec<String> = names(clause).into_iter().map(|(k, v)| if k == v { k } else { format!("{k}: {v}") }).collect();
            format!("const {{ {} }} = {req};", fields.join(", "))
        } else {
            format!("const {clause} = __sulfurDefault({req});")
        }
    };
    let mut out = Vec::new();
    let mut tail = Vec::new();
    let mut n = 0;
    for line in src.split('\n') {
        if let Some(c) = re[0].captures(line) {
            out.push(format!("require({});", json!(spec(&c, 1, 2))));
        } else if let Some(c) = re[1].captures(line) {
            let from = spec(&c, 3, 4);
            out.push(format!("{} {}", binding(&c[1], &from), binding(&c[2], &from)));
        } else if let Some(c) = re[2].captures(line) {
            out.push(binding(&c[1], &spec(&c, 2, 3)));
        } else if let Some(c) = re[3].captures(line) {
            out.push(format!("__sulfurStar(exports, require({}));", json!(spec(&c, 1, 2))));
        } else if let Some(c) = re[4].captures(line) {
            n += 1;
            let from = spec(&c, 2, 3);
            out.push(format!("const __sulfurRe{n} = require({});", json!(from)));
            for (k, v) in names(&c[1]) {
                tail.push(format!("exports.{v} = __sulfurRe{n}.{k};"));
            }
        } else if let Some(c) = re[5].captures(line) {
            for (k, v) in names(&c[1]) {
                tail.push(format!("exports.{v} = {k};"));
            }
        } else if let Some(c) = re[6].captures(line) {
            let name = if c[3].is_empty() { "__sulfurDefaultExport".to_owned() } else { c[3].to_owned() };
            let rest = &line[c.get(0).map(|m| m.end()).unwrap_or(0)..];
            let kind = c[2].trim_end();
            let star = if c[0].contains('*') { "*" } else { "" };
            out.push(format!("{}{kind}{star} {name}{rest}", &c[1]));
            tail.push(format!("exports.default = {name};"));
        } else if let Some(c) = re[7].captures(line) {
            out.push(format!("{}exports.default = {}", &c[1], &line[c[0].len()..]));
        } else if let Some(c) = re[8].captures(line) {
            let rest = &line[c[0].len()..];
            out.push(format!("{}{} {}{rest}", &c[1], &c[2], &c[3]));
            tail.push(format!("exports.{0} = {0};", &c[3]));
        } else if esm_re().is_match(line) {
            return fail("This web extension's ES modules need their own bundled build");
        } else {
            out.push(line.to_owned());
        }
    }
    let mut text = out.join("\n");
    if !tail.is_empty() {
        text.push('\n');
        text.push_str(&tail.join("\n"));
    }
    Ok(format!("Object.defineProperty(exports, '__esModule', {{ value: true }});\n{text}"))
}

const RUNTIME: &str = r#"var __sulfurCache = {};
function __sulfurDefault(m) { return m && m.__esModule ? m.default : m; }
function __sulfurStar(to, from) { for (var k in from) if (k !== 'default' && !Object.prototype.hasOwnProperty.call(to, k)) to[k] = from[k]; }
function __sulfurLoad(id) {
  var hit = __sulfurCache[id];
  if (hit) return hit.exports;
  var m = { exports: {} }, own = __sulfurModules[id];
  __sulfurCache[id] = m;
  own[0](m, m.exports, function (spec) { return spec in own[1] ? __sulfurLoad(own[1][spec]) : require(spec); });
  return m.exports;
}
"#;

/// a converted web extension's code made one file its frame can run
pub fn bundle_browser_extension(result: &mut Converted) -> Res<()> {
    if result.manifest["sulfur"]["vscode"]["runtime"] != "browser" {
        return Ok(());
    }
    let Some(main) = result.manifest["main"].as_str().map(str::to_owned) else { return Ok(()) };
    let pkg = Pkg { files: &result.files, binary: &result.binary };
    let mut modules: BTreeMap<String, (String, BTreeMap<String, String>)> = BTreeMap::new();
    let mut queue = vec![main.clone()];
    let mut external = false;
    while let Some(id) = queue.pop() {
        if modules.contains_key(&id) {
            continue;
        }
        let Some(mut src) = pkg.text(&id) else { return fail(format!("{id} isn't readable text")) };
        if id.ends_with(".json") {
            modules.insert(id, (format!("module.exports = {src};"), BTreeMap::new()));
            continue;
        }
        if esm_re().is_match(&src) {
            src = esm_to_cjs(&src)?;
        }
        let mut map = BTreeMap::new();
        for c in require_re().captures_iter(&src) {
            let spec = c.get(1).or_else(|| c.get(2)).map(|m| m.as_str()).unwrap_or("");
            match pkg.resolve(&id, spec, "vscode") {
                Some(target) => {
                    map.insert(spec.to_owned(), target.clone());
                    queue.push(target);
                }
                None if spec != "vscode" => external = true,
                None => {}
            }
        }
        if modules.len() > 4000 {
            return fail("This web extension has more modules than its frame can load");
        }
        modules.insert(id, (src, map));
    }
    let _ = external;
    // one module needing nothing else runs as it is
    if modules.len() == 1 && modules[&main].1.is_empty() && pkg.text(&main).as_deref() == Some(modules[&main].0.as_str()) {
        return Ok(());
    }
    let mut out = String::from("var __sulfurModules = {\n");
    for (id, (src, map)) in &modules {
        out.push_str(&format!(
            "{}: [function (module, exports, require) {{\n{src}\n}}, {}],\n",
            json!(id),
            json!(map)
        ));
    }
    out.push_str("};\n");
    out.push_str(RUNTIME);
    out.push_str(&format!("module.exports = __sulfurLoad({});\n", json!(main)));
    let entry = "vscode/sulfur-web.cjs".to_owned();
    result.files.insert(entry.clone(), json!(out));
    result.manifest["main"] = json!(entry);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn converted(files: Value) -> Converted {
        Converted {
            id: "vsx.a.b".into(),
            manifest: json!({ "main": "vscode/dist/web.js", "sulfur": { "vscode": { "runtime": "browser" } } }),
            files: files.as_object().unwrap().clone(),
            binary: Default::default(),
            report: vec![],
        }
    }

    #[test]
    fn single_files_pass_through_and_local_modules_join() {
        let mut one = converted(json!({ "vscode/dist/web.js": "const v = require('vscode'); exports.activate = () => v;" }));
        bundle_browser_extension(&mut one).unwrap();
        assert_eq!(one.manifest["main"], "vscode/dist/web.js");

        let mut many = converted(json!({
            "vscode/dist/web.js": "const h = require('./helper'); const l = require(\"lib\"); exports.activate = () => h.x + l;",
            "vscode/dist/helper.js": "exports.x = require('../data.json').n;",
            "vscode/data.json": "{\"n\": 2}",
            "vscode/node_modules/lib/package.json": "{\"main\": \"main.js\"}",
            "vscode/node_modules/lib/main.js": "export const y = 1;\nexport default 40;",
        }));
        bundle_browser_extension(&mut many).unwrap();
        assert_eq!(many.manifest["main"], "vscode/sulfur-web.cjs");
        let code = many.files["vscode/sulfur-web.cjs"].as_str().unwrap();
        assert!(code.contains("\"vscode/dist/helper.js\""));
        assert!(code.contains("\"vscode/node_modules/lib/main.js\""));
        assert!(code.contains("exports.default = 40"));
        assert!(code.contains("exports.y = y;"));
    }

    #[test]
    fn plain_es_modules_become_commonjs() {
        let out = esm_to_cjs(
            "import a, { b as c } from './x';\nimport * as ns from 'y';\nimport 'z';\nexport function activate() {}\nexport { a as d };\nexport default class Q {}",
        )
        .unwrap();
        assert!(out.contains("const a = __sulfurDefault(require(\"./x\"));"));
        assert!(out.contains("const { b: c } = require(\"./x\");"));
        assert!(out.contains("const ns = require(\"y\");"));
        assert!(out.contains("require(\"z\");"));
        assert!(out.contains("function activate() {}"));
        assert!(out.contains("exports.activate = activate;"));
        assert!(out.contains("exports.d = a;"));
        assert!(out.contains("class Q {}"));
        assert!(out.contains("exports.default = Q;"));
        assert!(esm_to_cjs("console.log(import.meta.url)").is_err());
    }
}

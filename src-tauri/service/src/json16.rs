//! JSON whose strings are UTF-16, as the page's are: a live edit may split a
//! surrogate pair between two operations, which a UTF-8 parser refuses.
use std::fmt::Write;

#[derive(Debug, Clone, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(fields) => fields.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str16(&self) -> Option<&[u16]> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }
    /// a string field as Rust text, lone surrogates replaced
    pub fn string(&self, key: &str) -> Option<String> {
        self.get(key).and_then(J::str16).map(String::from_utf16_lossy)
    }
    pub fn num(&self, key: &str) -> Option<f64> {
        match self.get(key) {
            Some(J::Num(n)) => Some(*n),
            _ => None,
        }
    }
    pub fn text(s: &str) -> J {
        J::Str(s.encode_utf16().collect())
    }
    pub fn obj(fields: Vec<(&str, J)>) -> J {
        J::Obj(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        write_value(self, &mut out);
        out
    }
}

impl From<&str> for J {
    fn from(s: &str) -> J {
        J::text(s)
    }
}
impl From<String> for J {
    fn from(s: String) -> J {
        J::text(&s)
    }
}
impl From<bool> for J {
    fn from(b: bool) -> J {
        J::Bool(b)
    }
}
impl From<u64> for J {
    fn from(n: u64) -> J {
        J::Num(n as f64)
    }
}
impl From<i64> for J {
    fn from(n: i64) -> J {
        J::Num(n as f64)
    }
}
impl From<usize> for J {
    fn from(n: usize) -> J {
        J::Num(n as f64)
    }
}

fn write_value(v: &J, out: &mut String) {
    match v {
        J::Null => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::Num(n) => {
            if !n.is_finite() {
                out.push_str("null");
            } else if n.fract() == 0.0 && n.abs() < 1e21 {
                let _ = write!(out, "{}", *n as i128);
            } else {
                let _ = write!(out, "{n}");
            }
        }
        J::Str(s) => write_string(s, out),
        J::Arr(items) => {
            out.push('[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(x, out);
            }
            out.push(']');
        }
        J::Obj(fields) => {
            out.push('{');
            for (i, (k, x)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(&k.encode_utf16().collect::<Vec<_>>(), out);
                out.push(':');
                write_value(x, out);
            }
            out.push('}');
        }
    }
}

/// a UTF-16 string as JSON.stringify writes it, lone surrogates escaped
pub fn write_string(s: &[u16], out: &mut String) {
    out.push('"');
    for r in char::decode_utf16(s.iter().copied()) {
        match r {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(c) if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            Ok(c) => out.push(c),
            Err(e) => {
                let _ = write!(out, "\\u{:04x}", e.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

pub fn parse(text: &str) -> Result<J, String> {
    let mut p = Parser { b: text.as_bytes(), i: 0, depth: 0 };
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err("trailing characters".into());
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected {}", c as char))
        }
    }
    fn value(&mut self) -> Result<J, String> {
        self.ws();
        match self.b.get(self.i) {
            Some(b'{') => {
                self.depth += 1;
                if self.depth > 128 {
                    return Err("nested too deeply".into());
                }
                self.i += 1;
                let mut fields = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                } else {
                    loop {
                        self.ws();
                        let key = String::from_utf16_lossy(&self.string()?);
                        self.eat(b':')?;
                        let v = self.value()?;
                        fields.push((key, v));
                        self.ws();
                        match self.b.get(self.i) {
                            Some(b',') => self.i += 1,
                            Some(b'}') => {
                                self.i += 1;
                                break;
                            }
                            _ => return Err("expected , or }".into()),
                        }
                    }
                }
                self.depth -= 1;
                Ok(J::Obj(fields))
            }
            Some(b'[') => {
                self.depth += 1;
                if self.depth > 128 {
                    return Err("nested too deeply".into());
                }
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                } else {
                    loop {
                        items.push(self.value()?);
                        self.ws();
                        match self.b.get(self.i) {
                            Some(b',') => self.i += 1,
                            Some(b']') => {
                                self.i += 1;
                                break;
                            }
                            _ => return Err("expected , or ]".into()),
                        }
                    }
                }
                self.depth -= 1;
                Ok(J::Arr(items))
            }
            Some(b'"') => Ok(J::Str(self.string()?)),
            Some(b't') if self.b[self.i..].starts_with(b"true") => {
                self.i += 4;
                Ok(J::Bool(true))
            }
            Some(b'f') if self.b[self.i..].starts_with(b"false") => {
                self.i += 5;
                Ok(J::Bool(false))
            }
            Some(b'n') if self.b[self.i..].starts_with(b"null") => {
                self.i += 4;
                Ok(J::Null)
            }
            Some(c) if *c == b'-' || c.is_ascii_digit() => {
                let start = self.i;
                self.i += 1;
                while self.i < self.b.len()
                    && matches!(self.b[self.i], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
                {
                    self.i += 1;
                }
                std::str::from_utf8(&self.b[start..self.i])
                    .ok()
                    .and_then(|s| s.parse::<f64>().ok())
                    .map(J::Num)
                    .ok_or_else(|| "invalid number".into())
            }
            _ => Err("unexpected character".into()),
        }
    }
    fn string(&mut self) -> Result<Vec<u16>, String> {
        if self.b.get(self.i) != Some(&b'"') {
            return Err("expected a string".into());
        }
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let start = self.i;
            while self.i < self.b.len() && self.b[self.i] != b'"' && self.b[self.i] != b'\\' {
                if self.b[self.i] < 0x20 {
                    return Err("control character in string".into());
                }
                self.i += 1;
            }
            let run = std::str::from_utf8(&self.b[start..self.i]).map_err(|_| "invalid UTF-8")?;
            out.extend(run.encode_utf16());
            match self.b.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = *self.b.get(self.i).ok_or("unterminated escape")?;
                    self.i += 1;
                    out.push(match c {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let hex = self.b.get(self.i..self.i + 4).ok_or("short \\u escape")?;
                            self.i += 4;
                            u16::from_str_radix(std::str::from_utf8(hex).map_err(|_| "bad escape")?, 16)
                                .map_err(|_| "bad \\u escape")?
                        }
                        _ => return Err("bad escape".into()),
                    });
                }
                _ => return Err("unterminated string".into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_surrogates_round_trip() {
        let v = parse(r#"{"type":"op","ops":[1,"\ud83d",-1,"x😀"],"base":3}"#).unwrap();
        let ops = match v.get("ops") {
            Some(J::Arr(a)) => a.clone(),
            _ => panic!(),
        };
        assert_eq!(ops[1], J::Str(vec![0xd83d]));
        assert_eq!(ops[3].str16().unwrap().len(), 3);
        assert_eq!(v.to_json(), r#"{"type":"op","ops":[1,"\ud83d",-1,"x😀"],"base":3}"#);
        assert_eq!(J::text("a\"\n\u{1}").to_json(), r#""a\"\n\u0001""#);
    }
}

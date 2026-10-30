//! The live session's text operations, in UTF-16 code units as the page's
//! web/src/text-operations.js counts them: a retain (n > 0), a delete (n < 0)
//! or an insert.
use crate::json16::J;

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    N(i64),
    S(Vec<u16>),
}

impl Op {
    fn is_ins(&self) -> bool {
        matches!(self, Op::S(_))
    }
    fn is_del(&self) -> bool {
        matches!(self, Op::N(n) if *n < 0)
    }
    pub fn to_j(&self) -> J {
        match self {
            Op::N(n) => J::Num(*n as f64),
            Op::S(s) => J::Str(s.clone()),
        }
    }
}

pub fn ops_j(ops: &[Op]) -> J {
    J::Arr(ops.iter().map(Op::to_j).collect())
}

#[derive(Default)]
pub struct Builder {
    pub ops: Vec<Op>,
}

impl Builder {
    fn add(&mut self, o: Op) {
        match &o {
            Op::N(0) => return,
            Op::S(s) if s.is_empty() => return,
            _ => {}
        }
        let n = self.ops.len();
        if o.is_ins() && n > 0 && self.ops[n - 1].is_del() {
            if n >= 2 {
                if let (Op::S(before), Op::S(add)) = (&mut self.ops[n - 2], &o) {
                    before.extend_from_slice(add);
                    return;
                }
            }
            self.ops.insert(n - 1, o);
            return;
        }
        if let Some(last) = self.ops.last_mut() {
            match (last, &o) {
                (Op::S(a), Op::S(b)) => {
                    a.extend_from_slice(b);
                    return;
                }
                (Op::N(a), Op::N(b)) if (*a > 0) == (*b > 0) => {
                    *a += b;
                    return;
                }
                _ => {}
            }
        }
        self.ops.push(o);
    }
    pub fn retain(&mut self, n: i64) {
        self.add(Op::N(n));
    }
    pub fn insert(&mut self, s: &[u16]) {
        self.add(Op::S(s.to_vec()));
    }
    pub fn del(&mut self, n: i64) {
        self.add(Op::N(-n));
    }
}

pub fn apply(doc: &[u16], ops: &[Op]) -> Vec<u16> {
    let mut out = Vec::with_capacity(doc.len());
    let mut at = 0usize;
    for o in ops {
        match o {
            Op::S(s) => out.extend_from_slice(s),
            Op::N(n) if *n > 0 => {
                let end = (at + *n as usize).min(doc.len());
                out.extend_from_slice(&doc[at.min(end)..end]);
                at += *n as usize;
            }
            Op::N(n) => at += n.unsigned_abs() as usize,
        }
    }
    out
}

/// two concurrent operations on the same text as each other's follow-up
pub fn transform(a: &[Op], b: &[Op]) -> Result<(Vec<Op>, Vec<Op>), &'static str> {
    let (mut a1, mut b1) = (Builder::default(), Builder::default());
    let (mut i, mut j) = (0, 0);
    let mut x = a.get(i).cloned();
    i += 1;
    let mut y = b.get(j).cloned();
    j += 1;
    loop {
        if x.is_none() && y.is_none() {
            break;
        }
        if let Some(Op::S(s)) = &x {
            a1.insert(s);
            b1.retain(s.len() as i64);
            x = a.get(i).cloned();
            i += 1;
            continue;
        }
        if let Some(Op::S(s)) = &y {
            a1.retain(s.len() as i64);
            b1.insert(s);
            y = b.get(j).cloned();
            j += 1;
            continue;
        }
        let (Some(Op::N(xn)), Some(Op::N(yn))) = (&x, &y) else {
            return Err("operations of different lengths");
        };
        let (xn, yn) = (*xn, *yn);
        let n = xn.abs().min(yn.abs());
        if xn > 0 && yn > 0 {
            a1.retain(n);
            b1.retain(n);
        } else if xn < 0 && yn > 0 {
            a1.del(n);
        } else if xn > 0 && yn < 0 {
            b1.del(n);
        }
        x = if xn.abs() == n {
            let v = a.get(i).cloned();
            i += 1;
            v
        } else {
            Some(Op::N(if xn > 0 { xn - n } else { xn + n }))
        };
        y = if yn.abs() == n {
            let v = b.get(j).cloned();
            j += 1;
            v
        } else {
            Some(Op::N(if yn > 0 { yn - n } else { yn + n }))
        };
    }
    Ok((a1.ops, b1.ops))
}

/// where a place in the text lands after an edit
pub fn map(ops: &[Op], pos: usize) -> usize {
    let (mut i, mut j) = (0usize, 0usize);
    for o in ops {
        match o {
            Op::S(s) => j += s.len(),
            Op::N(n) => {
                let len = n.unsigned_abs() as usize;
                if pos <= i + len {
                    return if *n > 0 { j + (pos - i) } else { j };
                }
                i += len;
                if *n > 0 {
                    j += len;
                }
            }
        }
    }
    j
}

fn low_surrogate(c: Option<&u16>) -> bool {
    c.is_some_and(|c| (0xDC00..=0xDFFF).contains(c))
}

/// the one replace between two texts, never splitting a surrogate pair
pub fn disk_diff(before: &[u16], after: &[u16]) -> Vec<Op> {
    let mut start = 0;
    while start < before.len() && start < after.len() && before[start] == after[start] {
        start += 1;
    }
    if start > 0 && low_surrogate(before.get(start)) {
        start -= 1;
    }
    let mut tail = 0;
    while tail < before.len() - start
        && tail < after.len() - start
        && before[before.len() - tail - 1] == after[after.len() - tail - 1]
    {
        tail += 1;
    }
    if tail > 0 && low_surrogate(after.get(after.len() - tail)) {
        tail -= 1;
    }
    let mut b = Builder::default();
    b.retain(start as i64);
    b.insert(&after[start..after.len() - tail]);
    b.del((before.len() - start - tail) as i64);
    b.retain(tail as i64);
    b.ops
}

/// operations read from the page: strings and safe nonzero integers only
pub fn parse_ops(v: &J) -> Option<Vec<Op>> {
    let J::Arr(items) = v else { return None };
    let mut out = Vec::with_capacity(items.len());
    for x in items {
        match x {
            J::Str(s) => out.push(Op::S(s.clone())),
            J::Num(n) if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && *n != 0.0 => {
                out.push(Op::N(*n as i64))
            }
            _ => return None,
        }
    }
    Some(out)
}

/// an operation spanning exactly a text of `length`, inserting at most `max`
/// the length a text of `length` units has once ops are applied, with no text made
pub fn applied_len(length: usize, ops: &[Op]) -> usize {
    let mut out = length;
    for o in ops {
        match o {
            Op::S(s) => out += s.len(),
            Op::N(n) if *n < 0 => out = out.saturating_sub(n.unsigned_abs() as usize),
            _ => {}
        }
    }
    out
}

pub fn valid(ops: &[Op], length: usize, max: usize) -> bool {
    if ops.len() > max {
        return false;
    }
    let (mut used, mut inserted) = (0usize, 0usize);
    for o in ops {
        match o {
            Op::S(s) => inserted += s.len(),
            Op::N(n) => used += n.unsigned_abs() as usize,
        }
    }
    used == length && inserted <= max
}

#[cfg(test)]
mod tests {
    use super::*;
    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn disk_diffs_rebuild_the_text_without_splitting_pairs() {
        for (a, b) in [("a😀b", "a😃b"), ("😀", "x😀"), ("😀x", "😃x"), ("", "abc"), ("abc", "")] {
            assert_eq!(apply(&u(a), &disk_diff(&u(a), &u(b))), u(b));
        }
    }

    #[test]
    fn applied_length_matches_the_text_made() {
        let doc = u("hello world");
        let ops = vec![Op::N(6), Op::S(u("brave ")), Op::N(-5), Op::S(u("there"))];
        assert_eq!(applied_len(doc.len(), &ops), apply(&doc, &ops).len());
        assert_eq!(applied_len(3, &[Op::N(-3)]), 0);
    }
    #[test]
    fn concurrent_edits_converge() {
        let doc = u("a😀b");
        let left = vec![Op::N(1), Op::S(u("X")), Op::N(3)];
        let right = vec![Op::N(4), Op::S(u("Y"))];
        let (l2, r2) = transform(&left, &right).unwrap();
        let one = apply(&apply(&doc, &right), &l2);
        let two = apply(&apply(&doc, &left), &r2);
        assert_eq!(one, two);
        assert_eq!(String::from_utf16(&one).unwrap(), "aX😀bY");
        assert_eq!(map(&left, 2), 3);
    }

    #[test]
    fn builders_merge_like_the_page() {
        let mut b = Builder::default();
        b.retain(2);
        b.del(1);
        b.insert(&u("x"));
        b.insert(&u("y"));
        b.retain(0);
        b.retain(3);
        assert_eq!(b.ops, vec![Op::N(2), Op::S(u("xy")), Op::N(-1), Op::N(3)]);
    }
}

//! SQLite as the page's database tool asks it: a database created only when
//! asked, queries read-only, a batch one transaction, and SQLite itself
//! deciding what's allowed. Every call has a ten-second deadline that stops
//! the work inside SQLite, not just the wait for it.
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    types::ValueRef,
    Connection, OpenFlags,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use crate::util::{fail, is_absolute_str, Fail, Res};

const RESULT_BYTES: usize = 8 << 20;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize, Default, Clone)]
pub struct Request {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub sql: String,
    #[serde(default)]
    pub limit: Option<f64>,
}

fn validate(p: &Request) -> Res<()> {
    if !is_absolute_str(&p.path) || p.path.contains('\0') {
        return fail("choose a full path to a database");
    }
    if !["create", "schema", "query", "execute"].contains(&p.op.as_str()) {
        return fail("unknown SQLite operation");
    }
    if p.sql.len() > 1 << 20 {
        return fail("SQL exceeds 1 MiB");
    }
    if (p.op == "query" || p.op == "execute") && p.sql.trim().is_empty() {
        return fail("enter SQL first");
    }
    Ok(())
}

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) if n.unsigned_abs() > 9_007_199_254_740_991 => json!(n.to_string()),
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) if !f.is_finite() => json!(if f.is_nan() { "NaN".to_owned() } else if f > 0.0 { "Infinity".into() } else { "-Infinity".into() }),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) if t.len() > 65536 => {
            json!(format!("{}… [truncated]", String::from_utf8_lossy(&t[..65536])))
        }
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => {
            let hex: String = b.iter().take(64).map(|x| format!("{x:02x}")).collect();
            json!(format!("BLOB ({} bytes): {hex}", b.len()))
        }
    }
}

fn sql_error(e: rusqlite::Error) -> Fail {
    match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::OperationInterrupted => {
            Fail::new("SQLite query timed out", 504)
        }
        rusqlite::Error::SqliteFailure(_, Some(m)) => Fail::new(m, 400),
        e => Fail::new(e.to_string(), 400),
    }
}

/// one request on its own connection; `interrupt` receives the handle that stops it
fn run_sync(p: &Request, interrupt: impl FnOnce(rusqlite::InterruptHandle)) -> Res<Value> {
    validate(p)?;
    let path = Path::new(&p.path);
    let mut created = false;
    if p.op == "create" {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(path)?;
        created = true;
    } else if !std::fs::metadata(path)?.is_file() {
        return fail("choose a database file");
    }
    let result = (|| {
        let writable = p.op == "create" || p.op == "execute";
        let flags = if writable { OpenFlags::SQLITE_OPEN_READ_WRITE } else { OpenFlags::SQLITE_OPEN_READ_ONLY }
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let mut db = Connection::open_with_flags(path, flags).map_err(sql_error)?;
        interrupt(db.get_interrupt_handle());
        // bound single allocations before SQL can ask for a giant value
        for (limit, value) in [
            (Limit::SQLITE_LIMIT_LENGTH, 16 << 20),
            (Limit::SQLITE_LIMIT_SQL_LENGTH, (1 << 20) + 64),
            (Limit::SQLITE_LIMIT_COLUMN, 512),
        ] {
            db.set_limit(limit, value).map_err(sql_error)?;
        }
        db.execute_batch("PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")
            .map_err(sql_error)?;
        let guard = Arc::new(AtomicBool::new(false));
        let guarded = guard.clone();
        db.authorizer(Some(move |ctx: AuthContext<'_>| match ctx.action {
            // VACUUM attaches a temporary, unnamed database
            AuthAction::Attach { filename } if !filename.is_empty() => Authorization::Deny,
            AuthAction::Function { function_name }
                if ["load_extension", "readfile", "writefile"].contains(&function_name.to_lowercase().as_str()) =>
            {
                Authorization::Deny
            }
            AuthAction::Pragma { pragma_name, .. }
                if ["temp_store_directory", "data_store_directory"].contains(&pragma_name.to_lowercase().as_str()) =>
            {
                Authorization::Deny
            }
            AuthAction::Transaction { .. } | AuthAction::Savepoint { .. } if guarded.load(Ordering::Acquire) => {
                Authorization::Deny
            }
            _ => Authorization::Allow,
        }))
        .map_err(sql_error)?;
        if p.op == "create" {
            db.execute_batch("VACUUM").map_err(sql_error)?;
            return Ok(json!({ "columns": [], "rows": [] }));
        }
        if p.op == "execute" {
            db.execute_batch("BEGIN").map_err(sql_error)?;
            guard.store(true, Ordering::Release);
            let ran = db.execute_batch(&p.sql);
            guard.store(false, Ordering::Release);
            if let Err(e) = ran {
                let _ = db.execute_batch("ROLLBACK");
                return Err(sql_error(e));
            }
            let changes: i64 = match db.query_row("SELECT total_changes()", [], |r| r.get(0)) {
                Ok(n) => n,
                Err(e) => {
                    let _ = db.execute_batch("ROLLBACK");
                    return Err(sql_error(e));
                }
            };
            if let Err(e) = db.execute_batch("COMMIT") {
                let _ = db.execute_batch("ROLLBACK");
                return Err(sql_error(e));
            }
            return Ok(json!({ "columns": [], "rows": [], "changes": changes }));
        }
        let sql = if p.op == "schema" {
            "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' ORDER BY name"
        } else {
            p.sql.as_str()
        };
        let mut stmt = db.prepare(sql).map_err(sql_error)?;
        let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
        if columns.len() > 512 {
            return fail("query has more than 512 columns");
        }
        let limit = p.limit.filter(|l| *l > 0.0 && *l <= 1000.0).map(|l| l as usize).unwrap_or(200);
        let mut rows_out = Vec::new();
        let mut size = 0usize;
        let mut truncated = false;
        let mut rows = stmt.query([]).map_err(sql_error)?;
        while let Some(row) = rows.next().map_err(sql_error)? {
            let values: Vec<Value> = (0..columns.len()).map(|i| row.get_ref(i).map(cell).unwrap_or(Value::Null)).collect();
            let bytes = serde_json::to_vec(&values).map(|v| v.len()).unwrap_or(0);
            if rows_out.len() >= limit || size + bytes > RESULT_BYTES {
                truncated = true;
                break;
            }
            size += bytes;
            rows_out.push(Value::Array(values));
        }
        let mut out = json!({ "columns": columns, "rows": rows_out });
        if truncated {
            out["truncated"] = json!(true);
        }
        Ok(out)
    })();
    if created && result.is_err() {
        let _ = std::fs::remove_file(path);
    }
    result
}

/// two at a time, 64 waiting at most; each stopped at its deadline or when its page goes
pub struct SQLite {
    slots: Semaphore,
    waiting: AtomicUsize,
    timeout: Duration,
}

impl Default for SQLite {
    fn default() -> Self {
        SQLite { slots: Semaphore::new(2), waiting: AtomicUsize::new(0), timeout: TIMEOUT }
    }
}

struct Interrupter(Arc<std::sync::Mutex<Option<rusqlite::InterruptHandle>>>);

impl Drop for Interrupter {
    fn drop(&mut self) {
        if let Some(h) = self.0.lock().unwrap().as_ref() {
            h.interrupt();
        }
    }
}

impl SQLite {
    pub async fn run(&self, p: Request) -> Res<Value> {
        validate(&p)?;
        if self.waiting.fetch_add(1, Ordering::AcqRel) >= 64 {
            self.waiting.fetch_sub(1, Ordering::AcqRel);
            return Err(Fail::new("SQLite host is busy", 503));
        }
        let permit = self.slots.acquire().await;
        self.waiting.fetch_sub(1, Ordering::AcqRel);
        let _permit = permit.map_err(|_| Fail::new("SQLite host stopped", 503))?;
        let handle = Arc::new(std::sync::Mutex::new(None));
        // a dropped request (its page gone) or the deadline stops the statement
        let interrupter = Interrupter(handle.clone());
        let job = tokio::task::spawn_blocking(move || run_sync(&p, |h| *handle.lock().unwrap() = Some(h)));
        // a finished statement's handle is inert: its connection is closed
        let out = match tokio::time::timeout(self.timeout, job).await {
            Ok(r) => r?,
            Err(_) => Err(Fail::new("SQLite query timed out", 504)),
        };
        drop(interrupter);
        out
    }
}

/// the mesh host helper: one request on stdin, its answer (or error) on stdout
pub fn helper_main() -> i32 {
    let mut input = Vec::new();
    use std::io::Read;
    if std::io::stdin().take((1 << 20) + 4096).read_to_end(&mut input).is_err() {
        eprintln!("invalid SQLite request");
        return 2;
    }
    let Ok(p) = serde_json::from_slice::<Request>(&input) else {
        eprintln!("invalid SQLite request");
        return 2;
    };
    let out = match run_sync(&p, |h| {
        std::thread::spawn(move || {
            std::thread::sleep(TIMEOUT);
            h.interrupt();
        });
    }) {
        Ok(v) => v,
        Err(e) => json!({ "columns": [], "rows": [], "error": e.message }),
    };
    println!("{out}");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn batches_are_atomic_triggers_work_and_authorization_holds() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.db").to_string_lossy().into_owned();
        let db = SQLite::default();
        let req = |op: &str, sql: &str, limit: Option<f64>| Request { path: file.clone(), op: op.into(), sql: sql.into(), limit };
        db.run(req("create", "", None)).await.unwrap();
        assert!(db.run(req("create", "", None)).await.is_err());
        db.run(req(
            "execute",
            "CREATE TABLE t(n); CREATE TABLE log(n); CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES(new.n); INSERT INTO log VALUES(new.n+1); END; INSERT INTO t VALUES(1);",
            None,
        ))
        .await
        .unwrap();
        assert_eq!(db.run(req("query", "SELECT n,n as n FROM log", None)).await.unwrap()["rows"], json!([[1, 1], [2, 2]]));
        assert!(db.run(req("execute", "INSERT INTO t VALUES(9); INSERT INTO missing VALUES(1)", None)).await.is_err());
        assert_eq!(db.run(req("query", "SELECT count(*) FROM t", None)).await.unwrap()["rows"], json!([[1]]));
        assert!(db.run(req("execute", "INSERT INTO t VALUES(8); COMMIT; INSERT INTO t VALUES(9)", None)).await.is_err());
        assert_eq!(db.run(req("query", "SELECT count(*) FROM t", None)).await.unwrap()["rows"], json!([[1]]));
        assert!(db.run(req("execute", "ATTACH DATABASE ':memory:' AS other", None)).await.is_err());
        assert!(db.run(req("query", "SELECT load_extension('bad')", None)).await.is_err());
        assert!(db.run(req("query", "INSERT INTO t VALUES(5)", None)).await.is_err());
        assert_eq!(
            db.run(req("query", "SELECT 1 AS \"attach\", 'load_extension' AS text", None)).await.unwrap()["rows"],
            json!([[1, "load_extension"]])
        );
        let r = db.run(req("query", "WITH RECURSIVE r(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM r) SELECT x FROM r", Some(3.0))).await.unwrap();
        assert_eq!(r["rows"], json!([[1], [2], [3]]));
        assert_eq!(r["truncated"], true);
        assert_eq!(
            db.run(req("query", "SELECT 9223372036854775807, x'0102'", None)).await.unwrap()["rows"],
            json!([["9223372036854775807", "BLOB (2 bytes): 0102"]])
        );
        assert_eq!(db.run(req("schema", "", None)).await.unwrap()["rows"].as_array().unwrap().len(), 2);
        assert!(db.run(req("query", "SELECT zeroblob(100000000)", None)).await.is_err());
    }

    #[tokio::test]
    async fn deadlines_stop_work_inside_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("d.db").to_string_lossy().into_owned();
        let mut db = SQLite::default();
        db.run(Request { path: file.clone(), op: "create".into(), ..Default::default() }).await.unwrap();
        db.timeout = Duration::from_millis(100);
        let started = std::time::Instant::now();
        let e = db
            .run(Request {
                path: file.clone(),
                op: "query".into(),
                sql: "WITH RECURSIVE r(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM r) SELECT sum(x) FROM r".into(),
                limit: None,
            })
            .await
            .unwrap_err();
        assert!(e.message.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
        db.timeout = TIMEOUT;
        assert_eq!(
            db.run(Request { path: file, op: "query".into(), sql: "SELECT 7".into(), limit: None }).await.unwrap()["rows"],
            json!([[7]])
        );
    }
}

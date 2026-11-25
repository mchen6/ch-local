//! For tests: a private file of the home (the run directory's files, and
//! shim.json), written as ch-local's lib/private-write.js writes one: never
//! there half written, or with another mode.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

static N: AtomicU64 = AtomicU64::new(0);

/// `body` at `path`, 0600: through a temporary file created so, renamed in
/// place. A shim under test may be reading `path` all the while.
pub fn private(path: &Path, body: &[u8]) {
    let name = path.file_name().unwrap().to_string_lossy();
    let n = N.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_file_name(format!(".{name}.{}.{n}.tmp", std::process::id()));
    let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp).unwrap();
    f.set_permissions(fs::Permissions::from_mode(0o600)).unwrap();
    f.write_all(body).unwrap();
    drop(f);
    fs::rename(&temp, path).unwrap();
}

#[test]
fn a_file_being_written_is_whole_and_0600_at_every_look() {
    use std::io::Read;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};
    // (whatever the test does: the reader ends, the directory goes)
    struct End<'a>(&'a AtomicBool, std::path::PathBuf);
    impl Drop for End<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
            let _ = fs::remove_dir_all(&self.1);
        }
    }
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let dir = std::env::temp_dir()
        .join(format!("ch-shim-files-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
    fs::create_dir(&dir).unwrap();
    let path = dir.join("daemon.json");
    let body = vec![b'x'; 4096];
    let stop = AtomicBool::new(false);
    let looks = AtomicU64::new(0);
    // (replaced: a file that is there is never missing)
    let there = AtomicBool::new(false);
    thread::scope(|s| {
        let end = End(&stop, dir.clone());
        let reader = s.spawn(|| {
            let mut bad = None;
            while !stop.load(Ordering::SeqCst) {
                let replaced = there.load(Ordering::SeqCst);
                let Ok(mut f) = fs::File::open(&path) else {
                    if replaced && there.load(Ordering::SeqCst) {
                        bad.get_or_insert("missing while it was replaced".to_string());
                    }
                    continue;
                };
                // (looked at on the open descriptor, as the shim does)
                let mode = f.metadata().unwrap().permissions().mode() & 0o7777;
                let mut got = Vec::new();
                f.read_to_end(&mut got).unwrap();
                if mode != 0o600 || got != body {
                    bad.get_or_insert(format!("{} bytes, mode {mode:o}", got.len()));
                }
                looks.fetch_add(1, Ordering::SeqCst);
            }
            bad
        });
        private(&path, &body);
        let until = Instant::now() + Duration::from_secs(30);
        while looks.load(Ordering::SeqCst) == 0 && Instant::now() < until {
            thread::sleep(Duration::from_millis(1));
        }
        let before = looks.load(Ordering::SeqCst);
        assert!(before > 0, "it was looked at");
        for _ in 0..1000 {
            fs::remove_file(&path).unwrap();
            private(&path, &body);
        }
        there.store(true, Ordering::SeqCst);
        for _ in 0..1000 {
            private(&path, &body);
        }
        // (the looks made while it was written)
        let during = looks.load(Ordering::SeqCst) - before;
        there.store(false, Ordering::SeqCst);
        stop.store(true, Ordering::SeqCst);
        let bad = reader.join().unwrap();
        let left = fs::read_dir(&dir).unwrap().count();
        drop(end);
        assert!(during > 0, "it was looked at while it was written");
        assert!(bad.is_none(), "{bad:?}, {during} looks");
        assert_eq!(left, 1, "no temporary file left");
    });
}

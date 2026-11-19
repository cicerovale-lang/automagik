/// Disposable issue-932 verification: run the candidate installed by install.sh against both
/// reread paths, using the same synthetic Antigravity builders as the focused regression cases.
#[test]
fn verify_932_installed_sync_rereads() {
    use std::time::{Duration, SystemTime};

    let bin = std::env::var_os("VERIFY_932_INSTALLED_BIN")
        .expect("the workflow must install the candidate and set VERIFY_932_INSTALLED_BIN");
    let bin = Path::new(&bin);
    assert!(bin.is_file(), "installed candidate missing: {}", bin.display());

    let run = |env: &Env, expected_events: i64| {
        let mut command = std::process::Command::new(bin);
        command
            .env_clear()
            .env("HOME", env.home())
            .env("METER_STATE_DIR", env.state())
            .env("METER_HC", env.dir.path().join("no-hc"))
            .current_dir(env.dir.path())
            .args(["sync", "--force", "--no-publish", "--days", "3650"]);
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        let output = command.output().unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(
            output.status.success(),
            "installed sync failed: {stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout.contains(&format!("{expected_events} new usage events")),
            "candidate CLI reported unexpected events: {stdout}"
        );
        assert!(
            stdout.contains("not published (--no-publish)"),
            "candidate CLI did not confirm publishing disabled: {stdout}"
        );
        println!("{stdout}");
    };
    let old = SystemTime::UNIX_EPOCH + Duration::from_millis(at("2026-01-15T09:00:00Z") as u64);

    // A changed cursor rereads the same counted call after an earlier step arrives.
    let env = Env::new();
    let path = env.agy("conv-verify-932-cursor.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &opus_gen(&usage(500, 0, 0, 100, 0), &[2, 3, 9]));
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    run(&env, 1);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    let c = Connection::open(&path).unwrap();
    c.execute(
        "INSERT INTO steps(idx, step_type, status, metadata) VALUES(9, 15, 3, ?1)",
        [step_metadata(at("2026-01-15T10:01:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    run(&env, 0);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    let c = Connection::open(&path).unwrap();
    for (idx, time) in [
        (2, "2026-01-15T11:00:00Z"),
        (3, "2026-01-15T11:01:00Z"),
        (9, "2026-01-15T11:02:00Z"),
    ] {
        c.execute(
            "UPDATE steps SET metadata = ?1 WHERE idx = ?2",
            params![step_metadata(at(time) / 1000), idx],
        )
        .unwrap();
    }
    drop(c);
    put_gen(&path, 0, &opus_gen(&usage(900, 0, 0, 100, 0), &[2, 3, 9]));
    run(&env, 1);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 1_600);

    // A refused earlier row keeps the cursor behind a counted row on every sync.
    let env = Env::new();
    let path = env.agy("conv-verify-932-held.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &[0xff]);
    put_gen(&path, 1, &opus_gen(&usage(500, 0, 0, 100, 0), &[2, 3, 9]));
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    run(&env, 1);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    let c = Connection::open(&path).unwrap();
    c.execute(
        "INSERT INTO steps(idx, step_type, status, metadata) VALUES(9, 15, 3, ?1)",
        [step_metadata(at("2026-01-15T10:01:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    run(&env, 0);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
}

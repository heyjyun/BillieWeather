//! One-time preparation of the Apple Vision text models.
//!
//! The first recognition under an app identity makes macOS compile the models for the Neural
//! Engine: tens of seconds (34-54 s measured), then cached per bundle identifier and OS build, so
//! it is expected after a first install or a system update, not after an ordinary app update.
//! Stopping a worker in the middle throws that work away, and workers that start together queue
//! behind each other. So one worker prepares the models under its own finite limit, and requests
//! wait for it within their normal deadline without ever stopping it.
use std::{
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

pub const PREPARE_LIMIT: Duration = Duration::from_secs(180);
/// A failed preparation is tried again once, by a later request, and then never in this run.
const MAX_ATTEMPTS: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Running,
    Ready,
    Failed,
}

#[derive(Clone)]
pub struct Preparation {
    state: Arc<Mutex<State>>,
    limit: Duration,
}

struct State {
    phase: Option<watch::Receiver<Phase>>,
    attempts: u32,
}

impl Default for Preparation {
    fn default() -> Self {
        Self::with_limit(PREPARE_LIMIT)
    }
}

impl Preparation {
    pub fn with_limit(limit: Duration) -> Self {
        Self { state: Arc::new(Mutex::new(State { phase: None, attempts: 0 })), limit }
    }

    /// Starts the preparation, or joins the one that already runs or finished.
    pub fn ensure(&self, command: impl FnOnce() -> Option<Command>) -> watch::Receiver<Phase> {
        let mut state = self.state.lock().unwrap();
        if let Some(phase) = &state.phase {
            if *phase.borrow() != Phase::Failed || state.attempts >= MAX_ATTEMPTS {
                return phase.clone();
            }
        }
        state.attempts += 1;
        let (send, receive) = watch::channel(Phase::Running);
        state.phase = Some(receive.clone());
        let command = command();
        let limit = self.limit;
        tauri::async_runtime::spawn(async move {
            let ready = match command {
                Some(command) => run(command, limit).await,
                None => false,
            };
            let _ = send.send(if ready { Phase::Ready } else { Phase::Failed });
        });
        receive
    }
}

async fn run(mut command: Command, limit: Duration) -> bool {
    // stdin stays open for as long as this process lives: the worker stops when it closes.
    let Ok(mut child) = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return false;
    };
    let _open = child.stdin.take();
    match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => status.is_ok_and(|status| status.success()),
        Err(_) => {
            // kill() waits for the child to exit.
            let _ = child.kill().await;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Option<Command> {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        Some(command)
    }

    async fn settled(mut phase: watch::Receiver<Phase>) -> Phase {
        tokio::time::timeout(Duration::from_secs(5), phase.wait_for(|phase| *phase != Phase::Running))
            .await
            .expect("preparation never settled")
            .map(|phase| *phase)
            .unwrap()
    }

    #[test]
    fn many_requests_share_one_preparation() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join(format!("bw-prepare-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let script = format!("mktemp {}/run.XXXXXX; sleep 0.2", dir.display());
            let preparation = Preparation::default();
            let waits: Vec<_> = (0..5).map(|_| preparation.ensure(|| shell(&script))).collect();
            for wait in waits {
                assert_eq!(settled(wait).await, Phase::Ready);
            }
            assert_eq!(settled(preparation.ensure(|| shell(&script))).await, Phase::Ready);
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
            std::fs::remove_dir_all(&dir).unwrap();
        });
    }

    #[test]
    fn crashes_and_hangs_end_and_are_retried_once() {
        tauri::async_runtime::block_on(async {
            let crash = Preparation::default();
            assert_eq!(settled(crash.ensure(|| shell("kill -9 $$"))).await, Phase::Failed);
            assert_eq!(settled(crash.ensure(|| None)).await, Phase::Failed);
            // Two attempts were used: no third worker, even if it would succeed.
            assert_eq!(settled(crash.ensure(|| shell("exit 0"))).await, Phase::Failed);

            let recovers = Preparation::default();
            assert_eq!(settled(recovers.ensure(|| shell("exit 1"))).await, Phase::Failed);
            assert_eq!(settled(recovers.ensure(|| shell("exit 0"))).await, Phase::Ready);

            let marker = std::env::temp_dir().join(format!("bw-prepare-pid-{}", std::process::id()));
            let hang = Preparation::with_limit(Duration::from_millis(300));
            let script = format!("echo $$ > {}; exec sleep 30", marker.display());
            assert_eq!(settled(hang.ensure(|| shell(&script))).await, Phase::Failed);
            let pid = std::fs::read_to_string(&marker).unwrap();
            let alive = std::process::Command::new("/bin/kill").args(["-0", pid.trim()]).stderr(Stdio::null()).status().unwrap();
            assert!(!alive.success(), "the stuck preparation worker is still running");
            std::fs::remove_file(marker).unwrap();
        });
    }
}

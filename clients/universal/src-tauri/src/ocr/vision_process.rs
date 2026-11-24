use super::{recognize, MAX_IMAGE_BYTES};
use serde_json::Value;
use std::{
    collections::VecDeque,
    io::{self, Read},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::oneshot,
};

const DEADLINE: Duration = Duration::from_secs(18);
const MAX_RESULT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Default)]
pub struct VisionJobs(Mutex<Jobs>);

#[derive(Default)]
struct Jobs {
    active: Option<(String, Option<oneshot::Sender<()>>)>,
    cancelled: VecDeque<String>,
}

struct ActiveJob<'a>(&'a VisionJobs);

impl Drop for ActiveJob<'_> {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().active = None;
    }
}

fn valid_job(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

impl VisionJobs {
    pub fn cancel(&self, id: &str) {
        if !valid_job(id) {
            return;
        }
        let mut jobs = self.0.lock().unwrap();
        if let Some((_, sender)) = jobs.active.as_mut().filter(|(active, _)| active == id) {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
        } else if !jobs.cancelled.iter().any(|cancelled| cancelled == id) {
            // Cancellation IPC may arrive before recognition is dispatched.
            if jobs.cancelled.len() == 16 {
                jobs.cancelled.pop_front();
            }
            jobs.cancelled.push_back(id.to_owned());
        }
    }

    fn start(&self, id: &str) -> Result<(ActiveJob<'_>, oneshot::Receiver<()>), &'static str> {
        if !valid_job(id) {
            return Err("recognition_failed");
        }
        let mut jobs = self.0.lock().unwrap();
        if let Some(index) = jobs.cancelled.iter().position(|cancelled| cancelled == id) {
            jobs.cancelled.remove(index);
            return Err("cancelled");
        }
        if jobs.active.is_some() {
            return Err("recognition_failed");
        }
        let (send, receive) = oneshot::channel();
        jobs.active = Some((id.to_owned(), Some(send)));
        Ok((ActiveJob(self), receive))
    }

    pub async fn recognize(
        &self,
        id: &str,
        bytes: &[u8],
        languages: &str,
        page: i32,
    ) -> Result<Value, String> {
        let (_active, cancelled) = self.start(id)?;
        let executable = std::env::current_exe().map_err(|_| "recognition_failed")?;
        let mut child = Command::new(executable)
            .arg("--billie-vision-worker")
            .arg(languages)
            .arg(page.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "recognition_failed")?;
        let result = supervise(&mut child, bytes, cancelled, DEADLINE).await?;
        serde_json::from_slice(&result).map_err(|_| "recognition_failed".into())
    }
}

async fn supervise(
    child: &mut Child,
    bytes: &[u8],
    mut cancelled: oneshot::Receiver<()>,
    deadline: Duration,
) -> Result<Vec<u8>, &'static str> {
    let result = tokio::select! {
        biased;
        _ = &mut cancelled => Err("cancelled"),
        response = tokio::time::timeout(deadline, exchange(child, bytes)) => match response {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err("recognition_failed"),
            Err(_) => Err("ocr_timeout"),
        },
    };
    if result.is_err() {
        // kill() waits for the child to exit. The fallback kill-on-drop also covers shutdown.
        let _ = child.kill().await;
    }
    result
}

async fn exchange(child: &mut Child, bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut stdin = child.stdin.take().expect("worker stdin is piped");
    let mut stdout = child
        .stdout
        .take()
        .expect("worker stdout is piped")
        .take(MAX_RESULT_BYTES + 1);
    let send = async {
        stdin.write_all(bytes).await?;
        drop(stdin);
        Ok(())
    };
    let read = async {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).await?;
        if output.len() as u64 > MAX_RESULT_BYTES {
            return Err(io::Error::other("OCR output too large"));
        }
        Ok(output)
    };
    let ((), output, status) = tokio::try_join!(send, read, child.wait())?;
    if status.success() {
        Ok(output)
    } else {
        Err(io::Error::other("OCR worker failed"))
    }
}

/// Worker entry point of the same signed app. No window, keychain or database is opened.
pub fn run_worker() -> Result<(), String> {
    let mut args = std::env::args().skip(2);
    let languages = args.next().ok_or("recognition_failed")?;
    let page = args
        .next()
        .and_then(|arg| arg.parse().ok())
        .ok_or("recognition_failed")?;
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "recognition_failed")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("too_large".into());
    }
    let value = recognize(&bytes, &languages, page)?;
    serde_json::to_writer(io::stdout().lock(), &value).map_err(|_| "recognition_failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: &str = "22222222-2222-2222-2222-222222222222";
    const SECOND: &str = "33333333-3333-3333-3333-333333333333";

    #[test]
    fn cancellation_handles_ipc_ordering_and_only_one_job_runs() {
        let jobs = VisionJobs::default();
        jobs.cancel(FIRST);
        assert!(matches!(jobs.start(FIRST), Err("cancelled")));
        let (active, mut cancelled) = jobs.start(FIRST).unwrap();
        assert!(matches!(jobs.start(SECOND), Err("recognition_failed")));
        jobs.cancel(FIRST);
        assert_eq!(cancelled.try_recv(), Ok(()));
        drop(active);
        assert!(jobs.start(SECOND).is_ok());
    }

    #[test]
    fn cancellation_and_timeout_reap_the_worker() {
        tauri::async_runtime::block_on(async {
            for cancel in [true, false] {
                let mut child = Command::new("/bin/sleep")
                    .arg("30")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap();
                let (send, receive) = oneshot::channel();
                if cancel {
                    send.send(()).unwrap();
                }
                let result = supervise(&mut child, b"", receive, Duration::from_millis(100)).await;
                assert_eq!(
                    result,
                    Err(if cancel { "cancelled" } else { "ocr_timeout" })
                );
                assert!(child.try_wait().unwrap().is_some(), "worker was not reaped");
            }
        });
    }
}

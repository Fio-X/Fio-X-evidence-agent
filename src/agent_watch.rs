//! The run-time limits of the Rust agent loop (1011af step 5): the five NEWSROOM_RPC_* waits keep their names, defaults and meaning from
//! the old runner (pi.rs), read under the old names; renaming them is a later step. `Watchdog` is the state machine, fed the loop's events
//! and the elapsed time, so its decisions can be tested without waiting; `watched_prompt` runs one prompt under it, aborts the loop when a
//! limit runs out (the abort sequence of agent-spec 8 closes the run) and reports which limit it was.

use crate::agent_loop::Agent;
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub struct Timeouts {
    /// Until the run is accepted (the loop's first event).
    pub startup: Duration,
    /// Silence while no turn is active (between turns); a turn, a tool call or a retry wait counts as active work.
    pub idle: Duration,
    /// From `agent_settled` until the closing queries are answered.
    pub finish: Duration,
    /// The whole run; zero switches only this one off.
    pub total: Duration,
    /// How often the phase line is reported.
    pub heartbeat: Duration,
}

fn wait(name: &str, raw: Option<String>, default: u64, allow_zero: bool) -> Result<Duration> {
    let value = match raw {
        Some(raw) => raw
            .parse::<u64>()
            .with_context(|| format!("invalid {name}"))?,
        None => default,
    };
    if (!allow_zero && value == 0) || value > 604_800_000 {
        bail!(
            "{name} must be within {}..=604800000 milliseconds",
            if allow_zero { 0 } else { 1 }
        );
    }
    Ok(Duration::from_millis(value))
}

impl Timeouts {
    /// Reads the five limits through `get` (the environment in the product, a table in tests); only the names and rules are checked.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        Ok(Self {
            startup: wait(
                "NEWSROOM_RPC_STARTUP_MS",
                get("NEWSROOM_RPC_STARTUP_MS"),
                60_000,
                false,
            )?,
            idle: wait(
                "NEWSROOM_RPC_IDLE_MS",
                get("NEWSROOM_RPC_IDLE_MS"),
                300_000,
                false,
            )?,
            finish: wait(
                "NEWSROOM_RPC_FINISH_MS",
                get("NEWSROOM_RPC_FINISH_MS"),
                30_000,
                false,
            )?,
            total: wait(
                "NEWSROOM_RPC_TOTAL_MS",
                get("NEWSROOM_RPC_TOTAL_MS"),
                86_400_000,
                true,
            )?,
            heartbeat: wait(
                "NEWSROOM_RPC_HEARTBEAT_MS",
                get("NEWSROOM_RPC_HEARTBEAT_MS"),
                5_000,
                false,
            )?,
        })
    }

    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
}

#[derive(Debug)]
pub struct Watchdog {
    limits: Timeouts,
    accepted: bool,
    active: bool,
    last_activity: Duration,
    finish_started: Option<Duration>,
}

impl Watchdog {
    pub fn new(limits: Timeouts) -> Self {
        Self {
            limits,
            accepted: false,
            active: false,
            last_activity: Duration::ZERO,
            finish_started: None,
        }
    }

    /// One event of the loop, `at` into the run.
    pub fn observe(&mut self, kind: &str, at: Duration) {
        self.last_activity = at;
        match kind {
            "agent_start" => {
                self.accepted = true;
                self.active = true;
            }
            "turn_start"
            | "message_start"
            | "message_update"
            | "auto_retry_start"
            | "tool_execution_start"
            | "tool_execution_update" => self.active = true,
            // The idle boundary is back between turns; tool and thinking events keep it off for a whole turn.
            "turn_end" => self.active = false,
            "agent_settled" => {
                self.finish_started.get_or_insert(at);
            }
            _ => {}
        }
    }

    pub fn phase(&self) -> &'static str {
        if self.finish_started.is_some() {
            "finishing"
        } else if !self.accepted {
            "startup"
        } else if self.active {
            "active-work"
        } else {
            "rpc-wait"
        }
    }

    /// The limit that has run out at `at`, if any, in the old runner's order of precedence.
    pub fn expired(&self, at: Duration) -> Option<&'static str> {
        let limits = &self.limits;
        if !limits.total.is_zero() && at >= limits.total {
            Some("total")
        } else if !self.accepted && at >= limits.startup {
            Some("startup")
        } else if self.finish_started.is_some_and(|t| at - t >= limits.finish) {
            Some("finishing")
        } else if self.accepted
            && !self.active
            && self.finish_started.is_none()
            && at - self.last_activity >= limits.idle
        {
            Some("idle")
        } else {
            None
        }
    }
}

/// Runs one prompt under the limits. Every event still goes to `sink`; `beat(phase, elapsed_ms)` is called each heartbeat. When a limit runs
/// out, or Ctrl-C arrives, the loop is aborted and closes the run in the usual order; the error names the limit.
pub async fn watched_prompt(
    agent: &mut Agent,
    message: &str,
    sink: &mut (dyn FnMut(Value) + Send),
    limits: &Timeouts,
    beat: &mut (dyn FnMut(&str, u128) + Send),
) -> Result<(), String> {
    let started = Instant::now();
    let dog = Arc::new(Mutex::new(Watchdog::new(limits.clone())));
    let cancel = agent.cancel.clone();
    let seen = dog.clone();
    let mut forward = move |event: Value| {
        seen.lock()
            .unwrap()
            .observe(event["type"].as_str().unwrap_or(""), started.elapsed());
        sink(event);
    };
    let mut stopped: Option<String> = None;
    {
        let run = agent.prompt(message, &mut forward);
        tokio::pin!(run);
        let mut ticks = tokio::time::interval(limits.heartbeat.min(Duration::from_millis(100)));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut next_beat = limits.heartbeat;
        loop {
            tokio::select! {
                () = &mut run => break,
                _ = tokio::signal::ctrl_c(), if stopped.is_none() => {
                    stopped = Some("agent run cancelled by user".into());
                    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                _ = ticks.tick() => {
                    let at = started.elapsed();
                    let (phase, expired) = {
                        let dog = dog.lock().unwrap();
                        (dog.phase(), dog.expired(at))
                    };
                    if at >= next_beat {
                        beat(phase, at.as_millis());
                        next_beat = at + limits.heartbeat;
                    }
                    if let (Some(which), None) = (expired, &stopped) {
                        stopped = Some(format!("agent run {which} timeout"));
                        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            }
        }
    }
    if stopped.is_none() {
        stopped = agent
            .session_error()
            .map(|e| format!("agent run stopped: session record could not be written: {e}"));
    }
    stopped.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn limits() -> Timeouts {
        Timeouts {
            startup: ms(1000),
            idle: ms(500),
            finish: ms(300),
            total: ms(10_000),
            heartbeat: ms(100),
        }
    }

    #[test]
    fn the_five_old_names_are_read_and_nothing_else() {
        let table: BTreeMap<&str, &str> = BTreeMap::from([
            ("NEWSROOM_RPC_STARTUP_MS", "11"),
            ("NEWSROOM_RPC_IDLE_MS", "22"),
            ("NEWSROOM_RPC_FINISH_MS", "33"),
            ("NEWSROOM_RPC_TOTAL_MS", "44"),
            ("NEWSROOM_RPC_HEARTBEAT_MS", "55"),
        ]);
        let asked = Mutex::new(Vec::new());
        let got = Timeouts::from_lookup(|name| {
            asked.lock().unwrap().push(name.to_string());
            table.get(name).map(|v| v.to_string())
        })
        .unwrap();
        assert_eq!(
            (got.startup, got.idle, got.finish, got.total, got.heartbeat),
            (ms(11), ms(22), ms(33), ms(44), ms(55))
        );
        let mut names = asked.into_inner().unwrap();
        names.sort();
        assert_eq!(
            names,
            [
                "NEWSROOM_RPC_FINISH_MS",
                "NEWSROOM_RPC_HEARTBEAT_MS",
                "NEWSROOM_RPC_IDLE_MS",
                "NEWSROOM_RPC_STARTUP_MS",
                "NEWSROOM_RPC_TOTAL_MS"
            ]
        );
    }

    #[test]
    fn the_environment_reader_exists_and_reads_the_same_names() {
        // Only that it runs; the values in this process's environment are neither checked nor shown.
        let _ = Timeouts::from_env().is_ok();
    }

    #[test]
    fn defaults_and_bounds_match_the_old_runner() {
        let d = Timeouts::from_lookup(|_| None).unwrap();
        assert_eq!(
            (d.startup, d.idle, d.finish, d.total, d.heartbeat),
            (
                ms(60_000),
                ms(300_000),
                ms(30_000),
                ms(86_400_000),
                ms(5_000)
            )
        );
        let with = |name: &'static str, value: &'static str| {
            Timeouts::from_lookup(move |n| (n == name).then(|| value.to_string()))
        };
        assert!(with("NEWSROOM_RPC_TOTAL_MS", "0").unwrap().total.is_zero());
        for name in [
            "NEWSROOM_RPC_STARTUP_MS",
            "NEWSROOM_RPC_IDLE_MS",
            "NEWSROOM_RPC_FINISH_MS",
            "NEWSROOM_RPC_HEARTBEAT_MS",
        ] {
            assert!(with(name, "0").is_err(), "{name} may not be zero");
        }
        for name in ["NEWSROOM_RPC_IDLE_MS", "NEWSROOM_RPC_TOTAL_MS"] {
            assert!(with(name, "604800001").is_err());
            assert!(with(name, "soon").is_err());
            assert!(with(name, "604800000").is_ok());
        }
    }

    #[test]
    fn startup_runs_out_only_before_the_run_is_accepted() {
        let mut dog = Watchdog::new(limits());
        assert_eq!(dog.phase(), "startup");
        assert_eq!(dog.expired(ms(999)), None);
        assert_eq!(dog.expired(ms(1000)), Some("startup"));
        dog.observe("agent_start", ms(10));
        assert_eq!(
            dog.expired(ms(1500)),
            None,
            "accepted: startup no longer applies"
        );
    }

    #[test]
    fn idle_runs_out_between_turns_but_not_during_a_turn_or_a_tool() {
        let mut dog = Watchdog::new(limits());
        dog.observe("agent_start", ms(0));
        dog.observe("turn_start", ms(1));
        assert_eq!(dog.phase(), "active-work");
        assert_eq!(
            dog.expired(ms(5000)),
            None,
            "a turn in progress is active work"
        );
        dog.observe("tool_execution_start", ms(2));
        dog.observe("turn_end", ms(100));
        assert_eq!(dog.phase(), "rpc-wait");
        assert_eq!(dog.expired(ms(599)), None);
        assert_eq!(dog.expired(ms(600)), Some("idle"));
        dog.observe("turn_start", ms(550));
        assert_eq!(
            dog.expired(ms(5000)),
            None,
            "new activity resets and re-enters active work"
        );
    }

    #[test]
    fn finishing_total_and_the_zero_total_follow_the_old_order() {
        let mut dog = Watchdog::new(limits());
        dog.observe("agent_start", ms(0));
        dog.observe("turn_end", ms(10));
        dog.observe("agent_settled", ms(20));
        assert_eq!(dog.phase(), "finishing");
        assert_eq!(
            dog.expired(ms(319)),
            None,
            "idle does not apply while finishing"
        );
        assert_eq!(dog.expired(ms(320)), Some("finishing"));
        assert_eq!(
            dog.expired(ms(10_000)),
            Some("total"),
            "total is checked first"
        );
        let mut off = limits();
        off.total = Duration::ZERO;
        let mut dog = Watchdog::new(off);
        dog.observe("agent_start", ms(0));
        dog.observe("turn_start", ms(1));
        assert_eq!(dog.expired(Duration::from_secs(1_000_000)), None);
    }
}

"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Download,
  Film,
  Leaf,
  LockKeyhole,
  Mail,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  Video,
  Wifi,
  X,
} from "lucide-react";

type Stage = "idle" | "recording" | "processing" | "ready";
const courts = [
  {
    id: 1,
    name: "Court 01",
    location: "Garden side",
    status: "Available",
    available: true,
  },
  {
    id: 2,
    name: "Court 02",
    location: "Clubhouse side",
    status: "Available",
    available: true,
  },
  {
    id: 3,
    name: "Court 03",
    location: "Bougainvillea side",
    status: "In use",
    available: false,
  },
];
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;

function CourtArt({ miniature = false }: { miniature?: boolean }) {
  return (
    <svg
      viewBox="0 0 640 440"
      fill="none"
      aria-hidden="true"
      className={miniature ? "court-art miniature" : "court-art"}
    >
      <defs>
        <pattern
          id={miniature ? "tiny-grain" : "grain"}
          width="8"
          height="8"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".55" fill="#fff" opacity=".13" />
        </pattern>
      </defs>
      <path d="M22 292 308 85 622 246 337 456Z" fill="#163e38" opacity=".18" />
      <path d="M20 267 304 61 622 226 337 438Z" fill="#a5b4a0" />
      <path
        d="M64 259 306 85 576 227 335 405Z"
        fill="#286f64"
        stroke="#f5e9cf"
        strokeWidth="3"
      />
      <path d="M170 183 439 327 472 304 202 160Z" fill="#58917d" />
      <path
        d="M64 259 306 85 576 227 335 405Z"
        fill={`url(#${miniature ? "tiny-grain" : "grain"})`}
      />
      <path
        d="m169 184 270 144M201 160l271 144M199 330l104-75m34-23 105-75"
        stroke="#f5e9cf"
        strokeWidth="2.5"
      />
      <path d="M178 152 488 314" stroke="#e9dcc4" strokeWidth="3" />
      <path d="M178 121v58m310 107v57" stroke="#173e39" strokeWidth="5" />
      <path
        d="M180 126 486 288v25L180 151Z"
        fill="#173c36"
        opacity=".8"
        stroke="#e2d6ba"
        strokeWidth="1.5"
      />
      {Array.from({ length: 26 }, (_, i) => (
        <path
          key={i}
          d={`M${184 + i * 11.5} ${128 + i * 6.1}v22`}
          stroke="#b0bc9b"
          strokeWidth=".6"
        />
      ))}
      <path d="m182 137 302 160" stroke="#b0bc9b" strokeWidth=".7" />
      <ellipse cx="345" cy="326" rx="17" ry="8" fill="#153d36" opacity=".2" />
      <circle cx="339" cy="309" r="12" fill="#e8ed8c" />
      <circle cx="335" cy="305" r="2" fill="#a4b35b" />
      <circle cx="344" cy="307" r="2" fill="#a4b35b" />
      <circle cx="339" cy="314" r="2" fill="#a4b35b" />
    </svg>
  );
}

export default function PlayerPreview({
  livePanel,
  accountControls,
}: {
  livePanel?: React.ReactNode;
  accountControls?: React.ReactNode;
}) {
  const [selected, setSelected] = useState(1);
  const [stage, setStage] = useState<Stage>("idle");
  const [seconds, setSeconds] = useState(0);
  const [sent, setSent] = useState(false);
  const [modal, setModal] = useState<"signin" | "help" | null>(null);
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const startedAt = useRef(0);
  const active = stage === "recording" || stage === "processing";

  useEffect(() => {
    if (stage !== "recording") return;
    const interval = setInterval(() => {
      const elapsed = Math.min(
        900,
        Math.floor((Date.now() - startedAt.current) / 1000),
      );
      setSeconds(elapsed);
      if (elapsed >= 900) setStage("processing");
    }, 250);
    return () => clearInterval(interval);
  }, [stage]);
  useEffect(() => {
    if (stage !== "processing") return;
    const timeout = setTimeout(() => setStage("ready"), 2200);
    return () => clearTimeout(timeout);
  }, [stage]);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);

  function start() {
    setSeconds(0);
    setSent(false);
    startedAt.current = Date.now();
    setStage("recording");
  }
  function reset() {
    setStage("idle");
    setSeconds(0);
    setSent(false);
  }

  return (
    <>
      {!livePanel && (
        <div className="preview-banner">
          <span className="preview-pill">DESIGN PREVIEW</span>
          <span>Take a look around. Courts and recording are simulated.</span>
          <span className="preview-right">
            No camera connected <span className="small-dot" />
          </span>
        </div>
      )}
      <header className="site-header shell">
        <a href="#" className="brand" aria-label="Dink Vision home">
          <img
            src="/dink-vision-logo.png"
            alt="DinkVision"
          />
        </a>
        <nav aria-label="Main navigation">
          <a className="nav-active" href="#record">
            Record a match
          </a>
          <a href="#how-it-works">How it works</a>
        </nav>
        {accountControls || (
          <button className="sign-in" onClick={() => setModal("signin")}>
            Sign in <ArrowRight size={16} />
          </button>
        )}
      </header>

      <main>
        <section className="hero shell">
          <div className="hero-copy">
            <div className="eyebrow">
              <span /> GOOD GAMES DESERVE A REPLAY
            </div>
            <h1>
              Your court.
              <br />
              Your <em>moment.</em>
            </h1>
            <p>
              The rallies. The close calls. That winning shot.
              <br className="desktop-break" /> Record your match and take a
              little of the court home.
            </p>
            <a className="primary hero-cta" href="#record">
              Let’s play it back <ArrowDown size={17} />
            </a>
            <div className="hero-note">
              <Video size={16} /> Court cameras do the recording. You do the
              playing.
            </div>
          </div>
          <div className="hero-visual">
            <div className="visual-top">
              <span>
                <span className="small-dot" /> THE Dink Vision EXPERIENCE
              </span>
              <Leaf size={22} strokeWidth={1.2} />
            </div>
            <div className="court-scene">
              <CourtArt />
              <div className="floating-tag">
                <Video size={17} />
                <span>
                  A fresh perspective
                  <small>Every rally, from your court.</small>
                </span>
              </div>
              <span className="scene-ring ring-one" />
              <span className="scene-ring ring-two" />
            </div>
            <div className="visual-bottom">
              <span>PLAY. RECORD. RELIVE.</span>
              <span>
                Made for your next good game <ArrowRight size={14} />
              </span>
            </div>
          </div>
        </section>

        <section className="record-section" id="record">
          <div className="shell">
            <div className="section-heading">
              <div>
                <div className="eyebrow">YOUR NEXT REPLAY STARTS HERE</div>
                <h2>Make this match a keeper.</h2>
              </div>
              <div className="step-label">
                <span>01</span> Choose your court <span className="step-line" />{" "}
                <span className="muted-step">02</span> Hit record
              </div>
            </div>
            {livePanel || (
              <div className="record-grid">
                <div className="court-selection">
                  <div className="subheading">
                    <h3>Find your court</h3>
                    <span>
                      3 sample courts <ChevronDown size={13} />
                    </span>
                  </div>
                  <div className="court-list">
                    {courts.map((court) => (
                      <button
                        key={court.id}
                        className={`court-card ${selected === court.id ? "selected" : ""} ${!court.available ? "unavailable" : ""}`}
                        disabled={!court.available || active}
                        onClick={() => {
                          setSelected(court.id);
                          reset();
                        }}
                        aria-pressed={selected === court.id}
                        aria-label={`${court.name}, ${court.location}, ${court.status}`}
                      >
                        <div className={`court-thumb court-thumb-${court.id}`}>
                          <CourtArt miniature />
                        </div>
                        <div className="court-info">
                          <div className="court-name-row">
                            <h4>{court.name}</h4>
                            <span
                              className={`availability ${court.available ? "available" : "busy"}`}
                            >
                              <span />
                              {court.status}
                            </span>
                          </div>
                          <p>{court.location}</p>
                          <div className="camera-label">
                            <Video size={13} />
                            {court.available
                              ? "Primary camera · Sample feed"
                              : "Another match is in progress"}
                          </div>
                        </div>
                        <span className="selection-circle">
                          {selected === court.id && <Check size={13} />}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="court-footnote">
                    <Wifi size={15} />
                    <p>
                      Pick the court you’re playing on. We’ll take care of the
                      angle.
                    </p>
                  </div>
                </div>

                <aside className="session-panel" aria-label="Your recording">
                  <div className="panel-heading">
                    <span className="eyebrow">YOUR RECORDING</span>
                    <span className="panel-icon">
                      <Video size={18} />
                    </span>
                  </div>
                  <div className="session-title">
                    <h3>{courts.find((c) => c.id === selected)?.name}</h3>
                    <span className="preview-chip">Preview</span>
                  </div>
                  <p className="panel-description">
                    A good game. Saved for later.
                  </p>
                  <div className="session-facts">
                    <div>
                      <Clock3 size={17} />
                      <span>Recording limit</span>
                      <strong>15 minutes</strong>
                    </div>
                    <div>
                      <ShieldCheck size={17} />
                      <span>Private access</span>
                      <strong>Just for you</strong>
                    </div>
                    <div>
                      <Film size={17} />
                      <span>Video available for</span>
                      <strong>24 hours*</strong>
                    </div>
                  </div>
                  <div className="recipient">
                    <Mail size={16} />
                    <div>
                      <span>Send your replay to</span>
                      <strong>you@example.com</strong>
                    </div>
                    <span className="sample-label">SAMPLE</span>
                  </div>
                  <div className="record-action" aria-live="polite">
                    {stage === "idle" ? (
                      <>
                        <button
                          className="primary record-button"
                          onClick={start}
                        >
                          <span className="record-dot" /> Try recording preview{" "}
                          <ArrowRight size={17} />
                        </button>
                        <p className="action-hint">
                          <LockKeyhole size={12} /> Sign in will be required for
                          a real recording.
                        </p>
                      </>
                    ) : stage === "recording" ? (
                      <>
                        <div className="timer">
                          <span>
                            <i /> Preview recording
                          </span>
                          <strong>{time(seconds)}</strong>
                        </div>
                        <button
                          className="stop-button"
                          onClick={() => setStage("processing")}
                        >
                          <Square size={14} fill="currentColor" /> Stop preview
                        </button>
                        <p className="action-hint">
                          {time(900 - seconds)} remaining · No footage is being
                          captured
                        </p>
                      </>
                    ) : stage === "processing" ? (
                      <div className="processing">
                        <span className="spinner" />
                        <strong>Preparing your replay…</strong>
                        <p>Simulating video processing and upload.</p>
                      </div>
                    ) : (
                      <div className="ready">
                        <div className="ready-title">
                          <Check size={18} /> Your preview is ready
                        </div>
                        <p>
                          {time(seconds)} · Court 0{selected} · Sample result
                        </p>
                        <button
                          className="primary record-button"
                          onClick={() => setSent(true)}
                        >
                          <Mail size={16} />
                          {sent
                            ? "Email preview complete"
                            : "Preview email delivery"}
                        </button>
                        <p className="action-hint">
                          {sent
                            ? "Simulation only. No email was sent."
                            : "A private Drive link will appear here when connected."}
                        </p>
                        <button className="text-button" onClick={reset}>
                          <RotateCcw size={13} /> Start another preview
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="retention-note">
                    *From successful upload. Your court camera records the
                    playing area. Downloaded copies remain yours.
                  </p>
                </aside>
              </div>
            )}
          </div>
        </section>

        <section className="how-section shell" id="how-it-works">
          <div className="how-intro">
            <div className="eyebrow">LESS SETUP. MORE PLAY.</div>
            <h2>
              Three steps.
              <br />
              <em>All your best shots.</em>
            </h2>
            <p>
              Stay in the game.
              <br />
              We’ll handle the memories.
            </p>
          </div>
          <div className="how-steps">
            {[
              {
                icon: Video,
                title: "Pick your court",
                copy: "Choose your court and get ready. The installed camera has the perfect view.",
              },
              {
                icon: Play,
                title: "Play your game",
                copy: "Start the recording, then focus on your match. Stop when you’re done.",
              },
              {
                icon: Download,
                title: "Keep the good stuff",
                copy: livePanel
                  ? "Your video is saved at the venue and uploaded when Drive is connected. Open your private link from recent recordings."
                  : "Get a private Google Drive link. Watch, download, and relive your game.",
              },
            ].map((step, i) => (
              <div className="how-step" key={step.title}>
                <div className="step-icon">
                  <step.icon size={22} strokeWidth={1.5} />
                  <span>0{i + 1}</span>
                </div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="closing shell">
          <Leaf size={29} strokeWidth={1.2} />
          <p>A little competition. A lot of good memories.</p>
          <span>SEE YOU ON THE COURT.</span>
        </section>
      </main>
      <footer className="shell">
        <span>
          © {new Date().getFullYear()} Dink Vision{" "}
          <span className="footer-divider">/</span> House of Rare Bougainvillea
        </span>
        <button onClick={() => setModal("help")}>
          <CircleHelp size={15} /> Need a hand?
        </button>
        <span className="footer-location">Made for the love of the game.</span>
      </footer>
      <dialog
        ref={dialog}
        onCancel={() => setModal(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setModal(null);
        }}
      >
        <div className="dialog-content">
          <button
            className="close-dialog"
            aria-label="Close dialog"
            onClick={() => {
              setModal(null);
              setNotice("");
            }}
          >
            <X size={21} />
          </button>
          <div className="eyebrow">
            Dink Vision · {livePanel ? "COURTSIDE HELP" : "INTERFACE PREVIEW"}
          </div>
          <h2>
            {modal === "signin"
              ? "Your next good game."
              : "A little help courtside."}
          </h2>
          {modal === "signin" ? (
            <>
              <p>
                This is a separate design preview. For your real account, use
                the player sign-in page.
              </p>
              <a className="primary" href="/login">
                Go to player sign-in
              </a>
              <button
                className="primary"
                onClick={() => {
                  setModal(null);
                  document
                    .getElementById("record")
                    ?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Explore the recording preview <ArrowRight size={17} />
              </button>
            </>
          ) : (
            <>
              <p>
                {livePanel
                  ? "Sign in with your venue-issued account to see the configured courts. Ask venue staff if you need access or help with your password."
                  : "Choose an available sample court and try the recording preview. Stop it to see processing and the sample delivery screen."}
              </p>
              <p>
                Camera capture, Drive links, and match email delivery are not
                connected yet. No video is being captured.
              </p>
              <button
                className="primary"
                onClick={() =>
                  setNotice(
                    "For venue assistance, please speak to the Dink Vision court staff.",
                  )
                }
              >
                Venue assistance <ArrowRight size={16} />
              </button>
              {notice && <p role="status">{notice}</p>}
            </>
          )}
        </div>
      </dialog>
    </>
  );
}

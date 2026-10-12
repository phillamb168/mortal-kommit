import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CombatEvent, Fighter, Match } from '../core/types.js';
import { eventDuration } from './choreography.js';
import { boutWinner } from '../core/ending.js';
import { accountUsage } from '../core/usage.js';
import { ArenaCanvas } from './renderer.js';
import { ArcadeAudio } from './audio.js';
import './style.css';

async function api(path: string, data?: unknown) {
  const r = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error);
  return body;
}
const fighterName = (a: Fighter) => (a === 'claude' ? 'CLAUDE' : 'CODEX');
function App() {
  const [match, setMatch] = useState<Match | null>(null),
    [matches, setMatches] = useState<any[]>([]),
    [error, setError] = useState(''),
    [entered, setEntered] = useState(false),
    [playing, setPlaying] = useState(true),
    [cursor, setCursor] = useState(-1),
    [speed, setSpeed] = useState(1),
    [drawer, setDrawer] = useState<'evidence' | 'findings' | 'conversation' | 'scope' | null>(null),
    [selected, setSelected] = useState<CombatEvent | null>(null),
    [muted, setMuted] = useState(false),
    [music, setMusic] = useState(0.32),
    [effects, setEffects] = useState(0.55),
    [audioOpen, setAudioOpen] = useState(false),
    [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches),
    [connected, setConnected] = useState(false);
  const audio = useRef(new ArcadeAudio()),
    stream = useRef<EventSource | null>(null),
    playingRef = useRef(playing);
  playingRef.current = playing;
  const refreshMatches = () =>
    api('/api/matches')
      .then(setMatches)
      .catch((e) => setError(e.message));
  const load = async (id: string) => {
    const m: Match = await api(`/api/matches/${encodeURIComponent(id)}`);
    setMatch(m);
    setCursor(m.demo || m.status === 'complete' ? -1 : m.events.length - 1);
    setSelected(null);
    const url = new URL(location.href);
    url.searchParams.set('match', id);
    history.replaceState(null, '', url.pathname + url.search);
    stream.current?.close();
    const source = (stream.current = new EventSource(
      `/api/events?match=${encodeURIComponent(id)}`,
    ));
    source.addEventListener('match', (e) => {
      setMatch(JSON.parse((e as MessageEvent).data));
      setConnected(true);
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
  };
  useEffect(() => {
    void (async () => {
      try {
        const token = new URLSearchParams(location.hash.slice(1)).get('session');
        if (token) {
          await api('/api/session', { token });
          history.replaceState(null, '', location.pathname + location.search);
        }
        const list = await api('/api/matches');
        setMatches(list);
        const id = new URLSearchParams(location.search).get('match') ?? list[0]?.id;
        if (id) await load(id);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      stream.current?.close();
      audio.current.close();
    };
  }, []);
  const [audioStatus, setAudioStatus] = useState({ state: 'not-started', rms: 0 });
  useEffect(() => {
    const timer = setInterval(() => {
      const d = audio.current.diagnostics();
      setAudioStatus({ state: d.state, rms: d.rms });
    }, 400);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement as HTMLElement;
    const dialog = document.querySelector<HTMLElement>('.drawer')!;
    dialog.querySelector<HTMLButtonElement>('button')?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const elements = [
        ...dialog.querySelectorAll<HTMLElement>('button,a,input,select,summary,[tabindex="0"]'),
      ].filter((el) => el.getClientRects().length);
      const first = elements[0],
        last = elements.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener('keydown', trap);
    return () => {
      dialog.removeEventListener('keydown', trap);
      previous?.focus();
    };
  }, [drawer]);
  const event = match?.events[cursor] ?? null;
  useEffect(() => {
    if (!entered || !playing || !match || cursor >= match.events.length - 1) return;
    const delay = eventDuration(event) / speed;
    const timer = setTimeout(() => setCursor((c) => c + 1), delay);
    return () => clearTimeout(timer);
  }, [entered, playing, cursor, match?.events.length, speed]);
  useEffect(() => {
    if (entered && event) {
      audio.current.intensity =
        Math.min(event.health.claude, event.health.codex) < 40
          ? 1
          : (Math.floor(event.seq / 8) % 2) * 0.4;
      if (event.type !== 'finish') audio.current.setTheme('battle');
    }
  }, [event?.id, entered]);
  const cue = (kind: string) => {
    if (kind === 'ending-draw' || kind === 'ending-victory') {
      audio.current.effect(kind);
      audio.current.setTheme(kind === 'ending-draw' ? 'draw' : 'victory');
    } else audio.current.effect(kind);
  };
  useEffect(() => {
    audio.current.muted = muted;
    audio.current.musicVolume = music;
    audio.current.effectsVolume = effects;
    audio.current.volumes();
  }, [muted, music, effects]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      if (e.code === 'Space' && (e.target as HTMLElement).tagName !== 'BUTTON') {
        e.preventDefault();
        setPlaying((v) => !v);
      }
      if (e.key.toLowerCase() === 'm') setMuted((v) => !v);
      if (e.key.toLowerCase() === 'f') setDrawer((v) => (v === 'findings' ? null : 'findings'));
      if (e.key.toLowerCase() === 'c')
        setDrawer((v) => (v === 'conversation' ? null : 'conversation'));
      if (e.key === 'Escape') setDrawer(null);
      if (e.key === 'ArrowRight' && match)
        setCursor((c) => Math.min(match.events.length - 1, c + 1));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [match?.events.length]);
  const enter = async () => {
    await audio.current.start();
    audio.current.setTheme('battle');
    setEntered(true);
    setPlaying(true);
  };
  const startDemo = async () => {
    try {
      const m = await api('/api/demo', {});
      await refreshMatches();
      await load(m.id);
      await enter();
    } catch (e) {
      setError(String(e));
    }
  };
  const inspect = (e: CombatEvent | null) => {
    if (e) {
      setSelected(e);
      setDrawer('evidence');
    }
  };
  const used = new Set(match?.events.slice(0, cursor + 1).flatMap((e) => e.usageIds));
  const totals = (a: Fighter) =>
    accountUsage(match?.usage.filter((r) => r.agent === a && used.has(r.id)) ?? []);
  const health = (a: Fighter) => event?.health[a] ?? 100;
  const activeFinding = match?.findings.find((f) => f.id === selected?.findingId);
  const winner = event ? boutWinner(event, match?.battle.knockout ?? null).winner : 'draw';
  const state =
    match?.status === 'scouting'
      ? 'SCOUTING'
      : match?.demo
        ? 'DEMO / SCRIPTED'
        : match?.status === 'complete'
          ? cursor < match.events.length - 1
            ? 'REPLAYING REVIEW'
            : 'REVIEW COMPLETE'
          : connected
            ? 'BUZZ CONNECTED'
            : 'RECONNECTING';
  return (
    <main className={reduced ? 'reduced' : ''}>
      <header className="topbar">
        <button
          className="brand"
          onClick={() => {
            setEntered(false);
            audio.current.setTheme('title');
          }}
          aria-label="Mortal Kommit title screen"
        >
          MK<span>MORTAL KOMMIT</span>
        </button>
        <div className="channel">
          <span className="status-dot" />
          BUZZ <b>/</b> ARENA
        </div>
        <div className="top-actions">
          <button onClick={() => setDrawer('scope')}>Review scope</button>
          <select
            aria-label="Match history"
            value={match?.id ?? ''}
            onChange={(e) => void load(e.target.value)}
          >
            <option value="" disabled>
              Match history
            </option>
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.demo ? 'DEMO · ' : ''}
                {m.title}
              </option>
            ))}
          </select>
        </div>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {!entered ? (
        <section className="title-screen">
          <div className="title-shade" />
          <div className="title-content">
            <div className="eyebrow">
              <span /> THE CODE REVIEW ARENA <span />
            </div>
            <h1>
              MORTAL
              <br />
              <strong>KOMMIT</strong>
            </h1>
            <p>
              Two reviewers. One change.
              <br />
              Every hit has evidence.
            </p>
            <div className="title-buttons">
              {match && (
                <button className="primary" onClick={() => void enter()}>
                  ENTER THE ARENA <span>↗</span>
                </button>
              )}
              <button className={match ? 'secondary' : 'primary'} onClick={() => void startDemo()}>
                PLAY DEMO
              </button>
            </div>
            <small>
              {match?.demo
                ? 'SCRIPTED DEMO · NO MODEL CALLS'
                : 'BUZZ CONDUCTS THE CONVERSATION. YOU WATCH THE FIGHT.'}
            </small>
          </div>
          <div className="title-foot">
            <span>
              CLAUDE <i>vs.</i> CODEX
            </span>
            <span>ORIGINAL ART · ORIGINAL SOUNDTRACK</span>
          </div>
        </section>
      ) : match ? (
        <>
          <section className="match-heading">
            <div>
              <div className="eyebrow">{state}</div>
              <h2>{match.title}</h2>
            </div>
            <span className="round">
              {event?.type === 'finisher'
                ? 'FINISHING MOVE'
                : event?.type === 'finish'
                  ? 'FINAL RESULTS'
                  : `ROUND ${Math.min(3, 1 + Math.floor(Math.max(0, cursor) / 8))}`}
              <small>{match.scope?.head.slice(0, 12) ?? 'PREPARING'}</small>
            </span>
          </section>
          <section className="cabinet">
            <div className="hud">
              {(['claude', 'codex'] as Fighter[]).map((a) => (
                <div className={`fighter-hud ${a}`} key={a}>
                  <div className="fighter-name">
                    <h3>{fighterName(a)}</h3>
                    <span>
                      {health(a).toFixed(0)}
                      <small> / 100</small>
                    </span>
                  </div>
                  <div
                    className={`health ${health(a) < 40 ? 'low' : ''}`}
                    role="meter"
                    aria-label={`${fighterName(a)} health`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={health(a)}
                  >
                    <div style={{ width: `${health(a)}%` }} />
                  </div>
                  <div className="fighter-meta">
                    <span>
                      {totals(a).tokens === null
                        ? 'USAGE UNAVAILABLE'
                        : `${totals(a).tokens!.toLocaleString()} TOKENS · ${totals(a).label.toUpperCase()}`}
                    </span>
                    <span>
                      QUALITY <b>{event?.scores[a] ?? 0}</b>
                    </span>
                  </div>
                  <div className="special-meter">
                    <i style={{ width: `${event?.special[a] ?? 0}%` }} />
                    <span>SPECIAL {event?.special[a] ?? 0}%</span>
                  </div>
                </div>
              ))}
              <div className="versus">
                VS<small>MK</small>
              </div>
            </div>
            <ArenaCanvas
              match={match}
              event={event}
              paused={!playing}
              reduced={reduced}
              speed={speed}
              onCue={cue}
              onHit={() => inspect(event)}
            />
            <div className="stage-label">
              THE MERGE GATE <span>01</span>
            </div>
            {event && (
              <button
                className={`action-caption ${event.type === 'finisher' ? 'is-finisher' : event.type === 'special' ? 'is-special' : ''}`}
                onClick={() => inspect(event)}
                aria-label={`Inspect evidence for ${event.caption}`}
              >
                <small>
                  {event.agent ? fighterName(event.agent) : 'MORTAL KOMMIT'}{' '}
                  {event.findingId && ` / ${event.findingId}`}
                  {event.exchange && ' / REVIEW EXCHANGE'}
                  {event.type === 'finisher' && ' / VICTORY FINISHER'}
                </small>
                <strong>
                  {event.type === 'finish'
                    ? winner === 'draw'
                      ? 'HONORABLE DRAW'
                      : `${fighterName(winner)} WINS`
                    : event.caption}
                </strong>
                <span>{event.exchange ? 'NO POINTS OR DAMAGE · ' : ''}VIEW EVIDENCE ↗</span>
              </button>
            )}
            {!event && (
              <div className="fight-announcement">
                {match.status === 'scouting'
                  ? 'SCOUTING THE OPPONENT'
                  : match.events.length
                    ? 'FIGHT!'
                    : match.messages.some((x) => x.agent)
                      ? 'REVIEW IN PROGRESS'
                      : 'AWAITING REVIEWERS'}
                <small>
                  {match.demo
                    ? 'SCRIPTED EXHIBITION MATCH'
                    : 'WAITING FOR SUBSTANTIVE REVIEW EVIDENCE'}
                </small>
              </div>
            )}
            {match.battle.knockout && event && event.seq >= match.battle.knockout.seq && (
              <div className="ko-note">
                K.O. · {match.status === 'complete' ? 'Review complete' : 'Buzz review continues'}
              </div>
            )}
            <div className="stage-bottom">
              <span>
                {match.demo
                  ? 'DEMO · SIMULATED MESSAGES & USAGE'
                  : match.status === 'complete'
                    ? 'RECORDED REVIEW · PINNED SOURCE'
                    : 'LIVE REVIEW · PINNED SOURCE'}
              </span>
              <span>{match.scope?.branch}</span>
            </div>
          </section>
          <section className="controls">
            <div className="playback">
              <button
                className="play"
                onClick={() => setPlaying((v) => !v)}
                aria-label={playing ? 'Pause animation' : 'Play animation'}
              >
                {playing ? 'Ⅱ' : '▶'}
              </button>
              <button
                onClick={() => {
                  setCursor(-1);
                  setPlaying(true);
                  audio.current.setTheme('battle');
                }}
              >
                REPLAY
              </button>
              <button
                onClick={() => setCursor((c) => Math.min(match.events.length - 1, c + 1))}
                aria-label="Next combat event"
              >
                NEXT ›
              </button>
              <select
                aria-label="Playback speed"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
              </select>
            </div>
            <input
              aria-label="Replay position"
              className="timeline"
              type="range"
              min={-1}
              max={Math.max(0, match.events.length - 1)}
              value={cursor}
              onChange={(e) => {
                setPlaying(false);
                setCursor(Number(e.target.value));
              }}
            />
            <span className="event-count">
              {Math.max(0, cursor + 1)} / {match.events.length}
            </span>
            <button
              aria-label={muted ? 'Unmute audio' : 'Mute audio'}
              onClick={() => {
                setMuted((v) => !v);
                void audio.current.start();
              }}
            >
              {muted ? 'SOUND OFF' : 'SOUND ON'}
            </button>
            <button onClick={() => setAudioOpen((v) => !v)} aria-expanded={audioOpen}>
              MIXER
            </button>
          </section>
          {audioOpen && (
            <section className="mixer">
              <label>
                Music{' '}
                <input
                  aria-label="Music volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={music}
                  onChange={(e) => setMusic(+e.target.value)}
                />
              </label>
              <label>
                Effects{' '}
                <input
                  aria-label="Effects volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={effects}
                  onChange={(e) => setEffects(+e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reduced}
                  onChange={(e) => setReduced(e.target.checked)}
                />{' '}
                Reduced motion
              </label>
              <output
                aria-label="Audio engine status"
                data-state={audioStatus.state}
                data-rms={audioStatus.rms.toFixed(6)}
              >
                Audio {audioStatus.state === 'not-started' ? 'awaiting gesture' : audioStatus.state}
              </output>
              <button
                onClick={() => {
                  void audio.current.start().then(() => audio.current.effect('special'));
                }}
              >
                TEST SOUND
              </button>
              <small>SPACE pause · M mute · F findings · C conversation</small>
            </section>
          )}
          <section className="under-stage">
            <div className="review-tabs">
              <button onClick={() => setDrawer('findings')}>
                FINDINGS <b>{match.findings.length.toString().padStart(2, '0')}</b> ↗
              </button>
              <button onClick={() => setDrawer('conversation')}>
                CONVERSATION <b>{match.messages.filter((x) => x.agent).length}</b> ↗
              </button>
              <button onClick={() => setDrawer('scope')}>PINNED SCOPE ↗</button>
            </div>
            <p>
              Buzz conducts the review. Mortal Kommit observes.
              <br />
              <span>Pausing the arena never pauses the conversation.</span>
            </p>
          </section>
          {match.error && <div className="notice">{match.error}</div>}
          <section className="event-rail" aria-label="Combat event history">
            {match.events.slice(Math.max(0, cursor - 5), cursor + 1).map((e) => (
              <button key={e.id} className={e.agent ?? ''} onClick={() => inspect(e)}>
                <span>
                  {String(e.seq).padStart(2, '0')} / {e.agent ?? 'ARENA'}
                </span>
                <strong>{e.caption}</strong>
                <small>{e.findingId ?? (e.type === 'fatigue' ? 'USAGE RECORD' : 'MATCH')}</small>
              </button>
            ))}
          </section>
        </>
      ) : (
        <div className="empty">
          No match yet. Start a review from the CLI or post a request in ARENA.
          <button onClick={() => void startDemo()}>Play the demo</button>
        </div>
      )}
      <footer>
        <span>MK / v0.1</span>
        <span>EVIDENCE WINS. AGREEMENT ISN’T PROOF.</span>
        <span>LOCAL ARENA</span>
      </footer>
      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(null)}>
          <aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={drawer}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-header">
              <div className="eyebrow">MATCH INTELLIGENCE</div>
              <button aria-label="Close drawer" onClick={() => setDrawer(null)}>
                ×
              </button>
            </div>
            <nav className="drawer-tabs">
              {(['findings', 'conversation', 'scope'] as const).map((tab) => (
                <button
                  key={tab}
                  className={drawer === tab ? 'active' : ''}
                  onClick={() => setDrawer(tab)}
                >
                  {tab}
                </button>
              ))}
            </nav>
            {match && drawer === 'evidence' && (
              <>
                <h2>{selected?.caption}</h2>
                <p>{selected?.reason}</p>
                {selected?.type === 'finisher' && (
                  <p className="notice">
                    Finishing moves celebrate the recorded result. They add no review points or
                    token charges.
                  </p>
                )}
                {selected?.exchange && <blockquote>{selected.exchange.quote}</blockquote>}
                {activeFinding && (
                  <article>
                    <div className="finding-label">
                      {activeFinding.id} · {activeFinding.severity} · {activeFinding.status}
                    </div>
                    <h3>{activeFinding.title}</h3>
                    <p>{activeFinding.scenario}</p>
                    <p>{activeFinding.impact}</p>
                    {activeFinding.evidence.map((e, i) => (
                      <div className="code-evidence" key={i}>
                        <small>
                          {e.revision}:{e.file}:{e.line}
                        </small>
                        <pre>{e.quote}</pre>
                      </div>
                    ))}
                  </article>
                )}
                {selected?.usageIds.map((id) => {
                  const r = match.usage.find((r) => r.id === id);
                  return <pre key={id}>{JSON.stringify(r, null, 2)}</pre>;
                })}
                <h3>Source messages</h3>
                {match.messages
                  .filter((msg) => selected?.sourceIds.includes(msg.id))
                  .map((msg) => (
                    <article className={`message ${msg.agent}`} key={msg.id}>
                      <small>
                        {msg.agent ?? 'owner'} · {msg.id.slice(0, 18)}
                        {msg.deleted ? ' · edited/deleted source' : ''}
                      </small>
                      <p>{msg.content}</p>
                    </article>
                  ))}
              </>
            )}
            {match && drawer === 'findings' && (
              <>
                <h2>Finding ledger</h2>
                <p className="subtle">
                  Current review state, including retractions and unresolved disagreements.
                </p>
                {match.findings.map((f) => (
                  <article key={f.id}>
                    <div className={`finding-label ${f.status}`}>
                      {f.id} · {f.severity} · {f.status}
                    </div>
                    <h3>{f.title}</h3>
                    <p>{f.scenario}</p>
                    <p>
                      <b>Impact:</b> {f.impact}
                    </p>
                    <small>
                      Discovered by {f.discoverer}
                      {f.special ? ` · ${f.special}` : ''}
                    </small>
                    {f.evidence.map((e, i) => (
                      <div className="code-evidence" key={i}>
                        <small>
                          {e.revision}:{e.file}:{e.line}
                        </small>
                        <pre>{e.quote}</pre>
                      </div>
                    ))}
                    <details>
                      <summary>Challenges & corrections</summary>
                      {f.history.map((a, i) => (
                        <p key={i}>
                          <b>
                            {a.agent} / {a.type}:
                          </b>{' '}
                          {a.rationale}
                        </p>
                      ))}
                    </details>
                  </article>
                ))}
                {!match.findings.length && (
                  <p>
                    {match.status === 'complete'
                      ? 'No substantiated defects retained. Open Conversation for the discussion and validation limits.'
                      : 'Waiting for substantiated review events.'}
                  </p>
                )}
              </>
            )}
            {match && drawer === 'conversation' && (
              <>
                <h2>The review conversation</h2>
                {match.demo && (
                  <p className="demo-note">These messages are authored demo fixtures.</p>
                )}
                {[...match.messages]
                  .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
                  .map((msg) => (
                    <article className={`message ${msg.agent ?? ''}`} key={msg.id}>
                      <small>
                        {msg.agent ?? 'kickoff'} · {new Date(msg.at).toLocaleTimeString()}
                        {msg.deleted ? ' · superseded' : ''}
                      </small>
                      <p>{msg.content}</p>
                      <code>{msg.id.slice(0, 24)}</code>
                    </article>
                  ))}
              </>
            )}
            {match && drawer === 'scope' && (
              <>
                <h2>Pinned review scope</h2>
                <p>{match.scope?.repo}</p>
                <dl>
                  <dt>Mode</dt>
                  <dd>{match.scope?.mode}</dd>
                  {(match.scope?.pr || match.scope?.mr) && (
                    <>
                      <dt>Review</dt>
                      <dd>
                        <a
                          href={(match.scope.pr ?? match.scope.mr)!.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {match.scope.pr ? 'GitHub PR' : 'GitLab MR'} ↗
                        </a>
                      </dd>
                      <dt>Target branch</dt>
                      <dd>{(match.scope.pr ?? match.scope.mr)!.target}</dd>
                    </>
                  )}
                  <dt>Base</dt>
                  <dd>{match.scope?.base}</dd>
                  <dt>Head</dt>
                  <dd>{match.scope?.head}</dd>
                </dl>
                <h3>Selected commits</h3>
                {match.scope?.commits.map((c) => (
                  <p key={c.sha}>
                    <code>{c.sha.slice(0, 12)}</code> {c.subject}
                  </p>
                ))}
                {match.scope?.warnings.map((w, i) => (
                  <p className="notice" key={i}>
                    {w}
                  </p>
                ))}
                <h3>Accounting</h3>
                <p>
                  Health = 100 − supported combat damage − token fatigue. Fatigue uses up to{' '}
                  {match.config.weight} health across each fighter’s allowance. Quality scores are
                  separate.
                </p>
                {(['claude', 'codex'] as Fighter[]).map((a) => (
                  <div key={a}>
                    <p>
                      {fighterName(a)}:{' '}
                      {match.battle[a].usage.tokens?.toLocaleString() ?? 'usage unavailable'} (
                      {match.battle[a].usage.label}); allowance{' '}
                      {match.config.allowance[a].toLocaleString()}.
                    </p>
                    {match.battle[a].usage.notes.map((note) => (
                      <p className="subtle" key={note}>
                        {note}
                      </p>
                    ))}
                  </div>
                ))}
                <h3>Omitted context</h3>
                {match.omissions.length ? (
                  <ul>
                    {match.omissions.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                ) : (
                  <p>No omissions recorded.</p>
                )}
                <div className="exports">
                  <a href={`/api/matches/${match.id}/export.md`}>EXPORT MARKDOWN ↗</a>
                  <a href={`/api/matches/${match.id}/export.json`}>EXPORT JSON ↗</a>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);

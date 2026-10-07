"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * What a recap's page knows about its recording while someone listens, shared by the player, the key points, and the
 * transcript (MeetingPlaybackProvider around them). Outside a provider every part still works on its own: nothing
 * seeks, nothing is highlighted.
 */
export interface MeetingPlaybackControls {
  /** The recording is loaded: its moments can be played. */
  loaded: boolean;
  /** Its length (ms), when known. */
  durationMs: number | null;
  /** Play from `ms` into the recording (nothing until it's loaded). */
  playFrom: (ms: number) => void;
  /**
   * Bring the transcript line for `ms` into view and focus it (unfolding the transcript when needed). False when
   * there's no transcript with times to show.
   */
  showMoment: (ms: number) => boolean;
  /** The player hands over its <audio> once it can play (null when it goes), with the length when known. */
  attachAudio: (el: HTMLAudioElement | null, durationMs?: number | null) => void;
  /** The transcript says how to show a moment (null when it goes). */
  setMomentHandler: (handler: ((ms: number) => boolean) | null) => void;
}

/** Where playback is, apart from the controls: it changes a few times a second, and only the transcript follows it. */
export interface MeetingPlaybackPosition {
  /** ms into the recording. */
  positionMs: number;
  playing: boolean;
}

const INERT: MeetingPlaybackControls = {
  loaded: false,
  durationMs: null,
  playFrom: () => {},
  showMoment: () => false,
  attachAudio: () => {},
  setMomentHandler: () => {},
};
const STILL: MeetingPlaybackPosition = { positionMs: 0, playing: false };

const ControlsContext = createContext<MeetingPlaybackControls>(INERT);
const PositionContext = createContext<MeetingPlaybackPosition>(STILL);

/** Shares one recording's playback between the player, the key points, and the transcript under it. */
export function MeetingPlaybackProvider({ children }: { children: ReactNode }) {
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  // The same element, for seeking (state isn't changed in place).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [position, setPosition] = useState<MeetingPlaybackPosition>(STILL);
  const momentHandler = useRef<((ms: number) => boolean) | null>(null);

  useEffect(() => {
    if (!audio) return;
    const sync = () => {
      const positionMs = Math.round(audio.currentTime * 1000);
      const playing = !audio.paused && !audio.ended;
      setPosition((p) => (p.positionMs === positionMs && p.playing === playing ? p : { positionMs, playing }));
    };
    const onDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDurationMs(Math.round(audio.duration * 1000));
    };
    const events = ["timeupdate", "seeked", "play", "pause", "ended"] as const;
    for (const name of events) audio.addEventListener(name, sync);
    audio.addEventListener("durationchange", onDuration);
    return () => {
      for (const name of events) audio.removeEventListener(name, sync);
      audio.removeEventListener("durationchange", onDuration);
    };
  }, [audio]);

  const attachAudio = useCallback((el: HTMLAudioElement | null, length?: number | null) => {
    audioRef.current = el;
    setAudio(el);
    setDurationMs(el && length && length > 0 ? Math.round(length) : null);
    setPosition(el ? { positionMs: Math.round(el.currentTime * 1000), playing: !el.paused && !el.ended } : STILL);
  }, []);

  const playFrom = useCallback((ms: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms / 1000);
    // Refused without a recent tap (autoplay rules); the person can press play themselves.
    void el.play().catch(() => {});
  }, []);

  const showMoment = useCallback((ms: number) => momentHandler.current?.(ms) ?? false, []);
  const setMomentHandler = useCallback((handler: ((ms: number) => boolean) | null) => {
    momentHandler.current = handler;
  }, []);

  const controls = useMemo<MeetingPlaybackControls>(
    () => ({ loaded: !!audio, durationMs, playFrom, showMoment, attachAudio, setMomentHandler }),
    [audio, durationMs, playFrom, showMoment, attachAudio, setMomentHandler],
  );

  return (
    <ControlsContext.Provider value={controls}>
      <PositionContext.Provider value={position}>{children}</PositionContext.Provider>
    </ControlsContext.Provider>
  );
}

/** The recording's controls (inert outside a MeetingPlaybackProvider). */
export function useMeetingPlayback(): MeetingPlaybackControls {
  return useContext(ControlsContext);
}

/** Where playback is (always at 0, paused, outside a MeetingPlaybackProvider). */
export function useMeetingPlaybackPosition(): MeetingPlaybackPosition {
  return useContext(PositionContext);
}
